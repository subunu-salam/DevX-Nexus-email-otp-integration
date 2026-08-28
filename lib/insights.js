/* ══════════════════════════════════════════════════════════════════════
   VALUE-ADDED SERVICES — the reason a hypermarket pays a subscription.

   The client said "there is no value added service". This module turns the
   data we already hold (their live stock + every question shoppers asked
   the AI) into decisions their POS cannot produce.

   1. DEMAND GAP / LOST SALES  — what customers asked for that we could not
      sell them (not stocked, or out of stock). No POS can report this,
      because a POS only sees what DID sell. This is the flagship feature.
   2. REORDER FORECASTING      — sales velocity + lead time → reorder point,
      with a suggested order quantity and days-of-cover.
   3. INVENTORY HEALTH         — days of cover, dead stock, overstock and the
      capital tied up in it.
   4. WASTAGE / EXPIRY         — items to mark down before they expire.
   5. BASKET AFFINITY          — what sells together (shelf placement +
      smarter AI upsell).
══════════════════════════════════════════════════════════════════════ */

function round2(n) { return Math.round(n * 100) / 100; }
function daysBetween(a, b) { return Math.max(0, (new Date(b) - new Date(a)) / 86400000); }

/* ── 1. DEMAND GAP ────────────────────────────────────────────────────
   Every concierge query is logged with what the shopper asked for and
   whether we could fulfil it. Aggregate the misses. */
/* Conversational noise that must never appear as a "product customers wanted".
   Testing surfaced entries like "but", "they", "then", "account". */
const NOISE = new Set(['but','they','then','than','that','this','there','their','them','account',
  'store','shop','app','order','orders','item','items','thing','things','stuff','please','thanks',
  'thank','hello','okay','sure','yes','no','not','will','would','could','should','have','has','had',
  'what','when','where','which','who','why','how','can','cant','does','did','are','was','were','been',
  'about','from','with','without','also','more','less','some','any','all','one','two','get','got',
  'give','tell','show','know','need','want','like','make','made','see','said','say','ask','asked',
  'price','prices','cost','money','total','cart','pay','payment','delivery','weight','weigh','kg',
  'gram','grams','aed','dirham','good','nice','best','sorry','hey','still','only','just','now','here']);
function isProductLike(term) {
  if (NOISE.has(term)) return false;
  if (term.length < 3) return false;
  if (/^\d+$/.test(term)) return false;              // bare numbers
  return /^[a-z][a-z-]{2,}$/.test(term);             // simple word, no junk
}

