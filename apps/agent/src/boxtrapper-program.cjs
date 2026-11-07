'use strict'
// Runs as the mailbox's account: Dovecot's Sieve `execute` during delivery, runuser for queue review. The reconciler
// installs this file. It reads mail from strangers and files the account can edit, so it trusts neither.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const SENDMAIL = '/usr/sbin/sendmail'
const ID = /^\d{8}-[0-9a-f]{32}$/
const DAY = /^\d{8}$/
const TOKEN = /verify#(\d{8}-[0-9a-f]{32})/i
const RELEASE_HEADER = 'X-BoxTrapper-Release'
const ADDRESS = /^[^\s@<>()",;:\\]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const LISTS = ['allow', 'ignore', 'deny']
const ACTIONS = ['deliver', 'allow', 'delete', 'ignore', 'deny']
const MAX_HEAD = 64 * 1024
const MAX_VIEW = 256 * 1024
const MAX_HELD_PER_DAY = 5000
const MAX_LIST_BYTES = 60 * 1024
const MAX_RULES = 1000
const MAX_RELEASE = 200
const MAX_LOG_BYTES = 1024 * 1024
const MAX_ASSOCIATED = 20
const SENT_SCAN = 500
const SENT_HEAD = 16 * 1024

const compactDay = date => date.toISOString().slice(0, 10).replaceAll('-', '')
const isoDay = day => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
const clean = (text, max) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max)

/** Header fields of one message, unfolded, lower-cased by name. */
function parseHead(buffer) {
  let end = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (crlf >= 0 && (end < 0 || crlf < end)) end = crlf
  const text = buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  const head = new Map()
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 1) continue
    const name = line.slice(0, at).trim().toLowerCase()
    head.set(name, [...head.get(name) ?? [], line.slice(at + 1).trim()])
  }
  return head
}

/** Addresses of an address header: the angle-bracket form wins, display names and comments never match. */
function addresses(value) {
  const found = []
  for (const part of value.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\([^()]*\)/g, '').split(',')) {
    const angle = /<([^<>]*)>/.exec(part), text = (angle ? angle[1] : part).trim().toLowerCase()
    if (ADDRESS.test(text)) found.push(text)
  }
  return found
}

function decodeWords(value) {
  return value.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=(?:\s+(?==\?))?/g, (all, charset, encoding, text) => {
    try {
      const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
      return new TextDecoder(charset).decode(bytes)
    } catch { return all }
  })
}

/** Case-sensitive `*` and `?` match over the whole text; no backtracking engine, so a saved rule cannot stall delivery. */
function wildcard(pattern, text) {
  let p = 0, t = 0, star = -1, mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++ }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t }
    else if (star >= 0) { p = star + 1; t = ++mark }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

/** `from <glob>`, `to <glob>`, `subject <glob>` or a bare sender glob. */
function parseRule(line) {
  const text = line.trim().toLowerCase(), match = /^(from|to|subject)\s+(\S.{0,299})$/.exec(text)
  if (match) return { field: match[1], pattern: match[2] }
  return text && text.length <= 300 && !/\s/.test(text) ? { field: 'from', pattern: text } : null
}

function matches(lines, message) {
  return lines.some(line => {
    const rule = parseRule(line)
    if (!rule) return false
    if (rule.field === 'subject') return wildcard(rule.pattern, message.subject.toLowerCase())
    return (rule.field === 'to' ? message.to : [message.from]).some(item => wildcard(rule.pattern, item))
  })
}

