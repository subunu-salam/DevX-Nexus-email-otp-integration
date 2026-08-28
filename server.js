/* ══════════════════════════════════════════════════════════
   DEVX NEXUS — API + REAL-TIME SERVER WITH OPENAI CONCIERGE
   Supports: Live Inventory, Smart Alternatives, Multi-language,
   Recipe Prompts, and Dynamic Cart Building.
══════════════════════════════════════════════════════════ */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const Groq = require('groq-sdk');
const { Catalog } = require('./lib/catalog');
const { withImages, thumb } = require('./lib/images');
const PAY = require('./lib/payments');
const INSIGHT = require('./lib/insights');
const FC = require('./lib/forecast');
const LOY = require('./lib/loyalty');
const GUARD = require('./lib/guard');
const STAFF = require('./lib/staff');
const CUST = require('./lib/customers');
const SLOTS = require('./lib/slots');
const INTEG = require('./lib/integrations');
const STORES = require('./lib/stores');
const TEN = require('./lib/tenancy');
const ROLLUP = require('./lib/rollup');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ══════════════════════════════════════════════════════════
   LLM LAYER — Groq Llama 3.1 (primary) → OpenAI (fallback)
   Both SDKs expose the same `chat.completions.create` shape,
   so the concierge calls one unified interface.
══════════════════════════════════════════════════════════ */
const isPlaceholder = k => !k || /your-.*-key-here/i.test(k) || k.trim() === '';
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// maxRetries:0 + a short timeout make rate-limited/slow calls fail FAST and drop
// to the instant keyword fallback, instead of the SDK silently retrying with
// exponential backoff (the main cause of the long "thinking" delays).
const groq = !isPlaceholder(GROQ_KEY) ? new Groq({ apiKey: GROQ_KEY, maxRetries: 0, timeout: 12000 }) : null;
const openai = !isPlaceholder(OPENAI_KEY) ? new OpenAI({ apiKey: OPENAI_KEY, maxRetries: 0, timeout: 12000 }) : null;

// Choose the active provider: Groq Llama 3.1 first, OpenAI as fallback.
const LLM = groq
  ? { client: groq, model: 'llama-3.1-8b-instant', name: 'Groq Llama 3.1' }
  : openai
  ? { client: openai, model: 'gpt-4o-mini', name: 'OpenAI gpt-4o-mini' }
  : null;
// Whisper transcriber for voice input (Groq preferred, OpenAI fallback).
const TRANSCRIBER = groq
  ? { client: groq, model: 'whisper-large-v3' }
  : openai
  ? { client: openai, model: 'whisper-1' }
  : null;

console.log('[nexus] LLM provider:', LLM ? LLM.name : 'NONE (keyword fallback only — add GROQ_API_KEY)');

/* ── storage ── */
const KEYS = ['devx-catalog', 'devx-orders', 'devx-offers', 'devx-notifs-customer', 'devx-activity', 'devx-queries',
  'devx-loyalty', 'devx-personal-offers', 'devx-zones', 'devx-staff', 'devx-audit', 'devx-slots', 'devx-branches', 'devx-catalogs', 'devx-order-additions', 'devx-customer-passwords'];
let db = {
  'devx-catalog': null,
  'devx-orders': [],
  'devx-offers': [],
  'devx-notifs-customer': [],
  'devx-activity': [],
  'devx-queries': [],
  // till history imported from the supermarket's own loyalty programme,
  // joined to app accounts on mobile number
  'devx-loyalty': [],
  // personalised coupons issued to a specific card-holder
  'devx-personal-offers': [],
  // store-edited floor plan overrides, keyed by category
  'devx-zones': {},
  // named staff accounts and the record of what each of them did
  'devx-staff': [],
  'devx-audit': [],
  // delivery windows and their capacity, editable by the store
  'devx-slots': [],
  // branches of the chain; one deployment can serve several shops
  'devx-branches': [],
  /* Each branch keeps its own product list, so a new shop opens empty and its
     team fills it in. Keyed by branch id. */
  'devx-catalogs': {},
  // Customer requests to add products to an already placed order.
  'devx-order-additions': [],
  'devx-customer-passwords': [],
  'devx-order-count': 0
};

/* Storage lives behind lib/store.js: Postgres when DATABASE_URL is set,
   otherwise a JSON file. On Render's free tier the filesystem is ephemeral, so
   the file driver loses everything on each redeploy — set DATABASE_URL for any
   deployment that takes real orders. */
const { Store } = require('./lib/store');
const STORE = new Store(KEYS, { dataDir: DATA_DIR });

async function load() {
  await STORE.init(db);
  if (!STORE.status().durable)
    console.warn('[nexus] storage is a local file — set DATABASE_URL for durable storage');
}
/* save()      — everything that changes during trading (excludes the catalogue)
   saveAll()   — include the catalogue; only when products really changed       */
function save(...keys) { STORE.save(...keys); }
function saveAll() { STORE.saveAll(); }

/* ── seed catalog on first boot ──
   CATALOG_FILE lets you point at a bigger catalogue for scale testing,
   e.g.  CATALOG_FILE=seed-96k.json npm start                            */
const CATALOG_FILE = process.env.CATALOG_FILE || 'seed.json';
function seedCatalog() {
  const founding = STORES.fallbackId(db);
  if (TEN.catalog(db, founding).length) return;
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, CATALOG_FILE), 'utf8'));
    TEN.setCatalog(db, founding, seed.map((p, i) => Object.assign({}, p, { stock: p.stock != null ? p.stock : (18 + ((i * 7) % 30)) })));
    saveAll();   // persist the seeded catalogue so it is not re-seeded next boot
    save();
    console.log('[nexus] catalog seeded:', TEN.catalog(db, founding).length, 'products into', founding);
  } catch (e) { console.error('[nexus] seed failed:', e.message); }
}

/* ── catalog engine: index once, then serve pages/search from memory ── */
/* ── one search index per branch ──
   Each shop has its own product list, so each needs its own inverted index.
   Indexes are built lazily and dropped when that branch's catalogue changes,
   so a chain of twenty shops does not pay to index all twenty at boot. */
const INDEXES = new Map();
function catalogOf(branchId) { return TEN.catalog(db, branchId); }
function indexOf(branchId) {
  let ix = INDEXES.get(branchId);
  if (!ix) {
    ix = new Catalog();
    const t0 = Date.now();
    ix.reset(catalogOf(branchId));
    INDEXES.set(branchId, ix);
    if (ix.size) console.log(`[nexus] indexed ${ix.size} products for ${branchId} in ${Date.now() - t0}ms`);
  }
  return ix;
}
function reindex(branchId) {
  if (branchId) INDEXES.delete(branchId); else INDEXES.clear();
}

/* Which branch is this request for?
   · staff carry theirs on their account
   · shoppers arrive on a per-branch WhatsApp link, which puts ?branch= in the
     URL; the app then sends it on every call
   · anything else falls back to the founding branch, so a single-shop install
     never has to think about branches at all */
/* Which shops may this person touch at all? null means every shop, which is
   the owner. An area manager holds a list; everyone else holds one. */
function accessible(req) {
  const a = actor(req);
  if (!a) return null;
  if (a.role === 'owner' || a.legacy) return null;
  const list = (a.branchIds && a.branchIds.length) ? a.branchIds
             : (a.branchId ? [a.branchId] : []);
  return list.length ? list : null;
}

function branchOf(req) {
  const ids = STORES.list(db).map(b => b.id);
  /* Some callers pass a synthetic request (the login route audits before a
     real one exists), so nothing here may assume headers are present. */
  const asked = (req.query && req.query.branch) ||
                (req.headers && req.headers['x-branch']) ||
                (req.body && req.body.branchId);
  const mine = accessible(req);
  /* Someone pinned to shops may move between their own and no further. An
     owner goes anywhere. A request for a shop you do not hold does not error
     — it simply lands on yours, so a stale tab cannot leak another shop. */
  if (mine) {
    if (asked && mine.includes(asked)) return asked;
    return mine[0];
  }
  if (asked && ids.includes(asked)) return asked;
  return STORES.fallbackId(db);
}

/* ── helpers ── */
/* ── who is making this request ──
   Preferred path is a session token from /api/auth/login, which carries a name
   and a role so actions can be attributed and permission-checked. The legacy
   shared PIN still works and is treated as the owner, so an existing install
   keeps running while staff accounts are set up. */
function actor(req) {
  const tok = req.headers['x-admin-token'] || '';
  if (tok) {
    const s = STAFF.readToken(tok);
    /* Carry the whole shop list, not just the primary one. An area manager
       who loses branchIds here silently collapses to a single-shop manager —
       which is exactly what happened. */
    if (s) return { id: s.id, name: s.name, role: s.role,
                    branchId: s.branchId || null,
                    branchIds: s.branchIds || (s.branchId ? [s.branchId] : []) };
  }
  if ((req.headers['x-admin-pin'] || '') === ADMIN_PIN)
    return { id: 'legacy', name: 'Shared PIN', role: 'owner', legacy: true };
  return null;
}
const isAdmin = req => !!actor(req);

/* Gate a route on a permission rather than on "is staff". */
function need(perm) {
  return (req, res, next) => {
    const a = actor(req);
    if (!a) return res.status(401).json({ error: 'unauthorized' });
    if (!STAFF.can(a.role, perm))
      return res.status(403).json({ error: `Your role (${a.role}) cannot do this`, code: 'forbidden', perm });
    req.actor = a;
    next();
  };
}
/* Record a consequential action against the person who did it. */
function audit(req, action, detail, meta) {
  const a = (req && req.actor) || (req && actor(req)) || null;
  /* Stamp the shop, so a store manager reads their own shop's log rather than
     the whole chain's — and so "who approved that weight" stays answerable
     per branch. */
  let bid = null;
  try { bid = req ? branchOf(req) : null; } catch (e) { bid = null; }
  const withBranch = Object.assign({ branchId: bid }, meta || {});
  db['devx-audit'].unshift(STAFF.auditEntry(a, action, detail, withBranch));
  db['devx-audit'] = db['devx-audit'].slice(0, 500);
  save('devx-audit');
}
function broadcast(changed) { io.emit('sync', changed); }
function activity(type, msg, branchId) {
  db['devx-activity'].unshift({ type, msg, branchId: branchId || null, at: new Date().toISOString() });
  db['devx-activity'] = db['devx-activity'].slice(0, 120);
}
/* `phone` targets a loyalty member rather than a browser session, so a
   personal offer follows the card-holder onto any device they sign in from. */
/* Deliver a customer message through the configured driver. With none
   connected this records the intent rather than claiming a send. */
async function message(phone, text) {
  if (!phone) return { ok: false };
  try {
    const r = await INTEG.msgDriver().send({ to: phone, text });
    if (!r.ok) console.warn('[nexus] message failed:', r.error);
    else if (!r.delivered) console.log('[nexus] (not sent, no provider):', r.preview);
    return r;
  } catch (e) { console.error('[nexus] message error:', e.message); return { ok: false }; }
}

/* OTP-only SMS path. This keeps the existing order/notification messaging
   driver untouched. Set OTP_SMS_DRIVER=textbelt for the free Textbelt
   testing path; otherwise OTPs use the existing messaging driver. */
async function otpMessage(phone, text) {
  if (!phone) return { ok: false, delivered: false };
  const driverName = String(process.env.OTP_SMS_DRIVER || 'mock').toLowerCase();
  if (driverName === 'textbelt') {
    try {
      const driver = INTEG.msgDrivers && INTEG.msgDrivers.textbelt;
      if (!driver) return { ok: false, delivered: false, error: 'Textbelt driver unavailable' };
      const r = await driver.send({ to: phone, text });
      if (!r.ok) console.warn('[nexus] OTP SMS failed:', r.error);
      return r;
    } catch (e) {
      console.error('[nexus] OTP SMS error:', e.message);
      return { ok: false, delivered: false, error: e.message };
    }
  }
  return message(phone, text);
}

function notify(type, title, msg, cid, phone) {
  db['devx-notifs-customer'].unshift({
    id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
    type, title, msg, cid: cid || null, phone: phone || null, at: new Date().toISOString()
  });
  db['devx-notifs-customer'] = db['devx-notifs-customer'].slice(0, 60);
  if (phone) message(phone, `${title}\n${msg}`);
}
/* Public state WITHOUT the catalogue.
   At 96k SKUs the catalogue is ~30 MB — shipping it to every shopper is what
   killed the page. The app now pulls products through /api/products
   (paginated + searchable), so this payload stays a few KB forever.
   `full=1` keeps the old behaviour for the small demo catalogue. */
function publicState(cid, opts = {}) {
  reconcileApprovedCodAdditions();
  const bid = opts.branchId || STORES.fallbackId(db);
  const ix = indexOf(bid);
  const verifiedPhone=opts.verifiedPhone||null;
  const s = {
    'devx-offers': db['devx-offers'],
    'devx-activity': [],
    'devx-notifs-customer': verifiedPhone ? db['devx-notifs-customer'].filter(n=>n.phone&&LOY.normalisePhone(n.phone)===verifiedPhone) : [],
    'devx-orders': verifiedPhone ? [...new Map(db['devx-orders'].filter(o=>LOY.normalisePhone(o.customer&&o.customer.phone)===verifiedPhone).map(o=>[o.id,o])).values()] : [],
    'catalog-meta': { count: ix.size, categories: ix.categories(), paged: true,
                      branchId: bid, branch: (STORES.find(db, bid) || {}).name || '' }
  };
  if (opts.full) s['devx-catalog'] = catalogOf(bid).map(p => withImages(p, 200));
  return s;
}
/* Admin bootstrap. The shopper payload was capped long ago, but this one still
   shipped the whole catalogue — 29.5 MB at 96,000 SKUs, which hangs the admin
   browser on any normal connection. Send a working slice; the Inventory screen
   reaches the rest through /api/products, which is indexed and answers in
   milliseconds at any catalogue size. */
const ADMIN_CATALOG_LIMIT = 4000;
function fullState(branchId) {
  reconcileApprovedCodAdditions();
  const bid = branchId || STORES.fallbackId(db);
  const def = STORES.fallbackId(db);
  const s = {};
  KEYS.forEach(k => s[k] = db[k]);
  /* A picker at one shop must not see another shop's queue. Owners switch
     branches explicitly, which branchOf() already resolves. */
  for (const ord of db['devx-orders']) {
    const adds=(db['devx-order-additions']||[]).filter(a=>a.orderId===ord.id&&['paid_merged','approved_cod_merged'].includes(a.status));
    if(adds.length){const known=new Set((ord.items||[]).map(i=>String(i.id)+'|'+String(i.qty||1)+'|'+String(i.name||'')));for(const a of adds)for(const it of (a.items||[])){const k=String(it.id)+'|'+String(it.qty||1)+'|'+String(it.name||'');if(!known.has(k)){ord.items=ord.items||[];ord.items.push(it);known.add(k)}}}
  }
  s['devx-orders'] = STORES.scope(db['devx-orders'], bid, def);
  s['branch-meta'] = { branchId: bid, branch: STORES.find(db, bid) || null,
                       branches: STORES.list(db).filter(b => b.active !== false) };
  const cat = TEN.catalog(db, bid);
  const paged = cat.length > ADMIN_CATALOG_LIMIT;
  s['devx-catalog'] = paged ? cat.slice(0, ADMIN_CATALOG_LIMIT) : cat;
  s['catalog-meta'] = { count: cat.length, loaded: paged ? ADMIN_CATALOG_LIMIT : cat.length, paged };

  /* The per-branch containers are keyed by branch, so copying them wholesale
     handed every shop's catalogue, floor plan and delivery windows to whoever
     opened the panel — a cross-branch leak and a 300 KB payload on a shop
     with nothing in it. Send this branch's slice and nothing else. */
  s['devx-catalogs'] = { [bid]: undefined };
  delete s['devx-catalogs'];
  s['devx-zones'] = TEN.zones(db, bid);
  s['devx-slots'] = TEN.slots(db, bid);
  /* Loyalty is a chain-wide book by design, but the rows still belong to the
     shop that rang them up. */
  s['devx-loyalty'] = loyaltyRows(bid);
  /* The bootstrap copied every declared collection wholesale, which meant each
     staff member's scrypt salt and hash went to any signed-in browser — a
     picker's tab included. Send the public shape only. */
  s['devx-staff'] = (db['devx-staff'] || []).map(STAFF.publicUser);
  /* Same class of mistake, three more collections. The audit log is gated
     behind audit.view on its own route and then went out in full to every
     signed-in browser anyway; customer notifications carry phone numbers and
     the panel never reads them. Scope or drop. */
  s['devx-audit'] = [];
  s['devx-notifs-customer'] = [];
  s['devx-activity'] = STORES.scope(db['devx-activity'], bid, def);
  s['devx-queries'] = STORES.scope(db['devx-queries'], bid, def);
  s['devx-personal-offers'] = STORES.scope(db['devx-personal-offers'], bid, def);
  return s;
}

/* ── middleware ── */
app.set('trust proxy', 1);   // Render terminates TLS upstream; needed for real client IPs
app.use(express.json({ limit: '12mb' }));   // headroom for admin image uploads (base64)
// Return JSON (never an HTML stack trace) when a client sends malformed JSON.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError))
    return res.status(400).json({ error: 'invalid JSON body' });
  if (err && err.type === 'entity.too.large')
    return res.status(413).json({ error: 'payload too large' });
  if (err) {
    STORES.capture(err, { path: req.path, method: req.method });
    return res.status(500).json({ error: 'server error' });
  }
  next();
});
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/* ── API ── */
app.get('/api/health', (req, res) => {
  const m = process.memoryUsage();
  res.json({
    ok: true,
    orders: db['devx-orders'].length,
    products: Object.values(db['devx-catalogs'] || {}).reduce((n, l) => n + l.length, 0),
    indexed: INDEXES.size,
    memory_mb: Math.round(m.rss / 1048576),
    heap_mb: Math.round(m.heapUsed / 1048576),
    ai: GUARD.stats(),          // daily AI spend against its ceiling
    storage: STORE.status(),    // driver, durability, pending writes
    branches: STORES.list(db).length,
    errors: STORES.health(),
    integrations: INTEG.status(),
    uptime_s: Math.round(process.uptime())
  });
});

app.get('/api/state', (req, res) => {
  if (isAdmin(req)) return res.json(fullState(branchOf(req)));
  if (req.headers['x-admin-pin']) return res.status(401).json({ error: 'wrong pin' });
  // full=1 keeps legacy behaviour; default is the light payload.
  /* A verified session identifies the shopper by phone, which is what makes
     order history and personal offers follow them onto another device. The
     cid query stays as a fallback for anyone who has not signed in. */
  const s = shopper(req);
  res.json(publicState(req.query.cid || '', {
    full: req.query.full === '1',
    phone: (s && s.phone) || null,
    verifiedPhone: (s && s.phone) || null,
    branchId: branchOf(req)
  }));
});

/* ══════════════════════════════════════════════════════════
   PRODUCT API — paginated + searchable. This is what makes a
   96,000-SKU catalogue viable on a phone: the client asks for
   30 products at a time instead of downloading everything.
══════════════════════════════════════════════════════════ */
app.get('/api/products', (req, res) => {
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const w = Math.min(400, Math.max(80, parseInt(req.query.w, 10) || 200));
  const q = (req.query.q || '').trim();

  const t0 = process.hrtime.bigint();
  const ix = indexOf(branchOf(req));
  const result = q ? ix.search(q, limit, offset)
                   : ix.browse({ cat: req.query.cat, limit, offset });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    total: result.total,
    offset, limit,
    took_ms: Math.round(ms * 100) / 100,
    items: result.items.map(p => withImages(p, w))
  });
});

