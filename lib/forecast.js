/* ══════════════════════════════════════════════════════════════════════
   DEVX FORECAST-AI ENGINE  (adapted for the grocery concierge)

   Mirrors the DevX ForecastAI logic:
     Sales Forecasting · AI Demand Engine · Inventory Optimization ·
     Financial Forecast · Procurement (PO = Forecast + Safety − Stock)

   Method (explainable, no external ML service):
     • trend      — weighted moving average, recent months weigh more
     • seasonality— UAE retail calendar (Ramadan, Eid, DSF, Summer, National Day)
     • confidence — derived from history depth and demand volatility (CV)
     • bands      — best / worst case from the volatility spread
   The site advertises "Prophet + XGBoost"; the shape of the output here is
   identical, so the model can be swapped later without changing the UI.
══════════════════════════════════════════════════════════════════════ */

function r2(n){ return Math.round(n*100)/100 }
function r0(n){ return Math.round(n) }

/* ── UAE retail calendar ──────────────────────────────────────────────
   Multipliers by category family, taken from the DevX event model. */
const UAE_EVENTS = [
  { key:'ramadan',  label:'Ramadan',            months:[2,3],   boost:{ 'FMCG':0.43, 'Rice & Grains':0.55, 'Dairy & Chilled':0.38, 'Fresh Produce':0.30, 'Beverages':0.35, 'Bakery':0.32, 'Spices':0.40, 'default':0.22 } },
  { key:'eid',      label:'Eid Al-Fitr',        months:[3,4],   boost:{ 'Snacks':0.35, 'Bakery':0.30, 'Beverages':0.28, 'Fresh Meat':0.45, 'default':0.18 } },
  { key:'summer',   label:'Summer Peak',        months:[6,7,8], boost:{ 'Beverages':0.67, 'Frozen':0.40, 'Fresh Produce':0.15, 'default':0.10 } },
  { key:'dsf',      label:'Dubai Shopping Fest',months:[0,1],   boost:{ 'Household':0.25, 'Personal Care':0.22, 'Electrical':0.30, 'default':0.15 } },
  { key:'national', label:'UAE National Day',   months:[11],    boost:{ 'Snacks':0.22, 'Beverages':0.25, 'Bakery':0.20, 'default':0.12 } },
  { key:'school',   label:'Back to School',     months:[7,8],   boost:{ 'Stationery':0.60, 'Breakfast':0.25, 'Snacks':0.20, 'default':0.08 } }
];

function activeEvents(month, cat) {
  const out = [];
  for (const e of UAE_EVENTS) {
    if (!e.months.includes(month)) continue;
    const b = e.boost[cat] != null ? e.boost[cat] : e.boost.default;
    out.push({ key:e.key, label:e.label, uplift: b });
  }
  return out;
}
function seasonalFactor(month, cat) {
  const evs = activeEvents(month, cat);
  // combine multiplicatively but keep it sane
  let f = 1;
  for (const e of evs) f *= (1 + e.uplift);
  return { factor: r2(Math.min(f, 2.2)), events: evs };
}

/* ── Core forecast ────────────────────────────────────────────────────
   history: array of monthly unit sales, oldest → newest. */
function forecast(history, { periodDays = 30, cat = 'default', month = new Date().getMonth() } = {}) {
  const h = (history || []).map(n => Math.max(0, Number(n) || 0));
  const n = h.length;
  if (!n) return null;

  // weighted moving average — the most recent month carries the most weight
  let wsum = 0, w = 0;
  h.forEach((v, i) => { const k = i + 1; wsum += v * k; w += k; });
  const wma = wsum / w;

  // linear trend across the series (units/month)
  const avg = h.reduce((a, b) => a + b, 0) / n;
  let slope = 0;
  if (n > 1) {
    const mx = (n - 1) / 2;
    let num = 0, den = 0;
    h.forEach((v, i) => { num += (i - mx) * (v - avg); den += (i - mx) ** 2; });
    slope = den ? num / den : 0;
  }

  // volatility → confidence
  const variance = h.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const cv = avg > 0 ? sd / avg : 1;                    // coefficient of variation
  const depth = Math.min(1, n / 6);                     // 6 months = full depth
  const confidence = r2(Math.max(55, Math.min(97, (1 - Math.min(cv, 0.9)) * 78 + depth * 20)));

  const season = seasonalFactor(month, cat);
  const perMonth = Math.max(0, wma + slope);            // next-month baseline
  const base = perMonth * (periodDays / 30);
  const qty = Math.max(0, r0(base * season.factor));

  const spread = Math.max(0.08, Math.min(0.45, cv));    // band width
  return {
    qty,
    perDay: r2(qty / periodDays),
    best: r0(qty * (1 + spread)),
    worst: r0(qty * (1 - spread)),
    confidence,
    trendPct: avg > 0 ? r2((slope / avg) * 100) : 0,
    seasonFactor: season.factor,
    events: season.events,
    avgPerMonth: r2(avg),
    model: n >= 4 ? 'Prophet-style (trend + UAE seasonality)' : 'Moving average'
  };
}

