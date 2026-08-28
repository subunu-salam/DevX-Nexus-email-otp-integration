/* ══════════════════════════════════════════════════════════════════════
   GROUP ROLL-UP — what the owner of a chain actually needs

   The panel was built for one shop, and every screen is scoped to one shop.
   That is right for a manager: their job is their store. It is wrong for the
   person who owns forty of them, who opened the dashboard, saw AED 0, and had
   no way to ask "how is the group doing?" — the number was correct and useless.

   Two different jobs, so two different first screens:

     manager  → my shop today: my queue, my stock, my customers
     owner    → the group: which shops are behind, and what is it costing me

   An owner does not want forty dashboards. They want one page that ranks the
   shops and says where to look first. So this module does not average things
   into a comfortable blur — it computes per shop, then surfaces the outliers
   with money attached, because "Karama is down 22%, about AED 4,100 this week"
   is an instruction and "group revenue AED 96,400" is only a number.

   Deliberately cheap: pure arithmetic over data already in memory, no
   per-branch queries. At a hundred branches this is still a few milliseconds,
   which is what lets the page open without a spinner.
══════════════════════════════════════════════════════════════════════ */

const LOW_STOCK = 8;
const STALE_ORDER_HOURS = 2;

const dayKey = d => new Date(d).toDateString();
const round2 = n => Math.round(n * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

/* Orders written before branches existed carry no branchId; they belong to the
   founding shop rather than to nothing. */
function branchOfOrder(o, fallbackId) { return o.branchId || fallbackId; }

function windowOf(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const prevFrom = new Date(from.getTime() - days * 86400000);
  return { from, to, prevFrom };
}

/* ── one shop ── */
function branchStats(b, orders, catalog, opts) {
  const { from, prevFrom } = opts.win;
  const today = dayKey(new Date());
  const live = orders.filter(o => o.status !== 'cancelled');

  const inWindow = live.filter(o => new Date(o.date) >= from);
  const inPrev = live.filter(o => { const d = new Date(o.date); return d >= prevFrom && d < from; });

  const rev = inWindow.reduce((a, o) => a + (o.total || 0), 0);
  const prevRev = inPrev.reduce((a, o) => a + (o.total || 0), 0);
  const todayOrders = live.filter(o => dayKey(o.date) === today);

  const pending = live.filter(o => !['done', 'cancelled'].includes(o.status));
  const stale = pending.filter(o =>
    (Date.now() - new Date(o.date).getTime()) > STALE_ORDER_HOURS * 3600000);

  /* Money the shop has served but not collected. A manager sees this per
     order; only the group view makes it a number worth chasing. */
  const uncollected = live
    .filter(o => o.payStatus && !['paid', 'refunded'].includes(o.payStatus) && o.status === 'done')
    .reduce((a, o) => a + (o.total || 0), 0);

  const priced = catalog.filter(p => p.stock != null);
  const out = priced.filter(p => (p.stock || 0) <= 0);
  const low = priced.filter(p => p.stock > 0 && p.stock < LOW_STOCK);

  /* An out-of-stock line only costs money if it was selling. Rank the shortage
     by what the shop actually took for it, not by how many lines are at zero. */
  const soldQty = new Map();
  for (const o of inWindow)
    for (const it of (o.items || []))
      soldQty.set(it.id, (soldQty.get(it.id) || 0) + (it.qty || 1));
  const dailyRate = id => (soldQty.get(id) || 0) / Math.max(1, opts.days);
  const lostPerDay = out.reduce((a, p) =>
    a + dailyRate(p.id) * (p.price || p.perKg || 0), 0);

  const stockValue = catalog.reduce((a, p) =>
    a + (p.stock || 0) * (p.cost != null ? p.cost : (p.price || 0) * 0.75), 0);

  return {
    id: b.id, name: b.name, area: b.area || '', city: b.city || '',
    products: catalog.length,
    inStock: priced.filter(p => (p.stock || 0) > 0).length,
    outOfStock: out.length,
    lowStock: low.length,
    stockValue: Math.round(stockValue),
    revenue: round2(rev),
    prevRevenue: round2(prevRev),
    trendPct: pct(rev, prevRev),
    orders: inWindow.length,
    todayRevenue: round2(todayOrders.reduce((a, o) => a + (o.total || 0), 0)),
    todayOrders: todayOrders.length,
    aov: inWindow.length ? Math.round(rev / inWindow.length) : 0,
    pending: pending.length,
    stale: stale.length,
    uncollected: Math.round(uncollected),
    lostPerDay: Math.round(lostPerDay),
    live: catalog.length > 0,
    staff: opts.staffByBranch[b.id] || 0,
    zonesSet: !!(opts.zones[b.id] && Object.keys(opts.zones[b.id]).length)
  };
}

/* ── exceptions ──
   Ordered by what it costs, not by how alarming it sounds. A shop that has not
   been set up is first because nothing else about it can be true yet. */
function exceptionsFor(rows, days) {
  const ex = [];
  for (const r of rows) {
    if (!r.products) {
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'setup', weight: 1e9,
        title: 'Not set up yet', detail: 'No products — this shop cannot take an order',
        action: 'Stock it', view: 'branch' });
      continue;                       // nothing below is meaningful for an empty shop
    }
    if (r.lostPerDay >= 1)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'high', weight: r.lostPerDay * 30,
        title: `${r.outOfStock} lines out of stock`,
        detail: `About AED ${Math.round(r.lostPerDay * 30).toLocaleString()} a month of demand with nothing on the shelf`,
        money: Math.round(r.lostPerDay * 30), action: 'Open reorder', view: 'reorder' });

    if (r.trendPct != null && r.trendPct <= -15 && r.prevRevenue > 0)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'high',
        weight: (r.prevRevenue - r.revenue),
        title: `Revenue down ${Math.abs(r.trendPct)}%`,
        detail: `AED ${Math.round(r.prevRevenue - r.revenue).toLocaleString()} behind its own previous ${days} days`,
        money: Math.round(r.prevRevenue - r.revenue), action: 'Open insights', view: 'insights' });

    if (r.stale)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'urgent', weight: r.stale * 500,
        title: `${r.stale} order${r.stale > 1 ? 's' : ''} waiting over ${STALE_ORDER_HOURS}h`,
        detail: 'A customer is still waiting on this shop',
        action: 'Open orders', view: 'orders' });

    if (r.uncollected >= 100)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'med', weight: r.uncollected,
        title: `AED ${r.uncollected.toLocaleString()} handed over unpaid`,
        detail: 'Delivered or collected but never marked paid',
        money: r.uncollected, action: 'Open orders', view: 'orders' });

    if (!r.staff)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'setup', weight: 5000,
        title: 'No staff account', detail: 'Nobody can sign in to run this shop',
        action: 'Add staff', view: 'staff' });

    if (!r.zonesSet && r.products)
      ex.push({ branchId: r.id, branch: r.name, area: r.area, sev: 'low', weight: 100,
        title: 'Floor plan not set', detail: 'Space and reorder advice is running on defaults',
        action: 'Open planner', view: 'wh' });
  }
  return ex.sort((a, b) => b.weight - a.weight);
}

