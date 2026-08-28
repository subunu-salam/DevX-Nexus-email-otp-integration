# Runbook

Operating the live system: deploying, watching it, and what to do when something is wrong.

---

## Environments

| | Where | Data |
|---|---|---|
| Local | `localhost:3000` | `data/db.json` |
| Local scratch | `localhost:3100` (VS Code profile) | `.scratch/`, throwaway |
| Production | Render → `nexus.devxpert.ae` | Postgres |

---

## Deploying

Push to the main branch. Render builds and restarts automatically.

```bash
npm run test:all      # green first
git push
```

Then **read the deploy log**. Two lines matter:

```
[nexus] storage: postgres            ← must NOT say EPHEMERAL
[nexus] DevX Nexus running →  …
```

A restart signs every staff member out, because sessions are in memory. Deploy outside the shop's busy hours.

---

## Environment variables

Full list with comments in `.env.example`. In production, set these in the Render dashboard — **not** in `render.yaml`, where a value would be committed to the repo and would override the dashboard.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes, in production** | Without it everything is wiped on every deploy |
| `ADMIN_PIN` | **yes** | Never leave it at `1234` |
| `GROQ_API_KEY` | for the AI | Everything else works without it |
| `OPENAI_API_KEY` | no | Fallback if Groq is absent |
| `AI_DAILY_LIMIT` | no | Default 4000 assistant calls a day |
| `VOICE_DAILY_LIMIT` | no | Default 600. Tighter — billed per second of audio |
| `PAYMENT_DRIVER` | no | `mock` (default) · `telr` · `ngenius` · `stripe` |
| `MESSAGING_DRIVER` | no | `mock` (default) · `whatsapp` · `twilio` |
| `SENTRY_DSN` | no | Errors are captured either way and served at `/api/errors` |
| `RATE_LIMIT_OFF` | **never in production** | Test-only |

---

## Health

```bash
curl -s https://nexus.devxpert.ae/api/health | jq
```

| Field | Watch for |
|---|---|
| `storage.driver` | `postgres`. `file` in production is an incident |
| `ai.concierge.used / limit` | Near the ceiling means the assistant is about to stop answering |
| `memory.rss` | ~278 MB with 96k SKUs is normal |
| `uptime` | Resetting repeatedly means it is crash-looping |

`GET /api/errors` (owner) gives the recent captured errors.

---

## Things that go wrong

### "All our data disappeared"

**Cause:** almost certainly `DATABASE_URL` is unset and Render recycled the container.

**Check:** deploy log for `EPHEMERAL`, or `/api/health` → `storage.driver`.

**Fix:** create a Render Postgres instance, set `DATABASE_URL`, redeploy. **Data already lost is gone** — the filesystem it was on no longer exists. This is why it is the first item on the go-live checklist.

### "I can't sign in"

- Five wrong PINs locks the account for **fifteen minutes**. Wait, or have an owner reset the PIN.
- A deploy signs everyone out — sessions are in memory. Sign in again.
- Last resort: the `ADMIN_PIN` fallback. It shows as `Shared PIN` in the audit log.

### "The AI stopped answering"

- Daily ceiling reached → `/api/health` → `ai.concierge`. Raise `AI_DAILY_LIMIT` or wait for the reset.
- Rate limit → the shopper is over 12 requests a minute.
- Missing or wrong `GROQ_API_KEY`. Keys start `gsk_`.

Everything except the assistant keeps working — this is not an outage.

### "A shop shows no products"

Expected for a new branch. Open **Branches → Stock the shelves**. If it is a branch that *did* have products, check the branch switcher — you are probably in the wrong shop.

### "A customer can't see their orders"

They are on a different device and not signed in. Order history follows the **mobile number**, not the browser. Have them use Account → sign in with their number. Staff can read the code out at the counter via `/api/customer/codes`.

### "An order is stuck and won't move"

Look at both statuses. `payStatus: 'awaiting_approval'` means the customer has not accepted a weight change — staff cannot advance it for them. That is the design, not a fault. Cash and card-machine orders never enter that state.

### "The panel is slow to load"

Check the bootstrap size:

```bash
curl -s -H "x-admin-pin: PIN" https://nexus.devxpert.ae/api/state | wc -c
```

Should be a few kilobytes. If it is hundreds of kilobytes, something was added to `KEYS` and is now shipping to every browser. That has happened three times.

---

## Routine

**Weekly** — check `/api/health`, skim the audit log for anything odd, confirm the AI budget is not being drained.

**Monthly** — confirm Postgres has a recent backup, review staff accounts and disable anyone who has left, check catalogue size against memory.

**Before a client demo** — `npm run test:all`, confirm the demo branch still has its data, and make sure you are demonstrating the right branch. Do not present the mock payment driver as a live payment.

---

## Adding a new client

1. Separate Render service, **its own** `DATABASE_URL`, its own `ADMIN_PIN`.
2. Never point two clients at one database.
3. Their first shop, then their staff — [`OPENING-A-NEW-BRANCH.md`](OPENING-A-NEW-BRANCH.md).
4. Branch links onto their WhatsApp numbers.

Branches of one chain go inside one deployment. Different companies do not.

---

## Backups

Render Postgres has automated backups on paid plans. On the free plan there are none — export manually before anything significant:

```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F).sql
```

Before a client's first real trading day, move them to a paid plan. Explaining a free-tier backup policy after losing a day of orders is not a conversation worth having.
