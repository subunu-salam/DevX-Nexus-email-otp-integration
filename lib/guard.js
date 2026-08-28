/* ══════════════════════════════════════════════════════════════════════
   ABUSE & COST PROTECTION

   /api/concierge and /api/transcribe call Groq on every request and, until
   now, both were open to anyone with the URL. A single script could drain the
   token budget in minutes — and Whisper transcription is the expensive one,
   billed on audio length rather than tokens.

   Three layers, all in-process so there is nothing extra to deploy:
     1. per-IP sliding window   — stops one client hammering an endpoint
     2. daily spend ceiling     — caps total AI calls per day across everyone
     3. payload sanity limits   — rejects oversized prompts and audio early

   Deliberately NOT using express-rate-limit: it would be a fourth dependency
   for ~40 lines of logic, and a sliding window we own is easier to expose on
   the health endpoint for monitoring.
══════════════════════════════════════════════════════════════════════ */

const hits = new Map();          // key -> array of timestamps
let day = today();
const spend = { concierge: 0, transcribe: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function rollover() {
  const t = today();
  if (t !== day) { day = t; spend.concierge = 0; spend.transcribe = 0; }
}

/* Behind Render/Cloudflare the socket address is the proxy, so prefer the
   forwarded chain's first entry — that is the real client. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* Sliding window: keep only the timestamps inside the window, then compare. */
function take(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true, remaining: limit - arr.length };
}

/* Stop the map growing without bound on a long-lived process. */
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    const live = arr.filter(t => now - t < 3600000);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
}, 300000).unref();

const LIMITS = {
  concierge:  { perMin: 12, perHour: 120, daily: Number(process.env.AI_DAILY_LIMIT) || 4000 },
  transcribe: { perMin: 6,  perHour: 40,  daily: Number(process.env.VOICE_DAILY_LIMIT) || 600 },
  write:      { perMin: 20, perHour: 300 },   // orders, coupons — cheap but abusable
  admin:      { perMin: 60, perHour: 1200 }
};

/* Express middleware factory. `bucket` picks the limit set. */
/* The test suite drives hundreds of writes from one address in seconds, which
   is indistinguishable from abuse. An explicit opt-out keeps the limiter honest
   in every other environment — it is never inferred from NODE_ENV, so a
   misconfigured production deploy cannot silently disable it. */
const OFF = process.env.RATE_LIMIT_OFF === '1';

function limit(bucket) {
  if (OFF) return (req, res, next) => next();
  return (req, res, next) => {
    rollover();
    const cfg = LIMITS[bucket] || LIMITS.write;
    const ip = clientIp(req);

    if (cfg.daily != null && spend[bucket] >= cfg.daily) {
      res.set('Retry-After', '3600');
      return res.status(429).json({
        error: 'The assistant has reached its daily limit. Please try again tomorrow.',
        code: 'daily_budget'
      });
    }
    const m = take(`${bucket}:m:${ip}`, cfg.perMin, 60000);
    if (!m.ok) {
      res.set('Retry-After', String(m.retryAfter));
      return res.status(429).json({ error: 'Too many requests — please slow down.', code: 'rate', retryAfter: m.retryAfter });
    }
    const h = take(`${bucket}:h:${ip}`, cfg.perHour, 3600000);
    if (!h.ok) {
      res.set('Retry-After', String(h.retryAfter));
      return res.status(429).json({ error: 'Hourly limit reached — please try again later.', code: 'rate', retryAfter: h.retryAfter });
    }
    if (bucket in spend) spend[bucket]++;
    next();
  };
}

/* Reject absurd input before it reaches a paid API. */
const MAX_PROMPT = 1200;          // characters; a real shopper request is < 200
function sanePrompt(req, res, next) {
  const b = req.body || {};
  const p = String(b.prompt || b.message || '');
  if (p.length > MAX_PROMPT)
    return res.status(413).json({ error: 'That message is too long. Please shorten it.' });
  if (Array.isArray(b.history) && b.history.length > 40)
    return res.status(413).json({ error: 'Conversation too long — please start a new chat.' });
  next();
}

function stats() {
  rollover();
  return {
    day,
    concierge: { used: spend.concierge, limit: LIMITS.concierge.daily },
    transcribe: { used: spend.transcribe, limit: LIMITS.transcribe.daily },
    trackedClients: hits.size
  };
}

module.exports = { limit, sanePrompt, stats, clientIp, LIMITS };
