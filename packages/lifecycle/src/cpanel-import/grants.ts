// Parser for cPanel's mysql.sql (GRANT / CREATE USER statements). Password material is
// recognised only to be discarded; nothing here is ever executed.

export interface ParsedGrant {
  user: string
  host: string
  privileges: string[]
  /** unescaped database name, '*' for global, or null when it is a wildcard pattern */
  database: string | '*' | null
  /** raw (still escaped) database pattern as written */
  pattern: string
  table: string
  withGrantOption: boolean
}

interface GrantParseResult {
  grants: ParsedGrant[]
  users: { user: string; host: string }[]
  ignored: number
}

/** Splits on `;` outside quotes, backticks and comments. */
export const splitSql = (sql: string): string[] => {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    if (q) {
      cur += c
      if (c === '\\' && q !== '`' && i + 1 < sql.length) { cur += sql[i + 1]; i++ } else if (c === q) q = null
      continue
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue }
    if (c === '#') { while (i < sql.length && sql[i] !== '\n') i++; continue }
    if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; continue }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const unquote = (s: string): string | null => {
  const m = /^(['"`])([\s\S]*)\1$/.exec(s.trim())
  if (!m) return /^[A-Za-z0-9_.%-]+$/.test(s.trim()) ? s.trim() : null
  const q = m[1] as string
  const body = m[2] as string
  return q === '`' ? body.replace(/``/g, '`') : body.replace(/\\(.)/g, '$1').replace(new RegExp(`${q}${q}`, 'g'), q)
}

/** 'user'@'host' at the start of `s`; returns the rest. */
const parseAccount = (s: string): { user: string; host: string; rest: string } | null => {
  const m = /^\s*((?:'(?:[^'\\]|\\.)*')|(?:`[^`]*`)|(?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_]+)\s*@\s*((?:'(?:[^'\\]|\\.)*')|(?:`[^`]*`)|(?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_.%-]+)([\s\S]*)$/.exec(s)
  if (!m) return null
  const user = unquote(m[1] as string)
  const host = unquote(m[2] as string)
  return user === null || host === null ? null : { user, host, rest: m[3] as string }
}

/** MySQL grant db patterns escape _ and % with a backslash; unescaped % means wildcard. */
export const unescapeDbPattern = (p: string): string | null => {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string
    if (c === '\\' && (p[i + 1] === '_' || p[i + 1] === '%' || p[i + 1] === '\\')) { out += p[i + 1]; i++; continue }
    if (c === '%') return null
    out += c
  }
  return out
}

const splitPrivileges = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out.map((p) => p.replace(/\s+/g, ' ').toUpperCase())
}

const parseTarget = (t: string): { pattern: string; table: string } | null => {
  const s = t.trim()
  if (/^(PROCEDURE|FUNCTION)\s/i.test(s)) return null
  const m = /^((?:`(?:[^`]|``)*`)|\*|[A-Za-z0-9_$\\%]+)\s*\.\s*((?:`(?:[^`]|``)*`)|\*|[A-Za-z0-9_$]+)$/.exec(s)
  if (!m) return null
  const db = m[1] as string
  const table = m[2] as string
  return { pattern: db === '*' ? '*' : db.startsWith('`') ? db.slice(1, -1).replace(/``/g, '`') : db, table: table === '*' ? '*' : table.replace(/^`|`$/g, '') }
}

export const parseGrants = (sql: string): GrantParseResult => {
  const grants: ParsedGrant[] = []
  const users: { user: string; host: string }[] = []
  let ignored = 0
  for (const st of splitSql(sql)) {
    const g = /^GRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(st)
    if (g) {
      const target = parseTarget(g[2] as string)
      const acct = parseAccount(g[3] as string)
      if (!target || !acct) { ignored++; continue }
      const database = target.pattern === '*' ? '*' : unescapeDbPattern(target.pattern)
      grants.push({
        user: acct.user,
        host: acct.host,
        privileges: splitPrivileges(g[1] as string),
        database,
        pattern: target.pattern,
        table: target.table,
        withGrantOption: /\bWITH\s+GRANT\s+OPTION\b/i.test(acct.rest),
      })
      if (!users.some((u) => u.user === acct.user && u.host === acct.host)) users.push({ user: acct.user, host: acct.host })
      continue
    }
    const c = /^CREATE\s+USER\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(st)
    const acct = c ? parseAccount(c[1] as string) : null
    if (acct) {
      if (!users.some((u) => u.user === acct.user && u.host === acct.host)) users.push({ user: acct.user, host: acct.host })
      continue
    }
    ignored++
  }
  return { grants, users, ignored }
}