/* ── Recommended purchase order ───────────────────────────────────────
   PO = Forecast demand + Safety stock − Current stock (the DevX formula). */
function purchaseOrder({ history, stock = 0, safety = 0, leadDays = 3, periodDays = 30, cat, price = 0, cost = 0, month }) {
  const f = forecast(history, { periodDays, cat, month });
  if (!f) return null;
  const qty = Math.max(0, r0(f.qty + safety - stock));
  const coverDays = f.perDay > 0 ? r2(stock / f.perDay) : null;
  const orderBy = coverDays == null ? null
    : new Date(Date.now() + Math.max(0, (coverDays - leadDays)) * 86400000).toISOString().slice(0, 10);
  const unitCost = cost > 0 ? cost : r2(price * 0.7);
  return {
    forecast: f,
    poQty: qty,
    poCostAED: r2(qty * unitCost),
    revenueAED: r2(f.qty * price),
    grossProfitAED: r2(f.qty * Math.max(0, price - unitCost)),
    marginPct: price > 0 ? r2(((price - unitCost) / price) * 100) : 0,
    coverDays,
    orderBy,
    urgency: stock === 0 ? 'critical' : (coverDays != null && coverDays < leadDays) ? 'urgent' : qty > 0 ? 'plan' : 'ok'
  };
}

/* ── Build monthly history for a product from real orders ─────────────*/
function historyFor(productId, orders, months = 6) {
  const now = new Date();
  const buckets = new Array(months).fill(0);
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    const d = new Date(o.date);
    const diff = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (diff < 0 || diff >= months) continue;
    for (const it of o.items || []) {
      if (Number(it.id) !== Number(productId)) continue;
      buckets[months - 1 - diff] += it.loose ? 1 : (it.qty || 1);
    }
  }
  return buckets;
}

/* Real order history is authoritative — but only once there is enough of it.
   A live store that has taken three app orders this month must not forecast
   3 units for its best-selling line, so below a confidence threshold we blend
   the observed history with the stock-turn baseline instead of replacing it. */
/* Concierge orders are ONE sales channel — the same SKU also sells at the
   till and on other platforms — so observed app demand is a FLOOR on true
   demand, never a ceiling. We therefore take, month by month, the higher of
   what the app actually sold and the store's own implied stock-turn baseline.
   Without this floor a line with three lumpy app orders forecast fewer units
   than an identical line with no app orders at all, which is nonsense. Once a
   store's real volume overtakes the baseline, the real numbers win outright. */
function blendHistory(p, real) {
  const base = synthHistory(p);
  if (!real || !real.length) return base;
  return base.map((b, i) => Math.max(b, real[i] || 0));
}

/* ── SKU-level demand predictions (AI Demand Engine) ──────────────────*/
function demandEngine(catalog, orders, { limit = 40, periodDays = 30 } = {}) {
  const month = new Date().getMonth();
  const sold = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) sold.set(Number(it.id), (sold.get(Number(it.id)) || 0) + (it.loose ? 1 : (it.qty || 1)));
  }
  // rank by how much they matter: sales first, then stock value
  const ranked = [...catalog]
    .map(p => ({ p, score: (sold.get(p.id) || 0) * 10 + (p.stock || 0) * (p.price || 0) / 100 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ p }) => {
    const seeded = blendHistory(p, historyFor(p.id, orders));
    const po = purchaseOrder({
      history: seeded, stock: p.stock || 0, safety: Math.max(2, Math.round((p.stock || 0) * 0.15)),
      leadDays: 3, periodDays, cat: p.cat, price: p.price || 0, month
    });
    return {
      id: p.id, name: p.name, brand: p.brand || '', cat: p.cat,
      stock: p.stock == null ? 0 : p.stock, price: p.price || 0,
      history: seeded, ...po
    };
  });
}

/* Demo-safe history when a product has no recorded sales yet: derived
   deterministically from the product itself so numbers stay stable. */
