/* ══════════════════════════════════════════════════════════════════════
   WEB PUSH — zero-dependency implementation
   · VAPID (RFC 8292) JWT signed with ES256 via node:crypto
   · Payload encryption aes128gcm (RFC 8188 / RFC 8291)
   Works with FCM (Chrome/Edge/Android), Mozilla autopush (Firefox) and
   Apple's web.push.apple.com (Safari macOS + iOS/iPadOS 16.4+ home-screen apps).

   Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment if set,
   otherwise generated once and kept in db['devx-push'] so they survive
   restarts (with DATABASE_URL). Changing keys invalidates every subscription.
══════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function generateVapid() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
function privateKeyObject(vapid) {
  const pub = unb64u(vapid.publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}
function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + body), { key: privateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/* RFC 8291 §3.4 */
function encrypt(payload, keys, opts = {}) {
  const uaPublic = unb64u(keys.p256dh), authSecret = unb64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const salt = opts.salt || crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}
/* Receiver side — used only by the self-test. */
function decrypt(body, uaPrivate, keys) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const uaPublic = unb64u(keys.p256dh), authSecret = unb64u(keys.auth);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}

class Push {
  constructor(getDb, save) { this.getDb = getDb; this.save = save; this.subject = process.env.VAPID_SUBJECT || 'mailto:support@devx.ae'; }
  state() {
    const db = this.getDb();
    if (!db['devx-push'] || typeof db['devx-push'] !== 'object') db['devx-push'] = {};
    const s = db['devx-push'];
    if (!Array.isArray(s.subs)) s.subs = [];
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) s.vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, env: true };
    else if (!s.vapid || !s.vapid.publicKey || s.vapid.env) { s.vapid = generateVapid(); this.save(); }
    return s;
  }
  publicKey() { return this.state().vapid.publicKey; }
  subscribe(sub, meta = {}) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: 'invalid subscription' };
    const s = this.state();
    const existing = s.subs.find(x => x.endpoint === sub.endpoint);
    const row = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, phone: meta.phone || (existing && existing.phone) || null, platform: meta.platform || '', standalone: !!meta.standalone, at: new Date().toISOString() };
    if (existing) Object.assign(existing, row); else s.subs.unshift(row);
    s.subs = s.subs.slice(0, 5000);
    this.save();
    return { ok: true, isNew: !existing };
  }
  unsubscribe(endpoint) { const s = this.state(); const n = s.subs.length; s.subs = s.subs.filter(x => x.endpoint !== endpoint); if (s.subs.length !== n) this.save(); }
  async sendTo(sub, msg) {
    const s = this.state();
    const body = encrypt(JSON.stringify(msg), sub.keys);
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidHeader(sub.endpoint, s.vapid, this.subject) }, body });
      if (r.status === 404 || r.status === 410) { this.unsubscribe(sub.endpoint); return { ok: false, gone: true, status: r.status }; }
      if (!r.ok) { const t = await r.text().catch(() => ''); console.warn('[push] rejected', r.status, t.slice(0, 200)); return { ok: false, status: r.status }; }
      return { ok: true, status: r.status };
    } catch (e) { console.warn('[push] send error', e.message); return { ok: false, error: e.message }; }
  }
  /* filter: { phone } targets one shopper; {} broadcasts. */
  async send(filter, msg) {
    const s = this.state();
    const list = s.subs.filter(x => !filter || !filter.phone || (x.phone && x.phone === filter.phone));
    const res = await Promise.all(list.map(x => this.sendTo(x, msg)));
    return { targeted: list.length, delivered: res.filter(r => r.ok).length };
  }
}

module.exports = { Push, encrypt, decrypt, generateVapid, vapidHeader, b64u, unb64u };
