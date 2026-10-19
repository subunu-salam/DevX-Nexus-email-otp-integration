/* ══════════════════════════════════════════════════════════════════════
   SMART PRODUCT SEARCH  (no LLM needed, works on any catalogue)

   Turns a free-text shopper message into a ranked list of products:
     1. aliases      "dahi"/"curd" -> yogurt, "atta" -> wheat flour, Arabic/Hindi
                     /Malayalam words, "capsicum" -> bell pepper ...
     2. stemming     tomato = tomatoes, battery = batteries, leaf = leaves
     3. typo repair  "chiken", "biriyani", "tomatoe", "stationary"
     4. multi-item   "milk, eggs and 2 kg rice" -> one result set PER item
     5. category     "vegetables", "cold drinks", "spices" -> that whole aisle
     6. ranking      all words matched > head-noun match > partial; in-stock first

   Pure functions, no I/O. API:
     smartSearch(query, products, opts?) -> Product[]  (best first)
        result.segments = [{ text, tokens, products[] }]   one per item asked
        result.corrected = [[from,to], ...]                typo repairs made
        result.isCategory                                   aisle-style query
     normalizeQuery(query, products) -> string  (aliases + typo repair applied)
══════════════════════════════════════════════════════════════════════ */

/* ── 1. Aliases: phrase -> English catalogue words ───────────────────── */
const ALIASES = {
  // Hindi / Urdu (romanised)
  'dahi': 'yogurt', 'curd': 'yogurt', 'yoghurt': 'yogurt', 'doodh': 'milk', 'dudh': 'milk',
  'atta': 'wheat flour', 'maida': 'flour', 'chawal': 'rice', 'chaval': 'rice', 'basmati': 'basmati rice',
  'murgh': 'chicken', 'murg': 'chicken', 'murgi': 'chicken', 'gosht': 'mutton', 'goat': 'mutton',
  'machli': 'fish', 'jhinga': 'prawns', 'aloo': 'potatoes', 'alu': 'potatoes', 'pyaz': 'onions',
  'pyaaz': 'onions', 'tamatar': 'tomatoes', 'adrak': 'ginger', 'lehsun': 'garlic', 'lahsun': 'garlic',
  'haldi': 'turmeric', 'mirch': 'chili', 'mirchi': 'chili', 'jeera': 'cumin', 'dhania': 'coriander',
  'dhaniya': 'coriander', 'elaichi': 'cardamom', 'dalchini': 'cinnamon', 'tej patta': 'bay leaves',
  'namak': 'salt', 'cheeni': 'sugar', 'chini': 'sugar', 'shakkar': 'sugar', 'makhan': 'butter',
  'anda': 'eggs', 'ande': 'eggs', 'chai': 'tea', 'pani': 'water', 'nimbu': 'lemon', 'dal': 'lentils', 'daal': 'lentils', 'toor': 'toor dal', 'moong': 'green gram', 'chana': 'chickpeas',
  'kela': 'bananas', 'seb': 'apples', 'santra': 'oranges', 'aam': 'mango', 'palak': 'spinach',
  'gajar': 'carrots', 'kheera': 'cucumber', 'pudina': 'mint', 'tel': 'oil', 'ghi': 'ghee', 'shahad': 'honey',
  'roti': 'roti chapati', 'chapati': 'roti chapati', 'chapathi': 'roti chapati',
  // English synonyms / US-UK
  'capsicum': 'bell pepper', 'bellpepper': 'bell pepper', 'shrimp': 'prawns', 'shrimps': 'prawns',
  'lamb': 'lamb mutton', 'mutton': 'mutton lamb', 'mince': 'mince', 'minced': 'mince', 'ground beef': 'beef mince',
  'soda': 'cola', 'coke': 'cola', 'pepsi': 'pepsi cola', 'cooking oil': 'oil', 'tissue paper': 'tissue',
  'loo roll': 'toilet rolls', 'toilet paper': 'toilet rolls', 'toilet roll': 'toilet rolls',
  'paper towel': 'kitchen towel', 'paper towels': 'kitchen towel', 'kitchen roll': 'kitchen towel',
  'washing powder': 'laundry detergent', 'washing liquid': 'laundry detergent', 'detergent': 'detergent',
  'dishwash': 'dishwashing liquid', 'dish wash': 'dishwashing liquid', 'dish soap': 'dish soap',
  'aluminum foil': 'aluminium foil', 'tin foil': 'aluminium foil', 'foil': 'aluminium foil',
  'bin bags': 'garbage bags', 'trash bags': 'garbage bags', 'bin liners': 'garbage bags',
  'nappies': 'diapers', 'nappy': 'diapers', 'diaper': 'baby diapers', 'diapers': 'baby diapers',
  'formula milk': 'baby formula', 'cornflakes': 'corn flakes', 'cereal': 'cereal', 'cereals': 'cereal',
  'fries': 'frozen fries', 'chips': 'chips', 'crisps': 'potato chips', 'cookies': 'cookies biscuits',
  'cookie': 'cookies biscuits', 'jam': 'fruit jam', 'jelly': 'fruit jam', 'nuts': 'nuts', 'peanut': 'peanuts',
  'pasta': 'pasta', 'spaghetti': 'spaghetti', 'noodle': 'noodles', 'tuna': 'canned tuna',
  'chickpea': 'chickpeas', 'garbanzo': 'chickpeas', 'garbanzos': 'chickpeas', 'lentil': 'lentils',
  'beans': 'beans', 'sweetcorn': 'sweet corn', 'corn': 'corn', 'peas': 'peas', 'veggies': 'vegetables',
  'veggie': 'vegetables', 'coriander leaves': 'fresh coriander', 'cilantro': 'fresh coriander',
  'coriander leaf': 'fresh coriander', 'mint leaves': 'fresh mint', 'parsley': 'fresh coriander',
  'salmon': 'salmon fillet', 'hamour': 'hammour', 'hammour': 'hammour fillet', 'beef': 'beef',
  'steak': 'beef', 'roast': 'meat', 'wings': 'chicken', 'drumsticks': 'chicken thighs',
  'whole milk': 'full cream milk', 'full fat milk': 'full cream milk', 'skimmed milk': 'low fat milk',
  'skim milk': 'low fat milk', 'semi skimmed milk': 'low fat milk', 'double cream': 'cooking cream',
  'whipping cream': 'cooking cream', 'cream': 'cooking cream', 'cheddar': 'cheddar cheese',
  'mozarella': 'mozzarella', 'sliced cheese': 'cheese slices', 'toast': 'bread', 'loaf': 'bread',
  'bun': 'burger buns', 'buns': 'burger buns', 'burger bun': 'burger buns', 'tortilla': 'tortilla chips', 'water bottle': 'mineral water', 'bottled water': 'mineral water',
  'cold drink': 'beverages', 'cold drinks': 'beverages', 'soft drink': 'beverages', 'soft drinks': 'beverages',
  'fizzy drink': 'beverages', 'fizzy drinks': 'beverages', 'drinks': 'beverages', 'drink': 'beverages',
  'chocolate': 'chocolate', 'choc': 'chocolate', 'sugar free': 'sugar', 'something sweet': 'dessert', 'sweet treat': 'dessert', 'sweet treats': 'dessert', 'cumin seeds': 'cumin', 'jeera powder': 'cumin', 'red chilli': 'chili powder',
  'chilli': 'chili', 'chilly': 'chili', 'chillies': 'chili', 'chilies': 'chili', 'red chili': 'chili powder',
  'chili powder': 'chili powder', 'pepper': 'black pepper', 'peppercorn': 'black pepper',
  'bayleaf': 'bay leaves', 'bay leaf': 'bay leaves', 'cinnamon stick': 'cinnamon sticks',
  'salt': 'table salt', 'sea salt': 'table salt', 'sunflower': 'sunflower oil', 'evoo': 'olive oil',
  'batteries': 'batteries', 'cell': 'batteries', 'cells': 'batteries', 'torch': 'flashlight',
  'phone charger': 'usb c cable', 'charger': 'usb c cable', 'usb': 'usb c cable', 'cable': 'cable',
  'light bulb': 'led bulb', 'bulb': 'led bulb', 'stationary': 'stationery', 'copy': 'notebook',
  'paper': 'a4 paper', 'printer paper': 'a4 paper', 'pen': 'pen', 'tape': 'sticky tape', 'sellotape': 'sticky tape',
  'cling wrap': 'cling film', 'plastic wrap': 'cling film', 'zip bags': 'ziplock bags', 'napkin': 'napkins',
  'napkins': 'table napkins', 'cups': 'paper cups', 'plates': 'paper plates', 'cutlery': 'plastic cutlery',
  'sanitizer': 'hand wash', 'sanitiser': 'hand wash', 'handwash': 'hand wash', 'razor': 'razors',
  'shaving cream': 'shaving foam', 'tooth paste': 'toothpaste', 'tooth brush': 'toothbrush',
  'ice cream': 'ice cream', 'cat food': 'cat food', 'dog food': 'dog food', 'kitty litter': 'cat litter', 'puppy food': 'dog food',
  // Arabic
  'حليب': 'milk', 'لبن': 'laban', 'خبز': 'bread', 'أرز': 'rice', 'ارز': 'rice', 'رز': 'rice', 'دجاج': 'chicken',
  'فراخ': 'chicken', 'لحم': 'mutton', 'غنم': 'mutton', 'بيض': 'eggs', 'جبن': 'cheese', 'جبنة': 'cheese',
  'ماء': 'water', 'مياه': 'water', 'سكر': 'sugar', 'ملح': 'salt', 'زيت': 'oil', 'شاي': 'tea', 'قهوة': 'coffee',
  'بطاطس': 'potatoes', 'بطاطا': 'potatoes', 'بصل': 'onions', 'طماطم': 'tomatoes', 'زبادي': 'yogurt',
  'تمر': 'dates', 'عسل': 'honey', 'سمك': 'fish', 'جمبري': 'prawns', 'ثوم': 'garlic', 'زنجبيل': 'ginger',
  'ليمون': 'lemon', 'موز': 'bananas', 'تفاح': 'apples', 'برتقال': 'oranges', 'عصير': 'juice', 'زبدة': 'butter',
  'معكرونة': 'pasta', 'عدس': 'lentils', 'حمص': 'chickpeas', 'طحين': 'wheat flour', 'دقيق': 'wheat flour',
  'هيل': 'cardamom', 'قرفة': 'cinnamon', 'كركم': 'turmeric', 'كمون': 'cumin', 'فلفل': 'black pepper',
  // Hindi (Devanagari)
  'दूध': 'milk', 'चावल': 'rice', 'आटा': 'wheat flour', 'दही': 'yogurt', 'प्याज': 'onions', 'टमाटर': 'tomatoes',
  'आलू': 'potatoes', 'अंडे': 'eggs', 'अंडा': 'eggs', 'चीनी': 'sugar', 'नमक': 'salt', 'तेल': 'oil', 'चाय': 'tea',
  'मक्खन': 'butter', 'चिकन': 'chicken', 'दाल': 'lentils', 'हल्दी': 'turmeric',
  'मिर्च': 'chili', 'जीरा': 'cumin', 'अदरक': 'ginger', 'लहसुन': 'garlic', 'केला': 'bananas', 'सेब': 'apples',
  'पानी': 'water', 'रोटी': 'roti chapati', 'ब्रेड': 'bread', 'घी': 'ghee', 'शहद': 'honey',
  // Malayalam
  'അരി': 'rice', 'പാൽ': 'milk', 'മുട്ട': 'eggs', 'ഉള്ളി': 'onions', 'തക്കാളി': 'tomatoes', 'ചിക്കൻ': 'chicken',
  'ഉപ്പ്': 'salt', 'പഞ്ചസാര': 'sugar', 'എണ്ണ': 'oil', 'ചായ': 'tea', 'വെള്ളം': 'water', 'ബ്രെഡ്': 'bread'
};