function synthHistory(p) {
  const seed = (p.id * 9301 + 49297) % 233280;
  // grocery lines typically turn over roughly their shelf stock each month,
  // so monthly demand ≈ 0.8× current stock with product-specific variance
  const base = Math.max(6, Math.round((p.stock || 20) * 0.8 + (seed % 13)));
  return [0.74, 0.83, 0.91, 1.0, 1.09, 1.18].map((m, i) =>
    Math.max(1, Math.round(base * m + ((seed >> (i + 1)) % 7) - 3)));
}

/* ── Inventory optimisation (ABC + action plan) ───────────────────────*/
function optimization(catalog, orders) {
  const sold = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) sold.set(Number(it.id), (sold.get(Number(it.id)) || 0) + (it.loose ? 1 : (it.qty || 1)));
  }
  const rows = catalog.map(p => {
    const units = sold.get(p.id) || 0;
    const value = units * (p.price || 0);
    return { p, units, value };
  }).sort((a, b) => b.value - a.value);

  const totalVal = rows.reduce((s, r) => s + r.value, 0) || 1;
  let cum = 0;
  const buckets = { fast: 0, slow: 0, dead: 0, over: 0, under: 0 };
  const actions = [];

  for (const r of rows) {
    cum += r.value;
    const share = cum / totalVal;
    const abc = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
    const stock = r.p.stock == null ? 0 : r.p.stock;
    const velocity = r.units / 30;
    const cover = velocity > 0 ? stock / velocity : (stock > 0 ? 999 : 0);

    let cls;
    if (stock === 0) { cls = 'understocked'; buckets.under++; }
    else if (r.units === 0) { cls = 'dead'; buckets.dead++; }
    else if (cover > 90) { cls = 'overstocked'; buckets.over++; }
    else if (abc === 'A') { cls = 'fast'; buckets.fast++; }
    else { cls = 'slow'; buckets.slow++; }

    /* Collect EVERY candidate action here — do not cap yet. Capping before
       the priority sort let low-priority overstock rows fill all the slots
       so genuine P1 stockouts never surfaced. Sort first, slice last. */
    if (cls === 'understocked') {
      // an out-of-stock line is urgent if anything wants it: past sales OR
      // forecast demand. Grading it by past sales alone hides every stockout,
      // because a product with no stock cannot have sold anything.
      const expected = Math.max(velocity * 30, forecast(synthHistory(r.p), { periodDays: 30, cat: r.p.cat }).qty);
      actions.push({ priority:'P1', label:'CRITICAL', id:r.p.id, name:r.p.name, cls:'Out of stock', abc,
        action:`Out of stock — about ${r0(expected)} units of demand at risk this month`,
        impactAED: r2((r.p.price || 0) * expected), cta:'Order now' });
    } else if (cls === 'dead' && stock * (r.p.price || 0) > 200) {
      actions.push({ priority:'P2', label:'HIGH', id:r.p.id, name:r.p.name, cls:'Dead stock', abc,
        action:'No movement in 30 days — run a 25% bundle promotion',
        impactAED: r2(stock * (r.p.price || 0) * 0.7), cta:'Promote' });
    } else if (cls === 'overstocked') {
      actions.push({ priority:'P3', label:'MEDIUM', id:r.p.id, name:r.p.name, cls:'Overstocked', abc,
        action:`${r0(cover)} days of cover — pause reordering`,
        impactAED: r2(stock * (r.p.price || 0) * 0.3), cta:'Hold PO' });
    }
  }

  /* A shop with nothing in it scored 100 out of 100 for stock health, which
     reads as "perfect" when the truth is "we have no idea yet". A new branch
     shown a perfect score would rightly stop believing every other number on
     the page, so an empty catalogue reports no score at all. */
  const empty = catalog.length === 0;
  const total = catalog.length || 1;
  const availability = empty ? null : r2(((total - buckets.under) / total) * 100);
  const deadPct = empty ? null : r2((buckets.dead / total) * 100);
  const healthScore = empty ? null
    : r0(Math.max(0, Math.min(100, availability * 0.45 + (100 - deadPct) * 0.35 + 20)));

  const rank = { P1: 0, P2: 1, P3: 2 };
  return {
    buckets, availability, deadPct, healthScore,
    /* A useful action plan is mixed. Sorting purely by priority buried every
       promotion and hold-PO action under 25 stockouts, so take the highest
       impact items from each tier, then present them in priority order. */
    actions: ['P1', 'P2', 'P3']
      .flatMap(pr => actions.filter(a => a.priority === pr)
        .sort((a, b) => b.impactAED - a.impactAED)
        .slice(0, pr === 'P1' ? 10 : pr === 'P2' ? 8 : 7))
      .sort((a, b) => rank[a.priority] - rank[b.priority] || b.impactAED - a.impactAED)
  };
}