/** The facts the decision reads; `score` only from a header the installed spam filter rewrites. */
function readMessage(head, envelope, rules) {
  const all = name => head.get(name) ?? []
  const last = name => all(name).at(-1) ?? ''
  const from = addresses(all('from').join(',')).at(0) ?? '', subject = clean(decodeWords(last('subject')), 998)
  const to = [...new Set(addresses([...all('to'), ...all('cc')].join(',')))]
  const auto = last('auto-submitted').toLowerCase()
  const score = rules.spamBypass === null ? null : /\bscore=(-?\d+(?:\.\d+)?)/i.exec(last('x-spam-status'))?.[1]
  const own = [rules.mailbox, ...rules.extraAddresses]
  return {
    from, to, envelope: ADDRESS.test(envelope.toLowerCase()) ? envelope.toLowerCase() : '',
    subject,
    token: TOKEN.exec(subject)?.[1] ?? null,
    releaseId: last(RELEASE_HEADER.toLowerCase()),
    score: score === null || score === undefined ? null : Number(score),
    automated: !ADDRESS.test(envelope.toLowerCase()) || (!!auto && auto !== 'no') || /\b(bulk|list|junk)\b/i.test(last('precedence'))
      || all('list-id').length > 0 || all('list-unsubscribe').length > 0 || /^(mailer-daemon|postmaster|no-?reply)@/.test(from),
    flagged: /^yes\b/i.test(last('x-spam')) || /^yes\b/i.test(last('x-spam-flag')),
    addressed: to.some(item => own.includes(item)),
    own: own.includes(from),
  }
}

/** Ignore beats deny beats allow, as the catalog asks; a stranger's automatic mail never earns a challenge. */
function decide(rules, lists, message, context) {
  if (message.releaseId && context.takePass(message.releaseId)) return 'pass'
  if (matches(lists.ignore, message)) return 'ignore'
  if (matches(lists.deny, message)) return 'deny'
  if (message.token && !message.automated) return 'verify'
  if (matches(lists.allow, message)) return 'allow'
  if (message.score !== null && rules.spamBypass !== null && message.score < rules.spamBypass) return 'bypass'
  if (rules.autoAllowSent && message.from && !message.own && context.wroteTo(message.from)) return 'sent'
  return !message.from || message.automated || message.flagged || !message.addressed || message.own ? 'quiet' : 'challenge'
}

