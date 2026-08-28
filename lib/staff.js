/* ══════════════════════════════════════════════════════════════════════
   STAFF ACCOUNTS, ROLES AND AUDIT TRAIL

   The admin panel was one shared PIN. A supermarket has an owner, a manager,
   pickers and cashiers, and they will not all share `1234` — nor should a
   picker be able to publish offers or read the loyalty book. Worse, with a
   shared PIN nobody can answer "who approved that weight?" after the fact.

   Named accounts with roles, and every consequential action written to an
   audit log. No JWT dependency: PINs are hashed with scrypt and sessions are
   opaque random tokens held in memory, which is the right shape for a
   single-process app and avoids shipping a secret to the client.
══════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

/* Permissions are grouped by what a person in that job actually does on the
   shop floor, not by which screen happens to exist. */
const ROLES = {
  owner: {
    label: 'Owner',
    perms: ['*'],
    note: 'Everything, across every shop — including opening new ones'
  },
  /* A chain of forty shops is not run by one person reading forty dashboards.
     An area manager owns a handful of them: the same authority as a manager,
     but over a list of shops rather than one, and with the group roll-up so
     they can see which of theirs is behind. */
  area: {
    label: 'Area Manager',
    perms: ['orders.view', 'orders.advance', 'orders.weigh', 'orders.pay', 'orders.refund', 'orders.modify',
            'inventory.edit', 'offers.manage', 'loyalty.view', 'loyalty.issue',
            'forecast.view', 'forecast.edit', 'insights.view', 'group.view',
            'staff.manage', 'audit.view', 'branch.view'],
    note: 'Runs several shops; sees a roll-up across the ones they own'
  },
  manager: {
    label: 'Manager',
    perms: ['orders.view', 'orders.advance', 'orders.weigh', 'orders.pay', 'orders.refund', 'orders.modify',
            'inventory.edit', 'offers.manage', 'loyalty.view', 'loyalty.issue',
            'forecast.view', 'forecast.edit', 'insights.view',
            'staff.manage', 'audit.view', 'branch.view'],
    note: 'Runs the store day to day, including its own team'
  },
  picker: {
    label: 'Picker',
    perms: ['orders.view', 'orders.advance', 'orders.weigh'],
    note: 'Picks and weighs orders — sees no money, no reports, no staff'
  },
  cashier: {
    label: 'Cashier',
    perms: ['orders.view', 'orders.advance', 'orders.pay'],
    note: 'Takes payment and hands orders over — cannot change stock or prices'
  },
  buyer: {
    label: 'Buyer',
    perms: ['orders.view', 'forecast.view', 'forecast.edit', 'insights.view', 'inventory.edit'],
    note: 'Purchasing and forecasting only — no orders, no customers, no staff'
  }
};

function can(role, perm) {
  const r = ROLES[role];
  if (!r) return false;
  return r.perms.includes('*') || r.perms.includes(perm);
}

/* ── PIN hashing ──
   scrypt with a per-user salt. A 4-6 digit PIN is low entropy by nature, so
   the real protection is the rate limiter on the login route plus lockout
   after repeated failures — both applied by the server. */
function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), s, 32).toString('hex');
  return { salt: s, hash: h };
}
function verifyPin(pin, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch (e) { return false; }
}

/* ── sessions ── */
const SESSION_MS = 12 * 3600 * 1000;         // a long shift, then re-login
const sessions = new Map();                   // token -> { id, name, role, exp }

function issueToken(user) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { id: user.id, name: user.name, role: user.role,
                        branchId: user.branchId || null,
                        branchIds: user.branchIds || (user.branchId ? [user.branchId] : []),
                        exp: Date.now() + SESSION_MS });
  return token;
}
function readToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function revoke(token) { sessions.delete(token); }
function revokeUser(id) { for (const [t, s] of sessions) if (s.id === id) sessions.delete(t); }
setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (s.exp < n) sessions.delete(t); }, 600000).unref();

/* ── failed-login lockout ──
   A 4-digit PIN is 10,000 guesses. Five failures locks that account for
   fifteen minutes, which makes brute force impractical without inconveniencing
   someone who fat-fingers it twice. */
const fails = new Map();
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
function lockState(name) {
  const f = fails.get(name);
  if (!f) return { locked: false };
  if (f.until && f.until > Date.now())
    return { locked: true, seconds: Math.ceil((f.until - Date.now()) / 1000) };
  if (f.until && f.until <= Date.now()) { fails.delete(name); return { locked: false }; }
  return { locked: false, left: MAX_FAILS - f.n };
}
function noteFail(name) {
  const f = fails.get(name) || { n: 0 };
  f.n++;
  if (f.n >= MAX_FAILS) f.until = Date.now() + LOCK_MS;
  fails.set(name, f);
  return MAX_FAILS - f.n;
}
function clearFails(name) { fails.delete(name); }

/* ── user records ── */
function makeUser({ name, role, pin, branchId, branchIds }) {
  const { salt, hash } = hashPin(pin);
  return {
    id: 'u' + crypto.randomBytes(6).toString('hex'),
    name: String(name).trim().slice(0, 40),
    role: ROLES[role] ? role : 'picker',
    /* Staff belong to a shop. A picker at Deira must not see Al Nahda's
       queue — and must not be able to weigh its orders. Owners are
       chain-wide, which is why theirs is left unset. */
    branchId: branchId || null,
    /* An area manager holds several shops. Everyone else has one, kept in
       branchId, and branchIds simply mirrors it so callers have one shape
       to read. */
    branchIds: Array.isArray(branchIds) && branchIds.length ? branchIds.slice(0, 200)
             : (branchId ? [branchId] : []),
    salt, hash,
    active: true,
    createdAt: new Date().toISOString(),
    lastLogin: null
  };
}
/* Never let a hash or salt reach the client. */
function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, roleLabel: (ROLES[u.role] || {}).label,
           branchId: u.branchId || null,
           branchIds: u.branchIds || (u.branchId ? [u.branchId] : []),
           active: u.active, createdAt: u.createdAt, lastLogin: u.lastLogin };
}

function findByName(users, name) {
  const n = String(name || '').trim().toLowerCase();
  return (users || []).find(u => u.name.toLowerCase() === n && u.active !== false);
}

/* ── audit trail ── */
function auditEntry(actor, action, detail, meta) {
  return {
    at: new Date().toISOString(),
    who: actor ? actor.name : 'system',
    role: actor ? actor.role : 'system',
    action, detail: String(detail || '').slice(0, 240),
    ...(meta || {})
  };
}

module.exports = {
  ROLES, can, hashPin, verifyPin, issueToken, readToken, revoke, revokeUser,
  makeUser, publicUser, findByName, auditEntry,
  lockState, noteFail, clearFails, SESSION_MS
};
