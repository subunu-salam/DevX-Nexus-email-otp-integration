# DevX Nexus — AI Supermarket Platform

> **New to this project? Start with [`docs/START-HERE.md`](docs/START-HERE.md).**
> It sequences everything else — architecture, the retail rules, the API, the
> runbook — and gets you running in about ten minutes.


One deployable product, three surfaces:

| URL | What it is |
|---|---|
| `/` | Customer app — AI concierge, smart budget carts, store navigation, pickup pass |
| `/admin` | Store Operations platform (CRM) — orders, pickup counter, scanner, inventory, offers, customers |
| `/store-entry-qr.html` | Printable store-entrance poster — QR auto-points to your live URL |

Everything is connected in real time through the Node server (REST API + Socket.IO push):
customer order → appears in admin instantly (with sound) · admin publishes offer / adds product /
changes price / updates order status → customer app updates and gets a notification within a second,
on any device, anywhere.

## Run locally (your MacBook)

```bash
cd devx-nexus
npm install
npm start
```

Open http://localhost:3000 (customer) and http://localhost:3000/admin in two windows.
Sign in as **Owner** with the PIN from your `.env` (`ADMIN_PIN`).

## Deploy to Render (free)

1. Push this folder to a GitHub repo:
   ```bash
   cd devx-nexus
   git init && git add -A && git commit -m "DevX Nexus v1"
   git remote add origin https://github.com/YOURNAME/devx-nexus.git
   git push -u origin main
   ```
2. On https://dashboard.render.com → **New → Web Service** → pick the repo.
   Render reads `render.yaml` automatically (build `npm install`, start `node server.js`).
   Or set them manually. Set env var **ADMIN_PIN** to your own PIN.
3. Done. Your product is live at `https://your-app.onrender.com` — see [`docs/GO-LIVE.md`](docs/GO-LIVE.md) for a custom domain, and set `DATABASE_URL` before taking real orders.
   - customers: that URL (share it / print the QR poster page)
   - staff: `…/admin`

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | server port (Render sets this automatically) |
| `ADMIN_PIN` | 1234 | protects all admin writes (server-side check) |
| `DATA_DIR` | ./data | where db.json is stored |

## Important production notes (be honest with your client)

- **Data persistence on Render free tier is ephemeral** — the JSON database resets when the
  service redeploys or restarts. For real production attach a Render Disk (persistent, paid)
  and set `DATA_DIR=/var/data`, or migrate storage to Postgres (the storage layer is isolated
  in `server.js` — load/save — so swapping it is contained).
- **Demo data**: the 47 products, prices, brands and the 6 historical orders are sample data.
  Replace them via `/admin → Inventory` (add/edit products, click an image to change it) or by
  editing `seed.json` before first deploy.
- **Payments are not integrated** — orders are cash-on-delivery/pickup style. Stripe/Telr/etc.
  is the natural next step.
- The AI concierge is a deterministic on-device engine (budget parser + scenario library +
  brand scoring). No API keys needed, works offline, fully explainable — see README-LOGIC.
- Customer identity is a per-device ID (no signup friction — right for labour customers).
  OTP/WhatsApp login can be layered on later.

## Files

```
server.js          API + Socket.IO + storage
seed.json          initial product catalog
public/index.html  customer app (works standalone too — falls back to local demo mode)
public/admin.html  store platform (same dual-mode)
public/store-entry-qr.html  printable poster
render.yaml        Render blueprint
```

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/START-HERE.md`](docs/START-HERE.md) | What the product is, and how to run it |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the code is laid out, and why it is shaped this way |
| [`docs/BUSINESS-LOGIC.md`](docs/BUSINESS-LOGIC.md) | The retail rules — weigh-then-pay, loyalty, forecasting, branches |
| [`docs/API.md`](docs/API.md) | All 52 endpoints |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Every stored collection and record shape |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | House style, testing, and good first tasks |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Deploying, monitoring, and what to do when it breaks |
| [`docs/OPENING-A-NEW-BRANCH.md`](docs/OPENING-A-NEW-BRANCH.md) | The multi-branch model, in client-facing language |
| [`docs/GO-LIVE.md`](docs/GO-LIVE.md) | VS Code setup and the custom domain |
| [`docs/HANDOVER-CHECKLIST.md`](docs/HANDOVER-CHECKLIST.md) | For DevX — what to hand over when someone new joins |

`npm run docs` checks that these still match the code.


## Post-Order Product Addition Feature
- Customer can submit extra products against an existing open order.
- Addition total must be **more than AED 15**.
- Request status: pending admin approval -> approved awaiting payment -> paid and merged, or rejected.
- Admin approves/rejects from the order drawer.
- Customer sees the approval result in My Orders and completes the additional payment before items merge into the original order.
