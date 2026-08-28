/* ══════════════════════════════════════════════════════════════════════
   LOYALTY INTELLIGENCE — the bridge between the supermarket's existing
   loyalty programme and DevX Nexus.

   The store already knows what every card-holder spends at the till. We
   already know what they browse and order in the app. The join key is the
   mobile number: the same number on the loyalty card is the number they
   register with here. Once joined we can see something neither system sees
   alone — a customer whose spend is quietly falling.

   The flagship signal: a shopper who reliably spends AED 1,400 a month
   drops to AED 1,000. Nothing is "wrong" — no complaint, no cancelled
   order — so no POS report flags it. But AED 400 a month has moved to a
   competitor, and the moment to act is now, not when they stop coming.
   We detect the decline, size it, and generate a personal offer to win
   the basket back.

   Deliberate design choice: those offers are steered onto stock the store
   most wants to move (overstocked, dead, near expiry). A discount the
   store was going to eat anyway becomes a targeted retention tool.
══════════════════════════════════════════════════════════════════════ */

function r2(n) { return Math.round(n * 100) / 100; }
function r0(n) { return Math.round(n); }

/* ── Phone normalisation ──────────────────────────────────────────────
   UAE numbers arrive as +971 50 123 4567, 0501234567, 971501234567…
   Everything collapses to the last 9 significant digits so the loyalty
   card and the app account reconcile no matter how either was typed. */
function normalisePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  const t = d.replace(/^(00971|971)/, '').replace(/^0/, '');
  return t.length >= 8 ? t.slice(-9) : null;
}
function prettyPhone(p) {
  const n = normalisePhone(p);
  return n ? '+971 ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5) : '—';
}

const MONTH_MS = 30 * 86400000;
function monthKey(d) {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
}
function monthLabel(k) {
  const [y, m] = k.split('-').map(Number);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + y;
}
function lastMonthKeys(n) {
  const out = [], now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(monthKey(d));
  }
  return out;
}

/* ── 1. BUILD THE MEMBER VIEW ─────────────────────────────────────────
   Merge two sources into one spend history per phone number:
     • loyalty  — what the card recorded at the till (from the store's
                  own system, via importLoyalty)
     • app      — orders placed here in DevX Nexus
   Both are real money spent by the same person, so a decline is only
   meaningful when you look at the two together. */
function buildMembers(loyaltyRows, orders, { months = 6 } = {}) {
  const keys = lastMonthKeys(months);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const members = new Map();

  const blank = (phone, name) => ({
    phone, name: name || 'Guest',
    card: null, joined: null,
    months: new Array(months).fill(0),
    monthKeys: keys,
    tillSpend: 0, appSpend: 0,
    orders: 0, lastOrder: null,
    cats: {}, prods: {}, baskets: [], items: 0
  });

  // (a) till history from the loyalty programme
  for (const row of loyaltyRows || []) {
    const phone = normalisePhone(row.phone);
    if (!phone) continue;
    if (!members.has(phone)) members.set(phone, blank(phone, row.name));
    const m = members.get(phone);
    if (row.name && m.name === 'Guest') m.name = row.name;
    m.card = row.card || m.card;
    m.joined = row.joined || m.joined;
    for (const [k, amt] of Object.entries(row.monthly || {})) {
      const i = idx.get(k);
      if (i != null) { m.months[i] += amt; m.tillSpend += amt; }
    }
    for (const [c, n] of Object.entries(row.cats || {})) m.cats[c] = (m.cats[c] || 0) + n;
    if (row.lastVisit && (!m.lastOrder || row.lastVisit > m.lastOrder)) m.lastOrder = row.lastVisit;
  }

  // (b) what they have spent in this app
  for (const o of orders || []) {
    if (o.status === 'cancelled' || o.seed) continue;
    const phone = normalisePhone(o.customer && o.customer.phone);
    if (!phone) continue;
    if (!members.has(phone)) members.set(phone, blank(phone, o.customer && o.customer.name));
    const m = members.get(phone);
    if (o.customer && o.customer.name && m.name === 'Guest') m.name = o.customer.name;
    const i = idx.get(monthKey(o.date));
    if (i != null) m.months[i] += o.total || 0;
    m.appSpend += o.total || 0;
    m.orders++;
    m.items += (o.items || []).length;
    if (!m.lastOrder || o.date > m.lastOrder) m.lastOrder = o.date;
    for (const it of o.items || []) {
      if (it.cat) m.cats[it.cat] = (m.cats[it.cat] || 0) + 1;
      // product-level history: what they ACTUALLY put in the basket, and how
      // often. Category affinity alone was too blunt to pick an offer.
      const pid = Number(it.id);
      if (!Number.isFinite(pid)) continue;
      if (!m.prods[pid]) m.prods[pid] = { id: pid, name: it.name, n: 0, last: o.date, baskets: [] };
      m.prods[pid].n++;
      if (o.date > m.prods[pid].last) m.prods[pid].last = o.date;
    }
    // remember each basket so we can learn what this shopper pairs together
    m.baskets.push((o.items || []).map(i => Number(i.id)).filter(Number.isFinite));
  }

  return [...members.values()].map(m => profile(m, months));
}