/* Words that name a whole aisle rather than one product. */
const CATEGORY_WORDS = {
  'Fresh Produce':    ['vegetable', 'veggie', 'veg', 'fruit', 'produce', 'greens', 'herb', 'salad'],
  'Fresh Meat':       ['meat', 'seafood', 'poultry', 'protein'],
  'Dairy & Chilled':  ['dairy', 'chilled'],
  'Spices':           ['spice', 'seasoning', 'masala'],
  'Rice & Grains':    ['grain', 'pulse', 'cereal-grain'],
  'Beverages':        ['beverage', 'drink', 'juice', 'soda'],
  'Snacks':           ['snack', 'munchies', 'nibble', 'nut'],
  'Bakery':           ['bakery', 'pastry'],
  'Cooking Oil':      ['oil'],
  'Household':        ['household', 'cleaning', 'cleaner'],
  'Personal Care':    ['grooming', 'hygiene', 'toiletry', 'toiletries', 'personal'],
  'Stationery':       ['stationery', 'office', 'school'],
  'Electrical':       ['electrical', 'electronic', 'electronics'],
  'Kitchen & Dining': ['kitchenware', 'tableware', 'disposable'],
  'Frozen':           ['frozen'],
  'Baby':             ['baby'],
  'Pet':              ['pet'],
  'Breakfast':        ['breakfast'],
  'Condiments':       ['condiment', 'sauce'],
  'Canned & Jarred':  ['canned', 'tinned', 'jarred'],
  'Pasta & Noodles':  ['pasta', 'noodle'],
    'Health & Organic': ['organic', 'healthy', 'superfood']
};

