# Opening a new shop on DevX Nexus

*How the multi-branch model works, what each customer gets, and the steps to take a second shop live.*

---

## 1. The question you asked

> *If we implement this for a second branch, do we give them a different login for the CRM? Do we set their whole system up again?*

**No.** One supermarket group = **one system, one URL, one login page**. Branches live inside it.

A **second supermarket company** is different — that is a second deployment. The dividing line:

| Situation | What you give them |
|---|---|
| Madina Supermarket opens Branch 2, 3, 4 | **The same system.** Add the branch inside the panel. Same URL, same login page, new staff accounts pinned to the new shop. |
| A different company — say Al Manama Hypermarket | **A separate deployment.** Their own URL, their own database, their own owner account. Nothing is shared with Madina. |

The reason is not technical convenience, it is commercial. Two branches of one group **should** share a loyalty book — a customer who shops at Deira on Monday and Al Nahda on Friday is one customer, and their spend decline should be detected across both. Two different companies must **never** share anything: not products, not customers, not prices. A field on a record separates branches; only a separate database separates companies.

---

## 2. What is shared, and what is not

Inside one group:

| Per branch — separate | Chain-wide — shared |
|---|---|
| Product list | Customer accounts and mobile numbers |
| Stock levels | Loyalty history and spend baseline |
| Prices and promotions | Staff **roles** (what a Picker can do) |
| Shelf locations | The owner account |
| Floor plan and zone areas | Your branding and settings |
| Delivery and pickup windows | |
| Orders and the picking queue | |
| Forecasts, reorders, space plan | |
| Staff accounts | |

So: **Branch 2 opens genuinely blank.** No products, no stock, its own floor plan. Nothing is inherited unless someone asks for it.

---

## 3. Logins — who gets what

There is **one login page** for the whole group. Everyone signs in with a **name and a PIN**.

- **Owner** — sees every shop, switches between them from the sidebar, is the only person who can open a new branch or manage staff.
- **Manager, Picker, Cashier, Buyer** — pinned to **one shop**. A Deira picker signs in and sees Deira's queue and Deira's 1,043 products. They cannot see Al Nahda's orders and cannot edit its product list, even though they have the same job title.

So for Branch 2 you do **not** create a new system — you create **new staff accounts** on the existing one, with the new shop selected.

> Tested: a manager pinned to Al Nahda who tries to import a product file into Karama gets `403 — You can only change your own shop`, and Karama's list is untouched.

---

## 4. Opening Branch 2 — the steps

### Step 1 — Add the shop *(Owner only, 30 seconds)*

**Branches → Open a new shop.** Enter the name, the area, the city. It appears immediately with **0 products**.

### Step 2 — Put the products in *(the only real work)*

**Branches → Stock the shelves.** Three ways:

**a) Import their product file — best for a shop that already trades**

Export a CSV from whatever POS they run and upload it. Column names are matched loosely — `Product Name`, `Item`, `Description`, `Qty`, `Quantity`, `Shelf`, `Per Kg` all work, in any order. A row needs a name and **either** a unit price **or** a per-kg rate, so loose produce and meat come through correctly.

Anything skipped is listed with the reason. Nothing is dropped silently.

**b) Copy a sister branch — best for a new shop in the same group**

Pick the branch to copy from. The product list comes across; **stock resets to zero** and **shelf locations are cleared**, because the new shop has received nothing yet and its shelves are its own building. Prices and stock are then set per shop.

**c) Type them in** — Inventory → Add product. Fine for a small shop, not for a thousand lines.

> Not sure of the format? **Download a blank template** on the same screen and fill it in.

### Step 3 — Set stock and prices

**Inventory**, while working in that shop. Prices are per branch — Deira and Al Nahda can charge differently for the same item.

### Step 4 — Draw the floor plan

**Warehouse Planner → edit the square metres per category.** This shop's space plan, reorder recommendations and financial forecast all run off these numbers. Until they are set, the space advice is generic.

### Step 5 — Add the team

**Staff & Roles.** Name, role, **shop**, PIN. Everyone except the owner is pinned to the shop you pick.

### Step 6 — Give shoppers the link

Each shop has its own storefront link:

```
https://your-domain.com/?branch=br-al-nahda-x7k
```

The exact link is shown at the bottom of the **Stock the shelves** panel. Put it on **that branch's WhatsApp number** — exactly as you described. The link identifies the shop, is remembered on the customer's phone, and every order, slot and price then comes from that shop.

---

## 5. What Branch 2 gets on day one

Once the products are in, the new shop has the full platform: AI concierge, weigh-then-pay, loyalty and personalised offers, the five ForecastAI modules, the warehouse planner. Nothing is a cut-down version.

Two things need **real trading history** before they are meaningful, and this is worth saying to the customer up front rather than being asked later:

- **Forecasts and reorder advice** improve over roughly 4–8 weeks of sales. In the meantime they run off the seeded UAE seasonal calendar.
- **Loyalty spend-decline detection** needs a baseline. If their POS loyalty data is imported for that branch, it works from day one; otherwise it starts once customers have shopped a few times.

---

## 6. Selling a second *company*

For a different supermarket group, deploy a second copy:

1. New Render service from the same repository.
2. Its **own** `DATABASE_URL` — this is the wall between companies. **Never point two customers at one database.**
3. Its own `ADMIN_PIN`, its own Groq key or a shared one with its own budget, its own branding.
4. Their owner signs in and follows section 4 for their first shop.

Commercially this is the cleaner story anyway: each customer's data lives on their own instance, which is the first question a serious buyer asks.

---

## 7. The short version, for a sales conversation

> *"You get one system for the whole group. Head office sees every branch and switches between them; branch staff sign in and see only their own shop. Opening a new branch takes a few minutes — add the shop, upload their product file or copy a sister branch, set the floor plan, add the team, and share that branch's link on its WhatsApp number. Customers stay one customer across the group, so their loyalty and their offers follow them from Deira to Al Nahda."*

---

*DevX Technologies LLC · Dubai · devxpert.ae · +971 54 749 7336*
