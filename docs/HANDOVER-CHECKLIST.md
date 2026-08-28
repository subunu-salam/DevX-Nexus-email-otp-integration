# Handover checklist

For **DevX**, not for the intern. This is what you actually have to hand over, in what order, and what you should not hand over at all.

Print it. Tick it. An incomplete handover is discovered on day four, when she is blocked and you are in a client meeting.

---

## Before day one

### Accounts to create or grant

| # | Item | Where | Notes |
|---|---|---|---|
| 1 | GitHub access to the repo | github.com | **Write access, not owner.** Invite her personal or a company account |
| 2 | Her own Groq API key | console.groq.com | **Do not share yours.** Free tier is plenty. A separate key means her testing cannot exhaust production's budget |
| 3 | Render access | render.com | Start **read-only**. Promote once she has shipped a few changes |
| 4 | A company email | devxpert.ae | For client-facing anything |
| 5 | Her own admin account in the panel | `/admin` → Staff & Roles | Named account with role **owner** on the demo deployment. Never share the PIN-only login |

### What to hand over physically

| # | Item |
|---|---|
| 6 | The repository — she clones it, no zip files |
| 7 | This `docs/` folder — it is in the repo, so this is automatic |
| 8 | The client videos, if you keep them — most retail rules came from them |
| 9 | The pitch deck, one-pager and posters (`pitch/`) so she knows what has been promised |
| 10 | The client contact list, and **who is allowed to contact them** |

### What NOT to hand over

- **Your `.env` file.** She creates her own from `.env.example`.
- **The production `DATABASE_URL`.** No intern needs write access to a client's live data on day one.
- **Payment gateway credentials.** Telr, N-Genius or Stripe keys move money.
- **The production `ADMIN_PIN`.** She gets a named account.
- **Client WhatsApp numbers** until she has a reason to use them.

None of this is about trust. It is that the fastest way to lose a client is an accident on a live database in week one, and the fastest way to protect a new joiner is to make that accident impossible.

---

## Day one — sit with her

Do these together. Two hours, and it replaces a fortnight of guessing.

- [ ] **Tell her what the product is for.** Not the code — the supermarket, the 500 g of chicken that becomes 560 g, and why nothing else on the market handles it.
- [ ] **Get it running on her machine.** `docs/START-HERE.md` §3. Do not let her leave without a green `npm run test:all`.
- [ ] **Do the first-hour walkthrough with her** (`START-HERE.md` §4) — place a loose order, weigh it, watch the customer get asked to approve.
- [ ] **Show her the admin panel as a picker,** then as an owner. The difference is the permission model, in one minute.
- [ ] **Show her the Branches screen** and open a shop live. She will need to demo this.
- [ ] **Walk the `git log`.** The commit messages explain most of the why.
- [ ] **Say plainly what she must not touch alone:** production data, payment drivers, client communication.

---

## First week — reading, in order

She works through `docs/START-HERE.md`, which sequences the rest. Expect it to take three to four days alongside a first small task.

- [ ] `START-HERE.md`
- [ ] `ARCHITECTURE.md`
- [ ] `BUSINESS-LOGIC.md` — the one to discuss with her, because it is not deducible from the code
- [ ] `API.md`, `DATA-MODEL.md` — reference, skim then return to
- [ ] `CONVENTIONS.md` — including *Good first tasks*
- [ ] `RUNBOOK.md`
- [ ] `OPENING-A-NEW-BRANCH.md` — client-facing; she should be able to deliver this verbally

Her first task comes from `CONVENTIONS.md` → *Good first tasks*. They are ordered so she touches one layer at a time and cannot break the payment flow while learning.

---

## Things she will not learn from the code

Tell her these out loud. They are the expensive parts.

**The client rejected charging up front and refunding the difference.** If she "simplifies" the payment flow, she will rebuild exactly what was rejected. It is the product.

**Offers must be for what the customer already buys.** Not what the store wants cleared. Clearance is a multiplier, never the ranking.

**"1 lakh+ products", never "96,000"** in anything a client sees.

**The forecasting numbers are checked by people who know UAE retail.** A wrong-looking number costs more credibility than a missing feature.

**A picker must never see the loyalty book or the audit log.** Supermarket staff turnover is high and the store manager will ask about this.

---

## State of the project, honestly

Give her the real picture rather than letting her find it.

**Done and tested:** weigh-then-pay · loyalty intelligence · five ForecastAI modules · multi-branch with per-branch catalogues · roles and audit · group roll-up · shopper accounts · delivery slots and refunds · rate limiting and AI spend ceiling · 176 automated tests.

**Built but not connected to anything real:** payment gateways (mock driver — records intent, charges nothing) · WhatsApp and SMS messaging (mock) · the supermarket loyalty API (demo export until a client connects theirs).

**Known limits:** one process, so no horizontal scaling · one company per deployment · sessions lost on restart · the free Render tier wipes data without `DATABASE_URL`.

**Outstanding before the first real client:**

- [ ] `DATABASE_URL` on Render — **most urgent, storage still logs `EPHEMERAL`**
- [ ] Change `ADMIN_PIN` from `1234`
- [ ] Custom domain (`GO-LIVE.md`)
- [ ] Real payment gateway credentials when a client signs
- [ ] Move off the free Postgres plan before a client's first trading day — no backups on free

---

## Two weeks in — check these

Not "is she busy". These:

- [ ] Can she explain weigh-then-pay to someone else, without notes?
- [ ] Has she shipped a change with a test, unaided?
- [ ] Did she catch an empty-state or permission problem you had not spotted?
- [ ] Does she ask when a retail rule is unclear, rather than inventing one?

The fourth matters most. A developer who invents a plausible business rule and ships it is how a client discovers that the software quietly decided something on their behalf.

---

*DevX Technologies LLC · Dubai · devxpert.ae · +971 54 749 7336*
