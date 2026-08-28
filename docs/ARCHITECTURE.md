# Architecture

How the system is put together, and — more usefully — why it is put together this way. Where a decision looks unusual, the reason is given, because the reason is the part you need in order to change it safely.

---

## The shape of it

One Node process serves everything. No build step, no bundler, no framework.

```
                    ┌─────────────────────────┐
   shopper phone ──▶│                         │
                    │       server.js         │──▶  Groq (Llama 3.1)
   admin browser ──▶│   Express + Socket.IO   │──▶  Whisper (voice)
                    │                         │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │   in-memory `db` object │  ← the working copy
                    └───────────┬─────────────┘
                                │  lib/store.js
                    ┌───────────▼─────────────┐
                    │  Postgres  or  JSON file│
                    └─────────────────────────┘
```

**All state lives in memory and is persisted behind an adapter.** Reads never touch the database. That is what lets a 100,000-SKU catalogue search in single-digit milliseconds without Elasticsearch, and it is the assumption behind almost every performance property of this app.

The cost of that choice: the process holds the whole dataset, and a second instance would drift from the first. This runs as **one instance on purpose**. If you ever need two, the memory model has to change first — that is a project, not a config flag.

---

## Why no framework

An honest answer, because you will wonder.

React, a bundler and a component library would be normal for this. They were left out because the whole product is two screens, both of which are dense data tables and forms, and because a client demo has to run from a single `npm start` on a laptop with no build step. The trade is real: the two HTML files are large, and there is no component reuse across them.

Where the trade stops paying, split. But split along a seam that exists — for example the admin panel's forecasting screens are nearly independent — rather than rewriting everything into components because it feels tidier. A rewrite that pauses feature work for a month is not an improvement to a product that is being sold this quarter.

---

## Request lifecycle

Take `POST /api/orders`:

1. **Rate limit** — `GUARD.limit('write')` (`lib/guard.js`), sliding window per IP.
2. **Identify the branch** — `branchOf(req)` resolves `?branch=` / `x-branch` / body, clamped to what the caller may access.
3. **Price the order** — against *that branch's* catalogue, never a shared one. Loose lines are estimates.
4. **Claim a delivery slot** — `lib/slots.js`, server-side, so two shoppers cannot take the last one.
5. **Decide the payment state** — `lib/payments.js` sets `payStatus` from the method and whether anything needs weighing.
6. **Persist** — `save('devx-orders')` marks the key dirty; `lib/store.js` writes it.
7. **Broadcast** — `io.emit('sync', …)`, so every admin panel updates within a second.
8. **Respond**.

Understand this one and the rest are variations.

---

## The modules

Each `lib/` file opens with a comment explaining the problem it solves. Read those first; this table is only an index.

| File | Responsibility | Worth knowing |
|---|---|---|
| `catalog.js` | Inverted-index search over products | Built lazily per branch, cached. ~850 ms to index 96k SKUs, ~3 ms to search |
| `payments.js` | Payment methods, weight tolerance, state machine | `TOLERANCE = 0.10`. The heart of the product |
| `tenancy.js` | Per-branch catalogue, zones, slots; CSV import | Product ids are allocated chain-wide so orders are never ambiguous |
| `stores.js` | Branch list, scoping helper, error ring buffer | `scope()` treats a missing `branchId` as the founding branch |
| `staff.js` | Roles, scrypt PIN hashing, sessions, lockout | Sessions are opaque tokens in memory — no JWT, nothing secret sent to the client |
| `customers.js` | Shopper accounts by mobile number, OTP | `normalisePhone` keys on the last 9 digits so `+971 50…` and `050…` are one person |
| `slots.js` | Delivery windows with capacity; refunds | Capacity is enforced on the server, not suggested in the UI |
| `loyalty.js` | Till + app spend merged, decline detection, offer ranking | Median baseline, not mean — one big month must not hide a drift |
| `forecast.js` | The five ForecastAI modules | UAE seasonality; `PO = Forecast + Safety − Stock` |
| `rollup.js` | Group view across branches | Exceptions ranked by cost, not by severity label |
| `insights.js` | Lost sales and demand the POS cannot see | Built from shopper questions that found nothing |
| `guard.js` | Rate limits and the daily AI spend ceiling | `RATE_LIMIT_OFF=1` for tests only, never inferred from `NODE_ENV` |
| `store.js` | Postgres / file persistence | Excludes the catalogue from routine saves — 30 MB at 96k |
| `integrations.js` | Card gateway and messaging adapters | Mocks say plainly that nothing was charged |
| `images.js` | Thumbnails and lazy loading | Keeps page weight flat regardless of catalogue size |