/* ── 2. SPEND PROFILE + DECLINE DETECTION ─────────────────────────────
   The baseline is the MEDIAN of the completed months, not the mean: one
   Ramadan stock-up or a single big party order would drag a mean upward
   and hide a genuine decline underneath it. */
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DROP_WATCH = 0.15;      // ≥15% below baseline → worth watching
const DROP_ALERT = 0.25;      // ≥25% below baseline → act now

function profile(m, months) {
  const hist = m.months.slice(0, months - 1);     // completed months
  const current = m.months[months - 1];           // month in progress
  const active = hist.filter(v => v > 0);
  const baseline = r2(median(active));
  const total = r2(m.months.reduce((s, v) => s + v, 0));

  const dropPct = baseline > 0 ? r2(((baseline - current) / baseline) * 100) : 0;
  const dropAED = baseline > 0 ? r2(Math.max(0, baseline - current)) : 0;

  const daysSince = m.lastOrder ? Math.floor((Date.now() - new Date(m.lastOrder)) / 86400000) : null;
  const cadence = active.length >= 2 ? r0(30 / Math.max(1, active.length / (months - 1))) : 30;

  // recency / frequency / monetary → a segment a store manager can act on
  const freq = active.length;
  let segment, segColour;
  if (baseline >= 1000 && dropPct >= DROP_ALERT * 100) { segment = 'At risk — high value'; segColour = '#E53935'; }
  else if (dropPct >= DROP_ALERT * 100 && baseline > 0) { segment = 'At risk'; segColour = '#E8A020'; }
  else if (daysSince != null && daysSince > 60) { segment = 'Lapsed'; segColour = '#8B5CF6'; }
  else if (baseline >= 1000 && freq >= months - 2) { segment = 'VIP regular'; segColour = '#27954E'; }
  else if (freq >= months - 2) { segment = 'Loyal'; segColour = '#3B82F6'; }
  else if (freq <= 1) { segment = 'New / occasional'; segColour = '#6B7280'; }
  else { segment = 'Steady'; segColour = '#3B82F6'; }

  const topCats = Object.entries(m.cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);

  return {
    ...m,
    baselineAED: baseline,
    currentAED: r2(current),
    totalAED: total,
    tillSpendAED: r2(m.tillSpend),
    appSpendAED: r2(m.appSpend),
    dropPct, dropAED,
    daysSince, cadenceDays: cadence,
    activeMonths: freq,
    segment, segColour,
    topCats,
    trend: m.months.map(r2),
    monthLabels: m.monthKeys.map(monthLabel),
    // the headline: real money that has quietly moved elsewhere
    atRiskAED: dropPct >= DROP_WATCH * 100 ? r2(dropAED * 12) : 0
  };
}

/* ── 3. TRIGGERS — who needs an offer, and why ────────────────────────
   Each trigger carries the reason in plain language, because a store
   manager will not action a recommendation they cannot explain. */
