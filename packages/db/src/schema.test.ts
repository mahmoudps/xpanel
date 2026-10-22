import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_NAME_MAX, DB_USER_MAX, isXpanelError, MAX_ACCOUNT_UID, USERNAME_MAX } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from './client.ts'
import { loadMigrations } from './migrate.ts'
import { toXpanelError } from './pg-errors.ts'
import { schema } from './schema.ts'
import { ARGON2, php, seedAccount, seedPlan, sha } from './testing.ts'

let h: TestDbHandle

beforeAll(async () => {
  h = await createTestDb()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

/** Runs raw SQL and returns the mapped XpanelError code (or 'ok'). */
const sqlCode = async (text: string, params: unknown[] = [], on: TestDbHandle = h): Promise<string> => {
  try {
    await on.query(text, params)
    return 'ok'
  } catch (e) {
    const x = toXpanelError(e)
    return isXpanelError(x) ? x.code : `raw:${(e as Error).message}`
  }
}

const tables = () => Object.values(schema).map((t) => getTableConfig(t as PgTable))

describe('drizzle schema mirrors the SQL (parity over the migrated database)', () => {
  it('has a definition for every table and no extra ones', async () => {
    const dbTables = (await h.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.t)
    expect(tables().map((t) => t.name).sort()).toEqual(dbTables.sort())
  })

  it('matches every column name, type, nullability and default presence', async () => {
    const cols = await h.query<{ table: string; column: string; type: string; notnull: boolean; hasdefault: boolean }>(`
      SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
             (a.atthasdef OR a.attidentity <> '') AS hasdefault
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`)
    const fmt = (t: string, c: string, type: string, notNull: boolean, hasDefault: boolean) =>
      `${t}.${c} ${type}${notNull ? ' not null' : ''}${hasDefault ? ' default' : ''}`
    const fromDb = cols.map((c) => fmt(c.table, c.column, c.type, c.notnull, c.hasdefault)).sort()
    const fromDrizzle = tables()
      .flatMap((cfg) => cfg.columns.map((c) => fmt(cfg.name, c.name, c.getSQLType(), c.notNull, c.hasDefault)))
      .sort()
    expect(fromDrizzle).toEqual(fromDb)
  })

  it('matches every primary key', async () => {
    const rows = await h.query<{ table: string; cols: string[] }>(`
      SELECT c.relname AS table, array_agg(a.attname ORDER BY k.ord) AS cols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'p' AND c.relnamespace = 'public'::regnamespace GROUP BY c.relname`)
    const fromDb = rows.map((r) => `${r.table}(${[...r.cols].sort().join(',')})`).sort()
    const fromDrizzle = tables()
      .map((cfg) => {
        const single = cfg.columns.filter((c) => c.primary).map((c) => c.name)
        const composite = cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name))
        return `${cfg.name}(${[...single, ...composite].sort().join(',')})`
      })
      .sort()
    expect(fromDrizzle).toEqual(fromDb)
  })

  it('matches every foreign key, its columns, target and ON DELETE action', async () => {
    const rows = await h.query<{ table: string; cols: string[]; ref: string; refcols: string[]; ondelete: string }>(`
      SELECT c.relname AS table, r.relname AS ref, con.confdeltype AS ondelete,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS refcols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class r ON r.oid = con.confrelid
      WHERE con.contype = 'f' AND c.relnamespace = 'public'::regnamespace`)
    const action: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' }
    const fromDb = rows.map((r) => `${r.table}(${r.cols.join(',')}) -> ${r.ref}(${r.refcols.join(',')}) ${action[r.ondelete]}`).sort()
    const fromDrizzle = tables()
      .flatMap((cfg) =>
        cfg.foreignKeys.map((fk) => {
          const ref = fk.reference()
          return `${cfg.name}(${ref.columns.map((c) => c.name).join(',')}) -> ${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns
            .map((c) => c.name)
            .join(',')}) ${fk.onDelete ?? 'no action'}`
        }),
      )
      .sort()
    expect(fromDrizzle).toEqual(fromDb)
  })
})

