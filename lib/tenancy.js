/* ══════════════════════════════════════════════════════════════════════
   PER-BRANCH DATA

   Every branch runs its own shop: its own product list, its own stock and
   prices, its own shelf map, its own delivery windows. A second branch opens
   empty and the team fills it in — nothing is inherited unless they ask for it.

   Shape:
     devx-catalogs  { branchId: [ …products ] }     one list per shop
     devx-zones     { branchId: { category: {…} } } one floor plan per shop
     devx-slots     { branchId: [ …windows ] }      one delivery plan per shop

   Legacy installs stored a single flat catalogue with no branch. On first boot
   that becomes the founding branch's catalogue, so an existing shop keeps
   everything it had and simply becomes "branch one".

   Setting up branch two by hand is a lot of typing, which is why `seedFrom`
   exists: copy another branch's list as a starting point, then edit. Copying is
   opt-in — the default really is blank.
══════════════════════════════════════════════════════════════════════ */

const DEFAULT_BRANCH_ID = 'br-deira';

/* One-time move from the old single-catalogue shape. */
function migrate(db, defaultBranchId) {
  const id = defaultBranchId || DEFAULT_BRANCH_ID;
  if (!db['devx-catalogs']) db['devx-catalogs'] = {};

  const legacy = db['devx-catalog'];
  if (Array.isArray(legacy) && legacy.length && !db['devx-catalogs'][id]) {
    db['devx-catalogs'][id] = legacy;
    console.log(`[tenancy] moved ${legacy.length} products into branch "${id}"`);
  }
  // zones were a flat { category: {...} }; give them to the founding branch
  const z = db['devx-zones'];
  if (z && !Array.isArray(z) && Object.keys(z).length && !z[id] &&
      Object.values(z).some(v => v && (v.areaM2 != null || v.density != null))) {
    db['devx-zones'] = { [id]: z };
    console.log('[tenancy] moved the floor plan into the founding branch');
  }
  if (!db['devx-zones'] || Array.isArray(db['devx-zones'])) db['devx-zones'] = {};
  if (!db['devx-slots'] || Array.isArray(db['devx-slots'])) db['devx-slots'] = {};
  return db;
}

/* A branch's product list. Missing means the shop has not stocked anything
   yet, which is a legitimate state — a new branch on day one. */
function catalog(db, branchId) {
  const all = db['devx-catalogs'] || {};
  return all[branchId] || [];
}
function setCatalog(db, branchId, products) {
  if (!db['devx-catalogs']) db['devx-catalogs'] = {};
  db['devx-catalogs'][branchId] = products || [];
}
function zones(db, branchId) { return (db['devx-zones'] || {})[branchId] || {}; }
function setZones(db, branchId, z) {
  if (!db['devx-zones']) db['devx-zones'] = {};
  db['devx-zones'][branchId] = z || {};
}
function slots(db, branchId) { return (db['devx-slots'] || {})[branchId] || []; }

/* Product ids must not collide across branches — an order references a product
   id, and two shops both having "id 1" would make orders ambiguous. Ids are
   therefore allocated from a single counter across the whole chain. */
function nextProductId(db) {
  let max = 0;
  for (const list of Object.values(db['devx-catalogs'] || {}))
    for (const p of list) if (Number(p.id) > max) max = Number(p.id);
  return max + 1;
}

/* Copy another branch's list as a starting point. Stock is deliberately reset
   to zero: the new shop has not received anything yet, and inheriting a
   phantom stock figure would poison its first forecast and its first pick. */
function seedFrom(db, fromBranchId, toBranchId, { keepStock = false, categories = null } = {}) {
  const src = catalog(db, fromBranchId);
  if (!src.length) return { ok: false, error: 'That branch has no products to copy' };
  let base = src;
  if (Array.isArray(categories) && categories.length)
    base = src.filter(p => categories.includes(p.cat));
  if (!base.length) return { ok: false, error: 'No products matched those categories' };

  let id = nextProductId(db);
  const copied = base.map(p => Object.assign({}, p, {
    id: id++,
    stock: keepStock ? (p.stock || 0) : 0,
    // a shelf location belongs to a building, not to a product
    loc: '',
    // promotions are per shop, so a copy starts with none
    deal: false, was: undefined, offerPct: undefined, offerLabel: undefined
  }));
  setCatalog(db, toBranchId, copied);
  return { ok: true, copied: copied.length, from: fromBranchId, keptStock: !!keepStock };
}