/* ── the group ── */
function group(db, deps, { days = 7, branchIds = null } = {}) {
  const { STORES, TEN } = deps;
  const win = windowOf(days);
  const fallbackId = STORES.fallbackId(db);
  const all = STORES.list(db).filter(b => b.active !== false);
  const shops = branchIds ? all.filter(b => branchIds.includes(b.id)) : all;

  const staffByBranch = {};
  for (const u of (db['devx-staff'] || []))
    if (u.active !== false && u.branchId) staffByBranch[u.branchId] = (staffByBranch[u.branchId] || 0) + 1;

  const byBranch = new Map(shops.map(b => [b.id, []]));
  for (const o of (db['devx-orders'] || [])) {
    const bid = branchOfOrder(o, fallbackId);
    if (byBranch.has(bid)) byBranch.get(bid).push(o);
  }

  const opts = { win, days, staffByBranch, zones: db['devx-zones'] || {} };
  const rows = shops.map(b => branchStats(b, byBranch.get(b.id) || [], TEN.catalog(db, b.id), opts));

  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const revenue = round2(sum('revenue'));
  const prevRevenue = round2(sum('prevRevenue'));
  const orders = sum('orders');

  const ranked = rows.slice().sort((a, b) => b.revenue - a.revenue);
  ranked.forEach((r, i) => { r.rank = i + 1; });

  const trading = rows.filter(r => r.live);
  const best = ranked.find(r => r.live && r.revenue > 0) || null;
  /* "Worst" is only meaningful among shops that are actually trading —
     an empty new branch is a setup task, not a performance problem. */
  const worst = [...ranked].reverse().find(r => r.live && r.prevRevenue > 0) || null;

  return {
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      shops: rows.length,
      liveShops: trading.length,
      emptyShops: rows.length - trading.length,
      revenue, prevRevenue, trendPct: pct(revenue, prevRevenue),
      orders,
      aov: orders ? Math.round(revenue / orders) : 0,
      todayRevenue: round2(sum('todayRevenue')),
      todayOrders: sum('todayOrders'),
      pending: sum('pending'),
      stale: sum('stale'),
      uncollected: sum('uncollected'),
      outOfStock: sum('outOfStock'),
      lowStock: sum('lowStock'),
      products: sum('products'),
      stockValue: sum('stockValue'),
      lostPerMonth: Math.round(sum('lostPerDay') * 30)
    },
    branches: ranked,
    best: best && { id: best.id, name: best.name, area: best.area, revenue: best.revenue, trendPct: best.trendPct },
    worst: worst && { id: worst.id, name: worst.name, area: worst.area, revenue: worst.revenue, trendPct: worst.trendPct },
    exceptions: exceptionsFor(rows, days).slice(0, 25),
    exceptionCount: exceptionsFor(rows, days).length
  };
}

module.exports = { group, LOW_STOCK, STALE_ORDER_HOURS };
