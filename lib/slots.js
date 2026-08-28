/* ══════════════════════════════════════════════════════════════════════
   DELIVERY SLOTS AND REFUNDS

   Slots were a dropdown with no consequence: a hundred shoppers could all pick
   "Within 60 minutes" and the store would find out when the orders printed.
   A slot now has a capacity, fills up, and disappears when it is full or has
   passed.

   Refunds existed nowhere. A weighed-and-paid order that turns out to be
   spoiled had no path back, which is not something a store can operate
   without.
══════════════════════════════════════════════════════════════════════ */

function r2(n) { return Math.round(n * 100) / 100; }

/* Default shape of a trading day. Capacity is riders-per-window, which is the
   real constraint — the store can override any of it. */
const DEFAULT_SLOTS = [
  { key: 'express', label: 'Within 60 minutes', kind: 'express', capacity: 8,  cutoffMins: 0 },
  { key: 'am',      label: 'Today 10 AM – 12 PM', kind: 'window', capacity: 14, startHour: 10, endHour: 12 },
  { key: 'noon',    label: 'Today 12 – 2 PM',     kind: 'window', capacity: 14, startHour: 12, endHour: 14 },
  { key: 'pm',      label: 'Today 2 – 4 PM',      kind: 'window', capacity: 16, startHour: 14, endHour: 16 },
  { key: 'eve',     label: 'Today 6 – 8 PM',      kind: 'window', capacity: 20, startHour: 18, endHour: 20 },
  { key: 'tmr_am',  label: 'Tomorrow morning',    kind: 'window', capacity: 24, startHour: 9,  endHour: 12, tomorrow: true }
];

/* Orders already committed to each slot today (or tomorrow for those). */
function usage(orders, todayISO) {
  const used = {};
  const today = todayISO || new Date().toISOString().slice(0, 10);
  for (const o of orders || []) {
    if (o.status === 'cancelled' || o.mode !== 'delivery') continue;
    const day = String(o.date || '').slice(0, 10);
    const key = o.slotKey || null;
    if (!key) continue;
    // tomorrow slots are counted against the day they were booked for
    const bucket = day + '|' + key;
    used[bucket] = (used[bucket] || 0) + 1;
  }
  return { used, today };
}

/* What the checkout should offer right now. A slot is hidden once its window
   has passed and marked full once capacity is reached, so a shopper can never
   choose something the store cannot honour. */
function available(orders, config, now) {
  const cfg = (config && config.length ? config : DEFAULT_SLOTS);
  const t = now ? new Date(now) : new Date();
  const today = t.toISOString().slice(0, 10);
  const { used } = usage(orders, today);
  const hour = t.getHours() + t.getMinutes() / 60;

  return cfg.map(s => {
    const day = s.tomorrow
      ? new Date(t.getTime() + 86400000).toISOString().slice(0, 10)
      : today;
    const taken = used[day + '|' + s.key] || 0;
    const left = Math.max(0, (s.capacity || 0) - taken);

    // a window closes 30 minutes before it starts — a picker needs the lead time
    const passed = !s.tomorrow && s.kind === 'window' && (s.endHour != null) && hour > (s.endHour - 0.5);
    const full = left <= 0;

    return {
      key: s.key, label: s.label, kind: s.kind, day,
      capacity: s.capacity || 0, taken, left,
      available: !passed && !full,
      reason: passed ? 'This window has closed for today' : full ? 'Fully booked' : null
    };
  }).filter(s => !(s.kind === 'window' && !s.tomorrow && s.reason === 'This window has closed for today' && s.left > 0)
                 || s.available)          // keep sold-out ones visible, drop only stale windows
    .concat([]);
}

/* Server-side check at checkout, so a stale page cannot book a full slot. */
function claim(orders, config, slotKey, now) {
  if (!slotKey) return { ok: true, slot: null };          // pickup, or no slot chosen
  const s = available(orders, config, now).find(x => x.key === slotKey);
  if (!s) return { ok: false, error: 'That delivery time is no longer offered' };
  if (!s.available) return { ok: false, error: s.reason === 'Fully booked'
    ? 'That delivery time just filled up — please pick another'
    : 'That delivery time has closed — please pick another' };
  return { ok: true, slot: s };
}

/* ── refunds ──
   Partial by default: a store usually refunds one spoiled line, not the basket.
   The order keeps its history so the audit trail can show what was returned
   and why. */
function refund(order, { amount, reason, items, by }) {
  const paidTotal = order.total || 0;
  const already = (order.refunds || []).reduce((s, r) => s + r.amountAED, 0);
  const max = r2(paidTotal - already);
  const amt = amount == null ? max : r2(Number(amount));

  if (!(amt > 0)) return { ok: false, error: 'Refund amount must be more than zero' };
  if (amt > max) return { ok: false, error: `Only AED ${max} remains refundable on this order` };
  if (!reason || String(reason).trim().length < 3) return { ok: false, error: 'Give a reason for the refund' };

  const entry = {
    id: 'RF' + Date.now().toString(36).toUpperCase(),
    at: new Date().toISOString(),
    amountAED: amt,
    reason: String(reason).slice(0, 200),
    items: Array.isArray(items) ? items.slice(0, 50) : [],
    by: by || 'staff'
  };
  order.refunds = (order.refunds || []).concat(entry);
  order.refundedAED = r2(already + amt);
  order.payStatus = order.refundedAED >= paidTotal ? 'refunded' : 'part_refunded';
  order.history = (order.history || []).concat({ s: 'refunded', at: entry.at });
  return { ok: true, refund: entry, refundedAED: order.refundedAED, remainingAED: r2(max - amt) };
}

module.exports = { DEFAULT_SLOTS, available, claim, refund, usage };