/* Deals rail — a handful of on-offer products, not the whole catalogue. */
app.get('/api/deals', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ items: indexOf(branchOf(req)).deals(12).map(p => withImages(p, 320)) });
});

/* Single product (for the locator / detail view). */
app.get('/api/product/:id', (req, res) => {
  const p = indexOf(branchOf(req)).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(withImages(p, 400));
});

/* Category list for the filter bar. */
app.get('/api/categories', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  const ix = indexOf(branchOf(req));
  res.json({ categories: ix.categories(), count: ix.size });
});

/* ══════════════════════════════════════════════════════════
   AI GROCERY CONCIERGE
   Pipeline:  Intent Classification → Product Search
              → Conversation Memory → LLM (strict JSON)
   The LLM may ONLY pick products that exist in live inventory,
   which eliminates hallucinated items.
══════════════════════════════════════════════════════════ */

/* ── 1. Conversation Memory (per session) ── */
const SESSIONS = new Map();          // session_id -> [{ role, content }, ...]
const MEM_TURNS = 8;                 // remember last 8 messages (4 exchanges)
const SESSION_TTL = 1000 * 60 * 60;  // forget a session after 1h idle
const SESSION_SEEN = new Map();      // session_id -> last activity ts

function getMemory(sid) {
  if (!SESSIONS.has(sid)) SESSIONS.set(sid, []);
  SESSION_SEEN.set(sid, Date.now());
  return SESSIONS.get(sid);
}
function pushMemory(sid, role, content) {
  const h = getMemory(sid);
  h.push({ role, content });
  while (h.length > MEM_TURNS) h.shift();
}
// Track which product groups we've already shown in a session, so follow-up
// "add drinks / also / more" requests only surface NEW items, never repeats.
const SUGGESTED = new Map();               // session_id -> Set(groupKey)
function suggestedSet(sid) {
  if (!SUGGESTED.has(sid)) SUGGESTED.set(sid, new Set());
  return SUGGESTED.get(sid);
}
const ADDON_RE = /\b(add|also|more|another|extra|plus|include|as well|too|instead|swap|to go with|alongside|with (that|it)|something (else|sweet)|dessert|drinks?)\b/i;
// Remember if we just asked the shopper a clarifying question, so their next
// message is treated as the ANSWER (and we don't loop asking again).
const PENDING_CLARIFY = new Map();   // session_id -> last clarify question
// periodic cleanup of idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of SESSION_SEEN) {
    if (now - ts > SESSION_TTL) { SESSIONS.delete(sid); SESSION_SEEN.delete(sid); }
  }
}, 1000 * 60 * 10).unref();


/* ── AI query understanding helpers ─────────────────────────
   AI-processing only. No other feature/API logic is changed.
   ---------------------------------------------------------- */
