/* ══════════════════════════════════════════════════════════════════════
   PAYMENT & WEIGHT-CONFIRMATION ENGINE

   The problem this solves (raised by the client):
     A shopper orders 250 g of chicken. The picker cuts 300 g. If we already
     charged for 250 g the store loses money; if we charge more without
     telling them, the customer is angry.

   The retail answer (how Instacart / Carrefour / Talabat do it):
     NEVER capture money before the item is weighed.

   Order lifecycle:
     placed → picking → weighed → confirmed → paid → ready → done

   Payment methods and where money moves:
     cash         cash to the driver .......... charge at delivery
     card_machine PDQ at the door ............. charge at delivery
     online       card screen in the app ...... charged after weighing

   Tolerance: if the actual weight is within ±TOLERANCE of what was ordered
   we auto-accept (no customer ping). Outside it, the customer approves,
   swaps, or drops the line.
══════════════════════════════════════════════════════════════════════ */

const TOLERANCE = 0.10;          // ±10%
const PREAUTH_BUFFER = 0.20;     // authorise 120% of the estimate
/* Post-order additions below this value are rejected — small deltas are not
   worth an extra payment-gateway charge. */
const MIN_ADDITION_AED = 15;

/* Three options, exactly as the store offers them.
   Cash and the card machine are settled at the door, so weight variance is
   never a risk. "Online" opens the card screen — and for orders containing
   weighed items we only take the money AFTER the actual weight is confirmed,
   so the customer is never charged the wrong amount. */
const PAYMENT_METHODS = {
  cash:         { label: 'Cash',           hint: 'Pay the driver on delivery',        chargeAt: 'delivery',      needsGateway: false },
  card_machine: { label: 'Card machine',   hint: 'Tap or insert on delivery',         chargeAt: 'delivery',      needsGateway: false },
  online:       { label: 'Online payment', hint: 'Pay by card — charged after weighing', chargeAt: 'after_confirm', needsGateway: true }
};
// Legacy keys from earlier builds still resolve, so old orders keep working.
const METHOD_ALIASES = { cod: 'cash', online_after: 'online', preauth: 'online' };
function normaliseMethod(k) {
  const key = METHOD_ALIASES[k] || k;
  return PAYMENT_METHODS[key] ? key : 'cash';
}

const ORDER_STATES = ['placed', 'picking', 'weighed', 'confirmed', 'paid', 'ready', 'done', 'cancelled'];

function round2(n) { return Math.round(n * 100) / 100; }

/* Does this order contain anything that must be weighed? */
function hasLooseItems(order) {
  return (order.items || []).some(i => i.loose);
}

/* Amount to authorise up-front for a pre-auth card payment. */
function preauthAmount(order) {
  return round2((order.total || 0) * (1 + PREAUTH_BUFFER));
}

/* Record the actual weight a picker measured for one line.
   Returns the recalculated line and whether the customer must approve. */
function applyActualWeight(item, actualGrams) {
  const ordered = item.grams || 0;
  const perKg = item.perKg != null ? item.perKg : item.price;
  const newPrice = round2(perKg * actualGrams / 1000);
  const drift = ordered ? Math.abs(actualGrams - ordered) / ordered : 0;

  return {
    ...item,
    grams: ordered,
    actualGrams,
    price: newPrice,
    unit: actualGrams >= 1000 ? (actualGrams / 1000) + ' kg' : actualGrams + ' g',
    drift: round2(drift * 100),                 // % difference, for the UI
    needsApproval: drift > TOLERANCE            // outside ±10% → ask the customer
  };
}

/* Recalculate an order after weights are entered. */
function recalcOrder(order) {
  let sub = 0;
  let approval = false;
  for (const it of order.items) {
    sub += it.loose ? (it.price || 0) : (it.price || 0) * (it.qty || 1);
    if (it.needsApproval) approval = true;
  }
  const fee = order.mode === 'delivery' ? (order.fee != null ? order.fee : 10) : 0;
  /* Carry the redeemed coupon through the reweigh. Dropping it here silently
     re-charged the customer full price the moment their items hit the scale. */
  const discount = order.discount || 0;
  return {
    sub: round2(sub),
    fee,
    discount: round2(discount),
    total: round2(Math.max(0, sub + fee - discount)),
    needsApproval: approval
  };
}

/* What the customer should see/do next. */
/* Drives what the customer's order card offers next. Keyed off payStatus,
   which is the weigh-and-pay track — deliberately independent of `status`,
   the fulfilment track shown on the admin board. */
function nextAction(order) {
  switch (order.payStatus) {
    case 'awaiting_weight':   return 'wait_for_weighing';
    case 'awaiting_approval': return 'customer_approval';
    case 'awaiting_payment':  return 'send_payment_link';
    case 'due_on_delivery':   return 'collect_on_delivery';
    case 'paid':              return null;
    default:                  return null;
  }
}

/* Can the customer still request an addition to this order? */
function canRequestAddition(order) {
  if (!order) return false;
  if (['done', 'cancelled'].includes(order.status)) return false;
  if ((order.pendingAdditions || []).some(a => a.status === 'pending_admin')) return false;
  return true;
}

function calcItemsSub(items) {
  let sub = 0;
  for (const it of items || []) {
    sub += it.loose ? (it.price || 0) : (it.price || 0) * (it.qty || 1);
  }
  return round2(sub);
}

/* Merge an approved addition into the order and return payment deltas. */
function applyApprovedAddition(order, addition) {
  const prevTotal = order.total || 0;
  const wasPaid = order.payStatus === 'paid' || order.payStatus === 'part_refunded';
  order.items = (order.items || []).concat(addition.items);

  const newLoose = addition.items.some(i => i.loose);
  if (newLoose) {
    order.needsWeighing = hasLooseItems(order);
    order.weighed = false;
  }

  const totals = recalcOrder(order);
  Object.assign(order, totals);
  const delta = round2(order.total - prevTotal);

  order.additionDue = null;
  if (order.payMethod === 'online') {
    if (wasPaid && delta > 0) {
      order.additionDue = delta;
      order.payStatus = 'awaiting_payment';
    } else if (order.needsWeighing && !order.weighed) {
      order.payStatus = 'awaiting_weight';
    } else if (totals.needsApproval) {
      order.payStatus = 'awaiting_approval';
    } else {
      order.payStatus = 'awaiting_payment';
    }
  } else {
    order.payStatus = 'due_on_delivery';
  }

  return { prevTotal, delta, wasPaid };
}

/* Amount to charge at checkout / in-app pay — full total or addition delta only. */
function chargeAmount(order) {
  if (order.additionDue != null && order.additionDue > 0) return round2(order.additionDue);
  return round2(order.total || 0);
}

module.exports = {
  TOLERANCE, PREAUTH_BUFFER, MIN_ADDITION_AED, PAYMENT_METHODS, ORDER_STATES,
  hasLooseItems, preauthAmount, applyActualWeight, recalcOrder, nextAction, round2,
  normaliseMethod, METHOD_ALIASES,
  canRequestAddition, calcItemsSub, applyApprovedAddition, chargeAmount
};
