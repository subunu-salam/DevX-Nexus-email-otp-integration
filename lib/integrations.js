/* ══════════════════════════════════════════════════════════════════════
   PAYMENT AND MESSAGING ADAPTERS

   Two integrations a real store needs that we cannot finish without their
   accounts: a card gateway and a way to message customers. Rather than leave
   holes, both sit behind a driver interface with a working mock, so the whole
   flow runs end to end today and connecting the real provider is one file and
   a few environment variables.

   The mock is deliberately honest — it never claims a card was charged or an
   SMS was delivered. It records the intent, which is what lets the rest of the
   system be tested truthfully.
══════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

/* ── PAYMENTS ──────────────────────────────────────────────────────────
   UAE options, roughly in the order a Dubai grocer would consider them:
     Telr and Network International are the local acquirers most supermarkets
     already bank with; Stripe is simplest if they have no acquirer yet.
   A gateway driver implements: charge, refund, verifyWebhook. */

const payDrivers = {
  /* Records intent, settles immediately, never pretends to touch a card. */
  mock: {
    name: 'mock',
    live: false,
    async charge({ orderId, amountAED, last4 }) {
      return { ok: true, ref: 'MOCK-' + (last4 || '0000') + '-' + Date.now().toString(36).toUpperCase(),
        settled: true, note: 'No gateway connected — recorded, not charged' };
    },
    async refund({ ref, amountAED }) {
      return { ok: true, ref: 'MOCKRF-' + Date.now().toString(36).toUpperCase(), note: 'Recorded, not refunded' };
    },
    verifyWebhook() { return { ok: false, error: 'mock driver has no webhooks' }; }
  },

  /* Telr — hosted payment page. The store gets a store id and auth key. */
  telr: {
    name: 'telr',
    live: true,
    async charge({ orderId, amountAED, returnUrl, customer }) {
      const store = process.env.TELR_STORE_ID, key = process.env.TELR_AUTH_KEY;
      if (!store || !key) return { ok: false, error: 'TELR_STORE_ID and TELR_AUTH_KEY are not set' };
      const r = await fetch('https://secure.telr.com/gateway/order.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'create', store: Number(store), authkey: key,
          order: { cartid: orderId, test: process.env.TELR_TEST === '1' ? '1' : '0',
                   amount: Number(amountAED).toFixed(2), currency: 'AED',
                   description: 'DevX Nexus order ' + orderId },
          customer: { email: (customer && customer.email) || undefined,
                      name: { forenames: (customer && customer.name) || 'Customer', surname: '-' } },
          return: { authorised: returnUrl, declined: returnUrl, cancelled: returnUrl }
        })
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.order && d.order.url)
        // hosted page: the shopper is redirected, settlement arrives by webhook
        return { ok: true, redirect: d.order.url, ref: d.order.ref, settled: false };
      return { ok: false, error: (d && d.error && d.error.note) || 'Telr rejected the request' };
    },
    async refund() { return { ok: false, error: 'Refunds are issued from the Telr dashboard' }; },
    verifyWebhook(req) {
      // Telr signs with a shared secret over a fixed field order
      const secret = process.env.TELR_WEBHOOK_SECRET;
      if (!secret) return { ok: false, error: 'TELR_WEBHOOK_SECRET is not set' };
      const b = req.body || {};
      const expect = crypto.createHash('sha1')
        .update([secret, b.tran_store, b.tran_type, b.tran_class, b.tran_cartid,
                 b.tran_test, b.tran_ref, b.tran_prevref, b.tran_firstref,
                 b.tran_currency, b.tran_amount, b.tran_status].join(':')).digest('hex');
      return { ok: expect === b.tran_check, orderId: b.tran_cartid,
               paid: b.tran_status === 'A', ref: b.tran_ref };
    }
  },

  /* Network International — N-Genius hosted. */
  ngenius: {
    name: 'ngenius',
    live: true,
    async charge({ orderId, amountAED, returnUrl }) {
      const key = process.env.NGENIUS_API_KEY, outlet = process.env.NGENIUS_OUTLET_REF;
      if (!key || !outlet) return { ok: false, error: 'NGENIUS_API_KEY and NGENIUS_OUTLET_REF are not set' };
      const tokenRes = await fetch('https://api-gateway.ngenius-payments.com/identity/auth/access-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.ni-identity.v1+json',
                   Authorization: 'Basic ' + Buffer.from(key).toString('base64') }
      });
      const tok = (await tokenRes.json().catch(() => ({}))).access_token;
      if (!tok) return { ok: false, error: 'N-Genius authentication failed' };
      const r = await fetch(`https://api-gateway.ngenius-payments.com/transactions/outlets/${outlet}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.ni-payment.v2+json',
                   Accept: 'application/vnd.ni-payment.v2+json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ action: 'SALE', amount: { currencyCode: 'AED', value: Math.round(amountAED * 100) },
                               merchantOrderReference: orderId, merchantAttributes: { redirectUrl: returnUrl } })
      });
      const d = await r.json().catch(() => ({}));
      const url = d && d._links && d._links.payment && d._links.payment.href;
      return url ? { ok: true, redirect: url, ref: d.reference, settled: false }
                 : { ok: false, error: 'N-Genius rejected the request' };
    },
    async refund() { return { ok: false, error: 'Refunds are issued from the N-Genius portal' }; },
    verifyWebhook() { return { ok: false, error: 'configure the N-Genius webhook secret first' }; }
  },

  stripe: {
    name: 'stripe',
    live: true,
    async charge({ orderId, amountAED, returnUrl }) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) return { ok: false, error: 'STRIPE_SECRET_KEY is not set' };
      const form = new URLSearchParams({
        mode: 'payment', success_url: returnUrl, cancel_url: returnUrl,
        'line_items[0][price_data][currency]': 'aed',
        'line_items[0][price_data][product_data][name]': 'DevX Nexus order ' + orderId,
        'line_items[0][price_data][unit_amount]': String(Math.round(amountAED * 100)),
        'line_items[0][quantity]': '1', client_reference_id: orderId
      });
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key,
          'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      const d = await r.json().catch(() => ({}));
      return d && d.url ? { ok: true, redirect: d.url, ref: d.id, settled: false }
                        : { ok: false, error: (d.error && d.error.message) || 'Stripe rejected the request' };
    },
    async refund() { return { ok: false, error: 'Refunds are issued from the Stripe dashboard' }; },
    verifyWebhook() { return { ok: false, error: 'set STRIPE_WEBHOOK_SECRET first' }; }
  }
};

/* ── MESSAGING ─────────────────────────────────────────────────────────
   Order updates and one-time codes. WhatsApp is what UAE grocery actually
   uses, so it is the first-class driver. */
const msgDrivers = {
  /* Free testing SMS via Textbelt. The public key `textbelt` is limited to
     1 free SMS per day; use a Textbelt API key for a larger quota.
     This driver expects E.164 phone numbers and is intentionally separate
     from the existing order-message drivers so existing notifications are
     unchanged unless explicitly selected. */
  textbelt: {
    name: 'textbelt', live: true,
    async send({ to, text }) {
      const key = process.env.TEXTBELT_KEY || 'textbelt';
      const r = await fetch('https://textbelt.com/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          phone: String(to || ''),
          message: String(text || ''),
          key
        })
      });
      const d = await r.json().catch(() => ({}));
      return d && d.success
        ? { ok: true, delivered: true, id: d.textId, quotaRemaining: d.quotaRemaining }
        : { ok: false, delivered: false,
            error: (d && d.error) || 'Textbelt could not send the SMS',
            quotaRemaining: d && d.quotaRemaining };
    }
  },
  /* Writes to the activity feed so staff can read a code out or see what would
     have been sent. Never claims delivery. */
  mock: {
    name: 'mock', live: false,
    async send({ to, text }) {
      return { ok: true, delivered: false, note: 'No messaging provider connected — logged only',
        preview: `${to}: ${text}` };
    }
  },
  /* WhatsApp Cloud API — a template message for order updates. */
  whatsapp: {
    name: 'whatsapp', live: true,
    async send({ to, text }) {
      const token = process.env.WHATSAPP_TOKEN, id = process.env.WHATSAPP_PHONE_ID;
      if (!token || !id) return { ok: false, error: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are not set' };
      const r = await fetch(`https://graph.facebook.com/v19.0/${id}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: '971' + to,
                               type: 'text', text: { body: text } })
      });
      const d = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, delivered: true, id: (d.messages && d.messages[0] || {}).id }
                  : { ok: false, error: (d.error && d.error.message) || 'WhatsApp rejected the message' };
    }
  },
  twilio: {
    name: 'twilio', live: true,
    async send({ to, text }) {
      const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
      if (!sid || !tok || !from) return { ok: false, error: 'TWILIO_SID, TWILIO_TOKEN and TWILIO_FROM are not set' };
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
                   'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: '+971' + to, From: from, Body: text })
      });
      const d = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, delivered: true, id: d.sid }
                  : { ok: false, error: d.message || 'Twilio rejected the message' };
    }
  }
};

const payDriver = () => payDrivers[process.env.PAYMENT_DRIVER || 'mock'] || payDrivers.mock;
const msgDriver = () => msgDrivers[process.env.MESSAGING_DRIVER || 'mock'] || msgDrivers.mock;

function status() {
  const p = payDriver(), m = msgDriver();
  return {
    payments: { driver: p.name, live: p.live,
      available: Object.keys(payDrivers) },
    messaging: { driver: m.name, live: m.live,
      available: Object.keys(msgDrivers) }
  };
}

module.exports = { payDriver, msgDriver, payDrivers, msgDrivers, status };