/* Generic words that mean "this set of products" (group keys; missing ones are ignored). */
const GROUP_SETS = {
  vegetable: ['onions','tomatoes','potatoes','cucumber','carrots','bell-pepper','garlic','ginger','spinach','lettuce','coriander','mint','frozen-veg','frozen-peas'],
  fruit:     ['bananas','apples','oranges','lemons','grapes','mango','dried-apricots','dates'],
  meat:      ['whole-chicken','chicken-breast','chicken-thigh','mutton','beef-mince'],
  seafood:   ['fish-salmon','fish-hammour','prawns','canned-tuna'],
  herb:      ['coriander','mint','bay-leaf'],
  dessert:   ['cake','ice-cream','chocolate-bar','chocolate-spread','honey'],
  protein:   ['whole-chicken','chicken-breast','mutton','beef-mince','fish-salmon','prawns','eggs'],
  salad:     ['lettuce','tomatoes','cucumber','carrots','bell-pepper','olive-oil'],
  breakfast: ['eggs','cornflakes','choco-cereal','honey','jam','peanut-butter','full-cream-milk','white-bread','butter','dates']
};
const STOP = new Set(['i', 'me', 'my', 'we', 'us', 'is', 'are', 'am', 'it', 'do', 'does', 'did', 'there', 'here',
  'want', 'wanna', 'need', 'needs', 'looking', 'look', 'search', 'searching', 'show', 'find', 'give', 'get', 'got',
  'buy', 'shop', 'order', 'add', 'put', 'bring', 'send', 'cart', 'basket', 'please', 'pls', 'plz', 'kindly',
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'from', 'with', 'without', 'some', 'any', 'all',
  'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'you', 'your', 'our', 'that', 'this', 'these',
  'those', 'what', 'which', 'where', 'how', 'much', 'many', 'about', 'also', 'more', 'less', 'one', 'two', 'three',
  'something', 'anything', 'stuff', 'things', 'thing', 'item', 'items', 'product', 'products', 'store', 'cheap',
  'cheapest', 'best', 'good', 'healthy', 'health', 'fresh', 'new', 'nice', 'tasty', 'quality', 'brand', 'size',
  'kg', 'kgs', 'g', 'gm', 'gms', 'gram', 'grams', 'ml', 'l', 'ltr', 'liter', 'litre', 'liters', 'litres',
  'pcs', 'pc', 'piece', 'pieces', 'pack', 'packs', 'packet', 'packets', 'dozen', 'bottle', 'bottles', 'box',
  'ingredient', 'ingredients', 'recipe', 'make', 'making', 'cook', 'cooking', 'prepare', 'tonight', 'today',
  'aed', 'dhs', 'dh', 'dirham', 'dirhams', 'budget', 'week', 'weekly', 'month', 'monthly', 'design', 'plan', 'planner', 'list', 'grocery', 'groceries', 'under', 'within', 'around', 'total', 'spend', 'dinner', 'lunch', 'movie', 'night', 'party', 'weekend', 'guests', 'guest', 'kids', 'home', 'breakfast-time', 'serving', 'servings', 'people', 'persons', 'family', 'few', 'bit', 'lot']);