---

## Storage

`lib/store.js` picks a driver at boot:

- **`DATABASE_URL` set** → Postgres, a JSONB key/value table.
- **Not set** → `data/db.json`.

The file driver is right for local work and **wrong for production**: Render's filesystem is wiped on every deploy and on the daily container recycle. If a deployment logs `EPHEMERAL`, real orders are being written to something that will be thrown away.

Writes are dirty-key tracked. `save('devx-orders')` persists that one collection. `saveAll()` includes the catalogue and is only used when the catalogue really changed, because it is by far the largest thing stored.

---

## Real-time

Socket.IO, one event: `sync`, carrying the list of changed keys. Clients re-read what changed. Deliberately dumb — no per-record diffing, no optimistic updates, no reconciliation logic to get wrong. At this data size the whole-key refresh is imperceptible and it removes an entire category of bug.

---

## Authentication — two separate systems

They share no code, and shouldn't.

**Staff** (`lib/staff.js`) — name + PIN → scrypt verify → opaque session token, held in memory, 12-hour expiry. Five failures locks an account for fifteen minutes. Every consequential action is written to the audit log with the actor's name and branch.

**Shoppers** (`lib/customers.js`) — mobile number → one-time code → customer token. This is what makes order history survive a cleared browser or a second phone.

A third path exists: the shared `ADMIN_PIN`. It is a fallback for setup and demos, it appears in the audit log as `Shared PIN`, and it should not be how anyone works day to day.

---

## Permissions

Six roles in `lib/staff.js`: `owner`, `area`, `manager`, `picker`, `cashier`, `buyer`.

Two rules that matter more than the table:

**Enforcement is server-side.** `need('some.permission')` guards the route. The nav hiding in `admin.html` is presentation — a role that cannot open a screen also cannot reach it by typing the URL.

**Nobody can create a role at or above their own.** A manager adds pickers and cashiers, never another manager. Without that rule the whole model is decoration, because one compromised manager account becomes an owner account.

Scoping is by branch. `accessible(req)` returns `null` for an owner (meaning everywhere) or a list of branch ids. Everything else — orders, audit, staff, catalogue writes — filters through that.

---

## The branch model

Chosen with the client, deliberately, over the alternatives:

| | What it is | Why not / why yes |
|---|---|---|
| Separate deployment per shop | Total isolation | Six branches means six databases and six sets of staff accounts. Rejected |
| Shared catalogue, per-branch stock | One product list | Recommended, and the client declined — their branches genuinely stock different ranges |
| **Per-branch catalogue** | Each shop owns its list | **Chosen.** A new shop opens empty and fills its own shelves |
| Full multi-tenancy | Many companies, one deployment | Needs row-level isolation in storage. Different companies get separate deployments today |

Customers and loyalty stay chain-wide inside one group, because a shopper's relationship is with the chain.

---

## Performance, measured

On the 96,000-SKU catalogue:

| | |
|---|---|
| Index build | 742–855 ms, once per branch, lazy |
| Search | ~2.6 ms |
| AI reply | 1.2–1.4 s (Groq) |
| Shopper bootstrap | 445 bytes |
| Admin bootstrap | ~1.2 KB on an empty branch |
| Group roll-up, 101 branches | ~5 ms |
| Memory | ~278 MB RSS |

Bootstrap payloads are the thing to watch. They have twice grown by accident — once shipping the whole catalogue, once shipping every branch's catalogue plus staff PIN hashes. If you add a collection to `KEYS`, check what `fullState()` now sends.

---

## Deliberate limits

Say these plainly to anyone who asks, rather than discovering them under pressure:

- **One process.** Horizontal scaling needs the memory model changed first.
- **One company per deployment.** Never point two clients at one database.
- **Sessions are in memory.** A restart signs everyone out. Acceptable; a surprise if you don't know.
- **The catalogue is the memory ceiling.** ~278 MB at 96k SKUs is comfortable; 1M would not be.
- **Mock payments by default.** `PAYMENT_DRIVER=mock` records intent and charges nothing. Do not demo it as a live payment.

---

*Next: [`BUSINESS-LOGIC.md`](BUSINESS-LOGIC.md) — the retail rules the code implements.*