const fileOf = (store, ...parts) => path.join(store, ...parts)
function readList(store, list) {
  try { return fs.readFileSync(fileOf(store, list + '.txt'), 'utf8').split('\n').filter(Boolean).slice(0, MAX_RULES) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
const readLists = store => Object.fromEntries(LISTS.map(list => [list, readList(store, list)]))
const listsRevision = lists => createHash('sha256').update(JSON.stringify(lists)).digest('hex')
function addRule(store, list, line) {
  if (readList(store, list).includes(line)) return
  fs.appendFileSync(fileOf(store, list + '.txt'), line + '\n', { mode: 0o600 })
}
function log(store, now, action, message) {
  const dir = fileOf(store, 'log'), file = path.join(dir, now.toISOString().slice(0, 10) + '.log')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) return
  fs.appendFileSync(file, `${now.toISOString().slice(0, 19)}Z ${action} ${message.from || '-'} ${clean(message.subject, 200)}\n`, { mode: 0o600 })
}

function queueRows(store, day) {
  const dir = fileOf(store, 'queue', day), rows = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of names) {
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue
    const row = readQueued(store, name.slice(0, -5))
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at))
}
function readQueued(store, id) {
  if (!ID.test(id)) return null
  try {
    const row = JSON.parse(fs.readFileSync(fileOf(store, 'queue', id.slice(0, 8), id + '.json'), 'utf8'))
    return row && typeof row === 'object' && row.id === id && typeof row.from === 'string' && typeof row.at === 'string' ? row : null
  } catch { return null }
}
const queueDays = store => { try { return fs.readdirSync(fileOf(store, 'queue')).filter(name => DAY.test(name)).sort().reverse() } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
function dropQueued(store, id) { for (const ext of ['.eml', '.json']) fs.rmSync(fileOf(store, 'queue', id.slice(0, 8), id + ext), { force: true }) }
const sameSender = (store, from) => queueDays(store).flatMap(day => queueRows(store, day)).filter(row => row.from === from).slice(0, MAX_RELEASE)

/** Re-enters normal delivery, so quota, the mailbox's own filters and its forwarders apply; the one-time mark lets it past this filter once. */
function release(store, mailbox, row, sendmail) {
  const eml = fileOf(store, 'queue', row.id.slice(0, 8), row.id + '.eml'), mark = fileOf(store, 'pass', row.id)
  fs.mkdirSync(fileOf(store, 'pass'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(mark, '', { mode: 0o600 })
  const fd = fs.openSync(eml, 'r')
  let sent = false
  try { sent = sendmail(['-i', '-f', row.envelope || '<>', '--', mailbox], fd) } finally { fs.closeSync(fd) }
  if (sent) dropQueued(store, row.id); else fs.rmSync(mark, { force: true })
  return sent
}

function realSendmail(args, input) {
  const stdin = typeof input === 'number' ? input : 'pipe'
  return spawnSync(SENDMAIL, args, { input: typeof input === 'string' ? input : undefined, stdio: [stdin, 'ignore', 'ignore'], timeout: 15_000 }).status === 0
}

const encodeHeader = text => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`
function notify(rules, kind, to, values, sendmail, now) {
  const template = rules.templates[kind], domain = rules.mailbox.split('@')[1]
  const fill = text => text.replace(/\{(sender|subject|mailbox|name|token|reason)\}/g, (_, key) => values[key] ?? '')
  const name = rules.displayName ? `${encodeHeader(rules.displayName)} ` : ''
  const message = [`From: ${name}<${rules.mailbox}>`, `To: <${to}>`, `Subject: ${encodeHeader(clean(fill(template.subject), 200))}`, `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`, 'Auto-Submitted: auto-replied', 'X-Auto-Response-Suppress: All', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit', '', fill(template.body), ''].join('\n')
  return sendmail(['-i', '-f', '<>', '--', to], message)
}
/** One notice of a kind to a sender per day, and a daily cap per mailbox: the backscatter guard. Exclusive create, because deliveries run in parallel. */
function allowNotice(rules, store, now, kind, to) {
  const dir = fileOf(store, 'sent', compactDay(now))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.readdirSync(dir).length >= rules.dailyNotices) return false
  try { fs.writeFileSync(path.join(dir, createHash('sha256').update(`${kind} ${to}`).digest('hex')), '', { flag: 'wx', mode: 0o600 }); return true }
  catch (error) { if (error.code === 'EEXIST') return false; throw error }
}

/** Recipients in the newest Sent messages; Maildir names start with the delivery time. */
function wroteTo(store, from) {
  const box = path.dirname(store)
  for (const folder of ['.Sent/cur', '.Sent/new']) {
    let names = []
    try { names = fs.readdirSync(path.join(box, folder)) } catch { continue }
    names.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
    for (const name of names.slice(0, SENT_SCAN)) {
      let fd = -1
      try {
        fd = fs.openSync(path.join(box, folder, name), 'r')
        const buffer = Buffer.alloc(SENT_HEAD), read = fs.readSync(fd, buffer, 0, SENT_HEAD, 0), head = parseHead(buffer.subarray(0, read))
        if (addresses([...head.get('to') ?? [], ...head.get('cc') ?? [], ...head.get('bcc') ?? []].join(',')).includes(from)) return true
      } catch { /* an unreadable sent message proves nothing */ } finally { if (fd >= 0) fs.closeSync(fd) }
    }
  }
  return false
}

function purge(store, rules, now) {
  const mark = fileOf(store, '.purged'), today = compactDay(now)
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === today) return
  const oldest = compactDay(new Date(now.getTime() - rules.retentionDays * 86_400_000))
  for (const name of queueDays(store)) if (name < oldest) fs.rmSync(fileOf(store, 'queue', name), { recursive: true, force: true })
  for (const dir of ['sent', 'log']) {
    let names = []
    try { names = fs.readdirSync(fileOf(store, dir)) } catch { continue }
    for (const name of names) if (name.replace('.log', '').replaceAll('-', '') < oldest) fs.rmSync(fileOf(store, dir, name), { recursive: true, force: true })
  }
  fs.writeFileSync(mark, today, { mode: 0o600 })
}

/** Spools stdin before deciding, so a large message costs disk it would cost anyway and no memory. */
function spool(dir, id, fd, header) {
  const target = path.join(dir, id + '.tmp')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const out = fs.openSync(target, 'wx', 0o600), chunk = Buffer.allocUnsafe(64 * 1024), parts = []
  let kept = 0, size = 0
  fs.writeSync(out, `${header}: ${id}\n`)
  try {
    for (;;) {
      let read
      try { read = fs.readSync(fd, chunk, 0, chunk.length, null) } catch (error) { if (error.code === 'EOF') break; throw error }
      if (read === 0) break
      fs.writeSync(out, chunk, 0, read)
      size += read
      if (kept < MAX_HEAD) { parts.push(Buffer.from(chunk.subarray(0, Math.min(read, MAX_HEAD - kept)))); kept += parts.at(-1).length }
    }
  } finally { fs.closeSync(out) }
  return { target, head: Buffer.concat(parts), size }
}

/** Sieve `execute` entry. Any failure exits non-zero and the message stays in normal delivery: this filter never loses mail. */
function filter(rulesPath, fd, env, sendmail, now) {
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')), store = rules.store
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  purge(store, rules, now)
  const day = compactDay(now), id = `${day}-${randomBytes(16).toString('hex')}`, lists = readLists(store)
  const { target, head, size } = spool(fileOf(store, 'queue', day), id, fd, RELEASE_HEADER)
  const dropSpool = () => fs.rmSync(target, { force: true })
  try {
    const message = readMessage(parseHead(head), env.SENDER ?? '', rules)
    const action = decide(rules, lists, message, {
      takePass: value => { if (!ID.test(value)) return false; try { fs.rmSync(fileOf(store, 'pass', value)); return true } catch { return false } },
      wroteTo: from => wroteTo(store, from),
    })
    const values = { sender: message.from, subject: clean(message.subject, 120), mailbox: rules.mailbox, name: rules.displayName, token: id }
    log(store, now, action, message)
    if (action === 'pass') { dropSpool(); return 'allow' }
    if (action === 'ignore') { dropSpool(); return 'hold' }
    if (action === 'deny') {
      dropSpool()
      if (!message.automated && allowNotice(rules, store, now, 'deny', message.envelope)) notify(rules, 'deny', message.envelope, values, sendmail, now)
      return 'hold'
    }
    if (action === 'verify') {
      dropSpool()
      const row = readQueued(store, message.token)
      if (row && (row.from === message.from || !!row.envelope && row.envelope === message.envelope)) {
        addRule(store, 'allow', `from ${row.from}`)
        for (const item of sameSender(store, row.from)) release(store, rules.mailbox, item, sendmail)
        notify(rules, 'released', message.envelope, { ...values, subject: clean(row.subject, 120) }, sendmail, now)
        log(store, now, 'released', row)
      } else if (allowNotice(rules, store, now, 'failed', message.envelope)) notify(rules, 'failed', message.envelope, values, sendmail, now)
      return 'hold'
    }
    if (action === 'allow' || action === 'bypass' || action === 'sent') {
      dropSpool()
      if (action === 'sent') addRule(store, 'allow', `from ${message.from}`)
      if (action === 'allow' && rules.allowByAssociation) {
        const own = [rules.mailbox, ...rules.extraAddresses]
        for (const item of message.to.filter(address => !own.includes(address)).slice(0, MAX_ASSOCIATED)) if (![...lists.deny, ...lists.ignore].includes(`from ${item}`)) addRule(store, 'allow', `from ${item}`)
      }
      return 'allow'
    }
    if (fs.readdirSync(path.dirname(target)).length > MAX_HELD_PER_DAY * 2) { dropSpool(); return 'keep' }
    fs.writeFileSync(path.join(path.dirname(target), id + '.json'), JSON.stringify({ id, at: now.toISOString(), from: message.from, envelope: message.envelope, subject: message.subject, size }), { mode: 0o600 })
    fs.renameSync(target, path.join(path.dirname(target), id + '.eml'))
    if (action === 'challenge' && allowNotice(rules, store, now, 'verify', message.envelope)) notify(rules, 'verify', message.envelope, values, sendmail, now)
    return 'hold'
  } catch (error) { dropSpool(); throw error }
}

const publicRow = row => ({ id: row.id, at: row.at, from: clean(row.from, 254), subject: clean(String(row.subject ?? ''), 300), size: Number.isSafeInteger(row.size) ? row.size : 0 })
function queueView(store, wanted) {
  const days = queueDays(store), day = wanted === 'latest' ? days[0] ?? '' : wanted
  return { days: days.slice(0, 60).map(item => ({ day: isoDay(item), count: queueRows(store, item).length })), day: day ? isoDay(day) : null, rows: day ? queueRows(store, day).slice(0, 500).map(publicRow) : [] }
}
function messageView(store, id) {
  const row = readQueued(store, id)
  if (!row) return { found: false }
  const fd = fs.openSync(fileOf(store, 'queue', id.slice(0, 8), id + '.eml'), 'r'), buffer = Buffer.alloc(MAX_VIEW)
  try {
    const read = fs.readSync(fd, buffer, 0, MAX_VIEW, 0), text = buffer.subarray(0, read).toString('utf8').replace(/^X-BoxTrapper-Release: \S+\r?\n/, '').replace(/\r\n/g, '\n')
    const split = text.indexOf('\n\n')
    return { found: true, ...publicRow(row), headers: split < 0 ? text : text.slice(0, split), body: split < 0 ? '' : text.slice(split + 2), truncated: fs.fstatSync(fd).size > MAX_VIEW }
  } finally { fs.closeSync(fd) }
}
function logView(store, wanted) {
  let names = []
  try { names = fs.readdirSync(fileOf(store, 'log')).filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().reverse() } catch (error) { if (error.code !== 'ENOENT') throw error }
  const name = wanted === 'latest' ? names[0] : `${isoDay(wanted)}.log`
  const text = name && names.includes(name) ? fs.readFileSync(fileOf(store, 'log', name), 'utf8') : ''
  return { days: names.slice(0, 60).map(item => item.slice(0, 10)), day: name ? name.slice(0, 10) : null, lines: text.split('\n').filter(Boolean).slice(-1000) }
}
function setLists(store, revision, encoded) {
  const current = readLists(store)
  if (listsRevision(current) !== revision) return { saved: false, reason: 'lists_changed' }
  const next = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_LIST_BYTES || !LISTS.every(list => Array.isArray(next[list]) && next[list].length <= MAX_RULES && next[list].every(line => typeof line === 'string' && parseRule(line)))) return { saved: false, reason: 'lists_invalid' }
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  for (const list of LISTS) {
    const temporary = fileOf(store, `.${list}.${process.pid}`)
    fs.writeFileSync(temporary, next[list].map(line => line + '\n').join(''), { mode: 0o600 })
    fs.renameSync(temporary, fileOf(store, list + '.txt'))
  }
  const lists = readLists(store)
  return { saved: true, lists, revision: listsRevision(lists) }
}
function act(store, mailbox, action, ids, sendmail) {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  let done = 0, failed = 0
  for (const id of ids) {
    const row = readQueued(store, id)
    if (!row) continue
    const rows = action === 'deliver' || action === 'delete' || !row.from ? [row] : sameSender(store, row.from)
    if ((action === 'allow' || action === 'ignore' || action === 'deny') && row.from) addRule(store, action, `from ${row.from}`)
    for (const item of rows) {
      if (action === 'deliver' || action === 'allow') { if (release(store, mailbox, item, sendmail)) done++; else failed++ }
      else { dropQueued(store, item.id); done++ }
    }
  }
  return { done, failed }
}

function main(argv, fd, env, sendmail, now) {
  const [op, target, ...rest] = argv
  if (op === 'filter') return filter(target, fd, env, sendmail, now)
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('store_path')
  if (op === 'queue') return JSON.stringify(queueView(target, rest[0]))
  if (op === 'message') return JSON.stringify(messageView(target, rest[0]))
  if (op === 'log') return JSON.stringify(logView(target, rest[0]))
  if (op === 'lists') { const lists = readLists(target); return JSON.stringify({ lists, revision: listsRevision(lists) }) }
  if (op === 'lists-set') return JSON.stringify(setLists(target, rest[0], rest[1]))
  if (op === 'act' && ACTIONS.includes(rest[1])) return JSON.stringify(act(target, rest[0], rest[1], rest.slice(2), sendmail))
  throw new Error('unknown_operation')
}

if (require.main === module) {
  try { fs.writeSync(1, main(process.argv.slice(2), 0, process.env, realSendmail, new Date())) } catch { process.exitCode = 75 }
}
module.exports = { addresses, allowNotice, clean, compactDay, decide, decodeWords, main, notify, parseHead, parseRule, readMessage, realSendmail, spool, wildcard }
