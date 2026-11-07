'use strict'
// Runs as the list's account: Dovecot's Sieve `execute` during delivery, runuser for moderation. The reconciler installs this
// file beside the BoxTrapper program. It reads mail from strangers and files the account can edit, so it trusts neither.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
// Installed without an extension.
const shared = require(path.join(__dirname, __filename.endsWith('.cjs') ? 'boxtrapper-program.cjs' : 'xpanel-boxtrapper'))
const { addresses, allowNotice, clean, compactDay, notify, parseHead, readMessage, realSendmail, spool, wildcard } = shared

const ID = /^\d{8}-[0-9a-f]{32}$/
const RELEASE_HEADER = 'X-List-Release'
const ACTIONS = ['approve', 'reject', 'discard']
const OUTGOING_DROPS = /^(?:return-path|delivered-to|x-list-release|list-id|list-post|precedence)[ \t]*:/i
const MAX_HEAD = 64 * 1024
const MAX_VIEW = 256 * 1024
const MAX_HELD = 5000
const MAX_ROWS = 500
const MAX_ADOPT = 200
const DAILY_NOTICES = 200
// Sieve kills the program at 30 s and keeps the post; a stalled sendmail must not hold it twice.
const NOTICE_BUDGET_MS = 10_000
const REASONS = {
  non_member: 'The sender is not a member of this list.',
  moderated_member: 'Posts from this member need approval.',
  moderated_list: 'Every post to this list needs approval.',
  sender_filter: 'The sender matches a rule of this list.',
  too_large: 'The message is larger than this list allows.',
  automated: 'The message looks automated.',
  gate_failed: 'The list could not check this message during delivery.',
}
const TEMPLATES = {
  moderator: { subject: 'Message held for {mailbox}: {subject}', body: 'A message to {mailbox} is waiting for moderation.\n\nFrom: {sender}\nSubject: {subject}\nReason: {reason}\n\nApprove, reject or discard it on the Mailing lists page in xPanel, or under List administration in webmail.\n' },
  held: { subject: 'Your message to {mailbox} is waiting for approval', body: 'Your message with the subject "{subject}" is being held until a moderator of {mailbox} reviews it.\n\n{reason}\n' },
  rejected: { subject: 'Your message to {mailbox} was not delivered', body: 'Your message with the subject "{subject}" was not delivered to {mailbox}.\n\n{reason}\n' },
}
const noticeRules = address => ({ mailbox: address, displayName: '', templates: TEMPLATES, dailyNotices: DAILY_NOTICES })
const fileOf = (store, ...parts) => path.join(store, ...parts)
const newId = now => `${compactDay(now)}-${randomBytes(16).toString('hex')}`
const listId = address => `<${address.replace('@', '.')}>`

/** The facts the decision reads. Two authors name no single sender, so neither counts as a member. */
function readPost(head, envelope) {
  const post = readMessage(head, envelope, { spamBypass: null, mailbox: '', extraAddresses: [] }), authors = addresses((head.get('from') ?? []).join(','))
  return { ...post, author: authors[0] ?? '', from: authors.length === 1 ? authors[0] : '', releaseId: (head.get(RELEASE_HEADER.toLowerCase()) ?? []).at(-1) ?? '', listIds: head.get('list-id') ?? [] }
}
const listed = (patterns, sender) => !!sender && patterns.some(pattern => wildcard(pattern, sender))

/** Mailman's order: a member's own moderation flag, then a non-member's accept, hold, reject and discard filters, then the list. */
function decide(rules, post, size, takePass) {
  if (post.releaseId && takePass(post.releaseId)) return { action: 'pass', reason: 'approved' }
  if (post.listIds.some(value => value.includes(listId(rules.address)))) return { action: 'discard', reason: 'loop' }
  if (post.automated) return { action: 'hold', reason: 'automated' }
  const sender = post.from
  if (sender && rules.members.includes(sender)) {
    if (rules.moderatedMembers.includes(sender)) return { action: rules.memberAction, reason: 'moderated_member' }
  } else if (!listed(rules.acceptSenders, sender)) {
    if (listed(rules.holdSenders, sender)) return { action: 'hold', reason: 'sender_filter' }
    if (listed(rules.rejectSenders, sender)) return { action: 'reject', reason: 'sender_filter' }
    if (listed(rules.discardSenders, sender)) return { action: 'discard', reason: 'sender_filter' }
    if (rules.posting !== 'open') return { action: rules.nonMemberAction, reason: 'non_member' }
  }
  if (rules.posting === 'moderated') return { action: 'hold', reason: 'moderated_list' }
  if (rules.maxMessageKb > 0 && size > rules.maxMessageKb * 1024) return { action: 'hold', reason: 'too_large' }
  return { action: 'pass', reason: 'allowed' }
}