/* "fresh" is dropped above, but "Fresh Coriander" must still be found by "coriander". */

/* ── helpers ─────────────────────────────────────────────────────────── */
const IRREGULAR = { leaves: 'leaf', loaves: 'loaf', halves: 'half', knives: 'knife', potatoes: 'potato',
  tomatoes: 'tomato', mangoes: 'mango', cookies: 'cookie', chilies: 'chili', chillies: 'chili', berries: 'berry' };
function stem(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/(ss|us|is)$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
const NON_LATIN = /[^\u0000-ɏ]/;
function words(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9À-￿]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function stemTokens(s) { return words(s).map(stem); }

// Damerau-Levenshtein with early exit (strings are short).
function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[lb];
}

/* ── per-catalogue cache (vocabulary + per-product token sets) ───────── */
const CACHE = new WeakMap();      // products array -> { n, vocab, vocabList, prodWords }
const PROD = new WeakMap();       // product -> { name, group, cat, brand, nameSet, all }
function profile(p) {
  let x = PROD.get(p);
  if (!x) {
    const name = stemTokens(p.name);
    const group = stemTokens((p.group || '').replace(/-/g, ' '));
    const cat = stemTokens(p.cat);
    const brand = stemTokens(p.brand);
    x = { name, group, cat, brand, nameSet: new Set(name), groupSet: new Set(group) };
    PROD.set(p, x);
  }
  return x;
}
function ctxFor(products) {
  let c = CACHE.get(products);
  if (c && c.n === products.length) return c;
  const vocab = new Set(), prodWords = new Set();
  for (const p of products) {
    const x = profile(p);
    x.name.forEach(t => { vocab.add(t); prodWords.add(t); });
    x.group.forEach(t => { vocab.add(t); prodWords.add(t); });
    x.cat.forEach(t => vocab.add(t));
    x.brand.forEach(t => vocab.add(t));
  }
  for (const v of Object.values(ALIASES)) stemTokens(v).forEach(t => vocab.add(t));
  c = { n: products.length, vocab, vocabList: [...vocab].filter(t => t.length >= 4), prodWords };
  CACHE.set(products, c);
  return c;
}

