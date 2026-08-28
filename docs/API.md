# API reference

52 routes. Everything the two front-ends do goes through these.

## How to read this

**Auth column**

| | Meaning |
|---|---|
| public | No credentials |
| shopper | `x-customer-token` for a signed-in shopper, or ownership of the order |
| `perm` | Staff session with that permission — see [`CONVENTIONS.md`](CONVENTIONS.md) |

**Branch resolution.** Any branch-scoped route reads the branch from `?branch=`, the `x-branch` header, or `body.branchId`, in that order — then clamps it to what the caller may access. Ask for a shop you do not hold and you get **your own**, not an error, so a stale browser tab cannot leak another shop's data.

**Headers**

```
x-admin-token     staff session      (from /api/auth/login)
x-admin-pin       shared PIN fallback
x-customer-token  shopper session    (from /api/customer/verify)
x-customer-cid    anonymous device id
x-branch          which shop
```

Try anything quickly:

```bash
curl -s localhost:3000/api/health | jq
curl -s -H "x-admin-pin: 1234" localhost:3000/api/group/overview | jq .data.totals
```

---

## Catalogue and shopping

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | Storage driver, AI budget, memory. Check this first when something is wrong |
| GET | `/api/products` | public | `?q=` `?cat=` `?limit=` (max 60) `?offset=`. Indexed — never loads the full catalogue |
| GET | `/api/product/:id` | public | One product |
| GET | `/api/categories` | public | Category list with counts |
| GET | `/api/deals` | public | Active offers |
| GET | `/api/state` | public / staff | Bootstrap. Shoppers get a few hundred bytes; staff get the branch's working set |
| POST | `/api/concierge` | public | AI reply. Rate limited, daily ceiling |
| POST | `/api/transcribe` | public | Voice → text (Whisper). Tighter limit — billed per second of audio |

---

## Orders

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/api/orders` | public | Places an order. Prices against the branch catalogue, claims a slot, sets `payStatus` |
| POST | `/api/orders/:id/weigh` | `orders.weigh` | Actual weights. Reprices, may require approval |
| POST | `/api/orders/:id/confirm` | shopper | Customer approves the new weight |
| POST | `/api/orders/:id/pay` | shopper / `orders.pay` | Settles. Refuses if the order is not ready to be paid |
| POST | `/api/orders/:id/checkout` | shopper | Starts a gateway payment |
| POST | `/api/orders/:id/refund` | `orders.refund` | Partial by default. A reason is required — the customer sees it |
| POST | `/api/payments/webhook` | gateway | Gateway callback. Writes to the audit log |
| GET | `/api/payment-methods` | public | Methods and what each means |
| GET | `/api/slots` | public | Delivery windows, with passed and full ones marked |

> **Order ids are sequential and guessable** (`NX-0042`). Every route above that touches an order runs `ownsOrder()`. Do not add a route that acts on an order without it — `/pay`, `/checkout` and `/confirm` once treated "awaiting payment" as authorisation, which let anyone pay for, and therefore see, someone else's order.

---

## Shopper accounts

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/api/customer/otp` | public | Sends a code. 45-second resend cooldown |
| POST | `/api/customer/verify` | public | Code → token. 5 attempts, 5-minute expiry, constant-time compare |
| GET | `/api/customer/me` | shopper | Profile, orders, offers |
| POST | `/api/customer/logout` | shopper | |
| GET | `/api/customer/codes` | `orders.view` | Staff read a code out to a customer at the counter |
| GET | `/api/my-offers` | shopper | Personal offers |
| POST | `/api/coupon/check` | public | Validates a code |

---

## Staff, roles, audit

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | public | Name + PIN → session. 5 failures locks 15 minutes |
| POST | `/api/auth/logout` | staff | |
| GET | `/api/auth/me` | staff | Identity, permissions, accessible branches |
| GET | `/api/staff` | `staff.manage` | Scoped to your shops. Returns `grantable` roles and an `editable` flag per row |
| POST | `/api/staff` | `staff.manage` | Create. Cannot create a role at or above your own |
| POST | `/api/staff/:id` | `staff.manage` | Change role, PIN, shops, active. Signs that person out |
| GET | `/api/audit` | `audit.view` | Scoped to your shops. `?q=` `?limit=` |
| GET | `/api/errors` | `*` | Recent captured errors |

---

## Branches

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/branches` | public | Shop list — the shopper app needs it for `?branch=` links |
| POST | `/api/branches` | `branch.create` | Opens a shop. It starts **empty** |
| GET | `/api/branches/catalogs` | `branch.view` | Product and stock counts per shop |
| GET | `/api/branches/summary` | `branch.view` | Order counts per shop |
| GET | `/api/branches/:id/catalog/template` | `inventory.edit` | Blank CSV |
| POST | `/api/branches/:id/catalog/import` | `inventory.edit` | CSV body, `?mode=replace\|append`. Reports skipped rows |
| POST | `/api/branches/:id/catalog/copy` | `inventory.edit` | Seed from a sister branch. Stock → 0, locations cleared |
| GET | `/api/group/overview` | `insights.view` | Roll-up across your shops. `?days=` |

The import and copy routes also check `ownsBranch()` — permission to edit inventory is not permission to rewrite a sister shop's list.

---

## Intelligence

| Method | Route | Auth | Reports |
|---|---|---|---|
| GET | `/api/insights/:report` | `insights.view` | `demand-gap` · `reorder` · `health` · `expiry` · `affinity` · `summary` |
| GET | `/api/forecast/:module` | `forecast.view` | `demand` · `optimization` · `financial` · `warehouse` · `zones` · `events` · `summary` |
| POST | `/api/forecast/calc` | `forecast.view` | The live calculator |
| POST | `/api/forecast/zones` | `forecast.edit` | Edit a category's floor area |
| GET | `/api/loyalty/:report` | `loyalty.view` | `members` · `triggers` · `offers` · `summary` |
| GET | `/api/loyalty/candidates/:phone` | `loyalty.view` | What to offer this member |
| POST | `/api/loyalty/issue` | `loyalty.issue` | Issue a coupon. 5–70% |
| POST | `/api/loyalty/revoke/:id` | `loyalty.issue` | |
| POST | `/api/loyalty/import` | `loyalty.view` | Import a till loyalty export |

Unknown `:report` or `:module` returns **404**, which is how the tests confirm a module is genuinely absent rather than silently empty.

---

## Admin write

| Method | Route | Auth | Notes |
|---|---|---|---|
| POST | `/api/admin/set` | `inventory.edit` | Writes a whole collection. Catalogue writes go to the current branch only |
| GET | `/api/integrations` | `*` | Which payment and messaging drivers are configured |

---

## Real-time

One Socket.IO event:

```js
socket.on('sync', keys => { /* keys: ['devx-orders', ...] */ });
```

Re-read what changed. There is no per-record diffing and it does not need any.

---

## Errors

```json
{ "error": "Human-readable, shown to the user" }
```

| Code | Meaning |
|---|---|
| 400 | Bad input |
| 401 | Not signed in |
| 403 | Signed in, not allowed — message names the role or the shop |
| 404 | No such thing |
| 409 | Conflict — slot taken, wrong payment state, branch already stocked |
| 429 | Rate limited, or account locked |

Error messages are written for the person reading them, not for a log. `"You run one shop — your dashboard is the group"` beats `"insufficient scope"`.
