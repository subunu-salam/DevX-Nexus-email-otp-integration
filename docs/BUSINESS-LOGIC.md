# Business logic — the retail rules

The code is straightforward. The **rules** are not obvious, and most came out of client meetings rather than from a specification. This is the part you cannot reconstruct by reading the source.

---

## 1. Weigh-then-pay

The rule the whole product is built around.

### The problem

A shopper orders 500 g of chicken. The butcher cuts 560 g. Someone has to decide what happens to the AED 4.20 difference, and every ordinary checkout gets it wrong: charge at checkout and either the store absorbs it or the customer is billed for something they never agreed to.

### The rule

> **Money moves after the weight is known, and only with the customer's agreement.**

### How it runs

1. Shopper orders 500 g. The cart shows an **estimate**.
2. Order arrives with `payStatus: 'awaiting_weight'` — for online payment only.
3. The picker weighs it and enters **560 g** in the admin weighing station.
4. The line is repriced from the scale: `perKg × 0.560`.
5. Drift is 12%, which is outside tolerance → `payStatus: 'awaiting_approval'`, and the shopper is asked.
6. Shopper approves → `awaiting_payment`. Only now does a pay button exist.
7. Payment → `paid`.

### Tolerance

`TOLERANCE = 0.10` in `lib/payments.js`. Inside ±10%, the change is accepted automatically and the customer is not interrupted. A butcher cannot cut to the gram, and pinging a customer over 3% would make the feature hated.

### Cash and card machine never take this path

They settle at the door, where the customer sees the receipt and the scale. Their `payStatus` starts at `due_on_delivery` and the weighing station simply updates the amount owed.

> **This was a real bug.** `needsApproval` originally blocked staff from settling *any* order that drifted, including cash — which wedged an order that had already been paid for in the customer's hand. Approval is required for online payment only.

### Where it lives

`lib/payments.js` — `applyActualWeight`, `recalcOrder`, `nextAction`. Server routes `/api/orders/:id/weigh`, `/confirm`, `/pay`.

### Do not

- Collapse `status` and `payStatus` into one field.
- Charge before weighing "and refund the difference" — it is the thing the client explicitly rejected.
- Let `recalcOrder` drop the discount. It did once, and a coupon silently vanished after a reweigh.

---

## 2. Two statuses, always

| Field | Meaning | Values |
|---|---|---|
| `status` | Where the order physically is | `new` → `preparing` → `ready` (pickup) or `out` (delivery) → `done`, plus `cancelled` |
| `payStatus` | Where the money is | `awaiting_weight` → `awaiting_approval` → `awaiting_payment` → `paid`; or `due_on_delivery`; plus `refunded` |

They move independently and both are needed. A delivered cash order is `status: 'done'`, `payStatus: 'due_on_delivery'` until someone records the cash.

---

## 3. Loyalty intelligence

### The idea

The supermarket already knows what every card-holder spends at the till. Join that to the app account on the **mobile number** and you can see a customer drifting away before they have gone.

### Detecting a decline

Someone who spent AED 1,400 a month for six months and AED 1,000 last month is drifting. The system spots it and issues a personal coupon.

**The baseline is a median, not a mean.** One Ramadan spike would pull an average up and hide a genuine decline for months.

### What the coupon is for

Ranked in this order, in `LOY.offerCandidates`:

1. **Something they buy repeatedly** — highest weight. A coupon for something they have never bought is a discount, not a reason to return.
2. **Basket affinity** — bought alongside their regulars.
3. **Their categories** — weakest signal.

Stock the store wants cleared is a **multiplier on that ranking, never the ranking itself.** Otherwise it becomes "here is our surplus", which is exactly what makes retail coupons ignored.

> The client's words: *"it should be based on whatever the product he usually purchases."*

### Where it lives

`lib/loyalty.js`. Admin: Loyalty & Offers. Shopper: My Offers.

> **Reporting bug worth remembering.** "Revenue recovered" once summed the discount given — reporting the campaign's *cost* under a label promising its return.

---

## 4. ForecastAI — five modules