function demandGap(queryLog, catalog, days = 30) {
  const since = Date.now() - days * 86400000;
  const misses = new Map();     // term -> {count, lastAsked, sample}

  for (const q of queryLog || []) {
    if (new Date(q.at).getTime() < since) continue;
    if (q.fulfilled) continue;                       // we served it — not a gap
    for (const term of (q.terms || [])) {
      const k = term.toLowerCase();
      if (!isProductLike(k)) continue;               // drop conversational noise
      if (!misses.has(k)) misses.set(k, { term: k, count: 0, lastAsked: q.at, samples: [] });
      const m = misses.get(k);
      m.count++;
      if (new Date(q.at) > new Date(m.lastAsked)) m.lastAsked = q.at;
      if (m.samples.length < 3 && q.prompt) m.samples.push(q.prompt.slice(0, 80));
    }
  }

  // estimate the money left on the table using the average basket line value
  const avgLine = catalog.length
    ? catalog.reduce((s, p) => s + (p.price || 0), 0) / catalog.length : 12;

  return [...misses.values()]
    .filter(m => m.count >= 2)
    .map(m => ({ ...m, estLostAED: round2(m.count * avgLine) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}

/* ── 2. REORDER FORECASTING ───────────────────────────────────────────
   Simple moving-average velocity — accurate enough for grocery and
   explainable to a store manager. */
function reorderSuggestions(orders, catalog, { leadDays = 2, coverDays = 7, window = 30 } = {}) {
  const since = Date.now() - window * 86400000;
  const sold = new Map();       // productId -> units sold in window

  for (const o of orders || []) {
    if (new Date(o.date).getTime() < since) continue;
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) {
      const units = it.loose ? 1 : (it.qty || 1);
      sold.set(it.id, (sold.get(it.id) || 0) + units);
    }
  }

  const out = [];
  for (const p of catalog) {
    const units = sold.get(p.id) || 0;
    const velocity = units / window;                       // units per day
    if (velocity <= 0 && (p.stock == null || p.stock > 5)) continue;   // ignore idle, well-stocked lines
    const stock = p.stock == null ? 0 : p.stock;
    const daysCover = velocity > 0 ? stock / velocity : (stock > 0 ? 999 : 0);
    const reorderPoint = round2(velocity * (leadDays + 2));  // lead time + safety
    if (stock <= reorderPoint || stock === 0) {
      const suggestQty = Math.max(1, Math.ceil(velocity * (leadDays + coverDays) - stock));
      out.push({
        id: p.id, name: p.name, brand: p.brand || '', cat: p.cat,
        stock, velocity: round2(velocity),
        daysCover: daysCover >= 999 ? null : round2(daysCover),
        reorderPoint, suggestQty,
        urgency: stock === 0 ? 'out' : daysCover < leadDays ? 'critical' : 'low',
        estCostAED: round2(suggestQty * (p.price || 0) * 0.7)   // ~70% of retail = cost
      });
    }
  }
  const rank = { out: 0, critical: 1, low: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.velocity - a.velocity).slice(0, 60);
}

/* ── 3. INVENTORY HEALTH ──────────────────────────────────────────────*/
function inventoryHealth(orders, catalog, { window = 30 } = {}) {
  const since = Date.now() - window * 86400000;
  const sold = new Map();
  for (const o of orders || []) {
    if (new Date(o.date).getTime() < since || o.status === 'cancelled') continue;
    for (const it of o.items || []) sold.set(it.id, (sold.get(it.id) || 0) + (it.loose ? 1 : (it.qty || 1)));
  }

  let outOfStock = 0, low = 0, healthy = 0, dead = 0;
  let stockValue = 0, deadValue = 0, overstockValue = 0;
  const deadList = [], overstockList = [];

  for (const p of catalog) {
    const stock = p.stock == null ? 0 : p.stock;
    const units = sold.get(p.id) || 0;
    const velocity = units / window;
    const value = stock * (p.price || 0) * 0.7;
    stockValue += value;

    if (stock === 0) outOfStock++;
    else if (stock < 8) low++;
    else healthy++;

    if (units === 0 && stock > 0) {
      dead++; deadValue += value;
      if (deadList.length < 25) deadList.push({ id: p.id, name: p.name, cat: p.cat, stock, tiedAED: round2(value) });
    } else if (velocity > 0 && stock / velocity > 90) {
      overstockValue += value;
      if (overstockList.length < 25)
        overstockList.push({ id: p.id, name: p.name, stock, daysCover: Math.round(stock / velocity), tiedAED: round2(value) });
    }
  }

  const totalUnitsSold = [...sold.values()].reduce((a, b) => a + b, 0);
  return {
    products: catalog.length,
    outOfStock, low, healthy, dead,
    stockValueAED: round2(stockValue),
    deadValueAED: round2(deadValue),
    overstockValueAED: round2(overstockValue),
    stockTurn: stockValue > 0 ? round2((totalUnitsSold / window * 365) / Math.max(1, catalog.length)) : 0,
    deadList: deadList.sort((a, b) => b.tiedAED - a.tiedAED),
    overstockList: overstockList.sort((a, b) => b.tiedAED - a.tiedAED)
  };
}

/* ── 4. EXPIRY / WASTAGE ──────────────────────────────────────────────
   Uses an optional `expiry` field on products; suggests markdown depth. */
function expiryWatch(catalog, { horizonDays = 14 } = {}) {
  const now = Date.now();
  const out = [];
  for (const p of catalog) {
    if (!p.expiry) continue;
    const days = Math.floor((new Date(p.expiry) - now) / 86400000);
    if (days > horizonDays) continue;
    const stock = p.stock == null ? 0 : p.stock;
    if (stock <= 0) continue;
    const markdown = days <= 1 ? 50 : days <= 3 ? 35 : days <= 7 ? 20 : 10;
    out.push({
      id: p.id, name: p.name, cat: p.cat, stock,
      expiry: p.expiry, daysLeft: days,
      suggestedMarkdown: markdown,
      atRiskAED: round2(stock * (p.price || 0)),
      newPrice: round2((p.price || 0) * (1 - markdown / 100))
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 50);
}

/* ── 5. BASKET AFFINITY ───────────────────────────────────────────────*/
function basketAffinity(orders, { minPairs = 2 } = {}) {
  const pairs = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    const names = [...new Set((o.items || []).map(i => i.name))].sort();
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const k = names[i] + ' + ' + names[j];
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
  }
  return [...pairs.entries()]
    .filter(([, c]) => c >= minPairs)
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
}

module.exports = { demandGap, reorderSuggestions, inventoryHealth, expiryWatch, basketAffinity };