const QUERY_ALIASES = {
  'soft drink':'soda','soft drinks':'soda','cold drink':'drink','cold drinks':'drink',
  'fizzy drink':'soda','fizzy drinks':'soda','sweets':'dessert','sweet':'dessert',
  'veggies':'vegetables','vegetable':'vegetables','fruits':'fruit',
  'prawns':'shrimp','yoghurt':'yogurt','toilet paper':'tissue',
  'washing powder':'detergent','washing liquid':'detergent'
};
function expandShoppingQuery(text) {
  let q=String(text||'').toLowerCase();
  for (const [from,to] of Object.entries(QUERY_ALIASES)) {
    const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    q=q.replace(new RegExp('\\b'+escaped+'\\b','gi'),to);
  }
  return q.replace(/\b(please|pls|kindly|can you|could you|would you|i want|i need|i'd like|i would like|show me|give me|help me find|looking for)\b/gi,' ')
          .replace(/\s+/g,' ').trim();
}
function extractShoppingContext(text) {
  const q=String(text||'').toLowerCase();
  const out={people:null,quantity:null,budget:parseBudget(q),maxPrice:null,meal:null,dietary:[]};
  let m=q.match(/\b(?:for|serves?|family of)\s+(\d{1,2})\s*(?:people|persons|pax)?\b/);
  if(m) out.people=parseInt(m[1],10);
  if(!out.people){m=q.match(/\b(\d{1,2})\s*(?:people|persons|pax)\b/);if(m) out.people=parseInt(m[1],10);}
  m=q.match(/\b(\d{1,3})\s*(?:items?|packs?|pieces?|bottles?|cans?|boxes?|loaves?)\b/);
  if(m) out.quantity=parseInt(m[1],10);
  m=q.match(/\b(?:under|below|less than|up to|max(?:imum)?|within)\s*(?:aed|dhs?|dirhams?)?\s*(\d+(?:\.\d+)?)\b/);
  if(m) out.maxPrice=parseFloat(m[1]);
  const meal=q.match(/\b(breakfast|brunch|lunch|dinner|snacks?|dessert|iftar|suhoor)\b/);
  if(meal) out.meal=meal[1];
  for(const d of ['healthy','high protein','low calorie','low fat','low sugar','sugar free','keto','vegan','vegetarian','gluten free'])
    if(q.includes(d)) out.dietary.push(d);
  return out;
}
function mergeCandidates(a,b,limit=80){
  const seen=new Set(),out=[];
  for(const list of [a||[],b||[]]) for(const p of list){
    const id=String(p.id); if(seen.has(id)) continue;
    seen.add(id); out.push(p); if(out.length>=limit) return out;
  }
  return out;
}
function relevantGroupMenu(candidates,groups,intent,prompt){
  const keys=[],seen=new Set();
  for(const p of (candidates||[])){
    const g=p.group||('solo-'+p.id); if(!groups.has(g)||seen.has(g)) continue;
    seen.add(g); keys.push(g); if(keys.length>=80) break;
  }
  if(intent==='recipe_assistance'||/\b(cart|meal|dinner|lunch|breakfast|ingredients?)\b/i.test(prompt)){
    const pantry=['basmati-rice','whole-chicken','chicken-breast','onions','tomatoes','potatoes','carrots',
      'garlic','ginger','lentils-red','toor-dal','plain-yogurt','eggs','milk','sunflower-oil',
      'flour-wheat','black-pepper','turmeric','chili-powder','ground-coriander','salt','cinnamon','cardamom'];
    for(const g of pantry){if(keys.length>=110) break;if(groups.has(g)&&!seen.has(g)){seen.add(g);keys.push(g);}}
  }
  return keys.map(g=>{const best=bestValue(groups.get(g)||[]);return best?`${g}=AED${best.price}`:g;}).join(', ');
}

/* ── 2. Intent Classification ── */
function classifyIntent(q) {
  const t = ' ' + q.toLowerCase() + ' ';
  if (/(how (do|does|will|can|is)|where (do|can|will)|what happens|will i|can i (see|check|pay|change|cancel|track)|weighing|weighed|actual weight|final price|price change|reflect|previous order|order history|track (my )?order|payment option|pay (later|online|cash|by card)|refund|cancel my order|delivery time|when will)/.test(t))
    return 'app_help';
  if (/(nutrition|nutrient|nutritional|nutrition facts|calorie|kcal|carb(?:ohydrate)?|fat content|how much (?:protein|fat|carb)|protein (?:content|per)|macros|energy value)/.test(t))
    return 'nutrition';
  if (/(recipe|cook|dish|ingredient|make .*(for|dinner|lunch)|biryani|briyani|mandi|kabsa|machboos|curry|pasta|salad|bake|grill|bbq|barbecue|iftar|suhoor)/.test(t))
    return 'recipe_assistance';
  if (/(healthy|diet|low[\s-]?cal|low[\s-]?fat|high[\s-]?protein|protein[- ]rich|fitness|gym|nutriti|weight|keto|vegan|vegetarian|clean eating|sugar[\s-]?free|gluten[- ]?free)/.test(t))
    return 'healthy_recommendation';
  if (/(where|which aisle|which shelf|find the|locate|location of|navigat|how do i get to)/.test(t))
    return 'navigation';
  if (/(cheaper|cheapest|budget|under aed|less than|discount|offer|deal|save money|affordable|any alternative|something else)/.test(t))
    return 'shopping_help';
  if (/^\s*(hi|hii|hey|hello|salaam|salam|marhaba|thanks|thank you|thx|good (morning|evening|afternoon)|how are you|who are you|what can you do)\b/.test(q.toLowerCase()))
    return 'general_conversation';
  return 'product_search';
}

// Common dishes with clearly distinct variants — we deterministically ask which
// one (guarantees the behavior the small model is inconsistent about, and saves
// an LLM call). Only applied to English prompts; other languages go to the LLM.
const AMBIGUOUS_DISHES = {
  biryani: ['Chicken Biryani', 'Mutton Biryani', 'Prawn Biryani', 'Vegetable Biryani'],
  curry:   ['Chicken Curry', 'Fish Curry', 'Vegetable Curry', 'Paneer Curry'],
  pasta:   ['Chicken Pasta', 'Creamy Alfredo', 'Veg Pasta'],
  pizza:   ['Chicken Pizza', 'Margherita', 'Veg Pizza'],
  mandi:   ['Chicken Mandi', 'Mutton Mandi'],
  kabsa:   ['Chicken Kabsa', 'Mutton Kabsa']
};
function ambiguousDish(prompt) {
  const t = ' ' + prompt.toLowerCase() + ' ';
  if (/\b(chicken|mutton|lamb|prawn|shrimp|veg|vegetable|fish|beef|egg|paneer|mushroom|margherita)\b/.test(t)) return null;
  for (const [dish, opts] of Object.entries(AMBIGUOUS_DISHES)) {
    if (new RegExp('\\b' + dish + '\\b').test(t)) return { dish, opts };
  }
  return null;
}

// Detect the script of the CURRENT message so we can lock the reply language
// (the model was drifting to Hindi because earlier messages were Hindi).
function detectScript(text) {
  if (/[ऀ-ॿ]/.test(text)) return 'Hindi';
  if (/[ۀ-ۿݐ-ݿ]/.test(text)) return 'Urdu';
  if (/[؀-ۿ]/.test(text)) return 'Arabic';
  if (/[ഀ-ൿ]/.test(text)) return 'Malayalam';
  if (/[஀-௿]/.test(text)) return 'Tamil';
  if (/[ঀ-৿]/.test(text)) return 'Bengali';
  return null;   // no non-Latin script detected
}
// Shoppers often ASK to switch language while typing in English
// ("can you speak in Malayalam?", "reply in Arabic", "talk in hindi").
const LANG_NAMES = {
  malayalam:'Malayalam', 'മലയാളം':'Malayalam',
  arabic:'Arabic', 'عربي':'Arabic', 'العربية':'Arabic',
  hindi:'Hindi', 'हिंदी':'Hindi', 'हिन्दी':'Hindi',
  urdu:'Urdu', 'اردو':'Urdu',
  tamil:'Tamil', 'தமிழ்':'Tamil',
  bengali:'Bengali', bangla:'Bengali',
  english:'English', filipino:'Filipino', tagalog:'Filipino',
  french:'French', spanish:'Spanish', malay:'Malay', telugu:'Telugu',
  kannada:'Kannada', marathi:'Marathi', punjabi:'Punjabi', sinhala:'Sinhala', nepali:'Nepali'
};
// Any world language the shopper might name — we support them all, not a whitelist.
const EXTRA_LANGS = ['japanese','chinese','mandarin','cantonese','korean','german','italian','portuguese',
 'russian','turkish','persian','farsi','dari','pashto','indonesian','thai','vietnamese','swahili','somali',
 'amharic','tigrinya','dutch','polish','romanian','greek','hebrew','sinhalese','gujarati','odia','assamese',
 'konkani','tulu','kashmiri','burmese','khmer','lao','ukrainian','czech','hungarian','swedish','norwegian',
 'danish','finnish','serbian','croatian','bulgarian','albanian','armenian','georgian','azerbaijani','uzbek',
 'kazakh','kurdish','hausa','yoruba','igbo','zulu','afrikaans','maltese','catalan','basque','irish','welsh'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function requestedLang(text) {
  const t = (text || '').toLowerCase();
  // "in <lang>", "speak <lang>", "<lang> please", "switch to <lang>", "reply in <lang>"
  if (!/(speak|talk|reply|answer|say|write|switch|change|use|in)\b/.test(t) && !/language/.test(t)) return null;
  for (const [k, v] of Object.entries(LANG_NAMES)) {
    if (new RegExp('(^|[^a-z])' + k + '($|[^a-z])', 'i').test(t)) return v;
  }
  for (const k of EXTRA_LANGS) {
    if (new RegExp('(^|[^a-z])' + k + '($|[^a-z])', 'i').test(t)) return cap(k);
  }
  // Generic catch-all: "speak in <word>" / "talk in <word>" for any language name.
  const m = t.match(/\b(?:speak|talk|reply|answer|write|respond|converse)\s+(?:to me\s+)?(?:in|using)\s+([a-z]{3,20})\b/);
  if (m && !['the','this','that','store','shop','english'].includes(m[1])) return cap(m[1]);
  return null;
}
// ISO codes the client may send (from the mic language picker) -> language name.
// Needed for Latin-script languages (fr/es/tl) where script detection can't help.
const ISO_LANG = {
  en:'English', ar:'Arabic', hi:'Hindi', ur:'Urdu', ml:'Malayalam', ta:'Tamil',
  bn:'Bengali', fr:'French', es:'Spanish', tl:'Filipino', de:'German', it:'Italian',
  pt:'Portuguese', ru:'Russian', tr:'Turkish', fa:'Persian', id:'Indonesian',
  th:'Thai', vi:'Vietnamese', ja:'Japanese', ko:'Korean', zh:'Chinese', te:'Telugu',
  kn:'Kannada', mr:'Marathi', pa:'Punjabi', si:'Sinhala', ne:'Nepali'
};
// Per-session sticky language (set by an explicit request or a non-Latin message).
const SESSION_LANG = new Map();

/* Budget: "100 AED", "AED 100", "under 50", "budget of 200", "₹100" */
function parseBudget(text) {
  const t = (text || '').toLowerCase();
  const ok = v => (v >= 10 && v <= 100000) ? v : null;
  const pick = re => {                          // first VALID match, not just the first
    let m; const rx = new RegExp(re, 'g');
    while ((m = rx.exec(t)) !== null) { const v = ok(parseFloat(m[1])); if (v) return v; }
    return null;
  };
  // 1) number attached to a currency word ("200 aed", "aed 150", "300 dhs")
  return pick('([0-9]{1,5}(?:\\.[0-9]+)?)\\s*(?:aed|dhs?|dirhams?)')
      || pick('(?:aed|dhs?|dirhams?)\\s*([0-9]{1,5}(?:\\.[0-9]+)?)')
  // 2) budget phrasing without a currency word ("budget of 200", "under 50",
  //    "i asked for 154"). pick() skips values < 10 so "for 2 people" is ignored.
      || pick('(?:budget(?:\\s*(?:of|is))?|under|below|within|max(?:imum)?|up\\s*to|upto|around|about|for|of|worth)\\s*([0-9]{1,5}(?:\\.[0-9]+)?)');
}
// Sticky per-session budget so follow-ups ("i asked for 154", "add more") keep it.
const SESSION_BUDGET = new Map();

const INTENT_GUIDE = {
  product_search:        'Find and recommend the matching products from inventory.',
  recipe_assistance:     'List the ingredient products needed for the dish, only ones that exist in inventory.',
  healthy_recommendation:'Recommend the healthiest in-stock options (fresh produce, lean protein, whole grains, low-sugar).',
  nutrition:             'Answer the nutrition question using the NUTRITION FACTS provided (per 100g/100ml). Quote the real numbers and include the product(s) in items so the card shows the values.',
  app_help:              'Explain how the service works using HOW THIS APP WORKS below. Answer factually and briefly. Set items:[] — this is a question, not a shopping request.',
  shopping_help:         'Help the shopper save money — suggest cheaper in-stock alternatives or budget-friendly picks.',
  navigation:            'Tell the shopper the aisle/shelf. ALWAYS include the product in items so the in-app map can guide them, and offer a "Start navigation" suggestion.',
  general_conversation:  'Reply warmly and briefly. Only include product_ids if the shopper actually asked for items.'
};

/* ── 3. Product Search (runs before the LLM) ── */
const STOPWORDS = new Set(['for','the','and','want','need','make','some','with','please','you','get','have','would','like','can','could','buy','shop','give','show','find','what','which','that','this','from','into','your','our','ingredients','recipe','something','anything','add','also','more']);
// Map casual words to store categories so "cold drinks" finds Beverages even
// without an exact name match (used to keep the keyword fallback useful).
const CAT_SYNONYMS = {
  'Beverages': ['drink','drinks','soda','sodas','cola','pepsi','coke','beverage','beverages','juice','juices','soft'],
  'Snacks': ['snack','snacks','chips','crisps','munchies','nachos','popcorn','wafer','wafers'],
  'Tea & Coffee': ['tea','coffee','karak','chai','nescafe'],
  'Bakery': ['bread','dessert','desserts','cake','sweet','sweets','bun','croissant'],
  'Dairy & Chilled': ['dairy','milk','yogurt','yoghurt','cheese','laban','butter','labneh'],
  'Fresh Produce': ['vegetable','vegetables','veg','fruit','fruits','produce'],
  'Fresh Meat': ['meat','chicken','beef','mutton','lamb','fish','seafood'],
  'Household': ['cleaning','detergent','soap','tissue','household','cleaner'],
  'Frozen': ['frozen','ice cream','icecream'],
  'Spices': ['spice','spices','masala']
};
function impliedCats(query) {
  const t = ' ' + query.toLowerCase() + ' ';
  const cats = [];
  for (const [cat, words] of Object.entries(CAT_SYNONYMS)) {
    if (words.some(w => t.includes(' ' + w) || t.includes(w + ' ') || t.includes(w + 's'))) cats.push(cat);
  }
  return cats;
}
function searchProducts(query, catalog) {
  const t = query.toLowerCase();
  const cats = impliedCats(query);
  const terms = t.split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  return catalog
    .map(p => {
      let s = 0;
      const name = (p.name || '').toLowerCase();
      const cat  = (p.cat  || '').toLowerCase();
      const brand= (p.brand|| '').toLowerCase();
      const grp  = (p.group|| '').toLowerCase();
      terms.forEach(w => {
        if (name.includes(w))  s += 3;
        if (cat.includes(w))   s += 2;
        if (grp.includes(w))   s += 1;
        if (brand.includes(w)) s += 1;
      });
      if (cats.includes(p.cat)) s += 2;    // casual-word -> category match
      return { p, s };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.p);
}

/* ── Variant / group model ──────────────────────────────────
   A "group" = a shopper NEED (e.g. "basmati-rice") that spans
   several brands AND sizes. This is what powers:
     • generic queries  ("I want rice")  -> show all options
     • recipe queries    ("make biryani") -> auto-pick best value,
                                             offer the rest as swaps
   With a large catalog we DON'T inject every SKU into the prompt.
   Instead we inject one compact line per group (a "store menu"),
   which keeps prompts small and lets the model see the whole store.
─────────────────────────────────────────────────────────────*/
function inStock(p) { return p.stock == null || p.stock > 0; }
// Line price for a loose (by-weight) item at a given gram weight.
function loosePriceServer(p, grams) {
  const per = p.perKg != null ? p.perKg : p.price;
  return Math.round(per * grams / 1000 * 100) / 100;
}

// Build group -> members map. Ungrouped items become their own solo group.
function buildGroups(catalog) {
  const groups = new Map();
  for (const p of catalog) {
    const key = p.group || ('solo-' + p.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

// Best-value default within a group:
//   1) in stock   2) on deal wins (biggest saving)   3) then lowest price.
// Shoppers still get every other brand/size as swappable alternatives,
// and can raise the quantity — so "value-first" is a safe, predictable default.
function bestValue(members) {
  const avail = members.filter(inStock);
  const pool = avail.length ? avail : members;
  return pool.slice().sort((a, b) => {
    const da = a.deal ? 1 : 0, dbb = b.deal ? 1 : 0;
    if (da !== dbb) return dbb - da;                       // deals first
    const sa = a.was ? (a.was - a.price) : 0, sb = b.was ? (b.was - b.price) : 0;
    if (sa !== sb) return sb - sa;                         // bigger saving
    return a.price - b.price;                              // then cheaper
  })[0];
}

function compact(p) {
  return {
    id: p.id, name: p.name, brand: p.brand || null, unit: p.unit,
    price: p.price, was: p.was || null, cat: p.cat, img: p.img || null,
    loc: p.loc || null, stock: p.stock != null ? p.stock : null,
    group: p.group || null, deal: !!p.deal,
    loose: !!p.loose, perKg: p.perKg != null ? p.perKg : null,
    nutri: p.nutri || null
  };
}

// Other in-stock brands/sizes in the same group (for the "▾ other options" swap).
function alternativesFor(product, groups) {
  const key = product.group || ('solo-' + product.id);
  const members = groups.get(key) || [];
  return members
    .filter(m => m.id !== product.id && inStock(m))
    .sort((a, b) => a.price - b.price)
    .slice(0, 6)
    .map(compact);
}

// One terse line per group for the prompt "store menu".
// Format: group-key | Name | Category | AEDmin-max
// The model returns group-keys (short strings) which keeps the prompt small
// enough for Groq's free-tier token limit, and the backend expands each key
// into the best-value SKU + alternatives.
// Flat comma-separated list of group-keys. Keys are self-descriptive, so this
// is compact (stays under Groq's free-tier token/min cap) AND unambiguous —
// a category-grouped format made the model return category names by mistake.
function storeMenu(groups, withPrice) {
  const keys = [];
  for (const [key, members] of groups) {
    if (key.startsWith('solo-')) continue;
    keys.push(withPrice ? `${key}=AED${bestValue(members).price}` : key);
  }
  return keys.join(', ');
}

/* Tolerant JSON extraction from an LLM response. */
function parseLLMJson(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

/* Build a plan row from a group's members: best-value default SKU,
   the requested quantity, and swappable alternatives. */
function rowFromMembers(members, qty, groups) {
  const def = bestValue(members);               // enforce value-first default
  return {
    p: compact(def),
    qty: Math.max(1, Math.min(20, parseInt(qty, 10) || 1)),
    alternatives: alternativesFor(def, groups)
  };
}
/* Build a plan row from any single product (resolves to its group first). */
function resolveRow(picked, qty, groups) {
  const key = picked.group || ('solo-' + picked.id);
  const members = groups.get(key) || [picked];
  return rowFromMembers(members, qty, groups);
}

/* ── Voice transcription (Whisper) ──
   The browser records mic audio and POSTs it here; we transcribe with Whisper,
   which auto-detects the language. Far more reliable than the browser's built-in
   speech API (which often fails with a network error). */
app.post('/api/transcribe',
  GUARD.limit('transcribe'),
  express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'application/octet-stream'], limit: '20mb' }),
  async (req, res) => {
    if (!TRANSCRIBER) return res.status(503).json({ error: 'no transcription provider configured' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty audio' });
    const tmp = path.join(os.tmpdir(), 'nx-voice-' + Date.now() + '.webm');
    // Language hint (ISO-639-1 like en/hi/ml/ar/ta) greatly improves accuracy
    // for non-English speech vs. auto-detect on short clips.
    const lang = (req.query.lang || '').toString().slice(0, 2).toLowerCase();
    try {
      fs.writeFileSync(tmp, req.body);
      const opts = { file: fs.createReadStream(tmp), model: TRANSCRIBER.model, temperature: 0 };
      if (lang && lang !== 'au') opts.language = lang;   // 'au' = auto → omit
      const r = await TRANSCRIBER.client.audio.transcriptions.create(opts);
      res.json({ text: (r && r.text ? r.text : '').trim() });
    } catch (e) {
      console.error('[nexus] transcribe error:', e.message);
      res.status(500).json({ error: 'transcription failed' });
    } finally {
      fs.unlink(tmp, () => {});
    }
  });

/* ── 4. The endpoint ── */
app.post('/api/concierge', GUARD.limit('concierge'), GUARD.sanePrompt, async (req, res) => {
  // Accept both the frontend's {prompt} and the spec's {message}; session_id optional.
  const body = req.body || {};
  const prompt = (body.prompt || body.message || '').trim();
  const sessionId = body.session_id || body.sid || 'anon';
  if (!prompt) return res.status(400).json({ error: 'empty prompt' });

  const catalog = catalogOf(branchOf(req));
  const intent = classifyIntent(prompt);
  /* ── Reply language resolution (priority order) ──
     1. Script of the current message (typed Malayalam -> Malayalam)
     2. An explicit request ("can you speak in Malayalam?")
     3. The language the shopper chose earlier this session (sticky)
     4. A UI language hint sent by the client
     5. English                                                        */
  const script = detectScript(prompt);
  const asked = requestedLang(prompt);
  // Language chosen in the app/mic picker (e.g. "fr-FR" or "fr"). Essential for
  // Latin-script languages where we cannot detect the language from the script.
  const rawUi = typeof body.lang === 'string' ? body.lang.toLowerCase().slice(0, 2) : '';
  const uiLang = (rawUi && rawUi !== 'au') ? (ISO_LANG[rawUi] || LANG_NAMES[rawUi] || null) : null;
  // A clear sentence typed in plain English means the shopper switched back to
  // English — but only when they have NOT explicitly picked another language.
  const wordsEN = (prompt.match(/[A-Za-z]+/g) || []).length;
  const backToEnglish = !script && !asked && wordsEN >= 4 && (!uiLang || uiLang === 'English');
  if (script) SESSION_LANG.set(sessionId, script);
  else if (asked) SESSION_LANG.set(sessionId, asked);
  else if (backToEnglish) SESSION_LANG.delete(sessionId);
  const replyLang = script || asked || (backToEnglish ? 'English' : SESSION_LANG.get(sessionId)) || uiLang || 'English';
  if (uiLang && !script && !asked && !SESSION_LANG.has(sessionId) && uiLang !== 'English') SESSION_LANG.set(sessionId, uiLang);
  const langSwitch = !!asked && !script;   // they asked to switch while typing in English
  const history = getMemory(sessionId);
  const groups = buildGroups(catalog);
  // An "add-on" is a follow-up like "add drinks", "also snacks", "anything cheaper"
  // — only true when there's prior context in this session.
  const addOn = history.length > 0 && ADDON_RE.test(prompt);
  const already = suggestedSet(sessionId);
  // "Refine" requests ("cheaper", "instead", "swap") genuinely need prior context.
  // "Add a new thing" requests ("add drinks", "some snacks") do NOT — and feeding
  // the old recipe history just makes a small model repeat it. So for those, we
  // send the model a clean slate (no history) to keep it focused on the new ask.
  const wantsRefine = /\b(cheaper|cheapest|instead|swap|replace|budget|less|alternative|other brand|other size)\b/i.test(prompt);
  const historyForLLM = (addOn && !wantsRefine) ? [] : history;
  // If we just asked a clarifying question, this message is the ANSWER — proceed
  // to recommend and do NOT ask again.
  const pendingQuestion = PENDING_CLARIFY.get(sessionId) || '';
  const answeringClarify = !!pendingQuestion;

  // Keyword candidates — used to prioritise and as a no-LLM fallback plan.
  /* RAG retrieval: pull only the relevant products from the index instead of
     scanning the whole catalogue. Keeps AI latency flat from 1k to 100k SKUs.
     Falls back to the original linear search for tiny catalogues. */
  const ix = indexOf(branchOf(req));
  const expandedQuery = expandShoppingQuery(prompt);
  const primaryCandidates = ix.size > 2000
    ? ix.candidatesFor(expandedQuery || prompt, 80)
    : searchProducts(expandedQuery || prompt, catalog);
  const secondaryCandidates = (expandedQuery && expandedQuery !== prompt.toLowerCase())
    ? searchProducts(expandedQuery, catalog)
    : [];
  const candidates = mergeCandidates(primaryCandidates, secondaryCandidates, 80);
  const shoppingContext = extractShoppingContext(prompt);
  /* Budget: use the amount in this message, otherwise keep the one the shopper
     already gave this session so follow-ups ("i asked for 154", "add more",
     "anything cheaper") still build to the same budget. Cleared on a brand-new
     unrelated request or an explicit reset. */
  const askedBudget = parseBudget(prompt);
  if (askedBudget) SESSION_BUDGET.set(sessionId, askedBudget);
  else if (/\b(no budget|forget the budget|without budget|reset)\b/i.test(prompt)) SESSION_BUDGET.delete(sessionId);
  const stickyBudget = SESSION_BUDGET.get(sessionId) || null;
  // Reuse the sticky budget for cart-shaped follow-ups (not for one-off lookups
  // like "where is milk" or a nutrition question).
  const cartish = /\b(cart|basket|list|add|more|another|also|cheaper|instead|budget|buy|shop|grocery|groceries|week|month|people|family|protein|meal)\b/i.test(prompt);
  const budget = askedBudget || ((stickyBudget && cartish) ? stickyBudget : null);

  /* For nutrition questions, inject the real per-100g facts for the products the
     shopper is asking about (or their current cart context) so the AI quotes
     accurate numbers instead of guessing. */
  let nutriFacts = '';
  if (intent === 'nutrition' || intent === 'healthy_recommendation') {
    const seen = new Set(); const lines = [];
    for (const p of candidates) {
      const g = p.group || ('solo-' + p.id);
      if (seen.has(g) || !p.nutri) continue;
      seen.add(g);
      lines.push(`${g}: ${p.nutri.kcal}kcal, protein ${p.nutri.protein}g, carbs ${p.nutri.carbs}g, fat ${p.nutri.fat}g`);
      if (lines.length >= 25) break;
    }
    if (!lines.length) {           // no keyword match — give common staples
      for (const [g, members] of groups) {
        const p = members[0];
        if (!p.nutri || seen.has(g)) continue;
        seen.add(g);
        lines.push(`${g}: ${p.nutri.kcal}kcal, protein ${p.nutri.protein}g, carbs ${p.nutri.carbs}g, fat ${p.nutri.fat}g`);
        if (lines.length >= 20) break;
      }
    }
    if (lines.length) nutriFacts = '\n\nNUTRITION FACTS (per 100g/100ml — quote these exact numbers):\n' + lines.join('\n');
  }

  let reply = '';
  let followUp = '';
  let suggestions = [];
  let plan = [];
  let clarify = '';
  let recipe = null;
  let usedLLM = false;
  let llmError = '';

  // Deterministic short-circuit for acknowledgements / chit-chat ("ok", "thanks",
  // "understood", "hi"...). These must NEVER return products, and skipping the LLM
  // also eases the rate limit.
  const ACK_RE = /^(ok(ay)?|k|kk|understood|got ?it|noted|thanks?|thank you|thankyou|thx|ty|cool|nice|great|awesome|perfect|fine|alright|sure|done|yes|yeah|yep|no|nope|hmm+|hi+|hey+|hello|good)\b[\s!.]*$/i;
  // Only short-circuit for English acks — never when a language switch was asked
  // or the shopper is speaking another language (those need a localized reply).
  if (ACK_RE.test(prompt.trim()) && !answeringClarify && replyLang === 'English' && !asked) {
    reply = "Sure! What would you like to shop for — ingredients for a dish, fresh produce, or something specific?";
    PENDING_CLARIFY.delete(sessionId);
    pushMemory(sessionId, 'user', prompt);
    pushMemory(sessionId, 'assistant', reply);
    return res.json({
      key: 'ai_concierge', intent: 'general_conversation', reply, clarify: '', recipe: null,
      follow_up: '', suggestions: ['Ingredients for a dish', 'Fresh produce', 'Household items'],
      plan: [], products: [], meta: null, total: 0, session_id: sessionId, model: 'rule'
    });
  }

  // Deterministic clarify for a bare ambiguous dish (English only) — guarantees
  // "biryani -> which type?" and avoids a wasted LLM call.
  const amb = (!answeringClarify && !addOn && replyLang === 'English') ? ambiguousDish(prompt) : null;
  if (amb) {
    reply = `Sure — let's make ${amb.dish}!`;
    clarify = `Which ${amb.dish} would you like to make?`;
    suggestions = amb.opts;
    PENDING_CLARIFY.set(sessionId, clarify);
    pushMemory(sessionId, 'user', prompt);
    pushMemory(sessionId, 'assistant', reply + ' ' + clarify);
    return res.json({
      key: 'ai_concierge', intent, reply, clarify, recipe: null,
      follow_up: '', suggestions, plan: [], products: [], meta: null,
      total: 0, session_id: sessionId, model: 'rule'
    });
  }

  if (LLM && catalog.length) {
    const relevantMenu = relevantGroupMenu(candidates, groups, intent, prompt);
    const menuForLLM = relevantMenu || storeMenu(groups, !!budget);
    const systemPrompt =
`You are "DevX AI Concierge", a friendly grocery assistant for a UAE supermarket.

REPLY LANGUAGE: Write reply, clarify, options, follow_up, suggestions and any recipe text ONLY in ${replyLang}. Ignore the language of earlier messages — match THIS message.
You are FULLY MULTILINGUAL — you speak EVERY language (Malayalam, Arabic, Hindi, Urdu, Tamil, Bengali, Japanese, Chinese, French, Spanish, and any other). NEVER say you can only speak English, never refuse a language, and NEVER mention "rules" — always answer in ${replyLang}.
EVERY field must be in ${replyLang}, including "suggestions" and "options" (translate the chip text too — never leave them in English when ${replyLang} is not English).${langSwitch ? ` The shopper just asked you to switch to ${replyLang}: confirm warmly IN ${replyLang} and continue helping in ${replyLang}. Set items:[] and suggestions:[] unless they also asked for a product.` : ''}

Return STRICT JSON only (no markdown), exact shape:
{"reply":"1-2 sentences","in_scope":true,"clarify":"","options":[],"recipe":null,"items":[{"group":"basmati-rice","qty":1}],"follow_up":"","suggestions":["Add cold drinks"]}

RULES:
- "group" MUST be one of the exact comma-separated keys in STORE MENU below (e.g. basmati-rice, whole-chicken, onions). Never invent a key. Pick ONE key per need — the app shows the brands/sizes.
- SCOPE + "in_scope": You help with SUPERMARKET shopping — food & groceries, household, cleaning, personal care, baby, pet, stationery & office, electrical & batteries, kitchen & dining, plus recipes, meal/shopping planning and store navigation. If the request is a normal shopping request, set "in_scope": true. If it is NOT shopping (weather, news, jokes, general knowledge, "say something funny"), OR it is a physical item we do not sell (e.g. shoes, TV, furniture), set "in_scope": false, give a one-line polite reply, and set items:[], clarify:"", suggestions:[]. When in_scope is false you MUST return items:[] — NEVER show rice/chicken/onions or any product for an out-of-scope request.
- If a wanted product simply isn't in the STORE MENU but is a grocery-type item, say we don't currently stock it (in_scope true, items:[]). Do not refuse a normal product just because it isn't food.
- Every "suggestions"/"options" entry MUST be a NON-EMPTY short human phrase for something we actually stock (in the STORE MENU). Never output empty strings, and never suggest something we don't sell (e.g. don't offer "shoes" or "Naan Bread" unless it exists).
- CLARIFY is ONLY for a missing DISH variant (e.g. bare "biryani" -> Chicken/Mutton/Prawn/Vegetable; bare "cake" -> flavor). NEVER clarify about brand, size, quantity, or which type of an ingredient (e.g. "which rice?") — the app auto-picks the best value and shows the other options. If the dish/product is already specified ("chicken biryani", "basmati rice"), DO NOT clarify — return items. Ask AT MOST ONCE.${answeringClarify ? ' The current message ANSWERS your previous question — return items now, clarify:"".' : ''}
- items = the shopper's CART: the product groups with sensible quantities. When the shopper NAMES or ASKS FOR a product ("AA batteries", "do you have naan", "I need milk"), you MUST put that product's group in items right away — never just describe it or ask "would you like to add it" while leaving items empty. For a DISH (in ANY language, e.g. biryani, sambar, curry, pasta), include EVERY core ingredient we DO stock and pick ONE protein — even if a few traditional ingredients aren't in the menu, still add all the ones we have (e.g. sambar -> toor-dal, onions, tomatoes, carrots, tamarind if present, turmeric, chili-powder, ground-coriander, mustard/curry-leaf if present). NEVER reply "we have the ingredients" with an empty items list. Do NOT add several cuts of the same meat.
- "suggestions" and "options" must be short HUMAN-READABLE phrases (e.g. "AAA batteries", "Add cold drinks"), NEVER raw group-keys like "aaa-battery".
- Make every reply feel like a helpful shopping assistant: acknowledge the request, state the useful result, and keep it to 1-3 short sentences.
- Avoid robotic phrases such as "matches from our inventory", "as per your request", "I have identified", or "the following products".
- Briefly explain why the recommendation fits when useful. If the request is actionable, offer the next useful action instead of a generic question.
- Ask a clarifying question only when a missing detail is genuinely necessary; never ask for information already present in SHOPPING CONTEXT.
- ONLY return items the shopper actually asked for. If they ask a QUESTION (about languages, the store, your abilities, "what can you do"), or make small talk, return items:[]. Never pad the list with staples like rice/chicken the shopper never mentioned.
- recipe: fill title + 4-8 steps ONLY if the shopper explicitly asks for a recipe / how to cook / steps. For "cart", "ingredients", "what do I need", "build a cart", "suggest a cart" -> recipe MUST be null (just items).
- ADD-ON ("add", "also", "more"): return ONLY the new groups, never repeat earlier items.${addOn ? ' This IS an add-on — only new items, clarify:"".' : ''}
- Never mention prices (the app shows them). Keep follow_up short and proactive.

${budget ? `\nBUDGET MODE — the shopper has AED ${budget} to spend:
- Build a FULL cart that uses most of the budget: aim for AED ${Math.round(budget*0.85)}-${budget}, and NEVER exceed AED ${budget}.
- Use the price shown after each key below (AEDx = price of one unit) and raise "qty" where sensible to reach the budget.
- Include 6-12 varied groups that fit the request, not one or two items.\n` : ''}
${intent === 'app_help' ? `
HOW THIS APP WORKS — answer from these facts, do not invent:
• Items sold by weight (fruit, vegetables, loose rice/dal/nuts/spices) are priced per kg. At checkout you pick an approximate weight and see an ESTIMATE.
• Our team weighs the item at the store. The ACTUAL weight and the revised price then appear in "My Orders" on the order card, showing ordered vs actual weight and the difference.
• You are only ever charged for the ACTUAL weight — never the estimate.
• If the actual weight is within ±10% of what you ordered it is accepted automatically. If it differs by more than 10%, the order waits for you to tap "Approve new total" — nothing is charged until you approve.
• Payment options: (1) Cash — pay the driver on delivery. (2) Card machine — tap or insert on delivery. (3) Online payment — pay by card in the app; for weighed items the card is charged only after the weight is confirmed.
• Cash and card-machine orders are settled at the door for the final weighed amount.
• Past orders, live status and the weighed prices are all in "My Orders" (the Orders tab at the bottom).
• You can shop by typing or by voice, in any language.
` : ''}
SHOPPING CONTEXT:
${JSON.stringify(shoppingContext)}
RELEVANT STORE OPTIONS${budget ? ' (key=AEDprice)' : ''}:
${menuForLLM}${nutriFacts}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...historyForLLM.slice(-4),   // last 2 exchanges only → smaller/faster request
      { role: 'user', content: prompt }
    ];

    try {
      // Retry rate-limit hiccups a few times with growing backoff, so a transient
      // 429 becomes a slightly-slower success instead of the "I'm busy" message.
      // Also fall back to a second Groq model if the primary stays limited.
      let completion, attempt = 0;
      const MODELS = [LLM.model, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
      while (true) {
        try {
          completion = await LLM.client.chat.completions.create({
            model: MODELS[Math.min(attempt, MODELS.length - 1)],
            messages,
            temperature: 0.3,
            max_tokens: 650,
            response_format: { type: 'json_object' }
          });
          break;
        } catch (err) {
          const limited = err.status === 429 || /rate.?limit/i.test(err.message || '');
          if (attempt < 3 && limited) {
            attempt++;
            await new Promise(r => setTimeout(r, 1200 * attempt));
            continue;
          }
          throw err;
        }
      }
      const raw = completion.choices?.[0]?.message?.content || '';
      const parsed = parseLLMJson(raw);
      if (parsed && typeof parsed.reply === 'string') {
        reply = parsed.reply;
        followUp = typeof parsed.follow_up === 'string' ? parsed.follow_up : '';
        clarify = typeof parsed.clarify === 'string' ? parsed.clarify.trim() : '';
        if (answeringClarify) clarify = '';   // never re-ask after an answer
        // Off-topic / not-sold: the model set in_scope:false -> show NO products.
        const offTopic = parsed.in_scope === false;
        suggestions = Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter(s => typeof s === 'string' && s.trim()).slice(0, 4) : [];
        // Recipe steps (only when the shopper asked for a recipe).
        if (parsed.recipe && Array.isArray(parsed.recipe.steps) && parsed.recipe.steps.length) {
          recipe = {
            title: typeof parsed.recipe.title === 'string' ? parsed.recipe.title : '',
            steps: parsed.recipe.steps.filter(s => typeof s === 'string').slice(0, 10)
          };
        }
        if (offTopic || (langSwitch && !/\b(need|want|buy|add|show|find|have|get)\b/i.test(prompt))) {
          // Out of scope, or a pure "please speak X" request: no products this turn.
          clarify = ''; followUp = ''; recipe = null;
          if (langSwitch) suggestions = [];   // no stray product chips on a language switch
        } else {
          // Build the product list from items.
          let items = [];
          if (Array.isArray(parsed.items)) {
            items = parsed.items.map(it => ({ group: it.group, id: it.id, qty: it.qty }));
          } else if (Array.isArray(parsed.product_ids)) {
            items = parsed.product_ids.map(id => ({ id, qty: 1 }));
          }
          const seenGroups = new Set(), seenNames = new Set();
          for (const it of items) {
            let gkey = null, members = null;
            if (it.group && groups.has(it.group)) {
              gkey = it.group; members = groups.get(gkey);
            } else if (it.id != null) {
              const picked = catalog.find(p => String(p.id) === String(it.id));
              if (picked) { gkey = picked.group || ('solo-' + picked.id); members = groups.get(gkey) || [picked]; }
            }
            if (!members || seenGroups.has(gkey)) continue;   // one row per need
            const row = rowFromMembers(members, it.qty, groups);
            const nm = (row.p.name || '').toLowerCase();
            if (seenNames.has(nm)) continue;                  // no duplicate product names
            seenGroups.add(gkey); seenNames.add(nm);
            plan.push(row);
            if (plan.length >= 12) break;
          }
          // Products win: if we have products to show, don't block on a clarify.
          if (plan.length) {
            clarify = '';
          } else if (clarify) {
            const opts = Array.isArray(parsed.options) ? parsed.options.filter(s => typeof s === 'string' && s.trim()).slice(0, 4) : [];
            if (opts.length) suggestions = opts;
            followUp = '';
          }
        }
        usedLLM = true;
      }
    } catch (error) {
      llmError = (error && (error.status === 429 || /rate.?limit|too many|quota/i.test(error.message || ''))) ? 'rate' : 'other';
      console.error('[nexus] LLM (' + LLM.name + ') warning:', error.message);
    }
  }

  // Fallback when no LLM configured or the call failed / returned bad JSON.
  // IMPORTANT: never dump random products for things we don't understand.
  if (!usedLLM) {
    // Localized fallback text so a hiccup never breaks the shopper's language.
    const T = {
      busy: {
        English:"I'm handling a lot of requests right now — please try again in a few seconds.",
        Malayalam:"ഇപ്പോൾ ഒരുപാട് അഭ്യർത്ഥനകൾ ഉണ്ട് — ദയവായി കുറച്ച് സെക്കൻഡിനുശേഷം വീണ്ടും ശ്രമിക്കുക.",
        Arabic:"لدي الكثير من الطلبات الآن — يرجى المحاولة مرة أخرى بعد ثوانٍ.",
        Hindi:"अभी बहुत सारे अनुरोध आ रहे हैं — कृपया कुछ सेकंड बाद फिर से कोशिश करें।",
        Urdu:"اس وقت بہت سی درخواستیں ہیں — براہ کرم چند سیکنڈ بعد دوبارہ کوشش کریں۔",
        Tamil:"இப்போது நிறைய கோரிக்கைகள் உள்ளன — சில வினாடிகளில் மீண்டும் முயற்சிக்கவும்.",
        Bengali:"এখন অনেক অনুরোধ আসছে — অনুগ্রহ করে কয়েক সেকেন্ড পরে আবার চেষ্টা করুন।"
      },
      hello: {
        English:"Hi! I'm your DevX AI Concierge. Tell me what you'd like to cook or shop for and I'll pull the right items from our shelves.",
        Malayalam:"ഹായ്! ഞാൻ നിങ്ങളുടെ DevX AI കൺസിയേർജ് ആണ്. എന്ത് പാചകം ചെയ്യണം അല്ലെങ്കിൽ വാങ്ങണം എന്ന് പറയൂ.",
        Arabic:"مرحباً! أنا مساعدك DevX. أخبرني بما تريد طهيه أو شراءه وسأجهز لك القائمة.",
        Hindi:"नमस्ते! मैं आपका DevX AI कंसीयज हूँ। बताइए क्या पकाना या खरीदना है।",
        Urdu:"ہیلو! میں آپ کا DevX AI کنسیئرج ہوں۔ بتائیے کیا پکانا یا خریدنا ہے۔",
        Tamil:"வணக்கம்! நான் உங்கள் DevX AI உதவியாளர். என்ன சமைக்க அல்லது வாங்க வேண்டும் என்று சொல்லுங்கள்.",
        Bengali:"হ্যালো! আমি আপনার DevX AI কনসিয়ার্জ। কী রান্না বা কেনাকাটা করতে চান বলুন।"
      }
    };
    const L = s => (T[s][replyLang] || T[s].English);
    if (llmError === 'rate') {
      reply = L('busy');
    } else if (intent === 'general_conversation') {
      reply = L('hello');
      suggestions = replyLang === 'English' ? ['Ingredients for biryani', 'Something healthy', 'Snacks for movie night'] : [];
    } else if (candidates.length) {
      // We DID match real products to the words — safe to show them.
      const seenGroups = new Set(), seenNames = new Set();
      for (const p of candidates) {
        const gkey = p.group || ('solo-' + p.id);
        if (seenGroups.has(gkey)) continue;
        const row = resolveRow(p, 1, groups);
        const nm = (row.p.name || '').toLowerCase();
        if (seenNames.has(nm)) continue;          // no duplicate product names
        seenGroups.add(gkey); seenNames.add(nm);
        plan.push(row);
        if (plan.length >= 6) break;
      }
      const MATCH = {
        English:'Here are the matches from our live store inventory:',
        Malayalam:'ഞങ്ങളുടെ സ്റ്റോറിൽ ലഭ്യമായ ഉൽപ്പന്നങ്ങൾ ഇതാ:',
        Arabic:'إليك المنتجات المتوفرة في متجرنا:',
        Hindi:'हमारे स्टोर में उपलब्ध सामान:',
        Urdu:'ہمارے اسٹور میں دستیاب اشیاء:',
        Tamil:'எங்கள் கடையில் கிடைக்கும் பொருட்கள்:',
        Bengali:'আমাদের দোকানে উপলব্ধ পণ্য:'
      };
      reply = MATCH[replyLang] || MATCH.English;
      followUp = '';
    } else {
      // No match and not chit-chat: DON'T guess. Ask, don't dump.
      const HUH = {
        English:"I didn't quite catch that. I can help you find products, plan a recipe, or build a shopping list — what are you looking for?",
        Malayalam:'എനിക്ക് അത് വ്യക്തമായില്ല. ഉൽപ്പന്നങ്ങൾ കണ്ടെത്താനും പാചകക്കുറിപ്പ് തയ്യാറാക്കാനും ഞാൻ സഹായിക്കാം — എന്താണ് വേണ്ടത്?',
        Arabic:'لم أفهم ذلك تماماً. يمكنني مساعدتك في إيجاد المنتجات أو إعداد قائمة تسوق — ماذا تحتاج؟',
        Hindi:'मैं ठीक से समझ नहीं पाया। मैं सामान ढूंढने या शॉपिंग लिस्ट बनाने में मदद कर सकता हूँ — आपको क्या चाहिए?',
        Urdu:'میں ٹھیک سے سمجھ نہیں سکا۔ میں اشیاء تلاش کرنے میں مدد کر سکتا ہوں — آپ کو کیا چاہیے؟',
        Tamil:'எனக்கு அது சரியாக புரியவில்லை. பொருட்களைக் கண்டுபிடிக்க உதவ முடியும் — உங்களுக்கு என்ன வேண்டும்?',
        Bengali:'আমি ঠিক বুঝতে পারিনি। আমি পণ্য খুঁজতে সাহায্য করতে পারি — আপনার কী প্রয়োজন?'
      };
      reply = HUH[replyLang] || HUH.English;
      suggestions = replyLang === 'English' ? ['Ingredients for a dish', 'Something healthy', 'Household items'] : [];
    }
  }

  // NOTE: when the LLM succeeds we TRUST its item list. If it returned no items
  // that is deliberate (off-topic question or a clarifying question), so we must
  // NOT force-add keyword matches — that was causing random products to appear
  // for unrelated questions.

  // Safety net: on an add-on request, drop any rows whose group was already
  // shown earlier this session, so the model can't repeat the previous list.
  const rowGroup = r => r.p.group || ('solo-' + r.p.id);
  if (addOn && plan.length) {
    const fresh = plan.filter(r => !already.has(rowGroup(r)));
    if (fresh.length) plan = fresh;   // keep only new items; if all repeats, leave as-is
  }

  // Honest handling when an add-on request resolved to nothing (item not stocked):
  // don't let the model claim it "added" a product that isn't there.
  if (usedLLM && addOn && !clarify && !plan.length) {
    reply = "Sorry, we don't stock that one. Want me to suggest something similar we do carry?";
  }

  // Humanize any suggestion that leaked through as a raw group-key.
  const humanize = s => {
    if (groups.has(s)) return groups.get(s)[0].name;
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(s)) return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return s;
  };
  suggestions = suggestions.map(humanize);

  /* ── BUDGET FIT ──────────────────────────────────────────────
     Guarantee the cart respects the shopper's budget: trim if it
     overshoots, then top up (more qty, then related items) until we
     are within ~85-100% of the budget. Small models are unreliable
     at arithmetic, so we enforce it deterministically. */
  const lineOf = r => (r.p.loose ? loosePriceServer(r.p, r.grams || 500) : r.p.price * r.qty);
  /* A nutrition question should always show the product card (that is where the
     kcal/protein chips live). If the model answered in prose without picking an
     item, attach the best keyword match. */
  if (intent === 'nutrition' && !plan.length && !clarify && candidates.length) {
    const seenG = new Set(), seenN = new Set();
    for (const p of candidates) {
      const g = p.group || ('solo-' + p.id);
      if (seenG.has(g)) continue;
      const row = resolveRow(p, 1, groups);
      const nm = (row.p.name || '').toLowerCase();
      if (seenN.has(nm)) continue;
      seenG.add(g); seenN.add(nm);
      plan.push(row);
      if (plan.length >= 3) break;
    }
  }

  // A budget request must never come back empty — seed a sensible staples cart.
  if (budget && !plan.length && !clarify) {
    const STAPLES = ['basmati-rice','whole-chicken','full-cream-milk','eggs','onions','tomatoes',
      'potatoes','sunflower-oil','plain-yogurt','arabic-bread','bananas','apples','carrots',
      'flour-wheat','sugar','black-tea','lentils-red','cheese-slices'];
    for (const g of STAPLES) {
      if (!groups.has(g)) continue;
      plan.push(rowFromMembers(groups.get(g), 1, groups));
      if (plan.length >= 10) break;
    }
    if (plan.length) reply = reply && !/didn.t quite catch/i.test(reply) ? reply
      : `Here's a balanced cart within AED ${budget}:`;
  }
  if (budget && plan.length) {
    let sum = () => plan.reduce((s, r) => s + lineOf(r), 0);
    // 1) Trim while over budget (drop the priciest line last-added first)
    let guard = 0;
    while (sum() > budget && plan.length > 1 && guard++ < 40) {
      let idx = 0, worst = -1;
      plan.forEach((r, i) => { const v = lineOf(r); if (v > worst) { worst = v; idx = i; } });
      if (plan[idx].qty > 1) plan[idx].qty--; else plan.splice(idx, 1);
    }
    // 2) Top up toward the budget: first raise quantities, then add fitting items
    guard = 0;
    while (sum() < budget * 0.85 && guard++ < 60) {
      const room = budget - sum();
      const cheapest = plan.filter(r => !r.p.loose && r.p.price <= room && r.qty < 6)
                           .sort((a, b) => a.p.price - b.p.price)[0];
      if (cheapest) { cheapest.qty++; continue; }
      // add a new affordable group we have not shown yet
      let added = false;
      for (const [gkey, members] of groups) {
        if (gkey.startsWith('solo-')) continue;
        if (plan.some(r => (r.p.group || '') === gkey)) continue;
        const best = bestValue(members);
        if (!best || best.price > room) continue;
        plan.push(rowFromMembers(members, 1, groups));
        added = true; break;
      }
      if (!added) break;
    }
  }

  // Remember the groups we're showing now (for future add-on filtering).
  plan.forEach(r => already.add(rowGroup(r)));

  const total = plan.reduce((sum, r) => sum + lineOf(r), 0);

  // Track pending clarify so the NEXT message is treated as the answer.
  if (clarify) PENDING_CLARIFY.set(sessionId, clarify);
  else PENDING_CLARIFY.delete(sessionId);

  /* ── DEMAND SIGNAL CAPTURE ──────────────────────────────────────────
     Log what the shopper asked for and whether we could serve it. This is
     the raw material for the lost-sales / demand-gap report — the insight
     no POS can produce, because a POS only records what DID sell. */
  try {
    const terms = (typeof tokenizeQuery === 'function' ? tokenizeQuery(prompt) : prompt.toLowerCase().split(/\s+/))
      .filter(w => w.length > 2 && !STOPWORDS.has(w)).slice(0, 6);
    if (terms.length && intent !== 'general_conversation') {
      db['devx-queries'].unshift({
        at: new Date().toISOString(),
        prompt: prompt.slice(0, 160),
        terms,
        intent,
        lang: replyLang,
        fulfilled: plan.length > 0,
        // out-of-stock counts as unfulfilled demand even if we listed it
        outOfStock: plan.some(r => r.p.stock === 0)
      });
      db['devx-queries'] = db['devx-queries'].slice(0, 5000);
    }
  } catch (e) { /* never let analytics break a reply */ }

  // Save this exchange to memory (store the plain reply text).
  pushMemory(sessionId, 'user', prompt);
  pushMemory(sessionId, 'assistant', reply + (followUp ? ' ' + followUp : ''));

  res.json({
    key: 'ai_concierge',
    intent,
    reply,
    clarify,
    recipe,
    follow_up: followUp,
    suggestions,
    plan,
    products: plan.map(x => x.p),   // spec-compatible field
    meta: budget ? { budget, spent: Math.round(total * 100) / 100, remaining: Math.round((budget - total) * 100) / 100 } : null,
    total,
    session_id: sessionId,
    model: usedLLM ? LLM.name : 'keyword-fallback'
  });
});

/* Customer places an order */
app.post('/api/orders', GUARD.limit('write'), (req, res) => {
  const o = req.body || {};
  if (!Array.isArray(o.items) || !o.items.length) return res.status(400).json({ error: 'empty order' });
  if (o.items.length > 200) return res.status(400).json({ error: 'too many line items' });
  if (!['delivery', 'pickup'].includes(o.mode)) return res.status(400).json({ error: 'bad mode' });

  db['devx-order-count'] += 1;
  o.id = 'NX-' + String(db['devx-order-count']).padStart(4, '0');
  o.date = new Date().toISOString();
  o.status = 'new';
  o.history = [{ s: 'new', at: o.date }];
  // Payment method decides WHEN money moves. Default to cash on delivery,
  // which carries zero weight-variance risk for the store.
  o.payMethod = PAY.normaliseMethod(o.payMethod);

  /* Settle the shop before anything reads from it. Resolving afterwards meant
     an unknown branch id produced an empty catalogue and every line came back
     as "unknown product" instead of falling back to the founding branch. */
  o.branchId = STORES.resolve(db, { requested: o.branchId });
  const cat = catalogOf(o.branchId);
  let sub = 0;
  for (const it of o.items) {
    const p = cat.find(x => x.id === it.id);
    if (!p) return res.status(400).json({ error: 'unknown product ' + it.id });
    if (p.loose || it.loose) {
      // Loose item: priced by weight. grams -> line = perKg * grams/1000.
      const g = parseInt(it.grams, 10);
      if (!Number.isFinite(g) || g < 50 || g > 50000)
        return res.status(400).json({ error: p.name + ': weight must be between 50g and 50kg' });
      const grams = g;
      const perKg = p.perKg != null ? p.perKg : p.price;
      it.loose = true; it.grams = grams; it.perKg = perKg;
      it.name = p.name; it.loc = p.loc; it.unit = (grams >= 1000 ? (grams / 1000) + ' kg' : grams + ' g');
      it.price = Math.round(perKg * grams / 1000 * 100) / 100;   // line price
      it.qty = 1;
      sub += it.price;
    } else {
      // Quantity must be a sane positive integer (blocks negative/zero/NaN abuse).
      const q = parseInt(it.qty, 10);
      if (!Number.isFinite(q) || q < 1 || q > 999)
        return res.status(400).json({ error: p.name + ': quantity must be between 1 and 999' });
      it.qty = q;
      if (p.stock != null && p.stock < q) return res.status(409).json({ error: p.name + ': only ' + p.stock + ' left' });
      it.price = p.price; it.name = p.name; it.loc = p.loc; it.unit = p.unit;
      sub += p.price * q;
    }
  }
  o.sub = Math.round(sub * 100) / 100;
  o.fee = o.mode === 'delivery' ? 10 : 0;

  /* Redeem a personalised coupon, if one was applied. Validated server-side
     against the issued offer — the discount is never taken from the client,
     and the coupon is burned here so it cannot be reused on another order. */
  o.discount = 0;
  if (o.coupon) {
    const code = String(o.coupon).trim().toUpperCase();
    const off = (db['devx-personal-offers'] || []).find(x => x.code === code);
    const ok = LOY.isRedeemable(off, (o.customer && o.customer.phone) || null);
    if (!ok.ok) return res.status(400).json({ error: ok.error });
    const d = LOY.discountFor(off, o.items, o.sub);
    if (d.error) return res.status(400).json({ error: d.error });
    o.discount = d.amount;
    o.coupon = code;
    o.couponPct = off.pct;
    off.status = 'redeemed';
    off.redeemedAt = new Date().toISOString();
    off.savedAED = d.amount;
    off.orderId = o.id;
    off.orderTotal = Math.round((o.sub + o.fee - o.discount) * 100) / 100;
    activity('offer', `Coupon ${code} redeemed by ${(o.customer && o.customer.name) || 'Guest'} — AED ${d.amount} off ${o.id}`, o.branchId);
  }
  o.total = Math.round((o.sub + o.fee - o.discount) * 100) / 100;
  o.items.forEach(it => { const p = cat.find(x => x.id === it.id); if (p && !it.loose && p.stock != null) p.stock = Math.max(0, p.stock - it.qty); });
  saveAll();   // stock moved, so the catalogue row must be written too

  /* Money must NEVER be taken before a by-weight item is on the scale.
     A shopper ordering 500g may be handed 560g; charging the estimate up
     front means the store eats the difference (or overcharges the customer
     and has to refund). So an online order containing loose items parks in
     `awaiting_weight` until a picker weighs it, and only then does the
     customer get a pay button. Nothing to weigh → pay immediately.
     Cash and card-machine orders never pay in-app at all. */
  /* Check the slot server-side. A page left open for an hour would otherwise
     book a window that filled up or closed while it sat there. */
  if (o.mode === 'delivery' && o.slotKey) {
    const c = SLOTS.claim(STORES.scope(db['devx-orders'], o.branchId, STORES.fallbackId(db)),
                          TEN.slots(db, o.branchId), o.slotKey);
    if (!c.ok) return res.status(409).json({ error: c.error, code: 'slot_unavailable' });
    o.slotLabel = c.slot.label;
  }
  o.needsWeighing = PAY.hasLooseItems(o);
  o.weighed = false;
  o.payStatus = o.payMethod === 'online'
    ? (o.needsWeighing ? 'awaiting_weight' : 'awaiting_payment')
    : 'due_on_delivery';

  db['devx-orders'].unshift(o);
  activity('order', `New ${o.mode} order ${o.id} — ${(o.customer && o.customer.name) || 'Guest'} — AED ${o.total}`
    + (o.needsWeighing ? ' — NEEDS WEIGHING' : ''), o.branchId);
  notify('order', 'Order ' + o.id + ' placed',
    o.needsWeighing
      ? 'Your by-weight items are being weighed at the store. You will see the exact weight and final price before you pay.'
      : o.mode === 'delivery'
        ? "We're preparing your delivery. Track it live in My Orders."
        : 'Reserved at ' + ((o.branch || '').split('—')[1] || 'the store').trim() + '. Your pickup pass is ready.',
    o.cid, LOY.normalisePhone(o.customer && o.customer.phone));
  save();
  broadcast({ 'devx-orders': db['devx-orders'], 'devx-catalog': cat, 'devx-notifs-customer': db['devx-notifs-customer'], 'devx-activity': db['devx-activity'], 'devx-personal-offers': db['devx-personal-offers'] });
  res.json({ order: o, state: publicState(o.cid || '', {verifiedPhone: LOY.normalisePhone(o.customer && o.customer.phone), branchId:o.branchId}) });
});

/* Admin writes — PIN required */
/* ══════════════════════════════════════════════════════════
   WEIGH & PAY — loose items are priced AFTER the picker weighs
   them, so the store never loses money on weight variance and
   the customer is never silently overcharged.
══════════════════════════════════════════════════════════ */

// What payment options the app should offer (used by the checkout screen).
/* ══════════════════════════════════════════════════════════
   THE GROUP VIEW
   A manager's job is one shop, so every other screen is
   scoped to one shop. The person who owns forty of them
   needs the opposite: one page that ranks the shops and
   says which to walk into first.
══════════════════════════════════════════════════════════ */
app.get('/api/group/overview', need('insights.view'), (req, res) => {
  const mine = accessible(req);
  const a = actor(req);
  /* Only somebody who holds more than one shop has a group. A single-shop
     manager asking for this is not an error, it is just their own shop. */
  if (mine && mine.length < 2 && !STAFF.can(a.role, 'group.view'))
    return res.status(403).json({ error: 'You run one shop — your dashboard is the group' });

  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const out = ROLLUP.group(db, { STORES, TEN }, { days, branchIds: mine });
  res.json({ data: out, scope: mine ? 'area' : 'group' });
});

app.get('/api/branches', (req, res) => {
  res.json({ data: STORES.list(db).filter(b => b.active !== false) });
});

/* ══════════════════════════════════════════════════════════
   SETTING UP A NEW BRANCH
   A shop opens with an empty product list. Typing a thousand
   lines by hand is not a plan, so there are three ways in:
   a CSV export from their POS, a copy of a sister branch, or
   adding products one at a time in Inventory.
══════════════════════════════════════════════════════════ */

/* A manager belongs to one shop. Being allowed to edit inventory does not
   mean being allowed to rewrite a sister branch's entire product list. */
function ownsBranch(req, id) {
  const mine = accessible(req);
  return !mine || mine.includes(id);
}

app.get('/api/branches/:id/catalog/template', need('inventory.edit'), (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="devx-nexus-product-template.csv"');
  res.send(TEN.csvTemplate());
});

/* Import a CSV export. Deliberately forgiving about column names and order,
   because the file comes out of whatever POS the shop already runs. */
app.post('/api/branches/:id/catalog/import', need('inventory.edit'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '12mb' }), (req, res) => {
    const bid = req.params.id;
    if (!STORES.find(db, bid)) return res.status(404).json({ error: 'Unknown branch' });
    if (!ownsBranch(req, bid))
      return res.status(403).json({ error: 'You can only change your own shop' });
    const text = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
    const parsed = TEN.parseCsv(text, db);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, skipped: parsed.skipped });

    const mode = (req.query.mode || 'replace') === 'append' ? 'append' : 'replace';
    const existing = mode === 'append' ? TEN.catalog(db, bid) : [];
    TEN.setCatalog(db, bid, existing.concat(parsed.products));
    reindex(bid);
    audit(req, 'catalog.import', `${parsed.products.length} products into ${bid} (${mode})`, { branchId: bid });
    activity('stock', `Imported ${parsed.products.length} products into ${(STORES.find(db, bid) || {}).name || bid}`, bid);
    saveAll();
    res.json({ imported: parsed.products.length, mode,
               total: TEN.catalog(db, bid).length,
               skipped: parsed.skippedCount || 0, skippedRows: parsed.skipped });
  });

/* Copy a sister branch's list as a starting point. Stock is reset to zero
   unless asked otherwise — a new shop has received nothing yet, and an
   inherited stock figure would poison its first forecast and first pick. */
app.post('/api/branches/:id/catalog/copy', need('inventory.edit'), (req, res) => {
  const to = req.params.id;
  const from = (req.body || {}).from;
  if (!STORES.find(db, to)) return res.status(404).json({ error: 'Unknown branch' });
  if (!ownsBranch(req, to)) return res.status(403).json({ error: 'You can only change your own shop' });
  if (!STORES.find(db, from)) return res.status(400).json({ error: 'Choose a branch to copy from' });
  if (from === to) return res.status(400).json({ error: 'That is the same branch' });
  if (TEN.catalog(db, to).length && !(req.body || {}).overwrite)
    return res.status(409).json({ error: 'This branch already has products. Tick overwrite to replace them.' });

  const r = TEN.seedFrom(db, from, to, {
    keepStock: !!(req.body || {}).keepStock,
    categories: (req.body || {}).categories
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  reindex(to);
  audit(req, 'catalog.copy', `${r.copied} products from ${from} to ${to}`, { branchId: to });
  saveAll();
  res.json({ data: r });
});

/* What a branch currently holds — used by the admin branch switcher to show
   which shops are still empty. */
app.get('/api/branches/catalogs', need('branch.view'), (req, res) => {
  res.json({
    data: STORES.list(db).map(b => ({
      id: b.id, name: b.name, area: b.area,
      products: TEN.catalog(db, b.id).length,
      categories: [...new Set(TEN.catalog(db, b.id).map(p => p.cat))].length,
      inStock: TEN.catalog(db, b.id).filter(p => (p.stock || 0) > 0).length
    }))
  });
});

app.get('/api/branches/summary', need('branch.view'), (req, res) => {
  res.json({ data: STORES.summary(db, db['devx-orders']) });
});

app.post('/api/branches', need('branch.create'), (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Branch name is required' });
  const branches = STORES.list(db).slice();
  // materialise the implicit default before adding a second, or the first
  // branch's existing orders would suddenly belong to nothing
  if (!db['devx-branches'].length) branches.forEach(x => db['devx-branches'].push(x));
  const nb = STORES.makeBranch(b);
  db['devx-branches'].push(nb);
  audit(req, 'branch.create', `added ${nb.name} (${nb.area})`, { branchId: nb.id });
  save('devx-branches');
  res.json({ data: nb });
});

/* Structured errors, for a chain operator or for forwarding to Sentry. */
app.get('/api/errors', need('*'), (req, res) => {
  res.json({ data: STORES.recent(parseInt(req.query.limit, 10) || 50), health: STORES.health() });
});

app.get('/api/slots', (req, res) => {
  const bid = branchOf(req);
  res.json({ data: SLOTS.available(STORES.scope(db['devx-orders'], bid, STORES.fallbackId(db)),
                                   TEN.slots(db, bid)), branchId: bid });
});

app.get('/api/integrations', need('orders.view'), (req, res) => {
  res.json({ data: INTEG.status() });
});


/* ── ADMIN ORDER STATUS UPDATE ──────────────────────────────── */
app.post('/api/orders/:id/status', need('orders.view'), (req, res) => {
  const o=db['devx-orders'].find(x=>x.id===req.params.id);
  if(!o)return res.status(404).json({error:'order not found'});
  const bid=branchOf(req);
  if(bid&&o.branchId&&o.branchId!==bid)return res.status(403).json({error:'You can only update orders for your current branch'});
  const next=String((req.body||{}).status||'').toLowerCase();
  const flow=o.mode==='delivery'?['new','preparing','out','done']:['new','preparing','ready','done'];
  if(!flow.includes(next)&&next!=='cancelled')return res.status(400).json({error:'invalid order status'});
  const ci=flow.indexOf(String(o.status||'new').toLowerCase()),ni=flow.indexOf(next);
  if(ci<0)return res.status(409).json({error:'order is not in an updatable state'});
  if(next==='cancelled'){/* handled by dedicated admin action elsewhere */ return res.status(400).json({error:'invalid order status'});}
  if(ni!==ci+1)return res.status(409).json({error:'invalid status transition'});
  const now=new Date().toISOString();o.status=next;o.history=Array.isArray(o.history)?o.history:[];o.history.push({s:next,at:now});o.updatedAt=now;
  if(['out','done'].includes(next)){
    const pending=(db['devx-order-additions']||[]).filter(a=>a.orderId===o.id&&['pending_admin_approval','approved_awaiting_payment'].includes(a.status));
    if(pending.length) pending.forEach(a=>{a.status='locked_after_dispatch';a.lockedAt=now;a.history=Array.isArray(a.history)?a.history:[];a.history.push({s:'locked_after_dispatch',at:now})});
  }
  const messages={
    preparing:['Order '+o.id+' is being prepared','Our team has started preparing your items.'],
    ready:['Order '+o.id+' is ready for pickup!','Your order is ready for collection.'],
    out:['Order '+o.id+' is on the way','Your rider has been dispatched and your order is on the way.'],
    done:['Order '+o.id+' '+(o.mode==='pickup'?'collected':'delivered')+' ✓','Your order has been completed. Thank you for shopping with us!']
  };
  if(messages[next])notify('order',messages[next][0],messages[next][1],o.cid,LOY.normalisePhone(o.customer&&o.customer.phone));
  activity('order',`Order ${o.id} → ${next}`,o.branchId);save();
  broadcast({'devx-orders':db['devx-orders'],'devx-notifs-customer':db['devx-notifs-customer'],'devx-activity':db['devx-activity']});
  res.json({ok:true,order:o});
});

/* ── POST-ORDER ADDITION TOTAL SYNCHRONISATION ───────────────
   An approved addition changes the order's visible revised total immediately,
   while the products are still merged only after the additional payment.
   This lets both customer and admin see the same updated price without
   double-counting the addition when payment is completed. */
/* Reconcile COD additions that were approved before the immediate-merge
   behaviour was enabled. This keeps older approved requests from appearing
   as a separate basket after the admin/customer state is reloaded. */
function reconcileApprovedCodAdditions() {
  let changed=false;
  const additions=db['devx-order-additions']||[];
  for(const a of additions){
    if(a.status!=='approved_awaiting_payment') continue;
    const o=db['devx-orders'].find(x=>x.id===a.orderId);
    if(!o || String(o.payMethod||'').toLowerCase()==='online') continue;
    const existing=new Set((o.items||[]).map(i=>`${i.id}|${i.name}|${i.qty||1}|${i.grams||''}`));
    o.items=Array.isArray(o.items)?o.items:[];
    const cat=catalogOf(o.branchId);
    for(const it of (a.items||[])){
      const key=`${it.id}|${it.name}|${it.qty||1}|${it.grams||''}`;
      if(!existing.has(key)){
        o.items.push(it);
        existing.add(key);
        const p=cat.find(x=>String(x.id)===String(it.id));
        if(p && !it.loose && p.stock!=null)p.stock=Math.max(0,p.stock-it.qty);
      }
    }
    a.status='approved_cod_merged';
    a.mergedAt=new Date().toISOString();
    a.history=Array.isArray(a.history)?a.history:[];
    a.history.push({s:a.status,at:a.mergedAt,by:'system-reconcile'});
    recomputeApprovedAdditionTotal(o);
    changed=true;
  }
  if(changed)save();
  return changed;
}

function recomputeApprovedAdditionTotal(o) {
  if (!o) return 0;
  if (o.baseTotalBeforeAdditions == null) {
    o.baseTotalBeforeAdditions = Number(o.total || 0);
    o.baseSubtotalBeforeAdditions = Number(o.sub || 0);
  }
  const additions = (db['devx-order-additions'] || []).filter(a =>
    a.orderId === o.id &&
    ['approved_awaiting_payment', 'paid_merged'].includes(a.status)
  );
  const approvedExtra = Math.round(
    additions.reduce((sum, a) => sum + Number(a.total || 0), 0) * 100
  ) / 100;

  o.approvedAdditionTotal = approvedExtra;
  o.total = Math.round((Number(o.baseTotalBeforeAdditions || 0) + approvedExtra) * 100) / 100;
  o.sub = Math.round((Number(o.baseSubtotalBeforeAdditions || 0) + approvedExtra) * 100) / 100;
  o.updatedAt = new Date().toISOString();
  return approvedExtra;
}

/* ── POST-ORDER PRODUCT ADDITIONS ─────────────────────────────
   Customer submits a separate addition request. It must be > AED 15,
   staff approve/reject it, and approved additions are paid and merged
   into the original order. */
function additionForOrder(id) {
  return (db['devx-order-additions'] || []).filter(x => x.orderId === id);
}

app.get('/api/orders/:id/additions', (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!ownsOrder(req, o, 'orders.view')) return res.status(403).json({ error: 'This is not your order' });
  res.json({ data: additionForOrder(o.id) });
});

app.get('/api/order-additions', need('orders.view'), (req, res) => {
  const bid = branchOf(req);
  const list = (db['devx-order-additions'] || []).filter(a => {
    const o = db['devx-orders'].find(x => x.id === a.orderId);
    return o && (!bid || o.branchId === bid);
  });
  res.json({ data: list });
});

app.post('/api/orders/:id/additions', GUARD.limit('write'), (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!ownsOrder(req, o)) return res.status(403).json({ error: 'This is not your order' });
  if (['out','done','cancelled','dispatched','delivered','out_for_delivery'].includes(String(o.status||'').toLowerCase())) return res.status(409).json({ error: 'Additional products are locked because this order has already been dispatched or closed' });

  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No products selected' });
  if (items.length > 100) return res.status(400).json({ error: 'Too many line items' });

  const cat = catalogOf(o.branchId);
  let total = 0, clean = [];
  for (const raw of items) {
    const p = cat.find(x => String(x.id) === String(raw.id));
    if (!p) return res.status(400).json({ error: 'Unknown product ' + raw.id });
    if (p.loose || raw.loose) {
      const g = parseInt(raw.grams, 10);
      if (!Number.isFinite(g) || g < 50 || g > 50000) return res.status(400).json({ error: p.name + ': invalid weight' });
      const perKg = p.perKg != null ? p.perKg : p.price;
      const price = Math.round(perKg * g / 1000 * 100) / 100;
      clean.push({ id:p.id, name:p.name, loose:true, grams:g, perKg, price, qty:1, loc:p.loc, unit:g>=1000?(g/1000)+' kg':g+' g' });
      total += price;
    } else {
      const qty = parseInt(raw.qty,10);
      if (!Number.isFinite(qty) || qty < 1 || qty > 999) return res.status(400).json({ error: p.name + ': invalid quantity' });
      if (p.stock != null && p.stock < qty) return res.status(409).json({ error: p.name + ': only ' + p.stock + ' left' });
      clean.push({ id:p.id, name:p.name, qty, price:p.price, loc:p.loc, unit:p.unit });
      total += p.price * qty;
    }
  }
  total = Math.round(total * 100) / 100;
  if (total <= 15) return res.status(400).json({ error: 'Additional products must total more than AED 15 to submit a modification request', code:'minimum_not_met', minimum:15 });

  const now = new Date().toISOString();
  const a = { id:'ADD-' + Date.now().toString(36).toUpperCase(), orderId:o.id, branchId:o.branchId,
    cid:o.cid || null, customer:o.customer ? { name:o.customer.name, phone:o.customer.phone } : null,
    items:clean, total, status:'pending_admin_approval', createdAt:now, history:[{s:'pending_admin_approval',at:now}] };
  db['devx-order-additions'].unshift(a);
  notify('order', 'Addition request submitted — ' + o.id, `AED ${total} in additional products is waiting for store approval.`, o.cid, LOY.normalisePhone(o.customer && o.customer.phone));
  activity('order', `Addition request ${a.id} for ${o.id} — AED ${total} awaiting admin approval`, o.branchId);
  save(); broadcast({ 'devx-order-additions':db['devx-order-additions'], 'devx-notifs-customer':db['devx-notifs-customer'], 'devx-activity':db['devx-activity'] });
  res.status(201).json({ data:a });
});

app.post('/api/order-additions/:id/approve', need('orders.refund'), (req, res) => {
  const a = (db['devx-order-additions'] || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error:'addition request not found' });
  if (a.status !== 'pending_admin_approval') return res.status(409).json({ error:'request is not pending' });
  const o = db['devx-orders'].find(x => x.id === a.orderId);
  if (!o || ['done','cancelled','out','dispatched','delivered','out_for_delivery'].includes(String(o?.status||'').toLowerCase())) return res.status(409).json({ error:'original order is closed or already dispatched' });
  const cat = catalogOf(o.branchId);
  for (const it of a.items) {
    const p=cat.find(x=>String(x.id)===String(it.id));
    if (!p) return res.status(409).json({ error:'product no longer exists: '+it.name });
    if (!it.loose && p.stock != null && p.stock < it.qty) return res.status(409).json({ error:'insufficient stock for '+it.name });
  }
  const now=new Date().toISOString();
  const previousTotal = Number(o.total || 0);
  const isCOD = String(o.payMethod || '').toLowerCase() !== 'online';

  a.approvedAt=now;
  a.approvedBy=req.actor ? req.actor.name : 'Admin';

  if (isCOD) {
    /* COD additions are paid together with the original delivery, so there
       is no second payment step. Merge them into the same basket immediately. */
    const existing=new Set((o.items||[]).map(i=>`${i.id}|${i.name}|${i.qty||1}|${i.grams||''}`));
    o.items=Array.isArray(o.items)?o.items:[];
    for (const it of a.items) {
      const key=`${it.id}|${it.name}|${it.qty||1}|${it.grams||''}`;
      if (!existing.has(key)) {
        o.items.push(it);
        existing.add(key);
      }
      const p=cat.find(x=>String(x.id)===String(it.id));
      if (p && !it.loose && p.stock!=null) p.stock=Math.max(0,p.stock-it.qty);
    }
    a.status='approved_cod_merged';
    a.history.push({s:a.status,at:now,by:a.approvedBy});
    recomputeApprovedAdditionTotal(o);
  } else {
    a.status='approved_awaiting_payment';
    a.history.push({s:a.status,at:now,by:a.approvedBy});
    recomputeApprovedAdditionTotal(o);
  }

  notify(
    'order',
    'Addition approved — ' + o.id,
    isCOD
      ? `Your additional products (AED ${a.total}) were approved and merged into your order. Updated order total: AED ${o.total}. The additional amount will be collected on delivery.`
      : `Your additional products (AED ${a.total}) were approved. Updated order total: AED ${o.total}. Complete the additional payment to add the products to your order.`,
    o.cid,
    LOY.normalisePhone(o.customer && o.customer.phone)
  );
  activity('order', `Addition ${a.id} approved for ${o.id} — revised order total AED ${o.total}`, o.branchId);
  audit(req,'order.addition.approve',`${a.id} approved for ${o.id}`,{
    orderId:o.id,
    additionId:a.id,
    previousTotal,
    additionTotal:Number(a.total || 0),
    updatedTotal:Number(o.total || 0)
  });

  save();
  broadcast({
    'devx-orders':db['devx-orders'],
    'devx-order-additions':db['devx-order-additions'],
    'devx-notifs-customer':db['devx-notifs-customer'],
    'devx-activity':db['devx-activity']
  });
  res.json({
    data:a,
    order:o,
    previousTotal,
    additionTotal:Number(a.total || 0),
    updatedTotal:Number(o.total || 0)
  });
});

app.post('/api/order-additions/:id/reject', need('orders.refund'), (req, res) => {
  const a=(db['devx-order-additions']||[]).find(x=>x.id===req.params.id);
  if(!a)return res.status(404).json({error:'addition request not found'});
  if(a.status!=='pending_admin_approval')return res.status(409).json({error:'request is not pending'});
  const now=new Date().toISOString(); a.status='rejected'; a.rejectedAt=now; a.rejectedBy=req.actor?req.actor.name:'Admin'; a.reason=String((req.body||{}).reason||'Not approved by the store').slice(0,240); a.history.push({s:'rejected',at:now,by:a.rejectedBy});
  const o=db['devx-orders'].find(x=>x.id===a.orderId);
  if(o)notify('order','Addition request not approved — '+o.id,a.reason,o.cid,LOY.normalisePhone(o.customer&&o.customer.phone));
  save(); broadcast({'devx-order-additions':db['devx-order-additions'],'devx-notifs-customer':db['devx-notifs-customer']});
  res.json({data:a});
});

app.post('/api/order-additions/:id/pay', GUARD.limit('write'), (req,res) => {
  const a=(db['devx-order-additions']||[]).find(x=>x.id===req.params.id);
  if(!a)return res.status(404).json({error:'addition request not found'});
  const o=db['devx-orders'].find(x=>x.id===a.orderId);
  if(!o)return res.status(404).json({error:'original order not found'});
  if(!ownsOrder(req,o))return res.status(403).json({error:'This is not your order'});
  if(a.status!=='approved_awaiting_payment')return res.status(409).json({error:'addition is not awaiting payment'});
  const now=new Date().toISOString(), cat=catalogOf(o.branchId);
  for(const it of a.items){ const p=cat.find(x=>String(x.id)===String(it.id)); if(!p || (!it.loose && p.stock!=null && p.stock<it.qty))return res.status(409).json({error:'Stock changed for '+it.name}); }
  for(const it of a.items){ const p=cat.find(x=>String(x.id)===String(it.id)); if(p&&!it.loose&&p.stock!=null)p.stock=Math.max(0,p.stock-it.qty); }
  a.status='paid_merged';
  a.paidAt=now;
  a.history.push({s:'paid_merged',at:now});

  // Avoid adding the amount a second time: the revised total was already
  // calculated when the admin approved this addition.
  o.items.push(...a.items);
  recomputeApprovedAdditionTotal(o);
  o.history.push({s:'products_added',at:now,additionId:a.id});
  notify('order','Products added to order — '+o.id,`Additional payment of AED ${a.total} received. The new products are now part of your order.`,o.cid,LOY.normalisePhone(o.customer&&o.customer.phone));
  activity('order',`Addition ${a.id} paid and merged into ${o.id} — AED ${a.total}`,o.branchId);
  saveAll(); broadcast({'devx-orders':db['devx-orders'],'devx-order-additions':db['devx-order-additions'],'devx-notifs-customer':db['devx-notifs-customer'],'devx-activity':db['devx-activity']});
  res.json({data:a,order:o});
});

/* Start a real card payment. With the mock driver this settles immediately;
   with a live gateway it returns a redirect and settlement arrives by webhook. */
app.post('/api/orders/:id/checkout', GUARD.limit('write'), async (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!ownsOrder(req, o, 'orders.pay'))
    return res.status(403).json({ error: 'This is not your order' });
  if (o.payStatus !== 'awaiting_payment')
    return res.status(409).json({ error: 'This order is not awaiting payment' });

  const drv = INTEG.payDriver();
  const r = await drv.charge({
    orderId: o.id, amountAED: o.total, customer: o.customer,
    last4: String((req.body || {}).last4 || '').slice(-4),
    returnUrl: (req.headers.origin || '') + '/?paid=' + o.id
  });
  if (!r.ok) return res.status(502).json({ error: r.error || 'The payment gateway refused the request' });

  if (r.settled) {           // mock driver: mark it here
    o.payStatus = 'paid';
    o.paidAt = new Date().toISOString();
    o.payRef = r.ref;
    o.history.push({ s: 'paid', at: o.paidAt });
    activity('order', `${o.id} paid — AED ${o.total} (${drv.name})`, o.branchId);
    audit(req, 'order.pay', `${o.id}: AED ${o.total} via ${drv.name}`, { orderId: o.id });
    save(); broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'] });
  } else {
    o.payRef = r.ref;        // live gateway: await the webhook
    save();
  }
  res.json({ data: { settled: !!r.settled, redirect: r.redirect || null, ref: r.ref, driver: drv.name, note: r.note } });
});

/* Gateway callback. Verified by the driver — an unsigned callback must never
   be able to mark an order paid. */
app.post('/api/payments/webhook', express.json({ limit: '256kb' }), (req, res) => {
  const drv = INTEG.payDriver();
  const v = drv.verifyWebhook(req);
  if (!v.ok) return res.status(400).json({ error: v.error || 'signature check failed' });
  const o = db['devx-orders'].find(x => x.id === v.orderId);
  if (!o) return res.status(404).json({ error: 'unknown order' });
  if (v.paid && o.payStatus !== 'paid') {
    o.payStatus = 'paid'; o.paidAt = new Date().toISOString(); o.payRef = v.ref || o.payRef;
    o.history.push({ s: 'paid', at: o.paidAt });
    notify('order', 'Payment received — ' + o.id, `AED ${o.total} confirmed.`, o.cid,
      LOY.normalisePhone(o.customer && o.customer.phone));
    activity('order', `${o.id} paid via ${drv.name} webhook`, o.branchId);
    audit(req, 'order.pay', `${o.id}: AED ${o.total} confirmed by ${drv.name} webhook`, { orderId: o.id });
    save(); broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'] });
  }
  res.json({ ok: true });
});

app.get('/api/payment-methods', (req, res) => {
  res.json({
    methods: Object.entries(PAY.PAYMENT_METHODS).map(([k, v]) => ({ key: k, ...v })),
    tolerancePct: PAY.TOLERANCE * 100,
    preauthBufferPct: PAY.PREAUTH_BUFFER * 100
  });
});

// Picker enters the actual weights: { id, items:[{id, actualGrams}] }
app.post('/api/orders/:id/weigh', need('orders.weigh'), (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });

  const weights = new Map((req.body.items || []).map(w => [Number(w.id), parseInt(w.actualGrams, 10)]));
  o.items = o.items.map(it => {
    if (!it.loose) return it;
    const g = weights.get(Number(it.id));
    if (!Number.isFinite(g) || g < 1) return it;
    return PAY.applyActualWeight(it, g);
  });

  const prevTotal = o.total;
  const totals = PAY.recalcOrder(o);
  Object.assign(o, totals);
  /* `status` is the FULFILMENT track (new → preparing → out → done) and the
     admin board is driven by it. Weighing and paying are a parallel track,
     so they must not overwrite it — doing so used to drop the order out of
     every board filter the moment it was weighed. */
  o.weighed = true;
  o.weighedAt = new Date().toISOString();
  o.weighedBy = req.actor ? req.actor.name : 'Shared PIN';
  o.history.push({ s: 'weighed', at: o.weighedAt });

  if (o.payMethod === 'online') {
    // money moves before the customer sees the goods, so a big swing needs
    // their explicit approval first; inside tolerance they just pay.
    o.needsApproval = totals.needsApproval;
    o.payStatus = totals.needsApproval ? 'awaiting_approval' : 'awaiting_payment';
  } else {
    /* Cash and card machine settle at the door, where the customer has the
       goods and the receipt in front of them — there is nothing to approve
       in advance. Leaving needsApproval set here wedged the order: staff
       could not record the cash because the pay guard was waiting on an
       approval that this flow never asks for. */
    o.needsApproval = false;
    o.payStatus = 'due_on_delivery';
  }

  const diff = Math.round((o.total - prevTotal) * 100) / 100;
  notify('order', 'Your items have been weighed — ' + o.id,
    `Actual weight recorded. Final total AED ${o.total}` +
    (diff ? ` (${diff > 0 ? '+' : ''}AED ${diff} vs your estimate)` : ' — exactly as estimated') +
    (o.payMethod === 'online'
      ? (totals.needsApproval ? '. Please review and approve the new total.' : '. Tap to pay now.')
      : '. Pay on delivery.'),
    o.cid);
  activity('order', `Weighed ${o.id} — AED ${prevTotal} → AED ${o.total}${totals.needsApproval ? ' (needs customer approval)' : ''}`, o.branchId);
  audit(req, 'order.weigh', `${o.id}: AED ${prevTotal} → AED ${o.total}`, { orderId: o.id });
  save(); broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'], 'devx-notifs-customer': db['devx-notifs-customer'] });
  res.json({ order: o, nextAction: PAY.nextAction(o) });
});