/** The fan-out copy: delivery trace of the hidden user goes, the list headers of RFC 2369 and RFC 2919 come in. */
function writeOutgoing(rules, source, target) {
  const input = fs.openSync(source, 'r'), output = fs.openSync(target, 'wx', 0o600), chunk = Buffer.allocUnsafe(64 * 1024)
  try {
    const first = Buffer.alloc(MAX_HEAD), read = fs.readSync(input, first, 0, MAX_HEAD, 0), text = first.subarray(0, read).toString('latin1'), end = /\r?\n\r?\n/.exec(text)
    const kept = end ? text.slice(0, end.index).split(/\r?\n(?![ \t])/).filter(line => !OUTGOING_DROPS.test(line)).join('\n') + '\n' : ''
    fs.writeSync(output, Buffer.from(`List-Id: ${listId(rules.address)}\nList-Post: <mailto:${rules.address}>\nPrecedence: list\n${kept}`, 'latin1'))
    let position = end ? end.index + /^\r?\n/.exec(text.slice(end.index))[0].length : 0
    for (;;) {
      const count = fs.readSync(input, chunk, 0, chunk.length, position)
      if (count === 0) break
      fs.writeSync(output, chunk, 0, count)
      position += count
    }
  } finally { fs.closeSync(input); fs.closeSync(output) }
}
function fanOut(rules, source, envelope, sendmail) {
  const outgoing = source + '.out'
  writeOutgoing(rules, source, outgoing)
  const fd = fs.openSync(outgoing, 'r')
  try { return sendmail(['-i', '-f', envelope || '<>', '--', ...rules.members], fd) } finally { fs.closeSync(fd); fs.rmSync(outgoing, { force: true }) }
}

const heldFile = (store, id, ext) => fileOf(store, 'held', id + ext)
function hold(store, target, id, post, size, reason, now) {
  fs.writeFileSync(heldFile(store, id, '.json'), JSON.stringify({ id, at: now.toISOString(), from: post.author, envelope: post.envelope, subject: post.subject, size, reason, automated: post.automated }), { mode: 0o600 })
  fs.renameSync(target, heldFile(store, id, '.eml'))
}
function readHeld(store, id) {
  if (!ID.test(id)) return null
  try {
    const row = JSON.parse(fs.readFileSync(heldFile(store, id, '.json'), 'utf8'))
    return row && typeof row === 'object' && row.id === id && typeof row.from === 'string' && typeof row.at === 'string' ? row : null
  } catch { return null }
}
function dropHeld(store, id) { for (const ext of ['.eml', '.json']) fs.rmSync(heldFile(store, id, ext), { force: true }) }
const heldIds = store => {
  try { return fs.readdirSync(fileOf(store, 'held')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => ID.test(id)).sort().reverse() }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

function purge(store, rules, now) {
  const mark = fileOf(store, '.purged'), today = compactDay(now)
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === today) return
  const oldest = compactDay(new Date(now.getTime() - Math.max(rules.retentionDays, 1) * 86_400_000))
  if (rules.retentionDays > 0) for (const id of heldIds(store)) if (id.slice(0, 8) < oldest) dropHeld(store, id)
  for (const dir of ['sent', 'pass']) {
    let names = []
    try { names = fs.readdirSync(fileOf(store, dir)) } catch { continue }
    for (const name of names) if (name.slice(0, 8) < oldest) fs.rmSync(fileOf(store, dir, name), { recursive: true, force: true })
  }
  fs.writeFileSync(mark, today, { mode: 0o600 })
}

function tellModerators(rules, store, id, values, sendmail, now, inTime) {
  const notice = noticeRules(rules.address)
  if (rules.notifyModerators) for (const moderator of rules.moderators) if (inTime() && allowNotice(notice, store, now, `held ${id}`, moderator)) notify(notice, 'moderator', moderator, values, sendmail, now)
}

/** Sieve `execute` entry. Any failure exits non-zero, and the script's implicit keep leaves the post for the queue to adopt. */
function filter(rulesPath, fd, env, sendmail, now) {
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')), store = rules.store, dir = fileOf(store, 'held'), started = Date.now(), inTime = () => Date.now() - started < NOTICE_BUDGET_MS
  fs.mkdirSync(store, { recursive: true, mode: 0o700 })
  purge(store, rules, now)
  const id = newId(now), { target, head, size } = spool(dir, id, fd, RELEASE_HEADER), dropSpool = () => fs.rmSync(target, { force: true })
  try {
    const post = readPost(parseHead(head), env.SENDER ?? ''), { action, reason } = decide(rules, post, size, value => {
      if (!ID.test(value)) return false
      try { fs.rmSync(fileOf(store, 'pass', value)); return true } catch { return false }
    })
    const values = { sender: post.author || '-', subject: clean(post.subject, 120), mailbox: rules.address, reason: REASONS[reason] ?? '' }, notice = noticeRules(rules.address)
    const senderNotice = kind => { if (inTime() && post.envelope && !post.automated && allowNotice(notice, store, now, kind, post.envelope)) notify(notice, kind, post.envelope, values, sendmail, now) }
    if (action === 'pass') {
      if (!fanOut(rules, target, post.envelope, sendmail)) throw new Error('fan_out_failed')
      dropSpool()
    } else if (action === 'reject') { dropSpool(); senderNotice('rejected') }
    else if (action === 'discard') dropSpool()
    else {
      if (fs.readdirSync(dir).length > MAX_HELD * 2) throw new Error('queue_full')
      hold(store, target, id, post, size, reason, now)
      tellModerators(rules, store, id, values, sendmail, now, inTime)
      if (rules.notifySender) senderNotice('held')
    }
    return ''
  } catch (error) { dropSpool(); throw error }
}

