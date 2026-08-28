/* ══════════════════════════════════════════════════════════════════════
   CUSTOMER ACCOUNTS

   A shopper's identity was a UUID in localStorage. Clear the browser, or open
   the app on a second phone, and their order history and personal offers were
   gone — which also undermined the loyalty story, because offers are issued
   against a mobile number and could not find the person holding it.

   Identity is now the mobile number, verified by a one-time code. That is the
   same key the loyalty card uses, so the till history, the app account and the
   personal offers finally describe one customer.

   Codes are delivered through a pluggable sender. Until an SMS provider is
   connected the code is surfaced to staff in the admin panel, which keeps the
   whole flow working end to end without pretending a message was sent.
══════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const CODE_TTL_MS = 5 * 60 * 1000;      // a code is good for five minutes
const SESSION_MS = 60 * 24 * 3600 * 1000; // shoppers should not re-verify often
const MAX_TRIES = 5;
const RESEND_MS = 45 * 1000;

const pending = new Map();   // phone -> { code, exp, tries, lastSent, name }
const sessions = new Map();  // token -> { phone, name, exp }

function normalisePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  const t = d.replace(/^(00971|971)/, '').replace(/^0/, '');
  return t.length >= 8 ? t.slice(-9) : null;
}
function pretty(p) {
  return p ? '+971 ' + p.slice(0, 2) + ' ' + p.slice(2, 5) + ' ' + p.slice(5) : '';
}
function mask(p) {
  return p ? '+971 ' + p.slice(0, 2) + ' ••• ' + p.slice(-4) : '';
}

/* Six digits, generated with a CSPRNG rather than Math.random — a predictable
   code would let anyone take over an account by guessing the sequence. */
function newCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function requestCode(phoneRaw, name) {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return { ok: false, error: 'Enter a valid UAE mobile number' };

  const cur = pending.get(phone);
  if (cur && Date.now() - cur.lastSent < RESEND_MS)
    return { ok: false, error: `Please wait ${Math.ceil((RESEND_MS - (Date.now() - cur.lastSent)) / 1000)} seconds before asking for another code`, code: 'resend' };

  const code = newCode();
  pending.set(phone, { code, exp: Date.now() + CODE_TTL_MS, tries: 0, lastSent: Date.now(), name: name || (cur && cur.name) });
  return { ok: true, phone, code, expiresInMs: CODE_TTL_MS };
}

function verifyCode(phoneRaw, codeRaw) {
  const phone = normalisePhone(phoneRaw);
  const code = String(codeRaw || '').trim();
  if (!phone) return { ok: false, error: 'Enter a valid UAE mobile number' };

  const p = pending.get(phone);
  if (!p) return { ok: false, error: 'Ask for a code first' };
  if (p.exp < Date.now()) { pending.delete(phone); return { ok: false, error: 'That code expired — ask for a new one' }; }
  if (p.tries >= MAX_TRIES) { pending.delete(phone); return { ok: false, error: 'Too many attempts — ask for a new code' }; }

  p.tries++;
  // constant-time compare so the failure path cannot be timed to leak digits
  const a = Buffer.from(code.padEnd(6).slice(0, 6));
  const b = Buffer.from(p.code.padEnd(6).slice(0, 6));
  if (!crypto.timingSafeEqual(a, b))
    return { ok: false, error: `Incorrect code — ${MAX_TRIES - p.tries} attempt${MAX_TRIES - p.tries === 1 ? '' : 's'} left` };

  pending.delete(phone);
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { phone, name: p.name || null, exp: Date.now() + SESSION_MS });
  return { ok: true, token, phone, name: p.name || null };
}

function readToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function revoke(token) { sessions.delete(token); }
function setName(token, name) {
  const s = sessions.get(token);
  if (s && name) s.name = String(name).slice(0, 60);
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of pending) if (v.exp < n) pending.delete(k);
  for (const [k, v] of sessions) if (v.exp < n) sessions.delete(k);
}, 300000).unref();

/* Codes waiting to be read out by staff, for the period before an SMS gateway
   is connected. Never exposed to shoppers — the admin panel gates this. */
function outstanding() {
  const now = Date.now();
  return [...pending.entries()]
    .filter(([, v]) => v.exp > now)
    .map(([phone, v]) => ({ phone: pretty(phone), code: v.code,
      expiresInS: Math.ceil((v.exp - now) / 1000), name: v.name || null }));
}

/* Build the customer's own view: their orders and their live offers, found by
   phone number rather than by browser session. */
function profile(phone, orders, offers) {
  const mine = (orders || []).filter(o => normalisePhone(o.customer && o.customer.phone) === phone && !o.seed);
  const now = new Date();
  return {
    phone, pretty: pretty(phone), masked: mask(phone),
    orders: mine.length,
    spendAED: Math.round(mine.reduce((s, o) => s + (o.total || 0), 0) * 100) / 100,
    lastOrder: mine.length ? mine[0].date : null,
    offers: (offers || []).filter(o => o.phone === phone && o.status === 'active' && new Date(o.expiresAt) > now).length
  };
}

module.exports = {
  normalisePhone, pretty, mask, requestCode, verifyCode, readToken, revoke,
  setName, outstanding, profile, CODE_TTL_MS, SESSION_MS, RESEND_MS
};