// Customer approves a reweighed total that fell outside tolerance.
app.post('/api/orders/:id/confirm', (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  /* Approving a revised weight commits the customer to a higher price, so it
     must come from that customer (or staff acting for them at the counter). */
  if (!ownsOrder(req, o, 'orders.weigh'))
    return res.status(403).json({ error: 'This is not your order' });
  o.needsApproval = false;
  o.approvedAt = new Date().toISOString();
  o.history.push({ s: 'approved', at: o.approvedAt });
  o.payStatus = o.payMethod === 'online' ? 'awaiting_payment' : 'due_on_delivery';
  activity('order', `${o.id} weight approved by customer — AED ${o.total} (${PAY.PAYMENT_METHODS[o.payMethod].label})`, o.branchId);
  save(); broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'] });
  res.json({ order: o, nextAction: PAY.nextAction(o) });
});

// Mark money received — admin (POS/driver) or the customer's own card sheet.
app.post('/api/orders/:id/pay', (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  /* The customer pays from their own device and has no admin PIN, so allow an
     unauthenticated pay ONLY on an order that is genuinely waiting for it.
     Anything else (marking a cash order settled, say) still needs staff. */
  /* The shopper settles their own order from their phone with no staff token;
     anyone recording a payment on someone else's behalf must be a cashier. */
  const payer = actor(req);
  if (!payer) {
    // a shopper settling their own order: must be awaiting payment AND theirs
    if (o.payStatus !== 'awaiting_payment')
      return res.status(401).json({ error: 'unauthorized' });
    if (!ownsOrder(req, o))
      return res.status(403).json({ error: 'This is not your order' });
  }
  if (payer && !STAFF.can(payer.role, 'orders.pay'))
    return res.status(403).json({ error: `Your role (${payer.role}) cannot take payments`, code: 'forbidden' });
  if (o.needsWeighing && !o.weighed)
    return res.status(409).json({ error: 'items must be weighed before payment' });
  if (o.needsApproval)
    return res.status(409).json({ error: 'customer must approve the new weight first' });
  o.payStatus = 'paid';
  o.paidAt = new Date().toISOString();
  o.payRef = String(req.body.ref || '').slice(0, 60) || null;
  o.paidBy = payer ? payer.name : 'Customer';
  o.history.push({ s: 'paid', at: o.paidAt });
  notify('order', 'Payment received — ' + o.id,
    `AED ${o.total} paid via ${PAY.PAYMENT_METHODS[o.payMethod].label}. Your order is confirmed.`, o.cid);
  activity('order', `${o.id} paid — AED ${o.total} via ${PAY.PAYMENT_METHODS[o.payMethod].label}`, o.branchId);
  audit(req, 'order.pay', `${o.id}: AED ${o.total} via ${PAY.PAYMENT_METHODS[o.payMethod].label}`, { orderId: o.id });
  save(); broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'], 'devx-notifs-customer': db['devx-notifs-customer'] });
  res.json({ order: o });
});