/* ── query normalisation ─────────────────────────────────────────────── */
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const LATIN_KEYS = ALIAS_KEYS.filter(k => !NON_LATIN.test(k));
const OTHER_KEYS = ALIAS_KEYS.filter(k => NON_LATIN.test(k));
// ONE pass, longest phrase first, so an expansion is never re-aliased
// ("ice cream" must not become "ice cooking cream").
const LATIN_RE = new RegExp('(^|[^a-z0-9])(' + LATIN_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^a-z0-9])', 'g');
function applyAliases(text) {
  let t = ' ' + String(text || '').toLowerCase().replace(/[\u2019']/g, '') + ' ';
  for (const k of OTHER_KEYS) if (t.includes(k)) t = t.split(k).join(' ' + ALIASES[k] + ' ');
  t = t.replace(LATIN_RE, (m, pre, key) => pre + ' ' + ALIASES[key] + ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Split "milk, eggs and 2 kg rice" into separate item phrases.
function splitSegments(text) {
  return String(text || '')
    .split(/\s*(?:,|;|\n|\||&|\+|\/|\band\b|\bplus\b|\baur\b|\bya\b|\balso\b|\bthen\b|\bwith\b|\bor\b|و(?=\s))\s*/i)
    .map(s => s.trim()).filter(Boolean);
}

function fixTypos(tokens, ctx, corrected) {
  return tokens.map(t => {
    if (t.length < 4 || ctx.vocab.has(t) || /\d/.test(t)) return t;
    // a real prefix of a catalogue word ("chick", "yogh") is fine as-is
    for (const v of ctx.vocabList) if (v.length > t.length && v.startsWith(t) && t.length >= 4) return t;
    const max = t.length <= 6 ? 1 : 2;
    let best = null, bd = max + 1;
    for (const v of ctx.vocabList) {
      const d = editDistance(t, v, max);
      if (d < bd || (d === bd && best && v.length < best.length)) { bd = d; best = v; }
    }
    if (best && bd <= max) { corrected.push([t, best]); return best; }
    return t;
  });
}

function parseQuery(query, products) {
  const ctx = ctxFor(products);
  const corrected = [];
  const aliased = applyAliases(query);
  const segs = splitSegments(aliased).map(text => {
    const toks = fixTypos(stemTokens(text).filter(w => !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w) && w.length > 1), ctx, corrected);
    return { text, tokens: [...new Set(toks)] };
  }).filter(s => s.tokens.length);
  return { ctx, segs, corrected, aliased };
}

function normalizeQuery(query, products) {
  const { segs } = parseQuery(query, products);
  return segs.map(s => s.tokens.join(' ')).join(', ');
}

/* ── scoring ─────────────────────────────────────────────────────────── */
function scoreProduct(p, tokens, catTargets, ctx) {
  const x = profile(p);
  let s = 0, strong = 0, weak = 0;
  const last = x.name[x.name.length - 1];
  const lastGroup = x.group[x.group.length - 1];
  for (const t of tokens) {
    if (GROUP_SETS[t] && p.group && GROUP_SETS[t].includes(p.group)) { s += 22; strong++; }
    else if (x.nameSet.has(t)) { s += 6 + ((t === last || t === lastGroup) ? 3 : 0); strong++; }
    else if (x.groupSet.has(t)) { s += 5; strong++; }
    else if (t.length >= 4 && x.name.some(n => n.startsWith(t))) { s += 3; strong++; }
    else if (t.length >= 5 && x.name.some(n => n.length > t.length && n.endsWith(t))) { s += 2.5; strong++; }
    else if (catTargets[t] && catTargets[t].has(p.cat)) { s += 7; strong++; }
    else if (x.cat.includes(t)) { s += 3; weak++; }
    else if (x.brand.includes(t)) { s += 3; weak++; }
  }
  if (!strong && !weak) return 0;
  const cover = strong / tokens.length;
  if (cover === 1) s += 12;
  else if (strong) s *= (0.35 + 0.65 * cover);
  else s *= 0.4;                      // matched only on aisle/brand name: weak evidence
  // specificity: prefer the product that IS the thing over one that merely contains it
  s -= 0.15 * Math.max(0, x.name.length - strong);
  if (p.stock == null || p.stock > 0) s += 1.5; else s -= 4;
  if (p.loose) s -= 0.3;            // show packaged first, loose variants live in the group swap
  return s;
}

function categoryTargets(tokens, ctx) {
  const out = {};
  for (const t of tokens) {
    // only treat the word as an aisle when no product is literally named after it
    for (const [cat, ws] of Object.entries(CATEGORY_WORDS)) {
      if (ws.some(w => stem(w) === t) && !ctx.prodWords.has(t)) { (out[t] = out[t] || new Set()).add(cat); }
      else if (ws.some(w => stem(w) === t) && ['oil', 'tea', 'coffee', 'sauce', 'pasta', 'noodle', 'baby', 'pet', 'frozen', 'breakfast'].includes(t)) {
        (out[t] = out[t] || new Set()).add(cat);
      }
    }
  }
  return out;
}

function smartSearch(query, products, opts = {}) {
  const limitPerSeg = opts.limitPerSeg || 40;
  const { ctx, segs, corrected } = parseQuery(query, opts.vocabFrom || products);
  const lists = [];
  let isCategory = false;
  const rank = seg => {
    const cats = categoryTargets(seg.tokens, ctx);
    if (Object.keys(cats).length || seg.tokens.some(t => GROUP_SETS[t])) isCategory = true;
    let scored = [];
    for (const p of products) {
      const sc = scoreProduct(p, seg.tokens, cats, ctx);
      if (sc > 0) scored.push([p, sc]);
    }
    // category prior: when a word matches products across aisles ("milk": dairy, canned,
    // health), the aisle holding most of the matches is the plain/normal product.
    if (scored.length > 1 && !Object.keys(cats).length) {
      const cnt = new Map();
      for (const [p] of scored) cnt.set(p.cat, (cnt.get(p.cat) || 0) + 1);
      let topCat = null, topN = 0;
      for (const [c, n] of cnt) if (n > topN) { topN = n; topCat = c; }
      scored = scored.map(([p, sc]) => [p, p.cat === topCat ? sc + 3 : sc]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    // drop legacy duplicates (an ungrouped "Chicken Whole" next to the grouped "Whole Chicken")
    const seenKey = new Set(), uniq = [];
    for (const [p, sc] of scored) {
      const key = profile(p).name.slice().sort().join('|');
      if (seenKey.has(key)) continue;
      seenKey.add(key); uniq.push([p, sc]);
    }
    const top = uniq.length ? uniq[0][1] : 0;
    const isSet = seg.tokens.some(t => GROUP_SETS[t]);
    const frac = (Object.keys(cats).length || isSet) ? 0.4 : 0.45;
    return { top: uniq[0] ? uniq[0][0] : null, cover: uniq.length ? uniq[0][1] : 0,
      keep: uniq.filter(([, sc]) => sc >= top * frac).slice(0, limitPerSeg).map(x => x[0]) };
  };
  const segInfo = [];
  for (const seg of segs) {
    let r = rank(seg);
    // Unseparated list ("milk eggs bread"): if no single product covers every word,
    // search each word as its own item instead of favouring whichever word ranks best.
    if (seg.tokens.length > 1 && r.top) {
      const x = profile(r.top);
      const all = seg.tokens.every(t => x.nameSet.has(t) || x.groupSet.has(t) || x.cat.includes(t) || x.brand.includes(t) || (t.length >= 4 && x.name.some(n => n.startsWith(t))));
      if (!all && !seg.tokens.some(t => GROUP_SETS[t])) {
        const parts = seg.tokens.map(t => ({ text: t, tokens: [t] }));
        const sub = parts.map(rank);
        sub.forEach((sr, i) => { lists.push(sr.keep); segInfo.push({ text: parts[i].text, tokens: parts[i].tokens, products: sr.keep }); });
        continue;
      }
    }
    lists.push(r.keep);
    segInfo.push({ text: seg.text, tokens: seg.tokens, products: r.keep });
  }
  // round-robin merge so every requested item is represented near the top
  const out = [], seen = new Set();
  for (let i = 0; out.length < 400; i++) {
    let any = false;
    for (const l of lists) {
      if (i < l.length) {
        any = true;
        if (!seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]); }
      }
    }
    if (!any) break;
  }
  out.segments = segInfo;
  out.corrected = corrected;
  out.isCategory = isCategory;
  return out;
}

module.exports = { smartSearch, normalizeQuery, applyAliases, splitSegments, stem, ALIASES };
