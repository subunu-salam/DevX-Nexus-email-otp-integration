# Moving to VS Code, and going live on nexus.devxpert.ae

Two separate jobs. Part 1 takes about ten minutes and nothing can break. Part 2 changes what the public sees, so it has a checklist and an order.

---

# Part 1 — VS Code

## The short version

**There is nothing to transfer.** The project is already a normal folder on your Mac with git history in it. VS Code is just a different window onto the same files — it is not a new home the project has to be moved into.

```bash
# install the `code` command once: open VS Code → Cmd+Shift+P → "Shell Command: Install 'code' command in PATH"
cd ~/Desktop/devx-nexus
code .
```

That's the whole migration. Same folder, same git history, same commits.

## What I added so it behaves properly

A `.vscode/` folder, committed so any machine that opens the project gets the same setup:

| File | Why |
|---|---|
| `settings.json` | Excludes `node_modules` and `data/` from search, and makes `data/` **read-only in the editor** so a stray keystroke can't corrupt live orders |
| `launch.json` | Press **F5** to run the server with the debugger attached — real breakpoints instead of `console.log` |
| `tasks.json` | **Cmd+Shift+P → Run Task** → start the server, run all tests, or free port 3000 |
| `extensions.json` | Four suggestions, and one deliberately marked *unwanted* — see below |

**Format-on-save is switched off on purpose.** There is no Prettier or ESLint config in this repo and the code is hand-formatted with aligned comment blocks. Turning on a formatter would rewrite thousands of lines the first time anyone saved a file, and every future diff would be unreadable. That's also why Prettier is in `unwantedRecommendations` — VS Code will stop suggesting it.

## Day-to-day

| Do this | How |
|---|---|
| Run the app | **F5**, or Terminal → `npm start` |
| Run it without touching real data | F5 → pick **Run DevX Nexus (scratch data)** — port 3100, throwaway database |
| Run all tests | Cmd+Shift+P → Run Task → **Run all tests** |
| "Port 3000 already in use" | Run Task → **Free port 3000** |
| Commit | Source Control icon in the left bar — stage, write a message, Commit, then Sync |

The built-in terminal (**Ctrl+`**) is the same shell you've been using. Nothing you already know stops working.

## One thing to check

Your `.env` file holds the real Groq key and is correctly gitignored — it will **not** travel with the repo, and it shouldn't. If you ever open this project on another machine, copy `.env.example` to `.env` and fill it in there.

---

# Part 2 — nexus.devxpert.ae

## First: find who runs your DNS

You weren't sure, so here's the two-minute way. In Terminal:

```bash
whois devxpert.ae | grep -i "name server"
```

Read the answer:

| What comes back | Who runs your DNS |
|---|---|
| `ns1.godaddy.com` / `domaincontrol.com` | GoDaddy |
| anything ending `.ns.cloudflare.com` | Cloudflare |
| `dns1.registrar-servers.com` | Namecheap |
| `ns-xxx.awsdns-xx.com` | AWS Route 53 |
| something with your web host's name | Whoever built devxpert.ae — ask them |

You need the **login for that account**, not the registrar you bought from — they're often different companies.

## The order matters

Do these in sequence. Steps 1 and 2 are not optional; skipping them means your first real client loses their data or gets a store running on PIN 1234.

### Step 1 — Postgres, before anything else

Right now your live site logs `EPHEMERAL`. Every order, branch, staff account and loyalty record is **wiped on every deploy and on Render's daily container recycle**. A client would add a hundred products on Monday and find them gone on Tuesday.

1. Render dashboard → **New → Postgres** → free plan → same region as the web service
2. Open the new database → copy the **Internal Database URL**
3. Web service → **Environment** → add `DATABASE_URL` = that URL → Save

On the next deploy the log should say `storage: postgres` instead of `EPHEMERAL`. **Check this line.** If it still says file, the URL didn't take.

### Step 2 — Change the admin PIN

`1234` is in the public repo and on the live site.

Render → Environment → set `ADMIN_PIN` to something real → Save.

I removed the hardcoded `"1234"` from `render.yaml` in this commit. It was overriding whatever you set in the dashboard, which is exactly how a default PIN reaches production without anyone noticing.

Then in the panel: **Staff & Roles** → create a named owner account for yourself and use that. The PIN-only login is a fallback, and it leaves `Shared PIN` in the audit log instead of a name.

### Step 3 — Add the domain in Render

Render → your service → **Settings → Custom Domains → Add Custom Domain** → `nexus.devxpert.ae`

Render will show you the record to create. For a subdomain it's a **CNAME**.

### Step 4 — Create the DNS record

In whichever panel step 0 pointed you to:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name / Host | `nexus` |
| Value / Target | the `xxx.onrender.com` hostname Render showed you |
| TTL | Automatic, or 300 |

**If you're on Cloudflare:** set the proxy to **DNS only** — the grey cloud, not orange. With the orange cloud on, Render can't complete the certificate check and the domain sits pending forever. You can turn it back on afterwards if you want Cloudflare's CDN.

**Do not** create an A record pointing at an IP. Render's IPs change.

### Step 5 — Wait, then verify

Propagation is usually 5–30 minutes. Render's dashboard flips the domain to **Verified** and issues the TLS certificate automatically.

```bash
dig nexus.devxpert.ae CNAME +short     # should show the onrender hostname
curl -I https://nexus.devxpert.ae      # should be 200, and https should not warn
```

### Step 6 — Update what points at the old URL

- **Branch WhatsApp links** — each shop's storefront link becomes `https://nexus.devxpert.ae/?branch=br-xxx`. The exact link is printed at the bottom of the Branches → Stock the shelves panel.
- **Store entrance QR poster** — `/store-entry-qr.html` reads `location.origin`, so it picks up the new domain by itself. Reprint any poster generated from the old URL.
- **Pitch deck, one-pager, posters, outreach email** — all currently say the Render URL.
- **Payment gateway** — when you move off the mock driver, the webhook URL becomes `https://nexus.devxpert.ae/api/payments/webhook`.

The old `.onrender.com` address keeps working, so nothing breaks the moment the domain goes live.

---

## Going further, when it's worth it

You chose one subdomain for now, which is the right call — one DNS record, one certificate, one deployment. Worth knowing what changes if the business does.

**A subdomain per client** (`madina.nexus.devxpert.ae`) is the version supermarkets find most convincing, because their address doesn't mention anyone else. It needs a wildcard DNS record and a wildcard certificate, and the server has to read the hostname to decide which client it's serving. That's a real piece of work, not a setting — worth doing at your third or fourth paying client, not before.

**A second company on the same deployment is the one thing not to improvise.** Branches of one group share a customer book by design. Two different supermarket companies must share nothing, and today that means a second Render service with its **own** `DATABASE_URL`. Never point two clients at one database.

---

## The checklist

- [ ] `code .` opens the project — F5 runs it
- [ ] `DATABASE_URL` set — deploy log says `storage: postgres`, not `EPHEMERAL`
- [ ] `ADMIN_PIN` changed, and a named owner account created
- [ ] Custom domain added in Render
- [ ] CNAME created (`nexus` → the onrender host), Cloudflare grey cloud if applicable
- [ ] `https://nexus.devxpert.ae` loads with a valid certificate
- [ ] Branch WhatsApp links and the entrance QR updated
- [ ] Deck, one-pager and posters updated to the new address

---

*DevX Technologies LLC · Dubai · devxpert.ae · +971 54 749 7336*