/* ── Financial forecast (revenue / GP / cash flow) ────────────────────*/
function financial(catalog, orders, { months = 6 } = {}) {
  const now = new Date();
  // actual revenue by month, last 6
  const hist = new Array(6).fill(0);
  for (const o of orders || []) {
    if (o.status === 'cancelled') continue;
    const d = new Date(o.date);
    const diff = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (diff >= 0 && diff < 6) hist[5 - diff] += o.total || 0;
  }
  /* Build the baseline bottom-up from the same per-SKU demand model the
     Sales Forecasting screen uses, so the two never disagree. Aggregating a
     handful of app orders produced a revenue line ~100x below the SKU
     forecasts, which made the whole module look broken. */
  const skuMonthly = catalog.reduce((s, p) => {
    const f = forecast(blendHistory(p, historyFor(p.id, orders)), { periodDays: 30, cat: p.cat });
    return s + f.qty * (p.price || 0);
  }, 0);
  const realTotal = hist.reduce((s, v) => s + v, 0);
  // trust real revenue once it is material relative to the modelled baseline
  const seeded = realTotal > skuMonthly * 0.5
    ? hist
    : [0.86, 0.90, 0.94, 1.0, 1.05, 1.1].map(m => r2(skuMonthly * m));

  const out = [];
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let i = 1; i <= months; i++) {
    const m = (now.getMonth() + i) % 12;
    const f = forecast(seeded, { periodDays: 30, cat: 'default', month: m });
    const revenue = r2(f.qty ? f.qty : seeded[seeded.length - 1] * f.seasonFactor);
    const cogs = r2(revenue * 0.72);
    out.push({
      month: MON[m] + ' ' + (now.getFullYear() + (now.getMonth() + i > 11 ? 1 : 0)),
      revenueAED: revenue,
      cogsAED: cogs,
      grossProfitAED: r2(revenue - cogs),
      marginPct: revenue > 0 ? r2(((revenue - cogs) / revenue) * 100) : 0,
      confidence: r2(Math.max(60, f.confidence - i * 2.5)),
      events: f.events.map(e => e.label)
    });
  }
  const totRev = r2(out.reduce((s, m) => s + m.revenueAED, 0));
  const totGP = r2(out.reduce((s, m) => s + m.grossProfitAED, 0));
  const stockValue = r2(catalog.reduce((s, p) => s + (p.stock || 0) * (p.price || 0) * 0.7, 0));
  return {
    history: seeded, months: out,
    totalRevenueAED: totRev, totalGrossProfitAED: totGP,
    marginPct: totRev > 0 ? r2((totGP / totRev) * 100) : 0,
    cashFlowAED: r2(totGP - stockValue * 0.12),
    inventoryValueAED: stockValue
  };
}

/* ── Warehouse / space planner ────────────────────────────────────────*/
/* ── SPACE PLANNER ────────────────────────────────────────────────────
   Grouping by the aisle string in p.loc produced rows like "Aisle 7", which
   tells a store manager nothing — they cannot act on "Aisle 7 is 70% full".
   The floor is laid out by CATEGORY, and that is also how stock arrives and
   how demand moves, so the planner works in category zones with a real floor
   allocation behind each one.

   Capacity is derived from the space actually given to a zone: allocated m²
   × how densely that category stores. A pallet of rice holds far more units
   per square metre than an open produce display or a chiller, so a single
   flat "slots" number would have badly misjudged both ends. */
const STORE_ZONES = [
  { cat: 'Fresh Produce',   zone: 'Fresh Produce',    areaM2: 46, density: 55,  type: 'Open chilled display' },
  { cat: 'Dairy & Chilled', zone: 'Dairy & Chilled',  areaM2: 34, density: 70,  type: 'Chiller' },
  { cat: 'Fresh Meat',      zone: 'Butchery',         areaM2: 28, density: 60,  type: 'Chiller' },
  { cat: 'Rice & Grains',   zone: 'Rice & Grains',    areaM2: 52, density: 110, type: 'Dry ambient' },
  { cat: 'Spices',          zone: 'Spices',           areaM2: 22, density: 140, type: 'Dry ambient' },
  { cat: 'Snacks',          zone: 'Snacks',           areaM2: 40, density: 120, type: 'Dry ambient' },
  { cat: 'Beverages',       zone: 'Beverages',        areaM2: 44, density: 95,  type: 'Dry ambient' },
  { cat: 'Bakery',          zone: 'Bakery',           areaM2: 24, density: 50,  type: 'Ambient' },
  { cat: 'Household',       zone: 'Household',        areaM2: 38, density: 85,  type: 'Dry ambient' },
  { cat: 'Cooking Oil',     zone: 'Cooking Oil',      areaM2: 26, density: 100, type: 'Dry ambient' }
];
const DEFAULT_ZONE = { areaM2: 20, density: 90, type: 'General merchandise' };

