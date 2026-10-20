/* ══════════════════════════════════════════════════════════════════════
   BRANCHES AND OBSERVABILITY

   One deployment served exactly one store, which makes the SaaS story
   awkward: a chain with six branches needed six deployments, six databases and
   six sets of staff accounts.

   The pragmatic step, and the one that matches how a grocery chain actually
   works, is branch scoping rather than full tenant isolation: one catalogue and
   one loyalty book across the chain, but stock, orders, staff and delivery
   slots belonging to a branch. That is how Lulu or a Union Coop operates — a
   customer's loyalty is with the chain, their order is with a shop.

   Full multi-tenant separation (different companies on one deployment) is a
   different problem and deliberately not solved here; it needs row-level
   isolation in storage, not a field on a record.
══════════════════════════════════════════════════════════════════════ */

const DEFAULT_BRANCH = {
  id: 'br-deira',
  name: 'Madina Supermarket',
  area: 'Deira — Branch 3',
  city: 'Dubai, UAE',
  // Deira, Dubai — so "nearest store" works out of the box on a fresh install
  lat: 25.2697,
  lng: 55.3095,
  active: true
};

function list(db) {
  const b = db['devx-branches'];
  return (b && b.length) ? b : [DEFAULT_BRANCH];
}
function find(db, id) {
  return list(db).find(b => b.id === id) || null;
}
function fallbackId(db) {
  return list(db)[0].id;
}

/* Which branch is this request about? Staff carry theirs on their account; a
   shopper picks one at checkout. Falls back to the first branch so a
   single-store install never has to think about any of this. */
function resolve(db, { actorBranch, requested } = {}) {
  const ids = list(db).map(b => b.id);
  if (requested && ids.includes(requested)) return requested;
  if (actorBranch && ids.includes(actorBranch)) return actorBranch;
  return fallbackId(db);
}

/* Scope a collection of records to a branch. Records written before branches
   existed have no branchId, so they belong to the default branch rather than
   disappearing from the board. */
function scope(rows, branchId, defaultId) {
  if (!branchId) return rows || [];
  return (rows || []).filter(r => (r.branchId || defaultId) === branchId);
}

/* ── store location ───────────────────────────────────────────────────
   A shopper's phone gives us a lat/lng; each shop has one. Great-circle
   distance is plenty accurate at city scale and needs no map API. */
function cleanCoord(v, lim) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= lim ? Math.round(n * 1e6) / 1e6 : null;
}
function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/* Every active shop, nearest first, each tagged with its distance and whether
   it sits inside the auto-pick radius (1 km by default). Shops with no
   coordinates yet are listed last so they can still be chosen by hand. */
function nearby(db, { lat, lng, radiusKm = 1, q = '' } = {}) {
  const la = cleanCoord(lat, 90), ln = cleanCoord(lng, 180);
  const r = Math.max(0.1, Math.min(50, Number(radiusKm) || 1));
  const needle = String(q || '').trim().toLowerCase();
  const rows = list(db).filter(b => b.active !== false)
    .filter(b => !needle || [b.name, b.area, b.city, b.address].join(' ').toLowerCase().includes(needle))
    .map(b => {
      const has = la != null && ln != null && b.lat != null && b.lng != null;
      const d = has ? Math.round(distanceKm(la, ln, b.lat, b.lng) * 100) / 100 : null;
      return { ...b, distanceKm: d, withinRadius: d != null && d <= r };
    });
  rows.sort((a, b) => (a.distanceKm == null) - (b.distanceKm == null) || (a.distanceKm || 0) - (b.distanceKm || 0));
  const nearest = rows.find(b => b.withinRadius) || null;
  return { radiusKm: r, located: la != null && ln != null, nearest, defaultId: fallbackId(db), data: rows };
}

function makeBranch({ name, area, city, lat, lng, address, phone }) {
  const slug = String(name || 'branch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return {
    id: 'br-' + slug + '-' + Math.random().toString(36).slice(2, 5),
    name: String(name || '').slice(0, 60),
    area: String(area || '').slice(0, 60),
    city: String(city || 'Dubai, UAE').slice(0, 60),
    address: String(address || '').slice(0, 140),
    phone: String(phone || '').slice(0, 30),
    lat: cleanCoord(lat, 90),
    lng: cleanCoord(lng, 180),
    active: true,
    createdAt: new Date().toISOString()
  };
}

/* Per-branch summary for a chain view: how much each shop is doing today. */
function summary(db, orders) {
  const today = new Date().toISOString().slice(0, 10);
  const def = fallbackId(db);
  return list(db).map(b => {
    const mine = (orders || []).filter(o => (o.branchId || def) === b.id && o.status !== 'cancelled');
    const todays = mine.filter(o => String(o.date || '').slice(0, 10) === today);
    return {
      ...b,
      ordersToday: todays.length,
      revenueTodayAED: Math.round(todays.reduce((s, o) => s + (o.total || 0), 0) * 100) / 100,
      ordersTotal: mine.length,
      awaitingWeigh: mine.filter(o => o.needsWeighing && !o.weighed).length,
      unpaid: mine.filter(o => o.payStatus && o.payStatus !== 'paid' && o.payStatus !== 'refunded').length
    };
  });
}

/* ── error tracking ───────────────────────────────────────────────────
   Structured, bounded, and shaped so it can be forwarded to Sentry by
   swapping one function — without adding the dependency now. */
const errors = [];
const MAX = 200;

function capture(err, context) {
  const entry = {
    at: new Date().toISOString(),
    message: (err && err.message) || String(err),
    stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 6).join('\n') : null,
    ...(context || {})
  };
  errors.unshift(entry);
  if (errors.length > MAX) errors.length = MAX;

  // one line, greppable, with the context that makes it diagnosable
  console.error(`[nexus:error] ${entry.message}` +
    (context ? ' ' + JSON.stringify(context) : ''));

  if (process.env.SENTRY_DSN) {
    // Deliberately not adding the SDK until it is actually wanted; this is the
    // single place to wire it, and everything already funnels through here.
    try { require('@sentry/node').captureException(err, { extra: context }); } catch (e) {}
  }
  return entry;
}

function recent(limit) {
  return errors.slice(0, Math.min(MAX, limit || 50));
}
function health() {
  const hour = Date.now() - 3600000;
  return {
    total: errors.length,
    lastHour: errors.filter(e => new Date(e.at).getTime() > hour).length,
    latest: errors[0] ? { at: errors[0].at, message: errors[0].message } : null,
    forwarding: !!process.env.SENTRY_DSN
  };
}

module.exports = { DEFAULT_BRANCH, list, find, resolve, scope, makeBranch,
                   nearby, distanceKm, cleanCoord,
                   summary, fallbackId, capture, recent, health };
