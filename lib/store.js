/* ══════════════════════════════════════════════════════════════════════
   DURABLE STORAGE

   The app keeps all state in memory (the search index depends on it) and
   persists it behind this adapter. Two drivers:

     postgres — when DATABASE_URL is set. One row per top-level key, value as
                JSONB. Survives redeploys.
     file     — a single JSON document on disk. Fine locally, but on Render's
                free tier the filesystem is EPHEMERAL: every redeploy and the
                daily container recycle wipe it, taking orders, issued coupons
                and floor-plan edits with them. That is the reason this exists.

   Why a key/value table rather than real relational tables: the server already
   reads `db['devx-orders']` in fifty-odd places. Modelling each collection as
   a row keeps every one of those working untouched, so durability lands
   without a rewrite. Proper tables can come later, per collection, without
   changing the call sites again.

   Writes are debounced and dirty-tracked. The catalogue is ~30 MB at
   hypermarket scale, so it is deliberately excluded from the default save —
   an order must not rewrite the entire product list.
══════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const CATALOG_KEY = 'devx-catalog';

class Store {
  constructor(keys, { dataDir, url } = {}) {
    this.keys = keys;
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.url = url || process.env.DATABASE_URL || '';
    /* SQL Server (MSSQL) — used when MSSQL_SERVER is set. Takes priority over
       DATABASE_URL so a store's own SQL Server is the source of truth. */
    this.mssqlCfg = process.env.MSSQL_SERVER ? {
      server: process.env.MSSQL_SERVER,
      port: parseInt(process.env.MSSQL_PORT, 10) || 1433,
      user: process.env.MSSQL_USER || 'sa',
      password: process.env.MSSQL_PASSWORD || '',
      database: process.env.MSSQL_DATABASE || 'DevXNexus',
      options: {
        encrypt: process.env.MSSQL_ENCRYPT === '1',
        trustServerCertificate: process.env.MSSQL_TRUST_CERT !== '0',
        enableArithAbort: true
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000,
      requestTimeout: 30000
    } : null;
    this.driver = this.mssqlCfg ? 'mssql' : (this.url ? 'postgres' : 'file');
    this.sql = null;
    this.pool = null;
    this.dirty = new Set();
    this.timer = null;
    this.data = null;
    this.writes = 0;
    this.lastError = null;
  }

  async init(seed) {
    this.data = seed;
    if (this.driver === 'mssql') {
      try { this.sql = require('mssql'); }
      catch (e) {
        console.error('[store] MSSQL_SERVER is set but the "mssql" package is missing — run: npm install');
        this.driver = this.url ? 'postgres' : 'file';
        this.lastError = 'mssql package missing';
      }
    }
    if (this.driver === 'mssql') {
      const cfg = this.mssqlCfg, db = cfg.database;
      if (!/^[A-Za-z0-9_]+$/.test(db)) throw new Error('MSSQL_DATABASE may only contain letters, digits and _');
      try {
        /* Create the database on first run, via master. */
        const boot = await new this.sql.ConnectionPool({ ...cfg, database: 'master' }).connect();
        await boot.request().query(`IF DB_ID(N'${db}') IS NULL CREATE DATABASE [${db}]`);
        await boot.close();

        this.pool = await new this.sql.ConnectionPool(cfg).connect();
        await this.pool.request().query(`IF OBJECT_ID(N'dbo.nexus_state', N'U') IS NULL
          CREATE TABLE dbo.nexus_state (
            k NVARCHAR(200) NOT NULL PRIMARY KEY,
            v NVARCHAR(MAX) NOT NULL,
            updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
          )`);
        const { recordset } = await this.pool.request().query('SELECT k, v FROM dbo.nexus_state');
        for (const r of recordset)
          if (this.keys.includes(r.k) || r.k === 'devx-order-count') {
            try { this.data[r.k] = JSON.parse(r.v); } catch (e) { console.error('[store] bad JSON in', r.k); }
          }
        console.log(`[store] mssql · ${cfg.server}/${db} · loaded ${recordset.length} collections`);
        return this.data;
      } catch (e) {
        console.error('[store] SQL Server unavailable, falling back to file:', e.message);
        this.lastError = e.message;
        this.driver = 'file';
        if (this.pool) { try { await this.pool.close(); } catch (_) {} this.pool = null; }
        return this._loadFile();
      }
    }
    if (this.driver === 'postgres') {
      let Pool;
      try { ({ Pool } = require('pg')); }
      catch (e) {
        console.error('[store] DATABASE_URL is set but the "pg" package is missing — run: npm install pg');
        this.driver = 'file';
        return this._loadFile();
      }
      this.pool = new Pool({
        ssl: { rejectUnauthorized: false },
        connectionString: this.url,
        // Render's managed Postgres requires TLS but presents a chain Node
        // does not ship a root for; this is the documented connection style.
        ssl: /localhost|127\.0\.0\.1/.test(this.url) ? false : { rejectUnauthorized: false },
        max: 4, idleTimeoutMillis: 30000
      });
      try {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS nexus_state (
          k TEXT PRIMARY KEY,
          v JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows } = await this.pool.query('SELECT k, v FROM nexus_state');
        for (const r of rows) if (this.keys.includes(r.k) || r.k === 'devx-order-count') this.data[r.k] = r.v;
        console.log(`[store] postgres · loaded ${rows.length} collections`);
        return this.data;
      } catch (e) {
        // A database that is unreachable at boot must not take the shop down.
        console.error('[store] postgres unavailable, falling back to file:', e.message);
        this.lastError = e.message;
        this.driver = 'file';
        return this._loadFile();
      }
    }
    return this._loadFile();
  }

  _loadFile() {
    try {
      if (fs.existsSync(this.file)) {
        Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
        console.log('[store] file · loaded from', this.file);
      }
    } catch (e) { console.error('[store] file load failed:', e.message); }
    return this.data;
  }

  /* Mark keys for writing. No arguments means "everything that changes during
     normal trading" — which excludes the catalogue, because rewriting 30 MB of
     products every time someone places an order is what makes a store feel
     slow. Pass the catalogue key explicitly when it really has changed. */
  save(...keys) {
    if (!keys.length) keys = this.keys.filter(k => k !== CATALOG_KEY).concat('devx-order-count');
    for (const k of keys) this.dirty.add(k);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), 400);
  }
  saveAll() { return this.save(...this.keys, 'devx-order-count'); }

  async flush() {
    if (!this.dirty.size) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    try {
      if (this.driver === 'mssql') {
        // all dirty keys in one transaction — either every collection lands or none
        const tx = new this.sql.Transaction(this.pool);
        await tx.begin();
        try {
          for (const k of keys) {
            await new this.sql.Request(tx)
              .input('k', this.sql.NVarChar(200), k)
              .input('v', this.sql.NVarChar(this.sql.MAX), JSON.stringify(this.data[k] ?? null))
              .query(`MERGE dbo.nexus_state WITH (HOLDLOCK) AS t
                      USING (SELECT @k AS k, @v AS v) AS s ON t.k = s.k
                      WHEN MATCHED THEN UPDATE SET v = s.v, updated_at = SYSUTCDATETIME()
                      WHEN NOT MATCHED THEN INSERT (k, v) VALUES (s.k, s.v);`);
          }
          await tx.commit();
        } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
      } else if (this.driver === 'postgres') {
        // one statement, all dirty keys — atomic and avoids a round trip each
        const vals = keys.map((k, i) => `($${i * 2 + 1}, $${i * 2 + 2}::jsonb)`).join(',');
        const params = keys.flatMap(k => [k, JSON.stringify(this.data[k] ?? null)]);
        await this.pool.query(
          `INSERT INTO nexus_state (k, v) VALUES ${vals}
           ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`, params);
      } else {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);      // atomic swap, never a half file
      }
      this.writes++;
      this.lastError = null;
    } catch (e) {
      // put them back so the next save retries rather than losing the write
      for (const k of keys) this.dirty.add(k);
      this.lastError = e.message;
      console.error('[store] write failed:', e.message);
    }
  }

  /* Flush synchronously on shutdown so an in-flight order is never lost to a
     deploy. Render sends SIGTERM and waits before killing the container. */
  async close() {
    clearTimeout(this.timer);
    await this.flush();
    if (this.pool) await (this.driver === 'mssql' || this.sql ? this.pool.close() : this.pool.end()).catch(() => {});
  }

  status() {
    return {
      driver: this.driver,
      durable: this.driver === 'postgres' || this.driver === 'mssql',
      writes: this.writes,
      pending: this.dirty.size,
      lastError: this.lastError
    };
  }
}

module.exports = { Store, CATALOG_KEY };