app.post('/api/orders/:id/refund', need('orders.refund'), (req, res) => {
  const o = db['devx-orders'].find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (o.payStatus !== 'paid' && o.payStatus !== 'part_refunded')
    return res.status(409).json({ error: 'Only a paid order can be refunded' });

  const b = req.body || {};
  const r = SLOTS.refund(o, { amount: b.amount, reason: b.reason, items: b.items,
    by: req.actor ? req.actor.name : 'staff' });
  if (!r.ok) return res.status(400).json({ error: r.error });

  notify('order', 'Refund issued — ' + o.id,
    `AED ${r.refund.amountAED} has been refunded. Reason: ${r.refund.reason}`, o.cid,
    LOY.normalisePhone(o.customer && o.customer.phone));
  activity('order', `Refund AED ${r.refund.amountAED} on ${o.id} — ${r.refund.reason}`, o.branchId);
  audit(req, 'order.refund', `${o.id}: AED ${r.refund.amountAED} — ${r.refund.reason}`, { orderId: o.id });
  save();
  broadcast({ 'devx-orders': db['devx-orders'], 'devx-activity': db['devx-activity'],
              'devx-notifs-customer': db['devx-notifs-customer'] });
  res.json({ data: r, order: o });
});

/* ══════════════════════════════════════════════════════════
   VALUE-ADDED SERVICES — insight the store's POS cannot give.
══════════════════════════════════════════════════════════ */
app.get('/api/insights/:report', need('insights.view'), (req, res) => {
  const bid = branchOf(req);
  const cat = catalogOf(bid);
  const ord = STORES.scope(db['devx-orders'], bid, STORES.fallbackId(db));
  const qs = db['devx-queries'] || [];
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const t0 = Date.now();
  let data;
  switch (req.params.report) {
    case 'demand-gap':  data = INSIGHT.demandGap(qs, cat, days); break;
    case 'reorder':     data = INSIGHT.reorderSuggestions(ord, cat, { window: days }); break;
    case 'health':      data = INSIGHT.inventoryHealth(ord, cat, { window: days }); break;
    case 'expiry':      data = INSIGHT.expiryWatch(cat); break;
    case 'affinity':    data = INSIGHT.basketAffinity(ord); break;
    case 'summary':
      data = {
        health: INSIGHT.inventoryHealth(ord, cat, { window: days }),
        reorderCount: INSIGHT.reorderSuggestions(ord, cat, { window: days }).length,
        demandGapTop: INSIGHT.demandGap(qs, cat, days).slice(0, 5),
        expiryCount: INSIGHT.expiryWatch(cat).length,
        queriesLogged: qs.length
      };
      break;
    default: return res.status(400).json({ error: 'unknown report' });
  }
  res.json({ report: req.params.report, days, took_ms: Date.now() - t0, data });
});