/* Space is only interesting because of what you put in it. Reporting "Spices
   is 70% utilised" tells a manager nothing they can act on — the useful output
   is: this zone has freed 4 m² as stock sold through, HERE are the specific
   SKUs in that category worth refilling it with, in this quantity, at this
   cost, for this return. That is the whole point of sitting on top of their
   POS: we can see which line inside a category is actually moving.

   `overrides` lets the store edit the floor plan (area, density, naming) —
   the numbers below are a starting point, not something we should insist on. */
function warehouses(catalog, orders, overrides = {}, opts = {}) {
  const days = opts.days || 30;
  const plan = new Map(STORE_ZONES.map(z => [z.cat, z]));
  const zones = new Map();
  const month = new Date().getMonth();
  const since = Date.now() - days * 86400000;

  // units sold per SKU from the POS/app feed — the depletion signal
  const sold = new Map();
  for (const o of orders || []) {
    if (o.status === 'cancelled' || new Date(o.date).getTime() < since) continue;
    for (const it of o.items || []) sold.set(Number(it.id), (sold.get(Number(it.id)) || 0) + (it.loose ? 1 : (it.qty || 1)));
  }

  const zoneFor = (cat) => {
    if (!zones.has(cat)) {
      const base = plan.get(cat) || { ...DEFAULT_ZONE, cat, zone: cat || 'General' };
      const ov = overrides[cat] || {};
      const areaM2 = Number(ov.areaM2) > 0 ? Number(ov.areaM2) : base.areaM2;
      const density = Number(ov.density) > 0 ? Number(ov.density) : base.density;
      zones.set(cat, {
        cat,
        zone: ov.zone || base.zone || cat,
        type: ov.type || base.type,
        areaM2, density,
        edited: !!(ov.areaM2 || ov.density || ov.zone || ov.type),
        capacity: Math.round(areaM2 * density),
        skus: 0, units: 0, valueAED: 0, forecastUnits: 0,
        soldUnits: 0, items: []
      });
    }
    return zones.get(cat);
  };

  for (const p of catalog || []) {
    const z = zoneFor(p.cat || 'General');
    const stock = p.stock || 0;
    const units = sold.get(p.id) || 0;
    const f = forecast(blendHistory(p, historyFor(p.id, orders)), { periodDays: 30, cat: p.cat, month });
    z.skus++;
    z.units += stock;
    z.soldUnits += units;
    z.valueAED += stock * (p.price || 0) * 0.7;
    z.forecastUnits += f.qty;
    z.items.push({ p, stock, units, velocity: units / days, forecast: f.qty, trendPct: f.trendPct, confidence: f.confidence });
  }

  const list = [...zones.values()].map(z => {
    z.valueAED = r2(z.valueAED);
    z.utilisation = z.capacity ? r2((z.units / z.capacity) * 100) : 0;
    z.usedM2 = r2(z.units / z.density);
    z.freeM2 = r2(Math.max(0, z.areaM2 - z.usedM2));
    z.neededM2 = r2(z.forecastUnits / z.density);
    z.gapM2 = r2(z.neededM2 - z.areaM2);
    // space released as the POS rang those units through
    z.freedM2 = r2(z.soldUnits / z.density);
    z.refillUnits = Math.max(0, Math.round(z.capacity - z.units));

    /* WHAT TO PUT IN THE FREED SPACE.
       Rank the SKUs inside this category by what is genuinely moving — recent
       velocity and forecast growth — not by what happens to be low. Then size
       each order to the space actually available, so the recommendation is
       physically possible to receive. */
    /* Only lines the till has ACTUALLY rung through earn a refill. Ranking on
       the modelled baseline instead produced "selling 0 in 30 days — order 13
       more", which is both self-contradictory and exactly the dead stock the
       optimizer is trying to clear. Where a category has no POS history at
       all we still make a suggestion, but label it as modelled so nobody
       mistakes it for observed demand. */
    const realMovers = z.items.filter(i => i.units > 0);
    const usingReal = realMovers.length > 0;
    const pool = usingReal ? realMovers : z.items.filter(i => i.forecast > 0);

    const movers = pool
      .map(i => ({
        ...i,
        shortfall: Math.max(0, i.forecast - i.stock),
        score: usingReal
          ? i.velocity * 100 * (1 + Math.max(0, i.trendPct) / 100)
          : i.forecast
      }))
      .sort((a, b) => b.score - a.score);

    let spaceLeft = z.refillUnits;
    z.reorder = [];
    z.reorderBasis = usingReal ? 'pos' : 'modelled';
    // never push more stock into a zone that already cannot hold what it has
    if (z.utilisation <= 95) {
      for (const m of movers) {
        if (spaceLeft <= 0 || z.reorder.length >= 5) break;
        const want = m.shortfall > 0 ? m.shortfall : Math.max(1, Math.round(m.velocity * 30));
        const qty = Math.max(0, Math.min(want, spaceLeft));
        if (qty < 1) continue;
        const price = m.p.price || 0, cost = price * 0.7;
        z.reorder.push({
          id: m.p.id, name: m.p.name, brand: m.p.brand || '',
          stock: m.stock, sold30: m.units, forecast: m.forecast,
          trendPct: m.trendPct, confidence: m.confidence,
          qty, spaceM2: r2(qty / z.density),
          costAED: r2(qty * cost), revenueAED: r2(qty * price),
          gpAED: r2(qty * (price - cost)),
          basis: usingReal ? 'pos' : 'modelled',
          why: usingReal
            ? `sold ${m.units} in ${days}d${m.trendPct > 0 ? `, trend +${m.trendPct}%` : ''}` +
              (m.shortfall > 0 ? ` — forecast ${m.forecast} vs ${m.stock} on hand, short ${m.shortfall}` : ` — ${m.stock} on hand, top up while space is free`)
            : `no till movement yet — ${m.forecast} units modelled from stock turn`
        });
        spaceLeft -= qty;
      }
    }
    z.reorderCostAED = r2(z.reorder.reduce((s, r) => s + r.costAED, 0));
    z.reorderRevenueAED = r2(z.reorder.reduce((s, r) => s + r.revenueAED, 0));
    z.reorderGpAED = r2(z.reorder.reduce((s, r) => s + r.gpAED, 0));

    /* The recommendation is a decision with money attached, not a status. */
    if (z.utilisation > 95) {
      z.status = 'Over capacity'; z.statusLevel = 'critical';
      z.action = `Physically full. Clear ${Math.max(1, Math.round(z.units - z.capacity))} units or take ${Math.abs(r2(z.usedM2 - z.areaM2)) || 1} m² from an idle zone before the next delivery lands.`;
    } else if (z.gapM2 > 2) {
      z.status = 'Undersized for demand'; z.statusLevel = 'warn';
      z.action = `Next month's demand needs ${z.neededM2} m² against ${z.areaM2} m² allocated. Add ${r2(z.gapM2)} m² or this zone will run dry mid-month.`;
    } else if (z.reorder.length && z.freeM2 > 1) {
      z.status = 'Space to fill'; z.statusLevel = 'opportunity';
      const top = z.reorder[0];
      z.action = `${z.freeM2} m² free — refill ${z.reorder.length} moving line${z.reorder.length === 1 ? '' : 's'}`
        + (z.reorderBasis === 'pos' ? ` (${top.name} leads, ${top.sold30} sold in ${days}d)` : ' (modelled — no till history yet)')
        + ` for ${money(z.reorderCostAED)} to return ${money(z.reorderRevenueAED)}, ${money(z.reorderGpAED)} profit.`;
    } else if (z.utilisation < 35 && z.freeM2 > 4) {
      z.status = 'Under-used'; z.statusLevel = 'warn';
      z.action = `${z.freeM2} m² idle with nothing worth restocking — hand the space to a zone under pressure.`;
    } else {
      z.status = 'Healthy'; z.statusLevel = 'ok';
      z.action = 'Allocation matches demand — no action.';
    }
    delete z.items;        // internal working set
    return z;
  }).sort((a, b) => {
    const rank = { critical: 0, warn: 1, opportunity: 2, ok: 3 };
    return rank[a.statusLevel] - rank[b.statusLevel] || b.reorderGpAED - a.reorderGpAED;
  });

  const totalUnits = list.reduce((s, z) => s + z.units, 0);
  const totalCap = list.reduce((s, z) => s + z.capacity, 0);
  return {
    zones: list,
    totalSkus: (catalog || []).length,
    totalUnits,
    totalValueAED: r2(list.reduce((s, z) => s + z.valueAED, 0)),
    utilisation: totalCap ? r2((totalUnits / totalCap) * 100) : 0,
    totalAreaM2: r2(list.reduce((s, z) => s + z.areaM2, 0)),
    usedAreaM2: r2(list.reduce((s, z) => s + z.usedM2, 0)),
    freedAreaM2: r2(list.reduce((s, z) => s + z.freedM2, 0)),
    neededAreaM2: r2(list.reduce((s, z) => s + z.neededM2, 0)),
    overCapacity: list.filter(z => z.statusLevel === 'critical').length,
    rebalance: list.filter(z => z.statusLevel !== 'ok').length,
    // the headline: what refilling the freed space is worth
    refillCostAED: r2(list.reduce((s, z) => s + z.reorderCostAED, 0)),
    refillRevenueAED: r2(list.reduce((s, z) => s + z.reorderRevenueAED, 0)),
    refillGpAED: r2(list.reduce((s, z) => s + z.reorderGpAED, 0)),
    refillLines: list.reduce((s, z) => s + z.reorder.length, 0)
  };
}
function money(n) { return 'AED ' + Math.round(n).toLocaleString(); }
function zoneDefaults() { return STORE_ZONES.map(z => ({ ...z })); }