/** Posts the check could not take sit in the hidden Maildir; this is the only place they surface. */
function adopt(store, maildir, now) {
  const incoming = path.join(maildir, 'new')
  let names = []
  try { names = fs.readdirSync(incoming) } catch { return }
  for (const name of names.slice(0, MAX_ADOPT)) {
    const file = path.join(incoming, name), fd = fs.openSync(file, 'r'), id = newId(now)
    try {
      const { target, head, size } = spool(fileOf(store, 'held'), id, fd, RELEASE_HEADER), parsed = parseHead(head)
      hold(store, target, id, readPost(parsed, addresses((parsed.get('return-path') ?? []).join(',')).at(0) ?? ''), size, 'gate_failed', now)
      fs.rmSync(file)
    } finally { fs.closeSync(fd) }
  }
}
const publicRow = row => ({ id: row.id, at: row.at, from: clean(row.from, 254), subject: clean(String(row.subject ?? ''), 300), size: Number.isSafeInteger(row.size) ? row.size : 0, reason: Object.hasOwn(REASONS, row.reason) ? row.reason : 'gate_failed' })
function queueView(store, maildir, now) {
  adopt(store, maildir, now)
  const ids = heldIds(store)
  return { total: ids.length, rows: ids.slice(0, MAX_ROWS).flatMap(id => { const row = readHeld(store, id); return row ? [publicRow(row)] : [] }) }
}
function messageView(store, id) {
  const row = readHeld(store, id)
  if (!row) return { found: false }
  const fd = fs.openSync(heldFile(store, id, '.eml'), 'r'), buffer = Buffer.alloc(MAX_VIEW)
  try {
    const read = fs.readSync(fd, buffer, 0, MAX_VIEW, 0), text = buffer.subarray(0, read).toString('utf8').replace(/^X-List-Release: \S+\r?\n/, '').replace(/\r\n/g, '\n'), split = text.indexOf('\n\n')
    return { found: true, ...publicRow(row), headers: split < 0 ? text : text.slice(0, split), body: split < 0 ? '' : text.slice(split + 2), truncated: fs.fstatSync(fd).size > MAX_VIEW }
  } finally { fs.closeSync(fd) }
}
/** Re-enters through Postfix, so the current members and any spam filter apply; the one-time mark passes the check once. */
function release(store, address, row, sendmail) {
  const mark = fileOf(store, 'pass', row.id), fd = fs.openSync(heldFile(store, row.id, '.eml'), 'r')
  fs.mkdirSync(fileOf(store, 'pass'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(mark, '', { mode: 0o600 })
  let sent = false
  try { sent = sendmail(['-i', '-f', row.envelope || '<>', '--', address], fd) } finally { fs.closeSync(fd) }
  if (sent) dropHeld(store, row.id); else fs.rmSync(mark, { force: true })
  return sent
}
function act(store, address, action, reason, ids, sendmail, now) {
  const notice = noticeRules(address), text = reason === '-' ? '' : clean(Buffer.from(reason, 'base64').toString('utf8'), 500)
  let done = 0, failed = 0
  for (const id of ids) {
    const row = readHeld(store, id)
    if (!row) continue
    if (action === 'approve') { if (release(store, address, row, sendmail)) done++; else failed++; continue }
    if (action === 'reject' && row.envelope && !row.automated && allowNotice(notice, store, now, `rejected ${id}`, row.envelope)) notify(notice, 'rejected', row.envelope, { subject: clean(String(row.subject ?? ''), 120), mailbox: address, reason: text }, sendmail, now)
    dropHeld(store, id); done++
  }
  return { done, failed }
}

function main(argv, fd, env, sendmail, now) {
  const [op, target, ...rest] = argv
  if (op === 'filter') return filter(target, fd, env, sendmail, now)
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('store_path')
  if (op === 'queue') return JSON.stringify(queueView(target, rest[0], now))
  if (op === 'message') return JSON.stringify(messageView(target, rest[0]))
  if (op === 'act' && ACTIONS.includes(rest[1])) return JSON.stringify(act(target, rest[0], rest[1], rest[2], rest.slice(3), sendmail, now))
  if (op === 'purge') { for (const dir of [target, rest[0]]) fs.rmSync(dir, { recursive: true, force: true }); return '{"purged":true}' }
  throw new Error('unknown_operation')
}

if (require.main === module) {
  try { fs.writeSync(1, main(process.argv.slice(2), 0, process.env, realSendmail, new Date())) } catch { process.exitCode = 75 }
}
module.exports = { decide, main, readPost }