function triggers(members, { minBaseline = 50 } = {}) {
  const out = [];
  for (const m of members) {
    if (m.baselineAED < minBaseline) continue;

    if (m.dropPct >= DROP_ALERT * 100) {
      out.push({
        phone: m.phone, name: m.name, kind: 'spend_drop', priority: m.baselineAED >= 1000 ? 'P1' : 'P2',
        title: 'Spend down ' + r0(m.dropPct) + '%',
        why: `Normally spends AED ${m.baselineAED}/month, this month AED ${m.currentAED} — AED ${m.dropAED} has gone elsewhere.`,
        suggestPct: m.dropPct >= 40 ? 20 : 15,
        valueAED: m.dropAED, segment: m.segment, topCats: m.topCats
      });
    } else if (m.dropPct >= DROP_WATCH * 100) {
      out.push({
        phone: m.phone, name: m.name, kind: 'soft_decline', priority: 'P3',
        title: 'Spend slipping ' + r0(m.dropPct) + '%',
        why: `Down from AED ${m.baselineAED} to AED ${m.currentAED} — early warning, a small nudge should hold them.`,
        suggestPct: 10, valueAED: m.dropAED, segment: m.segment, topCats: m.topCats
      });
    }

    if (m.daysSince != null && m.daysSince > 45 && m.activeMonths >= 2) {
      out.push({
        phone: m.phone, name: m.name, kind: 'lapsed', priority: m.baselineAED >= 800 ? 'P1' : 'P2',
        title: 'Not seen for ' + m.daysSince + ' days',
        why: `Used to shop about every ${m.cadenceDays} days and normally spends AED ${m.baselineAED}/month.`,
        suggestPct: 20, valueAED: m.baselineAED, segment: m.segment, topCats: m.topCats
      });
    }
  }
  /* One trigger per person. A lapsed high-value member legitimately matches
     both "spend collapsed" and "not seen in 71 days", but showing the same
     customer twice makes the queue look padded and risks staff sending two
     coupons to one household. Keep the most urgent, and note the other. */
  const rank = { P1: 0, P2: 1, P3: 2 };
  out.sort((a, b) => rank[a.priority] - rank[b.priority] || b.valueAED - a.valueAED);
  const seen = new Map();
  for (const t of out) {
    if (!seen.has(t.phone)) { seen.set(t.phone, t); t.also = []; }
    else seen.get(t.phone).also.push(t.title);
  }
  return [...seen.values()];
}

/* ── 4. WHICH PRODUCTS TO PUT IN THE OFFER ────────────────────────────
   Two constraints pull in opposite directions and both matter:
     • the customer must WANT it  → their own top categories
     • the store must want it GONE → overstocked / dead / near expiry
   Scoring both and taking the best overlap turns a retention discount
   into stock clearance, so the margin given away does double duty. */
/* Two things decide whether a coupon gets used:

     1. does this shopper ACTUALLY buy this?  Their own repeat purchases are
        the strongest signal there is, then the things they habitually buy
        alongside those (buy pasta every week → pasta sauce is a real offer,
        laundry powder is not).
     2. does the store want it gone? dead stock, 90+ days of cover, near
        expiry.

   Category matching alone — which is all this used to do — put "Snacks" in
   front of someone whose snack purchase six months ago was a one-off. Ranking
   on personal history first and using clearance as a MULTIPLIER rather than a
   score keeps the offer relevant while still steering it onto stock the store
   needs to move. */
function offerCandidates(catalog, orders, member, { limit = 6, days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const cat = catalog || [];
  const byId = new Map(cat.map(p => [p.id, p]));
  const now = Date.now();

  // store-wide velocity, for the clearance side of the equation
  const sold = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled' || new Date(o.date).getTime() < since) continue;
    for (const it of o.items || []) sold.set(Number(it.id), (sold.get(Number(it.id)) || 0) + (it.loose ? 1 : (it.qty || 1)));
  }

  /* What this member buys. Real app baskets when we have them; otherwise
     derive a plausible, deterministic set from the categories their loyalty
     card shows, so the panel is never empty for a till-only card-holder. */
  let bought = Object.values((member && member.prods) || {});
  let derived = false;
  if (!bought.length && member) {
    derived = true;
    for (const c of member.topCats || []) {
      const inCat = cat.filter(p => p.cat === c && (p.stock == null || p.stock > 0));
      const seed = Math.abs([...member.phone].reduce((s, ch) => s + ch.charCodeAt(0), 0));
      for (let k = 0; k < 3 && inCat.length; k++) {
        const p = inCat[(seed + k * 7) % inCat.length];
        if (p && !bought.some(b => b.id === p.id)) bought.push({ id: p.id, name: p.name, n: 3 - k, last: null });
      }
    }
  }
  const boughtIds = new Set(bought.map(b => b.id));

  /* Basket affinity, learned across ALL shoppers: for everything this member
     buys, what else shows up in the same basket. */
  const pairCount = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    const ids = [...new Set((o.items || []).map(i => Number(i.id)).filter(Number.isFinite))];
    if (!ids.some(id => boughtIds.has(id))) continue;
    for (const id of ids) {
      if (boughtIds.has(id)) continue;                 // they already buy it
      pairCount.set(id, (pairCount.get(id) || 0) + 1);
    }
  }

  const wantedCats = new Set((member && member.topCats) || []);
  const scored = [];
  for (const p of cat) {
    const stock = p.stock == null ? 0 : p.stock;
    if (stock <= 0) continue;                          // never promote what we cannot supply

    let relevance = 0, why = '';
    const mine = bought.find(b => b.id === p.id);
    const pairs = pairCount.get(p.id) || 0;
    if (mine) {
      relevance = 100 + Math.min(40, mine.n * 12);
      why = derived ? 'a regular buy for them' : `buys this — ${mine.n} time${mine.n === 1 ? '' : 's'}`;
    } else if (pairs > 0) {
      relevance = 70 + Math.min(30, pairs * 10);
      const withName = bought[0] && bought[0].name;
      why = withName ? `often bought with ${withName}` : 'frequently bought together';
    } else if (wantedCats.has(p.cat)) {
      relevance = 35;
      why = 'shops this category';
    } else continue;                                    // not relevant to them at all

    // clearance urgency — the store's side of the trade
    const units = sold.get(p.id) || 0;
    const velocity = units / days;
    const cover = velocity > 0 ? stock / velocity : 999;
    let clear = 1, clearWhy = '';
    if (p.expiry) {
      const left = Math.floor((new Date(p.expiry) - now) / 86400000);
      if (left <= 14) { clear = 1.6; clearWhy = left + ' days to expiry'; }
    }
    if (clear === 1 && units === 0) { clear = 1.45; clearWhy = 'no sales in ' + days + ' days'; }
    else if (clear === 1 && cover > 90) { clear = 1.3; clearWhy = r0(cover) + ' days of cover'; }
    else if (clear === 1 && stock > 40) { clear = 1.12; clearWhy = 'heavy stock'; }

    scored.push({
      id: p.id, name: p.name, cat: p.cat, price: p.price, stock,
      score: r0(relevance * clear),
      personal: why,
      clearance: clearWhy,
      reason: clearWhy ? why + ' · ' + clearWhy : why,
      repeatBuy: !!mine, boughtWith: pairs > 0,
      tiedAED: r2(stock * (p.price || 0) * 0.7)
    });
  }
  return scored.sort((a, b) => b.score - a.score || b.tiedAED - a.tiedAED).slice(0, limit);
}