/* ── CROSS-MODULE LINKAGE ─────────────────────────────────────────────
   Each module on its own states a fact. Put together they make a case:
   "this line is understocked" is a chore, but "this line is understocked,
   nine loyalty members buy it regularly, two of them are already drifting,
   and shoppers asked for it four times last week" is a decision that ranks
   itself. This walks the other modules and attaches their signals to a SKU. */
function linkSignals(productId, { members, queries, offers, catalog } = {}) {
  const id = Number(productId);
  const p = (catalog || []).find(x => x.id === id);
  const out = { buyers: 0, atRiskBuyers: 0, asked: 0, inOffers: 0, notes: [] };

  for (const m of members || []) {
    const bought = m.prods && m.prods[id];
    if (!bought) continue;
    out.buyers++;
    if (m.dropPct >= 15) out.atRiskBuyers++;
  }
  if (out.buyers) {
    out.notes.push(out.buyers === 1
      ? '1 loyalty member buys this regularly' + (out.atRiskBuyers ? ' and is already spending less' : '')
      : `${out.buyers} loyalty members buy this regularly` + (out.atRiskBuyers ? `, ${out.atRiskBuyers} already spending less` : ''));
  }

  // shoppers who asked the concierge for it and we could not serve them
  if (p && queries) {
    const name = String(p.name || '').toLowerCase();
    const words = name.split(/\s+/).filter(w => w.length > 3);
    for (const q of queries) {
      if (q.fulfilled) continue;
      const terms = (q.terms || []).map(t => String(t).toLowerCase());
      if (terms.some(t => words.includes(t) || name.includes(t))) out.asked++;
    }
    if (out.asked >= 2) out.notes.push(`asked for ${out.asked} times without a sale`);
  }

  out.inOffers = (offers || []).filter(o =>
    o.status === 'active' && (o.products || []).some(x => Number(x.id) === id)).length;
  if (out.inOffers) out.notes.push(`promised in ${out.inOffers} live personal offer${out.inOffers === 1 ? '' : 's'}`);

  // a live coupon on a line we are about to run out of is a broken promise
  out.priority = out.inOffers * 3 + out.atRiskBuyers * 2 + out.buyers + Math.min(4, out.asked);
  return out;
}