/* Import a plain CSV — the realistic way a shop with 1,000 lines gets started.
   Deliberately forgiving about column order and casing, because the file will
   come out of whatever their POS exports. */
const HEADER_ALIASES = {
  name: ['name', 'product', 'product name', 'item', 'description', 'item name'],
  brand: ['brand', 'make', 'manufacturer'],
  cat: ['cat', 'category', 'department', 'group', 'section'],
  price: ['price', 'selling price', 'sell', 'rate', 'mrp', 'unit price'],
  was: ['was', 'old price', 'list price', 'rrp'],
  unit: ['unit', 'size', 'pack', 'uom', 'weight'],
  stock: ['stock', 'qty', 'quantity', 'on hand', 'soh', 'balance'],
  loc: ['loc', 'location', 'shelf', 'aisle', 'bin', 'rack'],
  perKg: ['perkg', 'per kg', 'price per kg', 'kg price'],
  barcode: ['barcode', 'ean', 'upc', 'sku', 'code'],
  img: ['img', 'image', 'image url', 'photo']
};
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function parseCsv(text, db) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { ok: false, error: 'The file needs a header row and at least one product' };

  /* Compare headers on a squashed form — lower case, punctuation and spaces
     removed — so "Per Kg", "per_kg" and "PERKG" are all the same column. Our
     own downloadable template writes `per_kg`, and matching on the literal
     string silently dropped every loose item in it. */
  const squash = h => String(h).toLowerCase().replace(/^"|"$/g, '').replace(/[^a-z0-9]/g, '');
  const header = splitCsvLine(lines[0]).map(squash);
  const col = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) {
    const want = names.map(squash);
    const i = header.findIndex(h => want.includes(h));
    if (i >= 0) col[field] = i;
  }
  if (col.name == null)
    return { ok: false, error: `Could not find a product name column. Looked for: ${HEADER_ALIASES.name.join(', ')}` };

  let id = nextProductId(db);
  const products = [], skipped = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const name = (c[col.name] || '').replace(/^"|"$/g, '').trim();
    if (!name) { skipped.push(`row ${i + 1}: no name`); continue; }
    const num = k => {
      const v = col[k] != null ? parseFloat(String(c[col[k]]).replace(/[^\d.-]/g, '')) : NaN;
      return Number.isFinite(v) ? v : undefined;
    };
    /* A row needs A price, not necessarily a unit price. Produce and meat are
       sold by weight and carry only a per-kg rate — requiring `price` silently
       dropped exactly the items this product is built around. */
    const perKg = num('perKg');
    const price = num('price') != null ? num('price') : perKg;
    if (price == null) {
      skipped.push(`row ${i + 1}: ${name} has neither a price nor a per-kg rate`);
      continue;
    }
    products.push({
      id: id++, name: name.slice(0, 80),
      brand: (c[col.brand] || '').trim().slice(0, 40) || undefined,
      cat: (c[col.cat] || 'General').trim().slice(0, 40) || 'General',
      price, was: num('was'),
      unit: (c[col.unit] || '').trim().slice(0, 20) || undefined,
      stock: num('stock') != null ? Math.max(0, Math.round(num('stock'))) : 0,
      loc: (c[col.loc] || '').trim().slice(0, 60) || undefined,
      perKg, loose: perKg != null || undefined,
      barcode: (c[col.barcode] || '').trim().slice(0, 40) || undefined,
      img: (c[col.img] || '').trim() || undefined
    });
  }
  if (!products.length) return { ok: false, error: 'No usable rows found', skipped: skipped.slice(0, 10) };
  return { ok: true, products, skipped: skipped.slice(0, 20), skippedCount: skipped.length };
}

/* A template the store can fill in, so nobody has to guess the columns. */
function csvTemplate() {
  return ['name,brand,category,price,was,unit,stock,location,per_kg,barcode',
    'Basmati Rice,Nexus Gold,Rice & Grains,32,36,5kg,24,Aisle 7 · Rack 3 · Shelf 6,,6291234567890',
    'Tomatoes,,Fresh Produce,,,1 kg,40,Aisle 1 · Rack 1,5,',
    'Full Cream Milk,Al Ain,Dairy & Chilled,7,,1L,60,Aisle 2 · Chiller 1,,6299876543210'].join('\n');
}

module.exports = {
  DEFAULT_BRANCH_ID, migrate, catalog, setCatalog, zones, setZones, slots,
  nextProductId, seedFrom, parseCsv, csvTemplate
};