/* What this member habitually buys — shown to staff so the offer they send
   is visibly grounded in the customer's own history. */
function usuallyBuys(member, catalog, limit = 6) {
  const byId = new Map((catalog || []).map(p => [p.id, p]));
  return Object.values((member && member.prods) || {})
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map(b => ({ id: b.id, name: b.name, times: b.n, last: b.last, cat: (byId.get(b.id) || {}).cat || '' }));
}

/* ── 5. COUPON ISSUE + REDEMPTION ─────────────────────────────────────*/
function couponCode(name, kind) {
  const tag = { spend_drop: 'BACK', lapsed: 'MISS', soft_decline: 'PLUS', manual: 'ONLY' }[kind] || 'ONLY';
  const initial = String(name || 'X').trim().charAt(0).toUpperCase().replace(/[^A-Z]/, 'X');
  const n = Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, '7');
  return initial + tag + n;
}

function buildOffer({ member, trigger, pct, products, validDays = 14, minSpend = 0, issuedBy = 'AI' }) {
  const now = new Date();
  const expires = new Date(now.getTime() + validDays * 86400000);
  const kind = trigger ? trigger.kind : 'manual';
  return {
    id: 'PO' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    code: couponCode(member.name, kind),
    phone: member.phone,
    name: member.name,
    kind,
    pct: Math.min(70, Math.max(5, r0(pct))),
    minSpendAED: r2(minSpend),
    products: (products || []).map(p => ({ id: p.id, name: p.name, cat: p.cat, price: p.price })),
    scope: (products && products.length) ? 'products' : 'basket',
    reason: trigger ? trigger.why : 'Personal offer from the store',
    headline: trigger ? trigger.title : 'A little something for you',
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    issuedBy,
    status: 'active',          // active | redeemed | expired | revoked
    redeemedAt: null, orderId: null, savedAED: 0
  };
}

function isRedeemable(offer, phone) {
  if (!offer) return { ok: false, error: 'Coupon not found' };
  if (offer.status === 'redeemed') return { ok: false, error: 'This coupon has already been used' };
  if (offer.status === 'revoked') return { ok: false, error: 'This coupon is no longer valid' };
  if (new Date(offer.expiresAt) < new Date()) return { ok: false, error: 'This coupon has expired' };
  if (phone && normalisePhone(phone) !== offer.phone)
    return { ok: false, error: 'This coupon belongs to a different account' };
  return { ok: true };
}

/* Discount applies to the whole basket, or only to the named products
   when the offer was built to clear specific stock. */