/* ══════════════════════════════════════════════════════════
   DEVX FORECAST-AI — Sales Forecasting · Demand Engine ·
   Optimization · Financial Forecast · Warehouse planner
══════════════════════════════════════════════════════════ */
app.get('/api/forecast/:module', need('forecast.view'), (req, res) => {
  const bid = branchOf(req);
  const cat = catalogOf(bid);
  const ord = STORES.scope(db['devx-orders'], bid, STORES.fallbackId(db));
  const t0 = Date.now();
  let data;
  try {
    switch (req.params.module) {
      case 'demand': {
        data = FC.demandEngine(cat, ord, { limit: Math.min(80, parseInt(req.query.limit,10) || 40), periodDays: parseInt(req.query.days,10) || 30 });
        /* Enrich each forecast with what the OTHER modules know about that
           SKU. A reorder line that also carries "9 loyalty members buy this,
           2 already drifting, promised in a live coupon" ranks itself. */
        const ctx = { members: members(bid), queries: db['devx-queries'] || [],
                      offers: STORES.scope(db['devx-personal-offers'] || [], bid, STORES.fallbackId(db)),
                      catalog: cat };
        data = data.map(d => ({ ...d, signals: FC.linkSignals(d.id, ctx) }));
        break;
      }
      case 'optimization':data = FC.optimization(cat, ord); break;
      case 'financial':   data = FC.financial(cat, ord, { months: Math.min(12, parseInt(req.query.months,10) || 6) }); break;
      case 'warehouse':   data = FC.warehouses(cat, ord, TEN.zones(db, bid)); break;
      case 'zones':       data = { defaults: FC.zoneDefaults(), overrides: TEN.zones(db, bid), branchId: bid }; break;
      case 'events':      data = { events: FC.UAE_EVENTS, current: FC.seasonalFactor(new Date().getMonth(), req.query.cat || 'default') }; break;
      case 'summary': {
        const dem = FC.demandEngine(cat, ord, { limit: 40 });
        const opt = FC.optimization(cat, ord);
        const fin = FC.financial(cat, ord, { months: 3 });
        data = {
          forecastQty: dem.reduce((s,d)=>s+(d.forecast?d.forecast.qty:0),0),
          forecastRevenueAED: Math.round(dem.reduce((s,d)=>s+(d.revenueAED||0),0)),
          avgConfidence: dem.length ? Math.round(dem.reduce((s,d)=>s+(d.forecast?d.forecast.confidence:0),0)/dem.length) : 0,
          poValueAED: Math.round(dem.reduce((s,d)=>s+(d.poCostAED||0),0)),
          healthScore: opt.healthScore, buckets: opt.buckets,
          topActions: opt.actions.slice(0,3),
          finance: { revenue: fin.totalRevenueAED, gp: fin.totalGrossProfitAED, margin: fin.marginPct },
          events: FC.seasonalFactor(new Date().getMonth(), 'default').events
        };
        break;
      }
      default: return res.status(400).json({ error: 'unknown module' });
    }
  } catch (e) {
    console.error('[nexus] forecast error:', e.message);
    return res.status(500).json({ error: 'forecast failed' });
  }
  res.json({ module: req.params.module, took_ms: Date.now() - t0, data });
});