In `lib/forecast.js`. The client's brief was blunt: *"This is not just showing them a report — we should generate something out of it."* Every module must end in a decision with money attached.

| Module | Question | Output |
|---|---|---|
| Sales Forecasting | What will sell? | Per-SKU demand with a confidence band |
| AI Demand Engine | What do we buy? | `PO = Forecast + Safety − Stock` |
| Inventory Optimization | What is wrong today? | ABC-XYZ, prioritised actions with AED impact |
| Financial Forecast | What does it earn? | Revenue, margin, cash flow, bottom-up from the same per-SKU model |
| Warehouse Planner | Where does it go? | Category zones by floor area, with SKUs to reorder into freed space |

### The UAE calendar

Not decoration — it is the difference between a forecast a UAE buyer trusts and one they don't:

| Event | Uplift |
|---|---|
| Ramadan | +43% FMCG |
| Eid | +25% |
| Dubai Shopping Festival | +20% |
| Summer | +15% |
| National Day | +12% |

### Four bugs to know about, because each looks like a feature

**Out-of-stock items graded C.** Classification ran on past sales — but an item with no stock *cannot* have sold, so every stockout fell to the bottom and disappeared. Now graded by forecast demand.

**Optimization capped actions before sorting.** It took the first 20, and overstock filled every slot, so no P1 stockout ever surfaced. Now: collect all, sort, then take the top N per tier.

**Thin app history dragged forecasts down.** A line with three lumpy app orders forecast *fewer* units than one with none. App orders are now a **floor** on demand, not a ceiling — the app sees a fraction of what the till sees.

**Over-capacity zones told to order more.** Now suppressed.

### Warehouse planning is by category, not aisle

The client rejected "Aisle 7": *"We already have the map of the stores — divide based on their categories, locations, then how much space is allocated."* Zones are category areas in square metres × storage density, editable per branch.

Reorder recommendations rank on **real till movement only**. An earlier version produced *"selling 0 in 30 days — order 13 more"*, which is self-contradictory and destroys trust in every other number on the page.

---

## 5. Branches

Full treatment in [`OPENING-A-NEW-BRANCH.md`](OPENING-A-NEW-BRANCH.md) — that one is written for clients, and it is what DevX says in sales meetings, so keep it accurate.

The rules:

- **Per branch:** products, stock, prices, shelf map, floor plan, delivery windows, orders, forecasts, staff.
- **Chain-wide:** customers, loyalty history, the owner account.
- **A new branch opens empty.** Nothing is inherited unless someone asks.
- **Copying resets stock to zero and clears shelf locations.** A new shop has received nothing, and a shelf belongs to a building.
- **Product ids are allocated chain-wide**, so an order line is never ambiguous about which product it means.
- **Different companies get different deployments.** Never two clients on one database.

---

## 6. Honesty rules

These are product rules, not style preferences. They exist because breaking them ends a client relationship.

**Never fabricate data for a real shop.** A branch a client created shows only their own data. The demo loyalty book belongs to the seeded demo branch alone — one that was created through the panel gets an empty book and an honest empty state.

> This was live. A new branch was being served the demo shop's loyalty export: invented customers with invented spend, on the client's own screen.

**Never report a number you cannot support.** An empty catalogue scores *no* stock health, not 100/100. A shop that has never traded shows "—", not "AED 0". A dash means no data; a zero is a claim.

**Say what a mock is.** `PAYMENT_DRIVER=mock` responses state that nothing was charged.

**Skipped rows are reported.** The CSV importer lists what it dropped and why. A silent import that loses half a file is worse than a failed one.

---

## 7. Numbers that must stay consistent

Used in the product, the pitch deck and the posters. Change them everywhere or nowhere — `test/audit.js` checks this.

| | |
|---|---|
| Catalogue scale | **"1 lakh+ products"** — never "96,000" in client-facing material |
| Weight tolerance | ±10% |
| Pre-auth buffer | 120% of estimate |
| Low-stock threshold | 8 units |
| Stale order | 2 hours |
| Delivery fee | AED 10 |

---

*Next: [`API.md`](API.md).*