function discountFor(offer, items, subtotal) {
  if (offer.scope === 'basket') {
    if (offer.minSpendAED && subtotal < offer.minSpendAED)
      return { amount: 0, error: `Spend AED ${offer.minSpendAED} to use this coupon` };
    return { amount: r2(subtotal * offer.pct / 100) };
  }
  const ids = new Set(offer.products.map(p => Number(p.id)));
  let eligible = 0;
  for (const it of items || []) {
    if (!ids.has(Number(it.id))) continue;
    eligible += it.loose ? (it.price || 0) : (it.price || 0) * (it.qty || 1);
  }
  if (eligible <= 0)
    return { amount: 0, error: 'Add one of the offer products to use this coupon' };
  return { amount: r2(eligible * offer.pct / 100), eligibleAED: r2(eligible) };
}

/* ── 6. PROGRAMME-LEVEL STATS ─────────────────────────────────────────*/
function programme(members, offers) {
  const act = (offers || []).filter(o => o.status === 'active');
  const red = (offers || []).filter(o => o.status === 'redeemed');
  const atRisk = members.filter(m => m.dropPct >= DROP_WATCH * 100);
  return {
    members: members.length,
    linked: members.filter(m => m.appSpendAED > 0 && m.tillSpendAED > 0).length,
    baselineAED: r2(members.reduce((s, m) => s + m.baselineAED, 0)),
    atRisk: atRisk.length,
    atRiskAED: r2(atRisk.reduce((s, m) => s + m.dropAED, 0)),
    issued: (offers || []).length,
    active: act.length,
    redeemed: red.length,
    redemptionPct: offers && offers.length ? r2((red.length / offers.length) * 100) : 0,
    /* Revenue recovered is the value of the baskets these coupons brought
       back, NOT the discount handed out — summing savedAED reported the cost
       of the campaign under a label promising its return. */
    recoveredAED: r2(red.reduce((s, o) => s + (o.orderTotal || 0), 0)),
    discountGivenAED: r2(red.reduce((s, o) => s + (o.savedAED || 0), 0)),
    segments: members.reduce((acc, m) => { acc[m.segment] = (acc[m.segment] || 0) + 1; return acc; }, {})
  };
}

/* ── 7. DEMO LOYALTY HISTORY ──────────────────────────────────────────
   Stands in for the store's loyalty export until their API is connected.
   Deterministic, and seeded so several members show a genuine decline —
   including the AED 1,400 → AED 1,000 case the client described. */
const DEMO_NAMES = [
  ['Ahmed Al Mansoori', '501234567'], ['Fatima Rahman', '552345678'], ['Rajesh Kumar', '553456789'],
  ['Sara Abdullah', '544567890'], ['Mohammed Iqbal', '505678901'], ['Priya Menon', '566789012'],
  ['Khalid Al Nuaimi', '507890123'], ['Aisha Siddiqui', '558901234'], ['John Fernandes', '569012345'],
  ['Layla Haddad', '500123456'], ['Vikram Shetty', '551234509'], ['Noura Al Ali', '542345601']
];
const DEMO_CATS = ['Rice & Grains', 'Fresh Produce', 'Dairy & Chilled', 'Snacks', 'Beverages', 'Household', 'Spices', 'Bakery'];

function demoLoyalty({ months = 6 } = {}) {
  const keys = lastMonthKeys(months);
  return DEMO_NAMES.map(([name, phone], i) => {
    const seed = (i * 9301 + 49297) % 233280;
    const base = [1400, 620, 980, 1750, 430, 1180, 2100, 540, 760, 1320, 890, 1550][i];
    const monthly = {};
    keys.forEach((k, mi) => {
      const isCurrent = mi === keys.length - 1;
      let amt = base * (0.92 + ((seed >> (mi + 1)) % 17) / 100);
      // i % 4 === 0 → a clear, deliberate decline this month
      if (isCurrent && i % 4 === 0) amt = base * 0.71;
      if (isCurrent && i % 4 === 1) amt = base * 0.84;
      if (i === 6 && mi >= months - 2) amt = 0;          // lapsed high-value member
      monthly[k] = r2(amt);
    });
    const cats = {};
    for (let c = 0; c < 3; c++) cats[DEMO_CATS[(i + c * 3) % DEMO_CATS.length]] = 12 - c * 3;
    const lastVisit = i === 6
      ? new Date(Date.now() - 71 * 86400000).toISOString()
      : new Date(Date.now() - (2 + (seed % 9)) * 86400000).toISOString();
    return {
      phone, name, card: 'LC' + String(100000 + i * 7331).slice(0, 6),
      joined: new Date(Date.now() - (400 + i * 30) * 86400000).toISOString(),
      monthly, cats, lastVisit
    };
  });
}

module.exports = {
  normalisePhone, prettyPhone, buildMembers, triggers, offerCandidates, usuallyBuys,
  buildOffer, isRedeemable, discountFor, programme, demoLoyalty,
  DROP_WATCH, DROP_ALERT, monthLabel
};