/* Interactive forecast calculator (the LIVE tool from DevX ForecastAI). */
app.post('/api/forecast/calc', need('forecast.view'), (req, res) => {
  const b = req.body || {};
  const history = Array.isArray(b.history) ? b.history.map(Number).filter(n => Number.isFinite(n)) : [];
  if (!history.length) return res.status(400).json({ error: 'provide at least one month of sales history' });
  const out = FC.purchaseOrder({
    history,
    stock: Number(b.stock) || 0,
    safety: Number(b.safety) || 0,
    leadDays: Number(b.leadDays) || 3,
    periodDays: Number(b.periodDays) || 30,
    cat: b.cat || 'default',
    price: Number(b.price) || 0,
    cost: Number(b.cost) || 0,
    month: b.month != null ? Number(b.month) : new Date().getMonth()
  });
  const input = { ...b, history, periodDays: Number(b.periodDays) || 30 };
  res.json({ input: b, data: out, report: FC.calcReport(input, out) });
});

/* Store-editable floor plan. The defaults are a starting point — only the
   store knows how much space a zone actually has. */
app.post('/api/forecast/zones', need('forecast.edit'), (req, res) => {
  const b = req.body || {};
  const cat = String(b.cat || '').trim();
  if (!cat) return res.status(400).json({ error: 'category required' });
  const bid = branchOf(req);
  const zones = TEN.zones(db, bid);

  if (b.reset) {
    delete zones[cat];
    activity('stock', `Zone "${cat}" reset to the default floor plan`, bid);
  } else {
    const area = Number(b.areaM2), dens = Number(b.density);
    if (b.areaM2 != null && (!Number.isFinite(area) || area <= 0 || area > 5000))
      return res.status(400).json({ error: 'floor area must be between 1 and 5000 m²' });
    if (b.density != null && (!Number.isFinite(dens) || dens <= 0 || dens > 1000))
      return res.status(400).json({ error: 'storage density must be between 1 and 1000 units/m²' });
    const cur = zones[cat] || {};
    zones[cat] = {
      zone: b.zone != null ? String(b.zone).slice(0, 40) : cur.zone,
      type: b.type != null ? String(b.type).slice(0, 40) : cur.type,
      areaM2: b.areaM2 != null ? area : cur.areaM2,
      density: b.density != null ? dens : cur.density
    };
    activity('stock', `Zone "${zones[cat].zone || cat}" updated — ${zones[cat].areaM2 || '—'} m², ${zones[cat].density || '—'} units/m²`, bid);
  }
  TEN.setZones(db, bid, zones);
  save('devx-zones');
  broadcast({ 'devx-activity': db['devx-activity'] });
  res.json({ data: { cat, config: zones[cat] || null, branchId: bid } });
});

/* ══════════════════════════════════════════════════════════
   LOYALTY INTELLIGENCE & PERSONALISED OFFERS
   The store's loyalty programme knows till spend; we know app
   behaviour. Joined on mobile number, the pair reveals a
   customer whose spend is quietly falling — and lets us put a
   personal coupon in front of them before they stop coming.
══════════════════════════════════════════════════════════ */
/* The seeded shop carries a demo loyalty export so the sales demo has
   something to show. A shop the customer created themselves must never be
   handed invented customers with invented spend — they would be shown their
   own store's screen full of somebody else's numbers, which is worse than an
   empty page and destroys trust the moment they look closely.

   So: real rows for the branch that rang them up; the demo book only for the
   seeded demo branch, which is the one with no createdAt because nobody
   opened it through the panel. */
function isSeededDemoBranch(bid) {
  const b = STORES.find(db, bid);
  return !!b && !b.createdAt && bid === STORES.fallbackId(db);
}
function loyaltyRows(bid) {
  const id = bid || STORES.fallbackId(db);
  const def = STORES.fallbackId(db);
  const rows = STORES.scope(db['devx-loyalty'] || [], id, def);
  if (rows.length) return rows;
  return isSeededDemoBranch(id) ? LOY.demoLoyalty() : [];
}
function members(bid) {
  const id = bid || STORES.fallbackId(db);
  const def = STORES.fallbackId(db);
  return LOY.buildMembers(loyaltyRows(id), STORES.scope(db['devx-orders'] || [], id, def));
}

app.get('/api/loyalty/:report', need('loyalty.view'), (req, res) => {
  const t0 = Date.now();
  const bid = branchOf(req);
  const mem = members(bid);
  const offers = STORES.scope(db['devx-personal-offers'] || [], bid, STORES.fallbackId(db));
  let data;
  switch (req.params.report) {
    case 'members':  data = mem.sort((a, b) => b.baselineAED - a.baselineAED); break;
    case 'triggers': {
      // hide anyone who already holds a live coupon — do not spam them
      const live = new Set(offers.filter(o => o.status === 'active').map(o => o.phone));
      data = LOY.triggers(mem).filter(t => !live.has(t.phone));
      break;
    }
    case 'offers':   data = offers; break;
    case 'summary':  data = LOY.programme(mem, offers); break;
    default: return res.status(400).json({ error: 'unknown report' });
  }
  res.json({ report: req.params.report, took_ms: Date.now() - t0, data });
});

// Products worth putting in front of this member (wants it / store wants it gone)
app.get('/api/loyalty/candidates/:phone', need('loyalty.view'), (req, res) => {
  const bid = branchOf(req);
  const m = members(bid).find(x => x.phone === LOY.normalisePhone(req.params.phone));
  if (!m) return res.status(404).json({ error: 'member not found' });
  const cat = catalogOf(bid), ord = db['devx-orders'] || [];
  res.json({
    data: LOY.offerCandidates(cat, ord, m),
    usuallyBuys: LOY.usuallyBuys(m, cat)
  });
});

// Issue a personalised coupon
app.post('/api/loyalty/issue', need('loyalty.issue'), (req, res) => {
  const b = req.body || {};
  const phone = LOY.normalisePhone(b.phone);
  if (!phone) return res.status(400).json({ error: 'valid mobile number required' });
  const m = members(branchOf(req)).find(x => x.phone === phone);
  if (!m) return res.status(404).json({ error: 'member not found' });

  const pct = Number(b.pct);
  if (!Number.isFinite(pct) || pct < 5 || pct > 70)
    return res.status(400).json({ error: 'discount must be between 5% and 70%' });

  const cat = catalogOf(branchOf(req));
  const products = Array.isArray(b.productIds) && b.productIds.length
    ? b.productIds.map(id => cat.find(p => p.id === Number(id))).filter(Boolean)
    : [];
  const trig = b.trigger || (LOY.triggers([m])[0] || null);

  const offer = LOY.buildOffer({
    member: m, trigger: trig, pct, products,
    validDays: Math.min(90, Math.max(1, Number(b.validDays) || 14)),
    minSpend: Number(b.minSpend) || 0,
    issuedBy: b.issuedBy || 'AI'
  });
  db['devx-personal-offers'].unshift(offer);

  notify('offer', `Your personal offer — ${offer.pct}% off`,
    `${offer.headline}. Use code ${offer.code}${products.length ? ' on ' + products.map(p => p.name).join(', ') : ' on your next order'}. Valid until ${new Date(offer.expiresAt).toLocaleDateString()}.`,
    null, phone);
  activity('offer', `Personal offer ${offer.code} — ${offer.pct}% for ${offer.name} (${offer.kind.replace('_', ' ')})`);
  audit(req, 'loyalty.issue', `${offer.code}: ${offer.pct}% to ${offer.name}`);
  save();
  broadcast({ 'devx-personal-offers': db['devx-personal-offers'], 'devx-notifs-customer': db['devx-notifs-customer'], 'devx-activity': db['devx-activity'] });
  res.json({ data: offer });
});

app.post('/api/loyalty/revoke/:id', need('loyalty.issue'), (req, res) => {
  const o = (db['devx-personal-offers'] || []).find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'offer not found' });
  o.status = 'revoked';
  activity('offer', `Personal offer ${o.code} revoked`);
  save(); broadcast({ 'devx-personal-offers': db['devx-personal-offers'], 'devx-activity': db['devx-activity'] });
  res.json({ data: o });
});

// Import a loyalty export from the store's own system
app.post('/api/loyalty/import', need('loyalty.issue'), (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'expected { rows: [...] }' });
  const clean = rows.filter(r => LOY.normalisePhone(r.phone)).slice(0, 100000);
  db['devx-loyalty'] = clean;
  activity('offer', `Loyalty import — ${clean.length} card-holders synced`);
  save(); broadcast({ 'devx-activity': db['devx-activity'] });
  res.json({ imported: clean.length, skipped: rows.length - clean.length });
});

/* ── Customer-facing: my offers, and coupon redemption ── */
app.get('/api/my-offers', (req, res) => {
  const s = shopper(req);
  const phone = (s && s.phone) || LOY.normalisePhone(req.query.phone);
  if (!phone) return res.json({ data: [] });
  const now = new Date();
  const mine = (db['devx-personal-offers'] || []).filter(o =>
    o.phone === phone && o.status === 'active' && new Date(o.expiresAt) > now);
  res.json({ data: mine.map(o => ({ ...o, image: undefined })) });
});

// Check a coupon against a basket before checkout
app.post('/api/coupon/check', GUARD.limit('write'), (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const offer = (db['devx-personal-offers'] || []).find(o => o.code === code);
  const ok = LOY.isRedeemable(offer, b.phone);
  if (!ok.ok) return res.status(400).json({ error: ok.error });
  const sub = Number(b.subtotal) || 0;
  const d = LOY.discountFor(offer, b.items || [], sub);
  if (d.error) return res.status(400).json({ error: d.error });
  res.json({ data: { code: offer.code, pct: offer.pct, scope: offer.scope, discountAED: d.amount, offer } });
});

/* ══════════════════════════════════════════════════════════
   CUSTOMER ACCOUNTS — identity is the mobile number, verified
   by a one-time code, so orders and personal offers follow the
   shopper across devices instead of living in localStorage.
══════════════════════════════════════════════════════════ */
const PASSWORD_SESSIONS = new Map();
const CUSTOMER_PIN_RESETS = new Map();
function customerNameKey(name){return String(name||'').trim().replace(/\s+/g,' ').toLowerCase();}
function issueCustomerPinReset(phone){const code=String(crypto.randomInt(100000,1000000));const expiresAt=Date.now()+5*60*1000;CUSTOMER_PIN_RESETS.set(phone,{code,expiresAt,attempts:0});return {code,expiresAt};}
const PHONE_DIGITS_BY_CC={971:9,966:9,974:8,968:8,965:8,973:8};
function passwordPhone(v){
  const raw=String(v||'');
  const d=raw.replace(/\D/g,'');
  const cc=Object.keys(PHONE_DIGITS_BY_CC).find(x=>d.startsWith(x));
  if(cc){const local=d.slice(cc.length);if(local.length!==PHONE_DIGITS_BY_CC[cc])return '';return '+'+d;}
  return '';
}
function issuePasswordSession(phone,name){
  const token='pwd_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
  PASSWORD_SESSIONS.set(token,{phone,name:name||'',expiresAt:Date.now()+30*24*60*60*1000});
  return token;
}
function passwordProfile(phone,name){
  const p=LOY.normalisePhone(phone);
  const row=(db['devx-customer-passwords']||[]).find(x=>LOY.normalisePhone(x.phone)===p)||{};
  const orders=(db['devx-orders']||[]).filter(o=>LOY.normalisePhone(o.customer&&o.customer.phone)===p);
  return {phone:p,name:name||row.name||'',email:row.email||'',orders:orders.length};
}

function shopper(req) {
  const t=req.headers['x-customer-token'];
  if(!t)return null;
  const p=PASSWORD_SESSIONS.get(t);
  if(p){
    if(p.expiresAt>Date.now())return {phone:LOY.normalisePhone(p.phone),name:p.name};
    PASSWORD_SESSIONS.delete(t);
  }
  return CUST.readToken(t);
}

/* ── order ownership ──
   Order ids are sequential and therefore guessable (NX-0042, NX-0043…), so
   "is this order awaiting payment" is not on its own an authorisation check —
   without this, anyone could walk the sequence and settle or approve a
   stranger's order. A caller owns an order if they are the verified
   card-holder, or the browser session that placed it, or staff holding the
   relevant permission. */
function ownsOrder(req, o, staffPerm) {
  const s = shopper(req);
  if (s && LOY.normalisePhone(o.customer && o.customer.phone) === s.phone) return true;
  if (o.cid && req.headers['x-customer-cid'] === o.cid) return true;
  const body = req.body || {};
  if (o.cid && body.cid && body.cid === o.cid) return true;
  const a = actor(req);
  if (a && (!staffPerm || STAFF.can(a.role, staffPerm))) return true;
  return false;
}

/* ── EMAIL ACCOUNT / RECOVERY (additive; existing phone/SMS flow remains) ── */
const CUSTOMER_EMAIL_RESETS = new Map();
function normaliseCustomerEmail(raw){const e=String(raw||'').trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)?e:''}
function emailAccountRow(email){const e=normaliseCustomerEmail(email);return (db['devx-customer-passwords']||[]).find(x=>normaliseCustomerEmail(x.email)===e)||null}
function issueCustomerEmailReset(email){const code=String(Math.floor(100000+Math.random()*900000));CUSTOMER_EMAIL_RESETS.set(normaliseCustomerEmail(email),{code,expiresAt:Date.now()+5*60*1000,attempts:0});return {code,expiresAt:Date.now()+5*60*1000}}
async function sendCustomerEmail(to, subject, text){
  const email = normaliseCustomerEmail(to);
  if(!email) return {ok:false, delivered:false, error:'Invalid email'};

  // Resend configuration is read from .env / hosting environment.
  // No existing OTP, login, registration, SMS, or reset logic is changed.
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.MAIL_FROM || process.env.EMAIL_FROM || '').trim();

  // Keep the existing local-test fallback when Resend is not configured.
  if(!key || !from){
    console.log(`[nexus] EMAIL OTP (local test) to ${email}: ${text}`);
    return {ok:true, delivered:false, localTest:true};
  }

  try{
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        text
      })
    });

    const data = await response.json().catch(() => ({}));

    if(!response.ok){
      console.error('[nexus] Resend email error:', data);
      return {
        ok:false,
        delivered:false,
        error:data.message || 'Email provider rejected the request'
      };
    }

    console.log('[nexus] Email OTP sent successfully:', data.id || 'no-id');
    return {ok:true, delivered:true, id:data.id || null};
  }catch(error){
    console.error('[nexus] Email provider error:', error);
    return {
      ok:false,
      delivered:false,
      error:error.message || 'Email provider unavailable'
    };
  }
}
app.post('/api/customer/phone-check', GUARD.limit('write'), (req,res)=>{
  const phone=passwordPhone((req.body||{}).phone);
  if(!phone)return res.status(400).json({error:'Enter a valid phone number'});
  const row=(db['devx-customer-passwords']||[]).find(x=>LOY.normalisePhone(x.phone)===LOY.normalisePhone(phone));
  res.json({exists:!!row,name:row?row.name:'',phone});
});
app.post('/api/customer/register-password', GUARD.limit('write'), (req,res)=>{
  const b=req.body||{},phone=passwordPhone(b.phone),name=String(b.name||'').trim().slice(0,80),email=normaliseCustomerEmail(b.email),pin=String(b.pin||b.password||'').trim();
  if(!phone)return res.status(400).json({error:'Enter a valid phone number'});
  if(!name)return res.status(400).json({error:'Enter your full name'});
  if(!email)return res.status(400).json({error:'Email ID is required for account registration'});
  if(!/^\d{4}$/.test(pin))return res.status(400).json({error:'PIN must be exactly 4 digits'});
  db['devx-customer-passwords']=db['devx-customer-passwords']||[];
  if(db['devx-customer-passwords'].some(x=>LOY.normalisePhone(x.phone)===LOY.normalisePhone(phone)))
    return res.status(409).json({error:'User already exists. Enter your PIN to sign in.'});
  if(db['devx-customer-passwords'].some(x=>normaliseCustomerEmail(x.email)===email))
    return res.status(409).json({error:'An account already exists for this email. Please use a different email.'});
  const nk=customerNameKey(name);
  if(db['devx-customer-passwords'].some(x=>customerNameKey(x.name)===nk && String(x.pin)===pin))
    return res.status(409).json({error:'That name + 4-digit PIN combination is already in use. Please choose a different PIN.'});
  db['devx-customer-passwords'].push({phone,name,email,pin,createdAt:new Date().toISOString()});
  save('devx-customer-passwords');
  const token=issuePasswordSession(phone,name);
  res.status(201).json({token,profile:passwordProfile(phone,name)});
});
app.post('/api/customer/login-password', GUARD.limit('write'), (req,res)=>{
  const b=req.body||{},phone=passwordPhone(b.phone),pin=String(b.pin||b.password||'').trim();
  const row=(db['devx-customer-passwords']||[]).find(x=>LOY.normalisePhone(x.phone)===LOY.normalisePhone(phone));
  if(!row||row.pin!==pin)return res.status(401).json({error:'Incorrect 4-digit PIN'});
  const token=issuePasswordSession(phone,row.name);
  res.json({token,profile:passwordProfile(phone,row.name)});
});

