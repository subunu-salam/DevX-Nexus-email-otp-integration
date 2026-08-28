# DevX Nexus — start here

Welcome. You are taking over a live product, not a tutorial project. Real supermarkets are being pitched this, and one of them will be running their shop on it.

This page is your map. Read it fully before opening any other file — it should take about fifteen minutes, and it will save you a week.

---

## 1. What this product actually is

A UAE supermarket has a problem that looks small and isn't: **a customer orders 500 g of chicken, the butcher cuts 560 g.** Who decides the price, and when does the money move?

Every ordinary e-commerce platform charges at checkout, which means either the store eats the difference or the customer is charged for something they never agreed to. DevX Nexus is built around solving that properly — and everything else grew from it.

Three things ship in one Node process:

| URL | Who uses it | What it is |
|---|---|---|
| `/` | Shoppers | AI concierge, catalogue, cart, weigh-then-pay, order tracking |
| `/admin` | Store staff | Orders, picking, the weighing station, inventory, offers, loyalty, forecasting, branches |
| `/store-entry-qr.html` | Printed poster | QR code for the shop entrance |

Sold to supermarkets by **DevX Technologies LLC**, Dubai.

---

## 2. Read these in this order

| # | Document | What it answers |
|---|---|---|
| 1 | **This page** | What the product is and how to run it |
| 2 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the code is laid out and why it is shaped this way |
| 3 | [`BUSINESS-LOGIC.md`](BUSINESS-LOGIC.md) | The retail rules — weigh-then-pay, loyalty, forecasting, branches |
| 4 | [`API.md`](API.md) | Every endpoint, what it needs, what it returns |
| 5 | [`DATA-MODEL.md`](DATA-MODEL.md) | Every stored collection and record shape |
| 6 | [`CONVENTIONS.md`](CONVENTIONS.md) | How to write code that fits, and how to test it |
| 7 | [`RUNBOOK.md`](RUNBOOK.md) | Deploying, monitoring, and what to do when it breaks |
| 8 | [`OPENING-A-NEW-BRANCH.md`](OPENING-A-NEW-BRANCH.md) | The multi-branch model, in the words we use with clients |
| 9 | [`GO-LIVE.md`](GO-LIVE.md) | VS Code setup and the custom domain |

There is one more, for whoever is handing the project to you: [`HANDOVER-CHECKLIST.md`](HANDOVER-CHECKLIST.md).

---

## 3. Get it running (about 10 minutes)

You need **Node 18 or newer**. Check with `node -v`.

```bash
cd devx-nexus
npm install
cp .env.example .env
```

Open `.env` and set one value:

```
GROQ_API_KEY=gsk_...
```

Get a free key at [console.groq.com](https://console.groq.com). Without it the app still runs — the catalogue, orders, weighing, admin panel and every forecast work fine — but the AI concierge will not answer. Everything else is local computation.

```bash
npm start
```

- Shopper app → http://localhost:3000
- Admin panel → http://localhost:3000/admin — sign in as **Owner** with the PIN from your `.env` (`ADMIN_PIN`, `1234` by default locally)

In VS Code, press **F5** instead and you get breakpoints.

### Prove it works end to end

Run this before you change anything, so you know the baseline is green:

```bash
npm run test:all
```

You should see roughly **176 passed**, a static audit with 18 clean checks, and *"the full journey completed with nothing broken"*. If that is not what you see, stop and fix the environment before writing code — do not start debugging your own change on top of a broken baseline.

---

## 4. Your first hour, hands on

Do this in the browser. It is the fastest way to understand the product.

1. **Order something loose.** On the shopper app, add a per-kg item (tomatoes, chicken) and something normal, choose **Online payment**, and place the order.
2. **Watch it arrive.** In the admin panel it appears within a second, with a sound. That is Socket.IO, not polling.
3. **Weigh it.** Open the order, enter an actual weight about 12% above what was ordered, save.
4. **Watch the shopper app.** It now asks the customer to approve the new weight and price. Nothing has been charged.
5. **Approve as the customer, then pay.** Only now does the payment step appear.
6. **Try to cheat it.** Go back to step 3 and enter a weight within 5%. It auto-accepts with no customer approval — that is the ±10% tolerance.

You have now seen the core of the product. Everything else — forecasting, loyalty, branches — is built on top of that order record.

---

## 5. How to find your way around

```
server.js          all HTTP routes and the wiring between them (~2,300 lines)
lib/               one file per subject; each starts with a comment
                   explaining WHY it exists
public/index.html  the entire shopper app (~3,300 lines, single file)
public/admin.html  the entire admin panel (~3,000 lines, single file)
test/              run.js (behaviour) · audit.js (static) · flow.js (journey)
docs/              you are here
data/              the local database, generated — never edit by hand
```

**The comments are the documentation.** Every `lib/` file opens with a block explaining the problem it solves and, usually, what went wrong before it existed. Read those blocks before the code underneath them — they were written for you.

Yes, the two front-ends are single large HTML files. That is a deliberate choice, explained in `ARCHITECTURE.md`. Don't start by splitting them up.

---

## 6. Things that will confuse you (they confused us)

**Two statuses per order, on purpose.** `status` is where the order is physically (`new` → `preparing` → `ready`/`out` → `done`). `payStatus` is where the money is (`awaiting_weight` → `awaiting_approval` → `awaiting_payment` → `paid`). They move independently. A cash order can be delivered while `payStatus` is still `due_on_delivery`. Collapsing these into one field is the single most tempting mistake in this codebase and it breaks weigh-then-pay immediately.

**Money is decided by the scale, not the cart.** For loose items the cart price is an estimate. The real price comes from the weight a picker enters.

**Branches are separate, customers are shared.** Two branches of one chain have their own products, stock, prices, floor plans and staff — but one customer book, because someone who shops in Deira on Monday and Al Nahda on Friday is one person. Two different *companies* share nothing at all and get separate deployments.

**Nothing is fabricated for a real shop.** A branch a client created shows only their own data. There is a demo loyalty book, and it belongs to the seeded demo branch alone. If you ever find yourself writing a plausible-looking default so a screen isn't empty, stop — see `CONVENTIONS.md`.

**Permissions are enforced on the server.** Hiding a menu item is presentation, not security. Every admin route sits behind `need('some.permission')`.

---

## 7. Where to start contributing

Pick from `CONVENTIONS.md` → *Good first tasks*. They are chosen so you touch one layer at a time and cannot break the payment flow while you are learning.

Ask early. A question that costs ten minutes is cheaper than a day spent guessing at retail rules that took a client meeting to establish.

---

*DevX Technologies LLC · Dubai · devxpert.ae · +971 54 749 7336*