describe('constants shared with core', () => {
  it('uses core naming limits and the account UID ceiling', async () => {
    const [init] = await loadMigrations()
    const sql = init?.sql ?? ''
    expect(sql).toContain(`MAXVALUE ${MAX_ACCOUNT_UID} NO CYCLE`)
    expect(sql).toContain(`CHECK (uid BETWEEN 20000 AND ${MAX_ACCOUNT_UID})`)
    expect(sql).toContain(`username text NOT NULL CHECK (username ~ '^[a-z][a-z0-9]{0,${USERNAME_MAX - 1}}$')`)
    expect(sql).toContain(`CHECK (length(name) <= ${DB_NAME_MAX} AND`)
    expect(sql).toContain(`CHECK (length(name) <= ${DB_USER_MAX} AND`)
  })
})

describe('append-only audit_log', () => {
  it('rejects UPDATE, DELETE and TRUNCATE via trigger', async () => {
    await h.query(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'account.create', 'alice', 'ok')`)
    expect(await sqlCode(`UPDATE audit_log SET outcome = 'failed'`)).toBe('FORBIDDEN')
    expect(await sqlCode(`DELETE FROM audit_log`)).toBe('FORBIDDEN')
    expect(await sqlCode(`TRUNCATE audit_log`)).toBe('FORBIDDEN')
    const [row] = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'ok'`)
    expect(row?.n).toBeGreaterThanOrEqual(1)
  })

  it('validates action, outcome and detail shape', async () => {
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'x', 't', 'maybe')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'bad action', 't', 'ok')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES ('root', 'Account.Create', 't', 'ok')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome, detail) VALUES ('root', 'a', 't', 'ok', '[]')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO audit_log (actor, action, target, outcome) VALUES (E'root\\n', 'a', 't', 'ok')`)).toBe('VALIDATION')
  })
})

describe('uid_allocator', () => {
  it('cannot be edited or emptied, so a UID never comes back', async () => {
    await h.query(`INSERT INTO uid_allocator (username) VALUES ('ghost')`)
    expect(await sqlCode(`DELETE FROM uid_allocator WHERE username = 'ghost'`)).toBe('FORBIDDEN')
    expect(await sqlCode(`UPDATE uid_allocator SET username = 'other' WHERE username = 'ghost'`)).toBe('FORBIDDEN')
    expect(await sqlCode(`TRUNCATE uid_allocator CASCADE`)).toBe('FORBIDDEN')
  })

  it('stays inside 20000..MAX_ACCOUNT_UID and reports exhaustion instead of wrapping', async () => {
    const own = await createTestDb()
    try {
      expect(await sqlCode(`INSERT INTO uid_allocator (uid, username) VALUES (${MAX_ACCOUNT_UID + 1}, 'above')`, [], own)).toBe('VALIDATION')
      expect(await sqlCode(`INSERT INTO uid_allocator (uid, username) VALUES (65534, 'nobodyx')`, [], own)).toBe('VALIDATION')
      expect(await sqlCode(`INSERT INTO uid_allocator (uid, username) VALUES (1000, 'human')`, [], own)).toBe('VALIDATION')
      const [firstUid] = await own.query<{ uid: number }>(`INSERT INTO uid_allocator (username) VALUES ('first') RETURNING uid`)
      expect(firstUid?.uid).toBe(20000)
      await own.query(`SELECT setval('xpanel_uid_seq', ${MAX_ACCOUNT_UID - 1})`)
      const [last] = await own.query<{ uid: number }>(`INSERT INTO uid_allocator (username) VALUES ('last') RETURNING uid`)
      expect(last?.uid).toBe(MAX_ACCOUNT_UID)
      expect(await sqlCode(`INSERT INTO uid_allocator (username) VALUES ('toomany')`, [], own)).toBe('LIMIT_EXCEEDED')
    } finally {
      await own.close()
    }
  }, 120_000)
})

describe('constraints', () => {
  it('rejects -1 and other negative limits; NULL is the only unlimited', async () => {
    const plan = await seedPlan(h.db)
    expect(await sqlCode(`UPDATE plans SET disk_mb = -1 WHERE id = $1`, [plan.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE plans SET addon_domains = -1 WHERE id = $1`, [plan.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE plans SET memory_mb = 0 WHERE id = $1`, [plan.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE plans SET addon_domains = 0 WHERE id = $1`, [plan.id])).toBe('ok')
    expect(await sqlCode(`UPDATE plans SET disk_mb = NULL WHERE id = $1`, [plan.id])).toBe('ok')
    expect(await sqlCode(`UPDATE plans SET disk_mb = 9007199254740992 WHERE id = $1`, [plan.id])).toBe('VALIDATION')
  })

  it('enforces case-insensitive server-wide domain names and keeps docroots inside the home', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { primaryDomain: 'shop.example.org' })
    const b = await seedAccount(h.db, plan.id)
    let n = 0
    const insert = (accountId: string, name: string, docRoot = `${b.home}/d${++n}`) =>
      sqlCode(`INSERT INTO domains (account_id, name, kind, doc_root, php) VALUES ($1, $2, 'addon', $3, $4)`, [accountId, name, docRoot, JSON.stringify(php())])
    // stored names are canonical lowercase; the unique index is on lower(name) as a second guard
    expect(await insert(b.id, 'SHOP.example.org')).toBe('VALIDATION')
    expect(await insert(b.id, 'shop.example.org')).toBe('CONFLICT')
    expect(await insert(a.id, 'shop.example.org', `${a.home}/x`)).toBe('CONFLICT')
    expect(await insert(b.id, 'other.example.org')).toBe('ok')
    expect(await insert(b.id, 'outside.example.org', `${a.home}/stolen`)).toBe('VALIDATION')
    expect(await insert(b.id, 'etc.example.org', '/etc/nginx')).toBe('VALIDATION')
    expect(await insert(b.id, 'home.example.org', b.home)).toBe('VALIDATION')
    expect(await insert(b.id, 'hidden.example.org', `${b.home}/.ssh`)).toBe('VALIDATION')
    const [idx] = await h.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'domains_name_key'`)
    expect(idx?.def).toMatch(/UNIQUE INDEX .* \(lower\(name\)\)/)
  })

  it('pins database names to the owner prefix by trigger', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { username: 'dbowner' })
    expect(await sqlCode(`INSERT INTO databases (account_id, name) VALUES ($1, 'dbowner_shop')`, [a.id])).toBe('ok')
    expect(await sqlCode(`INSERT INTO databases (account_id, name) VALUES ($1, 'someone_shop')`, [a.id])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO databases (account_id, name) VALUES ($1, 'dbowner__x')`, [a.id])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO database_users (account_id, name, auth_string) VALUES ($1, 'other_u', 'abc')`, [a.id])).toBe('VALIDATION')
  })

  it('ties owner logins to their account name and reseller rows to reseller logins', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id, { username: 'tiedname' })
    expect(await sqlCode(`UPDATE principals SET username = 'renamed' WHERE account_id = $1`, [a.id])).toBe('NOT_FOUND')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'rootx', $1)`, [ARGON2])).toBe('ok')
    const [root] = await h.query<{ id: string }>(`SELECT id FROM principals WHERE username = 'rootx'`)
    expect(await sqlCode(`INSERT INTO resellers (id) VALUES ($1)`, [root?.id])).toBe('NOT_FOUND')
    expect(await sqlCode(`INSERT INTO resellers (id, kind) VALUES ($1, 'root')`, [root?.id])).toBe('VALIDATION')
  })

  it('refuses non-argon2id password hashes and bad tokens', async () => {
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'r1', 'plaintext')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'r1', '$1$abc$def')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'r1', $1)`, [ARGON2.replace('argon2id', 'argon2i')])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'r1', $1)`, [`${ARGON2}${'A'.repeat(500)}`])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'r1', $1)`, [ARGON2])).toBe('ok')
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('root', 'R1', $1)`, [ARGON2])).toBe('VALIDATION')
    // user principals need their account, root/reseller ones must not have one
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('user', 'u9', $1)`, [ARGON2])).toBe('VALIDATION')
    const [p] = await h.query<{ id: string }>(`SELECT id FROM principals WHERE username = 'r1'`)
    expect(await sqlCode(`INSERT INTO api_tokens (principal_id, name, token_hash) VALUES ($1, 'ci', 'nothex')`, [p?.id])).toBe('VALIDATION')
    expect(
      await sqlCode(`INSERT INTO api_tokens (principal_id, name, token_hash, allowed_ips) VALUES ($1, 'ci', $2, '{10.0.0.0/8,::1/128}')`, [p?.id, sha('a')]),
    ).toBe('VALIDATION') // tokens always expire
    expect(
      await sqlCode(
        `INSERT INTO api_tokens (principal_id, name, token_hash, allowed_ips, expires_at) VALUES ($1, 'ci', $2, '{10.0.0.0/8,::1/128}', now() + interval '90 days')`,
        [p?.id, sha('a')],
      ),
    ).toBe('ok')
    expect(
      await sqlCode(`INSERT INTO api_tokens (principal_id, name, token_hash, allowed_ips, expires_at) VALUES ($1, 'ci2', $2, '{not-an-ip}', now() + interval '1 day')`, [
        p?.id,
        sha('b'),
      ]),
    ).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO lockouts (locked_until) VALUES (now())`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO lockouts (username, ip, locked_until) VALUES ('a', '1.2.3.4', now())`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO lockouts (ip, locked_until) VALUES ('1.2.3.4', now())`)).toBe('ok')
    expect(await sqlCode(`INSERT INTO lockouts (ip, locked_until) VALUES ('1.2.3.4', now())`)).toBe('CONFLICT')
  })

  it('keeps reseller delegated addresses to single hosts', async () => {
    expect(await sqlCode(`INSERT INTO principals (kind, username, password_hash) VALUES ('reseller', 'dres', $1)`, [ARGON2])).toBe('ok')
    const [p] = await h.query<{ id: string }>(`SELECT id FROM principals WHERE username = 'dres'`)
    expect(await sqlCode(`INSERT INTO resellers (id, delegated_ips) VALUES ($1, '{10.0.0.0/8}')`, [p?.id])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO resellers (id, delegated_ips) VALUES ($1, '{10.0.0.1,2001:db8::1}')`, [p?.id])).toBe('ok')
  })

  it('rejects path traversal and config-breaking values', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    let n = 0
    const dom = (docRoot: string, redirect: string | null = null) =>
      sqlCode(
        `INSERT INTO domains (account_id, name, kind, doc_root, php, redirect_to, redirect_code)
         VALUES ($1, $2, 'addon', $3, $4, $5, $6)`,
        [a.id, `t${++n}.traversal.example`, docRoot, JSON.stringify(php()), redirect, redirect === null ? null : 301],
      )
    expect(await dom(`${a.home}/../../etc`)).toBe('VALIDATION')
    expect(await dom(`${a.home}/./a`)).toBe('VALIDATION')
    expect(await dom('relative/path')).toBe('VALIDATION')
    expect(await dom(`${a.home}/a b`)).toBe('VALIDATION')
    expect(await dom(`${a.home}/a;rm`)).toBe('VALIDATION')
    expect(await dom(`${a.home}/ok`, 'https://example.com/"; return 200')).toBe('VALIDATION')
    expect(await dom(`${a.home}/ok`, 'https://example.com/\nX: y')).toBe('VALIDATION')
    expect(await dom(`${a.home}/ok`, 'https://example.com/a?b=c')).toBe('ok')
    expect(
      await sqlCode(`INSERT INTO cron_jobs (account_id, schedule, command) VALUES ($1, '* * * * *', E'echo a\\n* * * * * evil')`, [a.id]),
    ).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO cron_jobs (account_id, schedule, command) VALUES ($1, '* * * * * *', 'echo')`, [a.id])).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO cron_jobs (account_id, schedule, command) VALUES ($1, '*/5 * * * *', 'php cron.php')`, [a.id])).toBe('ok')
    const [d] = await h.query<{ id: string }>(`SELECT id FROM domains WHERE account_id = $1 AND kind = 'primary'`, [a.id])
    const su = (local: string, ftpDir = '') =>
      sqlCode(`INSERT INTO service_users (account_id, domain_id, local_part, password_hash, email, ftp_dir) VALUES ($1, $2, $3, 'h', true, $4)`, [a.id, d?.id, local, ftpDir])
    expect(await su('a+b')).toBe('VALIDATION')
    expect(await su('a..b')).toBe('VALIDATION')
    expect(await su('ok', '.ssh')).toBe('VALIDATION')
    expect(await su('ok', 'public_html/../..')).toBe('VALIDATION')
    expect(await su('ok_', 'public_html')).toBe('ok')
  })

  it('keeps certificates free of key material, wildcard ACME on dns-01 and vhosts on their own certificates', async () => {
    const plan = await seedPlan(h.db)
    const a = await seedAccount(h.db, plan.id)
    const b = await seedAccount(h.db, plan.id)
    const base = `INSERT INTO certificates (account_id, names, source, challenge, not_after, cert_path, key_path) VALUES`
    expect(await sqlCode(`${base} ($1, '{example.com,*.example.com}', 'acme', 'http-01', now() + interval '90 days', '/etc/x/c.pem', '/etc/x/k.pem')`, [a.id])).toBe(
      'VALIDATION',
    )
    expect(await sqlCode(`${base} ($1, '{example.com,*.example.com}', 'acme', 'dns-01', now() + interval '90 days', '/etc/x/c.pem', '/etc/x/k.pem')`, [a.id])).toBe(
      'ok',
    )
    expect(await sqlCode(`${base} ($1, '{example.com}', 'upload', 'dns-01', now(), '/etc/x/c.pem', '/etc/x/k.pem')`, [a.id])).toBe('VALIDATION')
    const [c] = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'certificates' AND column_name ~ '(private|pem_content|key_data)'`,
    )
    expect(c?.n).toBe(0)
    const [cert] = await h.query<{ id: string }>(`SELECT id FROM certificates WHERE account_id = $1`, [a.id])
    expect(await sqlCode(`UPDATE domains SET certificate_id = $1 WHERE account_id = $2`, [cert?.id, b.id])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE domains SET certificate_id = $1 WHERE account_id = $2`, [cert?.id, a.id])).toBe('ok')
  })

  it('validates firewall rule shapes per kind', async () => {
    let order = 1000
    const ins = (cols: string, vals: string) => sqlCode(`INSERT INTO firewall_rules (${cols}, sort_order) VALUES (${vals}, ${++order})`)
    expect(await ins('kind, action, protocol, port', `'port', 'accept', 'tcp', '22'`)).toBe('ok')
    expect(await ins('kind, action, protocol, port', `'port', 'accept', 'tcp', '8100-8000'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port', `'port', 'accept', 'tcp', '70000'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port', `'port', 'accept', 'tcp', '022'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port', `'port', 'accept', 'tcp', '22; flush ruleset'`)).toBe('VALIDATION')
    expect(await ins('kind, action', `'port', 'accept'`)).toBe('VALIDATION')
    expect(await ins('kind, action, source', `'ip', 'drop', '203.0.113.0/24'`)).toBe('ok')
    expect(await ins('kind, action, source', `'ip', 'drop', '203.0.113.7/24'`)).toBe('VALIDATION')
    expect(await ins('kind, action', `'ip', 'drop'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port', `'icmp', 'accept', 'tcp', '1'`)).toBe('VALIDATION')
    expect(await ins('kind, action, list', `'prefix-list', 'drop', 'nolist'`)).toBe('NOT_FOUND')
    expect(await ins('kind, action, protocol, port, forward_to', `'forward', 'drop', 'tcp', '2222', '10.0.0.5:22'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port, forward_to', `'forward', 'accept', 'tcp', '2222-2223', '10.0.0.5:22'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port, forward_to', `'forward', 'accept', 'tcp', '2222', '[2001:DB8::1]:22'`)).toBe('ok')
    expect(await ins('kind, action, protocol, port, comment', `'port', 'accept', 'tcp', '25', 'x" accept; #'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port, comment', `'port', 'accept', 'tcp', '26', '${'x'.repeat(129)}'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port, id', `'port', 'accept', 'tcp', '27', 'bad id'`)).toBe('VALIDATION')
    expect(await ins('kind, action, protocol, port, id', `'port', 'accept', 'tcp', '27', 'default-ssh'`)).toBe('ok')
    expect(await sqlCode(`INSERT INTO firewall_rules (kind, action, protocol, port, sort_order) VALUES ('port', 'accept', 'tcp', '28', ${order})`)).toBe('CONFLICT')
    expect(await sqlCode(`INSERT INTO firewall_prefix_lists (name, entries) VALUES ('bad-name', '{}')`)).toBe('VALIDATION')
    expect(await sqlCode(`INSERT INTO firewall_prefix_lists (name, entries) VALUES ('hosts', '{10.0.0.1/8}')`)).toBe('VALIDATION')
  })
})

describe('server_settings', () => {
  it('repeats core worker rules as CHECKs', async () => {
    const cols = `hostname, admin_email, panel_port, nginx_worker_connections, nginx_worker_rlimit_nofile, nginx_keepalive_timeout_sec,
      apache_start_servers, apache_min_spare_servers, apache_max_spare_servers, apache_max_request_workers,
      apache_max_connections_per_child, apache_server_limit, backend_port, backend_tls_port`
    const row = (over: Partial<Record<string, number>> = {}) => {
      const v = { conn: 1024, nofile: 4096, start: 2, min: 2, max: 6, mrw: 100, limit: 100, ...over }
      return `'h.example.net', 'a@example.net', 2087, ${v.conn}, ${v.nofile}, 65, ${v.start}, ${v.min}, ${v.max}, ${v.mrw}, 0, ${v.limit}, 8080, 8443`
    }
    const ins = (over: Partial<Record<string, number>> = {}) => sqlCode(`INSERT INTO server_settings (${cols}) VALUES (${row(over)})`)
    expect(await ins({ conn: 32 })).toBe('VALIDATION')
    expect(await ins({ nofile: 1024 })).toBe('VALIDATION')
    expect(await ins({ min: 6, max: 6, start: 6 })).toBe('VALIDATION')
    expect(await ins({ start: 1 })).toBe('VALIDATION')
    expect(await ins({ max: 200, mrw: 100 })).toBe('VALIDATION')
    expect(await ins()).toBe('ok')
    await h.query('DELETE FROM server_settings')
  })
})

describe('config_generations', () => {
  it('allows at most one active row and only legal transitions', async () => {
    const [g1] = await h.query<{ id: number }>(`INSERT INTO config_generations (checksum) VALUES ($1) RETURNING id`, [sha('1')])
    const [g2] = await h.query<{ id: number }>(`INSERT INTO config_generations (checksum) VALUES ($1) RETURNING id`, [sha('2')])
    expect(await sqlCode(`UPDATE config_generations SET status = 'active', tested_at = now(), activated_at = now() WHERE id = $1`, [g1?.id])).toBe(
      'VALIDATION',
    ) // pending -> active skips the test
    await h.query(`UPDATE config_generations SET status = 'tested', tested_at = now() WHERE id IN ($1, $2)`, [g1?.id, g2?.id])
    expect(await sqlCode(`UPDATE config_generations SET status = 'active', activated_at = now() WHERE id = $1`, [g1?.id])).toBe('ok')
    expect(await sqlCode(`UPDATE config_generations SET status = 'active', activated_at = now() WHERE id = $1`, [g2?.id])).toBe('CONFLICT')
    expect(await sqlCode(`UPDATE config_generations SET checksum = $2 WHERE id = $1`, [g1?.id, sha('3')])).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE config_generations SET status = 'failed' WHERE id = $1`, [g2?.id])).toBe('VALIDATION') // needs error
    expect(await sqlCode(`UPDATE config_generations SET status = 'pending' WHERE id = $1`, [g1?.id])).toBe('VALIDATION')
    await h.query(`UPDATE config_generations SET status = 'superseded' WHERE id = $1`, [g1?.id])
  })
})

describe('upgrades', () => {
  it('allows a single upgrade in flight', async () => {
    const ins = () => sqlCode(`INSERT INTO upgrades (from_version, to_version, actor) VALUES ('1.0.0', '1.1.0', 'root')`)
    expect(await ins()).toBe('ok')
    expect(await ins()).toBe('CONFLICT')
    expect(await sqlCode(`INSERT INTO upgrades (from_version, to_version, actor, status) VALUES ('1.0', '1.1.0', 'root', 'succeeded')`)).toBe(
      'VALIDATION',
    )
    expect(await sqlCode(`UPDATE upgrades SET status = 'failed', finished_at = now() WHERE status = 'pending'`)).toBe('VALIDATION')
    expect(await sqlCode(`UPDATE upgrades SET status = 'failed', error = 'health check', finished_at = now() WHERE status = 'pending'`)).toBe('ok')
    expect(await ins()).toBe('ok')
  })
})