app.post('/api/customer/forgot-pin/email-request', GUARD.limit('write'), async (req,res)=>{
  const email=normaliseCustomerEmail((req.body||{}).email);
  if(!email)return res.status(400).json({error:'Enter a valid email address'});
  const row=emailAccountRow(email);
  if(!row)return res.json({sent:true,to:email});
  const r=issueCustomerEmailReset(email);
  const sent=await sendCustomerEmail(email,'DevX Nexus — PIN reset OTP',`Your DevX Nexus PIN reset OTP is ${r.code}. It expires in 5 minutes. If you did not request this, you can ignore this email.`);
  if(!sent.delivered){activity('order',`PIN reset email OTP for ${email} — local test code available in server activity/log`);console.log(`[nexus] Email PIN reset OTP for ${email}: ${r.code}`);save('devx-activity');broadcast({'devx-activity':db['devx-activity']});}
  const out={sent:true,to:email,expiresInMs:5*60*1000,hint:sent.delivered?null:'Email provider not configured. Localhost testing is enabled; use the OTP shown in the response/log.'};
  if(process.env.NODE_ENV!=='production' || String(process.env.EMAIL_OTP_LOCAL_TEST||'').toLowerCase()==='true')out.devOtp=r.code;
  res.json(out);
});
app.post('/api/customer/forgot-pin/email-reset', GUARD.limit('write'), (req,res)=>{
  const b=req.body||{},email=normaliseCustomerEmail(b.email),code=String(b.code||'').replace(/\D/g,''),pin=String(b.pin||'').trim();
  if(!email||!/^[0-9]{6}$/.test(code)||!/^[0-9]{4}$/.test(pin))return res.status(400).json({error:'Enter a valid OTP and 4-digit PIN'});
  const row=emailAccountRow(email),reset=CUSTOMER_EMAIL_RESETS.get(email);
  if(!row||!reset)return res.status(401).json({error:'Invalid or expired OTP'});
  if(reset.expiresAt<Date.now()){CUSTOMER_EMAIL_RESETS.delete(email);return res.status(401).json({error:'OTP expired. Please request a new one.'});}
  reset.attempts=(reset.attempts||0)+1;if(reset.attempts>5){CUSTOMER_EMAIL_RESETS.delete(email);return res.status(429).json({error:'Too many incorrect OTP attempts. Request a new OTP.'});}
  if(reset.code!==code)return res.status(401).json({error:'Incorrect OTP'});
  const nk=customerNameKey(row.name);if((db['devx-customer-passwords']||[]).some(x=>x!==row&&customerNameKey(x.name)===nk&&String(x.pin)===pin))return res.status(409).json({error:'That name + 4-digit PIN combination is already in use. Choose a different PIN.'});
  row.pin=pin;row.pinUpdatedAt=new Date().toISOString();save('devx-customer-passwords');CUSTOMER_EMAIL_RESETS.delete(email);res.json({ok:true});
});
app.post('/api/customer/forgot-pin/request', GUARD.limit('write'), async (req,res)=>{
  const phone=passwordPhone((req.body||{}).phone);
  if(!phone)return res.status(400).json({error:'Enter a valid registered mobile number'});
  const row=(db['devx-customer-passwords']||[]).find(x=>LOY.normalisePhone(x.phone)===phone);
  if(!row)return res.json({sent:true,to:CUST.mask?CUST.mask(phone):phone});
  const r=issueCustomerPinReset(phone);
  const sent=await otpMessage(phone,`Your DevX Nexus PIN reset OTP is ${r.code}. It expires in 5 minutes.`);
  if(!sent.delivered){activity('order',`PIN reset OTP for ${CUST.pretty?CUST.pretty(phone):phone} — read it to the customer if they ask`);console.log(`[nexus] PIN reset OTP for ${CUST.pretty?CUST.pretty(phone):phone}: ${r.code}`);save('devx-activity');broadcast({'devx-activity':db['devx-activity']});}
  res.json({sent:true,to:CUST.mask?CUST.mask(phone):phone,expiresInMs:5*60*1000,
    hint:sent.delivered?null:(sent.error||'No messaging provider is connected yet — store staff can read your code out.')});
});
app.post('/api/customer/forgot-pin/reset', GUARD.limit('write'), (req,res)=>{
  const b=req.body||{},phone=passwordPhone(b.phone),code=String(b.code||'').replace(/\D/g,''),pin=String(b.pin||'').trim();
  if(!phone||!/^[0-9]{6}$/.test(code)||!/^[0-9]{4}$/.test(pin))return res.status(400).json({error:'Enter a valid OTP and 4-digit PIN'});
  const row=(db['devx-customer-passwords']||[]).find(x=>LOY.normalisePhone(x.phone)===phone),reset=CUSTOMER_PIN_RESETS.get(phone);
  if(!row||!reset)return res.status(401).json({error:'Invalid or expired OTP'});
  if(reset.expiresAt<Date.now()){CUSTOMER_PIN_RESETS.delete(phone);return res.status(401).json({error:'OTP expired. Please request a new one.'});}
  reset.attempts=(reset.attempts||0)+1;if(reset.attempts>5){CUSTOMER_PIN_RESETS.delete(phone);return res.status(429).json({error:'Too many incorrect OTP attempts. Request a new OTP.'});}
  if(reset.code!==code)return res.status(401).json({error:'Incorrect OTP'});
  const nk=customerNameKey(row.name);if((db['devx-customer-passwords']||[]).some(x=>x!==row&&customerNameKey(x.name)===nk&&String(x.pin)===pin))return res.status(409).json({error:'That name + 4-digit PIN combination is already in use. Choose a different PIN.'});
  row.pin=pin;row.pinUpdatedAt=new Date().toISOString();save('devx-customer-passwords');CUSTOMER_PIN_RESETS.delete(phone);res.json({ok:true});
});
app.get('/api/customer/accounts', need('loyalty.view'), (req,res)=>{
  const rows=(db['devx-customer-passwords']||[]).map(x=>{const phone=LOY.normalisePhone(x.phone);const orders=(db['devx-orders']||[]).filter(o=>LOY.normalisePhone(o.customer&&o.customer.phone)===phone&&!['cancelled'].includes(o.status));return {phone,name:x.name||'',email:x.email||'',createdAt:x.createdAt||null,orders:orders.length,spent:orders.reduce((n,o)=>n+Number(o.total||0),0),last:orders.reduce((v,o)=>!v||o.date>v?o.date:v,'')};});
  res.json({data:rows});
});
app.post('/api/customer/otp', GUARD.limit('write'), async (req, res) => {
  const b = req.body || {};
  const r = CUST.requestCode(b.phone, b.name);
  if (!r.ok) return res.status(r.code === 'resend' ? 429 : 400).json({ error: r.error });

  /* Delivery is pluggable. With no SMS provider connected the code is written
     to the activity feed so staff can read it out — the flow stays real rather
     than pretending a message went out. Never return the code to the caller,
     or anyone could log in as anyone. */
  const sent = await message(r.phone, `Your DevX Nexus verification code is ${r.code}. It expires in 5 minutes.`);
  if (!sent.delivered) {
    activity('order', `Verification code for ${CUST.pretty(r.phone)} — read it to the customer if they ask`);
    console.log(`[nexus] OTP for ${CUST.pretty(r.phone)}: ${r.code}`);
  }
  save('devx-activity');
  broadcast({ 'devx-activity': db['devx-activity'] });
  res.json({ sent: true, to: CUST.mask(r.phone), expiresInMs: r.expiresInMs,
    hint: sent.delivered ? null : 'No messaging provider is connected yet — store staff can read your code out.' });
});

app.post('/api/customer/verify', GUARD.limit('write'), (req, res) => {
  const b = req.body || {};
  const r = CUST.verifyCode(b.phone, b.code);
  if (!r.ok) return res.status(401).json({ error: r.error });
  const prof = CUST.profile(r.phone, db['devx-orders'], db['devx-personal-offers']);
  activity('order', `${prof.pretty} signed in`);
  res.json({ token: r.token, profile: prof, expiresInMs: CUST.SESSION_MS });
});

app.get('/api/customer/me', (req, res) => {
  const s = shopper(req);
  if (!s) return res.status(401).json({ error: 'not signed in' });
  res.json({ profile: CUST.profile(s.phone, db['devx-orders'], db['devx-personal-offers']), name: s.name });
});

app.post('/api/customer/logout', (req, res) => {
  const t = req.headers['x-customer-token'];
  if (t) CUST.revoke(t);
  res.json({ ok: true });
});

/* Staff-facing: codes still waiting, so the counter can help someone who did
   not receive a message. Disappears once a real SMS gateway is wired in. */
app.get('/api/customer/codes', need('orders.view'), (req, res) => {
  res.json({ data: CUST.outstanding() });
});

/* ══════════════════════════════════════════════════════════
   STAFF ACCOUNTS — named logins, roles, audit trail
══════════════════════════════════════════════════════════ */

/* First boot with no accounts: create an owner from ADMIN_PIN so the panel is
   never locked out, and tell the operator to add real staff. */
function ensureOwner() {
  if ((db['devx-staff'] || []).length) return;
  db['devx-staff'] = [STAFF.makeUser({ name: 'Owner', role: 'owner', pin: ADMIN_PIN })];
  save('devx-staff');
  console.log('[nexus] created the initial "Owner" account using ADMIN_PIN — add real staff in Settings');
}

app.post('/api/auth/login', GUARD.limit('write'), (req, res) => {
  ensureOwner();
  const name = String((req.body || {}).name || '').trim();
  const pin = String((req.body || {}).pin || '');
  if (!name || !pin) return res.status(400).json({ error: 'Enter your name and PIN' });

  const lock = STAFF.lockState(name.toLowerCase());
  if (lock.locked)
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.seconds / 60)} minutes.` });

  const u = STAFF.findByName(db['devx-staff'], name);
  if (!u || !STAFF.verifyPin(pin, u.salt, u.hash)) {
    const left = STAFF.noteFail(name.toLowerCase());
    // deliberately vague: do not reveal whether the name exists
    return res.status(401).json({ error: 'Name or PIN is incorrect' + (left > 0 && left <= 2 ? ` — ${left} attempt${left === 1 ? '' : 's'} left` : '') });
  }
  STAFF.clearFails(name.toLowerCase());
  u.lastLogin = new Date().toISOString();
  const token = STAFF.issueToken(u);
  audit({ actor: { name: u.name, role: u.role },
          headers: { 'x-branch': u.branchId || '' } }, 'login', `${u.name} signed in`);
  save('devx-staff');
  res.json({ token, user: STAFF.publicUser(u), roles: STAFF.ROLES,
             branch: u.branchId ? STORES.find(db, u.branchId) : null,
             branches: STORES.list(db).filter(x => x.active !== false),
             expiresInMs: STAFF.SESSION_MS });
});

app.post('/api/auth/logout', (req, res) => {
  const t = req.headers['x-admin-token'];
  if (t) STAFF.revoke(t);
  res.json({ ok: true });
});

/* Who am I, and what may I do — the admin UI hides what a role cannot use. */
app.get('/api/auth/me', (req, res) => {
  const a = actor(req);
  if (!a) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: a, perms: STAFF.ROLES[a.role] ? STAFF.ROLES[a.role].perms : [], roles: STAFF.ROLES,
             branchId: branchOf(req),
             branches: STORES.list(db).filter(x => x.active !== false) });
});

/* Which roles may this person hand out? Never one at or above their own —
   otherwise a store manager can mint an owner and the whole permission model
   is decoration. */
function grantableRoles(req) {
  const a = actor(req);
  if (!a) return [];
  if (a.role === 'owner' || a.legacy) return Object.keys(STAFF.ROLES);
  if (a.role === 'area') return ['manager', 'picker', 'cashier', 'buyer'];
  if (a.role === 'manager') return ['picker', 'cashier', 'buyer'];
  return [];
}
function canTouchStaff(req, u) {
  const a = actor(req);
  if (!a) return false;
  if (a.role === 'owner' || a.legacy) return true;
  if (u.id === a.id) return false;                        // no editing your own role or PIN
  if (!grantableRoles(req).includes(u.role)) return false;  // never a peer or a senior
  const mine = accessible(req);
  return !mine || !u.branchId || mine.includes(u.branchId);
}

app.get('/api/staff', need('staff.manage'), (req, res) => {
  ensureOwner();
  const mine = accessible(req);
  const rows = (db['devx-staff'] || [])
    .filter(u => !mine || (u.branchIds || [u.branchId]).some(b => mine.includes(b)))
    .map(u => Object.assign(STAFF.publicUser(u), { editable: canTouchStaff(req, u) }));
  res.json({ data: rows, roles: STAFF.ROLES, grantable: grantableRoles(req) });
});

app.post('/api/staff', need('staff.manage'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const pin = String(b.pin || '');
  if (name.length < 2) return res.status(400).json({ error: 'Name is too short' });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
  if (!STAFF.ROLES[b.role]) return res.status(400).json({ error: 'Unknown role' });
  if (!grantableRoles(req).includes(b.role))
    return res.status(403).json({ error: `A ${(STAFF.ROLES[(actor(req) || {}).role] || {}).label || 'user'} cannot create a ${STAFF.ROLES[b.role].label}` });
  if (STAFF.findByName(db['devx-staff'], name)) return res.status(409).json({ error: 'Someone already uses that name' });

  /* Everyone except an owner is pinned to a shop; default to the branch the
     person creating them is working in. */
  const branchId = b.role === 'owner' ? null
    : (STORES.find(db, b.branchId) ? b.branchId : branchOf(req));
  const mineB = accessible(req);
  const branchIds = Array.isArray(b.branchIds)
    ? b.branchIds.filter(x => STORES.find(db, x) && (!mineB || mineB.includes(x))) : null;
  /* When a list is given it is the source of truth — the primary shop must be
     one of them, or the person's default lands somewhere they do not run. */
  const primary = (branchIds && branchIds.length) ? branchIds[0] : branchId;
  const u = STAFF.makeUser({ name, role: b.role, pin, branchId: primary, branchIds });
  db['devx-staff'].push(u);
  audit(req, 'staff.create', `added ${u.name} as ${u.role}${u.branchId ? ' at ' + u.branchId : ' (all branches)'}`);
  save('devx-staff');
  res.json({ data: STAFF.publicUser(u) });
});

app.post('/api/staff/:id', need('staff.manage'), (req, res) => {
  const u = (db['devx-staff'] || []).find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (!canTouchStaff(req, u))
    return res.status(403).json({ error: 'That account is outside what you manage' });
  const b = req.body || {};
  if (b.role && !grantableRoles(req).includes(b.role))
    return res.status(403).json({ error: `You cannot promote anyone to ${(STAFF.ROLES[b.role] || {}).label || b.role}` });
  const owners = db['devx-staff'].filter(x => x.role === 'owner' && x.active !== false);

  if (b.pin != null) {
    if (!/^\d{4,8}$/.test(String(b.pin))) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
    Object.assign(u, STAFF.hashPin(String(b.pin)));
    STAFF.revokeUser(u.id);                      // force a fresh sign-in
    audit(req, 'staff.pin', `reset the PIN for ${u.name}`);
  }
  if (b.role && STAFF.ROLES[b.role]) {
    // never allow the last owner to be demoted, or nobody can manage staff
    if (u.role === 'owner' && b.role !== 'owner' && owners.length <= 1)
      return res.status(400).json({ error: 'This is the only owner — promote someone else first' });
    audit(req, 'staff.role', `changed ${u.name} from ${u.role} to ${b.role}`);
    u.role = b.role;
    STAFF.revokeUser(u.id);
  }
  if (Array.isArray(b.branchIds)) {
    const mineB = accessible(req);
    const ok = b.branchIds.filter(x => STORES.find(db, x) && (!mineB || mineB.includes(x)));
    u.branchIds = ok;
    u.branchId = ok[0] || null;
    STAFF.revokeUser(u.id);
    audit(req, 'staff.branch', `${u.name} now covers ${ok.length} shop(s)`);
  } else if (b.branchId !== undefined) {
    if (b.branchId && !STORES.find(db, b.branchId))
      return res.status(400).json({ error: 'Unknown branch' });
    u.branchId = b.branchId || null;
    u.branchIds = u.branchId ? [u.branchId] : [];
    STAFF.revokeUser(u.id);
    audit(req, 'staff.branch', `moved ${u.name} to ${u.branchId || 'all branches'}`);
  }
  if (b.active != null) {
    if (u.role === 'owner' && !b.active && owners.length <= 1)
      return res.status(400).json({ error: 'This is the only owner — you cannot disable them' });
    u.active = !!b.active;
    if (!u.active) STAFF.revokeUser(u.id);
    audit(req, 'staff.active', `${u.active ? 'enabled' : 'disabled'} ${u.name}`);
  }
  save('devx-staff');
  res.json({ data: STAFF.publicUser(u) });
});

app.get('/api/audit', need('audit.view'), (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let rows = db['devx-audit'] || [];
  const mine = accessible(req);
  /* Entries written before branches existed have no shop; they belong to the
     founding one rather than to everybody. */
  if (mine) rows = rows.filter(r => mine.includes(r.branchId || STORES.fallbackId(db)));
  if (q) rows = rows.filter(r => (r.who + r.action + r.detail).toLowerCase().includes(q));
  res.json({ data: rows.slice(0, Math.min(300, parseInt(req.query.limit, 10) || 150)) });
});

app.post('/api/admin/set', need('inventory.edit'), (req, res) => {
  const { key, value } = req.body || {};
  if (!KEYS.includes(key)) return res.status(400).json({ error: 'bad key' });
  const bid = branchOf(req);
  if (key === 'devx-catalog') {
    // a catalogue write belongs to one shop, never the whole chain
    TEN.setCatalog(db, bid, value);
    reindex(bid);
    audit(req, 'inventory.write', `updated ${value.length} products at ${bid}`);
    saveAll();
  } else {
    db[key] = value;
    audit(req, 'inventory.write', `updated ${key}`);
    save(key);
  }
  broadcast({ [key]: value });
  res.json({ ok: true });
});

/* ── static frontends ── */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* Boot in order: storage first, then seed only what storage did not supply,
   then build the index. Listening starts last so no request can arrive before
   the catalogue is queryable. */
(async () => {
  await load();
  TEN.migrate(db, STORES.fallbackId(db));
  seedCatalog();
  ensureOwner();
  reindex();
  server.listen(PORT, () => {
    const st = STORE.status();
    console.log(`[nexus] storage: ${st.driver}${st.durable ? ' (durable)' : ' (EPHEMERAL — set DATABASE_URL)'}`);
    console.log(`[nexus] DevX Nexus running  →  http://localhost:${PORT}  (admin: /admin, PIN: ${ADMIN_PIN})`);
  });
})();

/* An unhandled rejection used to vanish into the void; a store reporting "it
   stopped working" then had nothing to look at. Both handlers record rather
   than exit, because taking the shop down over one bad request is worse than
   serving the rest. */
process.on('unhandledRejection', (reason) => {
  STORES.capture(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  STORES.capture(err, { kind: 'uncaughtException' });
  // a genuinely broken process should still restart; Render will bring it back
  if (/EADDRINUSE|EACCES/.test(err.code || '')) process.exit(1);
});

/* Flush pending writes before the container dies, so an order taken seconds
   before a deploy is not lost. */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[nexus] ${sig} — flushing state`);
    try { await STORE.close(); } catch (e) { console.error('[nexus] flush failed:', e.message); }
    process.exit(0);
  });
}
