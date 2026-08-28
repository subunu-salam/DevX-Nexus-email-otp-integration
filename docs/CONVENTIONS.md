# Conventions and how to work on this

House style, testing, and the rules that keep the product trustworthy.

---

## Comments explain *why*

The single most important convention here. Every `lib/` file opens with a block explaining the problem it solves and what went wrong before it existed.

```js
/* Out-of-stock lines were graded from past sales — but an item with no stock
   cannot have sold, so every stockout fell to class C and vanished from the
   report that exists to surface them. Graded from forecast demand instead. */
```

Not this:

```js
// grade by forecast demand
```

The code says *what*. Anyone can read that. What they cannot recover is why it isn't the obvious thing — and without it, someone eventually "simplifies" it back into the bug.

When you fix something subtle, leave the reason behind.

---

## Style

- 2-space indent, single quotes, semicolons.
- Small named functions over comments explaining a long one.
- Guard clauses; return early.
- Defensive reads: `(o.items || [])`, `p.stock || 0`. There is no schema.
- **Never** interpolate data into HTML without `esc()` — see below.

There is no Prettier or ESLint config, and format-on-save is off in `.vscode/settings.json`. The code is hand-formatted with aligned comment blocks; a formatter would rewrite thousands of lines on your first save and make every future diff unreadable. Match the surrounding style by hand.

---

## Security rules

Not negotiable. Each of these is here because it broke.

**Escape everything rendered into HTML.**

```js
el.innerHTML = `<div>${esc(p.name)}</div>`;
```

A product name once reached an `onclick` handler as raw text — a stored XSS with the product catalogue as the injection point. `test/audit.js` scans for unescaped interpolation.

**Check ownership on anything that touches an order.** Ids are sequential and guessable. `ownsOrder()` exists for this.

**Check the branch on anything that writes to a branch.** `ownsBranch()`. Permission to edit inventory is not permission to rewrite a sister shop's catalogue.

**Never send `salt` or `hash` to a client.** `STAFF.publicUser()` always.

**Watch what you add to `KEYS`.** `fullState()` copies declared collections to the browser. That is how the whole catalogue, then every branch's catalogue, then every staff PIN hash, then the entire audit log each ended up in a bootstrap payload. Adding a key means checking what now ships.

---

## Honesty rules

Product rules, not preferences. See [`BUSINESS-LOGIC.md`](BUSINESS-LOGIC.md) §7.

- No invented data for a real shop. Ever.
- No score you cannot support — `null` and "—", never a confident default.
- Say when something is a mock.
- Report what was skipped and why.

If a screen looks empty and you are tempted to fill it with something plausible, that is exactly the moment the rule exists for.

---

## Testing

```bash
npm run test:all      # everything — run this before every commit
npm test              # behaviour (test/run.js) — ~176 assertions
npm run audit         # static checks on the front-ends (test/audit.js)
npm run flow          # one full customer journey (test/flow.js)
```

Three layers, because they catch different things:

**`test/run.js`** boots a real server on a scratch data directory and exercises the API. No mocks — the same code paths production uses.

**`test/audit.js`** reads the two HTML files as text and finds the class of bug no API test can: an `onclick` calling a function that does not exist, a `fetch` to a route the server does not serve, an `await fetch` with no error path, unescaped interpolation.

**`test/flow.js`** walks one order from browse to delivery and asserts the story holds together.

### Writing a test

Every test in `run.js` corresponds to something that actually broke. Name it after the bug, so the next person knows what they are protecting:

```js
group('Payment method — regression: cash orders recorded as online');
```

Two rules learned the hard way:

**Do not depend on the clock.** A test asked for the "6–8 PM" delivery window by name; it passed all day and failed every evening once that window had passed. Ask the server what is available and take one.

**Assert the value, not just the status code.** A test that checks `200` would have missed an area manager silently collapsing to a single shop. Assert the count.

---

## Git

Subject line in the imperative, then a body explaining **why**. Look at `git log` — the history is genuinely useful here, and worth keeping that way.

```
Group Overview: the owner of a chain gets one page, not forty dashboards

Switching into an empty branch showed AED 0 for the whole business. The
number was right and useless — every screen answers "how is this shop?",
which is a manager's question, not an owner's.
```

Never commit `.env`. It is gitignored; keep it that way.

---

## Adding a feature — the path

1. **Understand the retail rule first.** If it is not in `BUSINESS-LOGIC.md`, ask. Do not infer a rule from the code — the code may be the bug.
2. **Server first.** Route + logic in `lib/`, guarded with `need()`.
3. **Test it** in `test/run.js`, before touching the UI.
4. **Then the UI.** Escape everything, give every fetch an error path.
5. **`npm run test:all`.**
6. **Check the empty case.** Open the screen on a branch with no products. If it shows a confident zero, it is not finished.
7. **Check it as a picker,** not just as an owner.

---

## Good first tasks

Ordered so you touch one layer at a time, and none can break the payment flow.

**1 — Read the failing case.** Create a branch, add nothing, and visit every admin screen. Write down every place that still shows a misleading number. Fix one. *(Teaches: branch scoping, empty states, the honesty rules.)*

**2 — Add a column to the group league table.** Stock value per shop is already computed in `lib/rollup.js` and not displayed. *(Teaches: the roll-up, sorting, the table renderer.)*

**3 — Make the audit log exportable as CSV.** New route behind `audit.view`, a button in the admin panel. *(Teaches: permissions, branch scoping, file responses.)*

**4 — Add a sixth delivery window.** In `lib/slots.js`, with capacity. Prove it cannot be overbooked. *(Teaches: server-side capacity, concurrency, time-independent testing.)*

**5 — Handle a real POS export.** Ask for a genuine CSV from a client and make the importer read it without editing the file. *(Teaches: the importer, forgiving parsing, reporting what was skipped.)*

Do not begin by splitting `index.html` into components, adding a build step, or introducing TypeScript. All three are defensible eventually and all three will stop you learning the product for a fortnight.

---

## When you are stuck

1. `GET /api/health` — storage driver, AI budget, memory.
2. The deploy log. `EPHEMERAL` explains a whole class of "my data vanished".
3. The audit log — who did what, and when.
4. `npm run test:all` — if it is red, fix that first; do not debug on a broken baseline.
5. Ask. The retail rules here came out of client meetings and are not deducible from the source.
