// Pure-FTPd virtual users (PureDB, built with `pure-pw mkdb`). Each user maps onto its
// account's uid/gid; the `/./` marker in the home field is Pure-FTPd's chroot point.
import type { HostAction, Limit, RenderedFile } from '@xpanel/core'
import { isUnlimited } from '@xpanel/core'
import {
  assertAbsPath,
  assertAccount,
  assertHome,
  assertInt,
  assertString,
  invalid,
  normalizeHostedEmail,
  type AccountRef,
} from './validate.ts'

export interface FtpUserInput {
  /** `user@domain` or the account username */
  login: string
  /** crypt(3) hash: $6$ (SHA-512), $2y$/$2b$ (bcrypt) or $argon2id$ */
  passwordHash: string
  account: AccountRef
  /** start directory relative to the account home; '' is the home itself. The jail is always the home. */
  dir: string
  quotaMb?: Limit
  maxFiles?: Limit
  uploadKBps?: Limit
  downloadKBps?: Limit
  maxConnections?: Limit
  suspended?: boolean
}

/** Pure-FTPd's compiled-in MAX_USER_LENGTH. */
export const FTP_LOGIN_MAX = 32
export const FTP_PASSWD_FILE = '/etc/pure-ftpd/pureftpd.passwd'
export const FTP_PDB_FILE = '/etc/pure-ftpd/pureftpd.pdb'

const CRYPT = '[./A-Za-z0-9]'
const FTP_HASH_RES = [
  new RegExp(`^\\$6\\$(?:rounds=\\d{1,9}\\$)?${CRYPT}{1,16}\\$${CRYPT}{86}$`),
  new RegExp(`^\\$2[aby]\\$\\d{2}\\$${CRYPT}{53}$`),
  /^\$argon2id\$v=19\$m=\d{1,7},t=\d{1,3},p=\d{1,3}\$[A-Za-z0-9+/]{11,64}\$[A-Za-z0-9+/]{16,128}$/,
]

export const assertFtpHash = (v: unknown): string => {
  const s = assertString('FTP password hash', v, 512)
  return FTP_HASH_RES.some((re) => re.test(s)) ? s : invalid('FTP password hash', '[redacted]', 'must be a SHA-512, bcrypt or argon2id crypt hash')
}

export const normalizeFtpLogin = (v: unknown, username: string): string => {
  const s = assertString('FTP login', v, 320)
  const login = s === username ? s : normalizeHostedEmail(s, 'FTP login').address
  if (login.length > FTP_LOGIN_MAX) return invalid('FTP login', login, `is longer than Pure-FTPd's ${FTP_LOGIN_MAX} characters`)
  return login
}

const DIR_SEG_RE = /^[A-Za-z0-9_@+-](?:[A-Za-z0-9._ @+-]{0,253}[A-Za-z0-9._@+-])?$/

/**
 * Relative directory under the home. Refuses absolute paths, `.`/`..` segments (which
 * also blocks a second `/./` chroot marker), `~`, backslashes, `%` escapes, empty
 * segments and anything non-ASCII.
 */
export const assertFtpDir = (v: unknown): string => {
  const s = assertString('FTP directory', v, 1024)
  if (s === '') return ''
  const t = s.endsWith('/') ? s.slice(0, -1) : s
  if (t.startsWith('/')) return invalid('FTP directory', s, 'must be relative to the account home')
  if (/[\\~%:\u0000-\u001f\u007f]|[^\x00-\x7f]/.test(t)) return invalid('FTP directory', s, 'contains a forbidden character')
  const segs = t.split('/')
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return invalid('FTP directory', s, 'may not contain empty, "." or ".." segments')
    if (!DIR_SEG_RE.test(seg)) return invalid('FTP directory', s, `bad segment "${seg}"`)
  }
  if (segs.length > 32) return invalid('FTP directory', s, 'is nested too deeply')
  return segs.join('/')
}

/** Empty field when unlimited or unset; otherwise a bounded integer. */
const limitField = (what: string, v: Limit | undefined, max: number, scale = 1): string => {
  if (v === undefined || isUnlimited(v)) return ''
  return String(assertInt(what, v, 1, max) * scale)
}

/**
 * Home field `<home>/./<dir>/`: Pure-FTPd chroots at `<home>` (root-owned parent, so the
 * account cannot swap it) and starts in `<dir>`. A jail at `<dir>` itself is not offered:
 * the account can replace any directory in its home with a symlink to `/`, and chroot(2)
 * follows it.
 */
export const ftpHomeField = (home: string, dir: string): string => {
  const h = assertHome(home)
  const d = assertFtpDir(dir)
  return d ? `${h}/./${d}/` : `${h}/./`
}

/**
 * `login:hash:uid:gid::<home>/./<dir>/:ul:dl:ulratio:dlratio:maxconn:files:bytes:::::`
 * (18 fields as written by pure-pw). pure-pw takes KB/s and MB but stores bytes/s and
 * bytes, so the inputs are scaled here.
 */
export const ftpPasswdLine = (u: FtpUserInput): string => {
  const a = assertAccount(u.account)
  const login = normalizeFtpLogin(u.login, a.username)
  const hash = assertFtpHash(u.passwordHash)
  const fields = [
    login,
    hash,
    String(a.uid),
    String(a.gid),
    '',
    ftpHomeField(a.home, u.dir),
    limitField('upload bandwidth (KB/s)', u.uploadKBps, 10_000_000, 1024),
    limitField('download bandwidth (KB/s)', u.downloadKBps, 10_000_000, 1024),
    '',
    '',
    limitField('max connections', u.maxConnections, 1000),
    limitField('max files', u.maxFiles, 2_000_000_000),
    limitField('FTP quota (MB)', u.quotaMb, 16 * 1024 * 1024, 1024 * 1024),
    '',
    '',
    '',
    '',
    '',
  ]
  return fields.join(':')
}

export interface FtpPasswdOptions {
  passwdFile?: string
  pdbFile?: string
}

/** Full passwd file (suspended users left out) plus the mkdb step that compiles it. */
export const renderFtpPasswd = (users: FtpUserInput[], o: FtpPasswdOptions = {}): { file: RenderedFile; actions: HostAction[] } => {
  const passwd = assertAbsPath('FTP passwd file', o.passwdFile ?? FTP_PASSWD_FILE)
  const pdb = assertAbsPath('FTP PureDB file', o.pdbFile ?? FTP_PDB_FILE)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const u of users) {
    const line = ftpPasswdLine(u)
    const login = line.slice(0, line.indexOf(':'))
    if (seen.has(login)) invalid('FTP login', login, 'is listed twice')
    seen.add(login)
    if (!u.suspended) lines.push(line)
  }
  lines.sort()
  return {
    file: { path: passwd, content: lines.map((l) => `${l}\n`).join(''), mode: 0o600, owner: 'root', group: 'root' },
    actions: [{ kind: 'exec', argv: ['pure-pw', 'mkdb', pdb, '-f', passwd] }],
  }
}
