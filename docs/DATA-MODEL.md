# Data model

Everything lives in one in-memory object, `db`, keyed by collection name. `lib/store.js` persists it to Postgres (a JSONB key/value table) or to `data/db.json`.

There is no schema and no migration tool. That is a real trade: adding a field is free, but nothing stops an old record missing it. **Always read defensively** — `(o.items || [])`, `p.stock || 0`, `o.branchId || fallbackId`.

---

## The collections

Declared as `KEYS` in `server.js`. Adding one means adding it there, giving it an initial value, and checking what `fullState()` now sends to the browser.

| Key | Shape | Scope |
|---|---|---|
| `devx-catalogs` | `{ branchId: [product] }` | per branch |
| `devx-catalog` | legacy flat list | migrated on first boot |
| `devx-orders` | `[order]` | tagged with `branchId` |
| `devx-offers` | `[offer]` | chain-wide |
| `devx-personal-offers` | `[personalOffer]` | per branch |
| `devx-loyalty` | `[tillRow]` | per branch |
| `devx-notifs-customer` | `[notification]` | per customer |
| `devx-activity` | `[activityEntry]` | per branch, capped 120 |
| `devx-queries` | `[shopperQuestion]` | per branch |
| `devx-zones` | `{ branchId: { category: zone } }` | per branch |
| `devx-slots` | `{ branchId: [slot] }` | per branch |
| `devx-staff` | `[user]` | chain-wide, branch-tagged |
| `devx-audit` | `[auditEntry]` | branch-stamped, capped 500 |
| `devx-branches` | `[branch]` | chain-wide |

---

## Product

```jsonc
{
  "id": 15,                    // number, unique across the whole chain
  "name": "Onions",
  "brand": "Al Ain",           // optional
  "cat": "Fresh Produce",
  "unit": "1 kg",
  "price": 4,                  // for loose items, the per-kg rate
  "was": 5,                    // optional, shows a strikethrough
  "loose": true,               // sold by weight → must be weighed
  "perKg": 4,                  // required when loose
  "stock": 24,
  "loc": "Aisle 1 · Rack 2 · Shelf 1",
  "img": "https://…",
  "deal": false,
  "nutri": { "kcal": 40, "protein": 1.1, "carbs": 9.3, "fat": 0.1 }
}
```

**`loose: true` is the important flag.** It sends the order down the weigh-then-pay path. A loose product needs `perKg`; a normal one needs `price`.

**Ids are allocated chain-wide** (`TEN.nextProductId`). Two shops must never both have "product 1", or an order line becomes ambiguous about which product it means.

---

## Order

```jsonc
{
  "id": "NX-0042",
  "date": "2026-07-24T06:42:00.000Z",
  "branchId": "br-deira",              // absent on old records → founding branch
  "cid": "abc123",                     // device id, for guests
  "mode": "delivery",                  // or "pickup"
  "customer": { "name": "…", "phone": "+971 50 …", "addr": "…" },
  "items": [
    { "id": 15, "name": "Onions", "qty": 1, "price": 4, "unit": "1 kg",
      "loose": true, "perKg": 4,
      "grams": 500,                    // what was ordered
      "actualGrams": 560 }             // what the scale said
  ],
  "sub": 45.5, "save": 3, "fee": 10, "total": 52.5,
  "payMethod": "online",               // cash | card_machine | online
  "payStatus": "awaiting_approval",
  "status": "new",
  "needsApproval": true,
  "slotKey": "eve",
  "refunds": [ { "amountAED": 5, "reason": "Tomatoes bruised", "at": "…", "by": "Ramesh" } ],
  "history": [ { "at": "…", "status": "new" } ]
}
```

### The two status fields

| `status` — where it physically is | `payStatus` — where the money is |
|---|---|
| `new` | `awaiting_weight` |
| `preparing` | `awaiting_approval` |
| `ready` (pickup) / `out` (delivery) | `awaiting_payment` |
| `done` | `due_on_delivery` |
| `cancelled` | `paid` · `refunded` |

They move independently. See [`BUSINESS-LOGIC.md`](BUSINESS-LOGIC.md).

`grams` is what the customer asked for and never changes. `actualGrams` is what the scale said. Keeping both is what lets the customer see the difference they are approving.

---

## Branch

```jsonc
{
  "id": "br-deira",
  "name": "Madina Supermarket",
  "area": "Deira — Branch 3",
  "city": "Dubai, UAE",
  "active": true,
  "createdAt": "2026-07-30T14:44:07.894Z"   // absent on the seeded demo branch
}
```

**The missing `createdAt` is load-bearing.** It is how the code knows a branch is the seeded demo one and may show the demo loyalty book. A branch created through the panel has it, gets an empty book, and is never shown invented customers.

---

## Staff user

```jsonc
{
  "id": "u63aa9c5de852",
  "name": "Ramesh",
  "role": "picker",                     // owner|area|manager|picker|cashier|buyer
  "branchId": "br-deira",               // primary shop; null for an owner
  "branchIds": ["br-deira"],            // several for an area manager
  "salt": "…", "hash": "…",             // scrypt — never leaves the server
  "active": true,
  "createdAt": "…", "lastLogin": "…"
}
```

Always send these through `STAFF.publicUser()`, which strips `salt` and `hash`. The admin bootstrap once copied the collection wholesale and shipped every PIN hash to every signed-in browser.

---

## Zone (floor plan)

```jsonc
{ "Rice & Grains": { "zone": "Dry Goods", "areaM2": 80, "density": 12 } }
```

`areaM2 × density` is the capacity the warehouse planner works from. Editable per branch — a client's frozen section is not a default.

---

## Audit entry

```jsonc
{
  "at": "…", "who": "Ramesh", "role": "picker",
  "action": "order.weigh",
  "detail": "Weighed NX-0042 — AED 45 → AED 50.40",
  "branchId": "br-deira",
  "orderId": "NX-0042"
}
```

`branchId` is what lets a store manager read their own shop's log instead of the whole chain's. Capped at 500 entries — if a client needs longer retention, that is a real change, not a constant.

---

## Loyalty till row

What the supermarket's POS exports; imported via `/api/loyalty/import`.

```jsonc
{ "phone": "+971 50 …", "name": "…", "card": "…",
  "date": "2026-06-14", "amountAED": 142.5,
  "items": [ { "id": 15, "qty": 2 } ],
  "branchId": "br-deira" }
```

`lib/loyalty.js` merges these with app orders into a member view. Phones are matched on the **last 9 digits**, so `+971 50 123 4567` and `050 123 4567` are the same person.

---

## Persistence

- `save('devx-orders')` marks one key dirty and writes it.
- `saveAll()` includes the catalogue — only when the catalogue actually changed. It is ~30 MB at 96k SKUs.
- On `SIGTERM`, `close()` flushes.

**Reads never touch storage.** Everything is served from memory. That is the whole performance story, and the reason a second process would be wrong without a redesign.

---

## Migrations, such as they are

`TEN.migrate()` runs at boot and moves an old flat catalogue into the founding branch. Handle old shapes by reading defensively rather than by rewriting stored data — a client's live database is not something to rewrite on a deploy.