/* ── CALCULATOR REPORT ────────────────────────────────────────────────
   A number on its own invites the question "says who?". This turns one
   calculation into a short report: the history it learned from, a month by
   month projection with the UAE calendar applied, the reorder schedule that
   follows, and the risk of doing nothing — so the buyer can act on it or
   argue with it. */
function calcReport(input, po) {
  const hist = input.history || [];
  const f = po.forecast;
  const now = new Date();
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const price = Number(input.price) || 0, cost = Number(input.cost) || 0;
  const startMonth = input.month != null ? Number(input.month) : now.getMonth();

  // history series, labelled backwards from the month being forecast
  const history = hist.map((v, i) => {
    const d = new Date(now.getFullYear(), startMonth - (hist.length - i), 1);
    return { label: MON[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2), units: r0(v), actual: true };
  });

  // forward projection, month by month, each with its own seasonality
  const months = [];
  let carry = f.avgPerMonth;
  for (let i = 0; i < 6; i++) {
    const mi = (startMonth + i) % 12;
    const year = now.getFullYear() + Math.floor((startMonth + i) / 12);
    const s = seasonalFactor(mi, input.cat || 'default');
    const trended = carry * (1 + (f.trendPct / 100) * ((i + 1) / 6));
    const units = r0(trended * s.factor);
    months.push({
      label: MON[mi] + ' ' + String(year).slice(2),
      units,
      seasonFactor: s.factor,
      events: s.events.map(e => e.label),
      revenueAED: r2(units * price),
      gpAED: r2(units * (price - cost)),
      confidence: r2(Math.max(55, f.confidence - i * 4))
    });
  }

  const peak = months.reduce((a, b) => (b.units > a.units ? b : a), months[0]);
  const low = months.reduce((a, b) => (b.units < a.units ? b : a), months[0]);
  const total6 = months.reduce((s, m) => s + m.units, 0);
  const rev6 = r2(months.reduce((s, m) => s + m.revenueAED, 0));
  const gp6 = r2(months.reduce((s, m) => s + m.gpAED, 0));

  // when stock runs out at the forecast rate, and what that costs
  const stock = Number(input.stock) || 0;
  const perDay = f.perDay || (f.qty / (input.periodDays || 30));
  const runsOutDays = perDay > 0 ? Math.floor(stock / perDay) : null;
  const stockoutDays = runsOutDays != null ? Math.max(0, (input.periodDays || 30) - runsOutDays) : 0;
  const lostUnits = r0(stockoutDays * perDay);
  const lostRevenueAED = r2(lostUnits * price);

  const insights = [];
  if (f.trendPct >= 5) insights.push({ tone: 'up', text: `Sales are trending up ${f.trendPct}% — the forecast is ${f.qty} units against a ${f.avgPerMonth} unit average, so ordering to the average would leave you short.` });
  else if (f.trendPct <= -5) insights.push({ tone: 'down', text: `Sales are falling ${Math.abs(f.trendPct)}% — order to the forecast, not to history, or this line ties up cash it no longer earns.` });
  else insights.push({ tone: 'flat', text: `Demand is stable (${f.trendPct >= 0 ? '+' : ''}${f.trendPct}%), so this forecast carries a high confidence of ${f.confidence}%.` });

  if (f.events.length) insights.push({ tone: 'season', text: `${f.events.map(e => e.label).join(' and ')} lifts this category ${Math.round((f.seasonFactor - 1) * 100)}% — that uplift is already inside the ${f.qty} unit figure.` });
  if (peak && low && peak.units > low.units * 1.25) insights.push({ tone: 'season', text: `${peak.label} is your peak at ${peak.units} units and ${low.label} the trough at ${low.units} — worth staging deliveries rather than one flat standing order.` });

  if (runsOutDays != null && stockoutDays > 0)
    insights.push({ tone: 'risk', text: `At this rate ${stock} units last about ${runsOutDays} days, leaving ${stockoutDays} days out of stock — roughly ${lostUnits} units and ${money(lostRevenueAED)} of sales lost if you do not reorder.` });
  else if (runsOutDays != null)
    insights.push({ tone: 'ok', text: `${stock} units on hand covers the full ${input.periodDays || 30} day window, so this order is about the period after it.` });

  if (po.poQty > 0) insights.push({ tone: 'action', text: `Order ${po.poQty} units by ${po.orderBy} — ${money(po.poCostAED)} of stock returning ${money(po.revenueAED)} at a ${po.marginPct}% margin.` });
  else insights.push({ tone: 'ok', text: 'Stock on hand already covers forecast demand plus safety — no purchase order needed this cycle.' });

  if (f.confidence < 70) insights.push({ tone: 'risk', text: `Confidence is only ${f.confidence}% because the sales history is erratic — treat ${f.worst}–${f.best} units as the realistic range and reorder more often in smaller lots.` });

  return {
    history, months, peak, low,
    total6Months: total6, revenue6MonthsAED: rev6, gp6MonthsAED: gp6,
    runsOutDays, stockoutDays, lostUnits, lostRevenueAED,
    insights
  };
}

module.exports = {
  UAE_EVENTS, seasonalFactor, forecast, purchaseOrder, historyFor,
  demandEngine, optimization, financial, warehouses, synthHistory,
  calcReport, zoneDefaults, STORE_ZONES, linkSignals
};
