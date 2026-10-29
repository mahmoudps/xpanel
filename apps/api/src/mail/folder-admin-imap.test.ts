import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapProtocolClient, decodeImapMailboxName, encodeImapMailboxName } from './imap.ts'

// Loopback IMAP commands against a declared scripted peer. No native Dovecot,
// deployed mailbox or Linux qualification is claimed.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Scripted folder peer cleanup failed')
})

interface Message { size: number; seen: boolean; date: number; deleted: boolean }
interface PeerOptions {
  capabilityLine?: string
  listLines?: string[]
  lsubStatus?: 'OK' | 'NO'
  statusLine?: string
  quotaLines?: string[]
  quotaStatus?: 'OK' | 'NO'
  createText?: string
  createStatus?: 'OK' | 'NO'
  omitSizeOf?: number
  moveOnly?: number[]
  changeValidityAfterSearch?: boolean
}
const DAY = 86_400_000, OLD = Date.UTC(2025, 0, 10), NEW = Date.UTC(2026, 9, 20)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const imapDate = (value: string): number => { const [day, month, year] = value.split('-'); return Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day)) }
const expand = (set: string): number[] => set.split(',').flatMap(part => {
  const [first, last] = part.split(':').map(Number)
  return last === undefined ? [first!] : Array.from({ length: last - first! + 1 }, (_, index) => first! + index)
})
async function peer(options: PeerOptions = {}) {
  const sockets = new Set<Socket>(), commands: string[] = []
  const box = (validity: number, items: Array<[number, number, boolean, number]>) => ({ validity, next: 100, messages: new Map(items.map(([uid, size, seen, date]) => [uid, { size, seen, date, deleted: false } as Message])) })
  const boxes = new Map([
    ['INBOX', box(17, [[1, 100, true, OLD], [2, 5_000_000, false, NEW], [3, 300, true, NEW]])],
    ['Sent', box(31, [[1, 2048, true, OLD]])], ['Trash', box(41, [])], ['Projects', box(51, [[4, 50, false, NEW]])],
  ])
  const attributes: Record<string, string> = { INBOX: '\\HasNoChildren', Sent: '\\HasNoChildren \\Sent', Trash: '\\HasNoChildren \\Trash', Projects: '\\HasNoChildren' }
  const subscribed = new Set(['INBOX', 'Sent', 'Trash'])
  const server = createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket))
    const reply = (tag: string, status: string, text: string, lines: string[] = []) => socket.write([...lines, tag + ' ' + status + ' ' + text, ''].join('\r\n'))
    socket.write('* OK scripted folder peer\r\n')
    let selected = 'INBOX', input = ''
    socket.on('data', chunk => {
      input += chunk.toString('utf8')
      for (;;) {
        const end = input.indexOf('\r\n')
        if (end < 0) return
        const line = input.slice(0, end); input = input.slice(end + 2)
        const split = line.indexOf(' '), tag = line.slice(0, split), command = line.slice(split + 1)
        commands.push(command.startsWith('LOGIN ') ? 'LOGIN [redacted]' : command)
        const names = [...command.matchAll(/"([^"]*)"/g)].map(match => match[1]!)
        if (command.startsWith('LOGIN ')) reply(tag, 'OK', 'authenticated')
        else if (command === 'CAPABILITY') reply(tag, 'OK', 'capabilities', [options.capabilityLine ?? '* CAPABILITY IMAP4rev1 MOVE UIDPLUS STATUS=SIZE QUOTA SPECIAL-USE'])
        else if (command === 'LIST "" "*"') reply(tag, 'OK', 'listed', options.listLines ?? [...boxes.keys()].map(name => '* LIST (' + (attributes[name] ?? '\\HasNoChildren') + ') "." "' + name + '"'))
        else if (command === 'LSUB "" "*"') reply(tag, options.lsubStatus ?? 'OK', 'lsub', options.lsubStatus === 'NO' ? [] : [...subscribed].map(name => '* LSUB () "." "' + name + '"'))
        else if (command.startsWith('CREATE ')) {
          const status = options.createStatus ?? (boxes.has(names[0]!) ? 'NO' : 'OK')
          if (status === 'OK') boxes.set(names[0]!, box(71, []))
          reply(tag, status, options.createText ?? (status === 'OK' ? 'created' : '[ALREADYEXISTS] mailbox exists'))
        } else if (command.startsWith('RENAME ')) {
          const source = boxes.get(names[0]!)
          if (source) { boxes.delete(names[0]!); boxes.set(names[1]!, source) }
          reply(tag, source ? 'OK' : 'NO', source ? 'renamed' : '[NONEXISTENT] no such mailbox')
        } else if (command.startsWith('DELETE ')) reply(tag, boxes.delete(names[0]!) ? 'OK' : 'NO', 'deleted')
        else if (/^(UN)?SUBSCRIBE /.test(command)) { if (command.startsWith('UN')) subscribed.delete(names[0]!); else subscribed.add(names[0]!); reply(tag, 'OK', 'subscription') }
        else if (command.startsWith('STATUS ')) {
          const target = boxes.get(names[0]!)
          if (!target) { reply(tag, 'NO', '[NONEXISTENT] no such mailbox'); continue }
          const items = /\(([^)]*)\)$/.exec(command)![1]!.split(' ').map(item => item + ' ' + (item === 'MESSAGES' ? target.messages.size : item === 'UNSEEN' ? [...target.messages.values()].filter(m => !m.seen).length : item === 'SIZE' ? [...target.messages.values()].reduce((sum, m) => sum + m.size, 0) : target.validity))
          reply(tag, 'OK', 'status', [options.statusLine ?? '* STATUS "' + names[0] + '" (' + items.join(' ') + ')'])
        } else if (command.startsWith('SELECT ')) {
          selected = names[0]!
          const target = boxes.get(selected)
          if (!target) { reply(tag, 'NO', 'no such mailbox'); continue }
          reply(tag, 'OK', 'selected', ['* ' + target.messages.size + ' EXISTS', '* OK [UIDVALIDITY ' + target.validity + '] observed'])
        } else if (command === 'UID FETCH 1:* (RFC822.SIZE)') {
          const rows = [...boxes.get(selected)!.messages].filter(([uid]) => uid !== options.omitSizeOf).map(([uid, m], index) => '* ' + (index + 1) + ' FETCH (UID ' + uid + ' RFC822.SIZE ' + m.size + ')')
          reply(tag, 'OK', 'fetched', ['* 1 FETCH (FLAGS (\\Seen))', ...rows])
        } else if (command.startsWith('UID SEARCH UID ')) {
          const wanted = new Set(expand(command.slice('UID SEARCH UID '.length))), present = [...boxes.get(selected)!.messages.keys()].filter(uid => wanted.has(uid))
          reply(tag, 'OK', 'searched', ['* SEARCH' + (present.length ? ' ' + present.join(' ') : '')])
        } else if (command.startsWith('UID SEARCH ')) {
          const before = /BEFORE (\S+)/.exec(command)?.[1], larger = /LARGER (\d+)/.exec(command)?.[1], seen = / SEEN\b/.test(command)
          const uids = [...boxes.get(selected)!.messages].filter(([, m]) => (!before || m.date < imapDate(before)) && (!larger || m.size > Number(larger)) && (!seen || m.seen)).map(([uid]) => uid)
          reply(tag, 'OK', 'searched', ['* SEARCH' + (uids.length ? ' ' + uids.join(' ') : '')])
          if (options.changeValidityAfterSearch) boxes.get(selected)!.validity = 18
        } else if (command.startsWith('UID MOVE ')) {
          const match = /^UID MOVE (\S+) "([^"]+)"$/.exec(command)!, source = boxes.get(selected)!, target = boxes.get(match[2]!)!
          for (const uid of expand(match[1]!)) {
            const message = source.messages.get(uid)
            if (!message || (options.moveOnly && !options.moveOnly.includes(uid))) continue
            source.messages.delete(uid); target.messages.set(target.next++, message)
          }
          reply(tag, 'OK', 'moved')
        } else if (command.startsWith('UID STORE ')) {
          const match = /^UID STORE (\S+) \+FLAGS\.SILENT \(\\Deleted\)$/.exec(command)
          if (match) for (const uid of expand(match[1]!)) { const message = boxes.get(selected)!.messages.get(uid); if (message) message.deleted = true }
          reply(tag, match ? 'OK' : 'BAD', 'stored')
        } else if (command.startsWith('UID EXPUNGE ')) {
          const messages = boxes.get(selected)!.messages
          for (const uid of expand(command.slice('UID EXPUNGE '.length))) if (messages.get(uid)?.deleted) messages.delete(uid)
          reply(tag, 'OK', 'expunged')
        } else if (command === 'EXPUNGE') {
          const messages = boxes.get(selected)!.messages
          for (const [uid, message] of messages) if (message.deleted) messages.delete(uid)
          reply(tag, 'OK', 'global expunge')
        } else if (command === 'GETQUOTAROOT INBOX') reply(tag, options.quotaStatus ?? 'OK', 'quota', options.quotaLines ?? ['* QUOTAROOT INBOX "User quota"', '* QUOTA "User quota" (STORAGE 2048 1048576 MESSAGE 5 0)'])
        else if (command === 'LOGOUT') { reply(tag, 'OK', 'logout', ['* BYE']); socket.end() }
        else reply(tag, 'BAD', 'unsupported scripted command')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  cleanup.push(() => new Promise((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Scripted folder peer has no TCP address')
  const client = new ImapProtocolClient({ host: '127.0.0.1', port: address.port, timeoutMs: 1000, maxLiteralBytes: 4096, maxResponseLineBytes: 65536, maxSearchResults: 50000 })
  cleanup.push(() => client.logout())
  await client.connect(); await client.login('reader@example.test', randomBytes(24).toString('hex'))
  return { client, boxes, subscribed, commands, effects: () => commands.filter(command => /^(?:CREATE|RENAME|DELETE|SUBSCRIBE|UNSUBSCRIBE|UID (?:STORE|MOVE|EXPUNGE|COPY)) |^EXPUNGE$/.test(command)) }
}

describe('RFC 3501 modified UTF-7 folder names', () => {
  it.each([['Café', 'Caf&AOk-'], ['A&B', 'A&-B'], ['台北', '&U,BTFw-'], ['日本語', '&ZeVnLIqe-'], ['Projects', 'Projects']])('encodes %s canonically', (name, wire) => {
    expect(encodeImapMailboxName(name)).toBe(wire)
    expect(decodeImapMailboxName(wire)).toBe(name)
  })
  it('round-trips Arabic and astral text', () => {
    for (const name of ['مشاريع 2026', 'Notes 😀']) expect(decodeImapMailboxName(encodeImapMailboxName(name))).toBe(name)
  })
  it.each(['&AGE-', '&U,BTFw-&ZeVnLIqe-', '&Jjo!', '&U,BTFw', 'Café', '&2D0-'])('refuses non-canonical or malformed wire name %s', wire => {
    expect(decodeImapMailboxName(wire)).toBeNull()
  })
  it('refuses lone surrogates before encoding', () => {
    expect(() => encodeImapMailboxName('bad\ud800')).toThrow()
  })
})

describe('folder listing and administration on the wire', () => {
  it('parses LIST special-use attributes, delimiter, quoted, atom and literal names with LSUB state', async () => {
    const f = await peer({ listLines: ['* LIST (\\HasChildren) "." INBOX', '* LIST (\\HasNoChildren \\Sent) "." "Sent"', '* LIST (\\HasNoChildren) "." {8}\r\nCaf&AOk-', '* LIST (\\Noselect \\HasChildren) "/" "Shared"'] })
    const listed = await f.client.listMailboxes()
    expect(listed.subscriptionsObserved).toBe(true)
    expect(listed.entries).toEqual([
      { name: 'INBOX', displayName: 'INBOX', delimiter: '.', attributes: ['\\HasChildren'], subscribed: true },
      { name: 'Sent', displayName: 'Sent', delimiter: '.', attributes: ['\\HasNoChildren', '\\Sent'], subscribed: true },
      { name: 'Caf&AOk-', displayName: 'Café', delimiter: '.', attributes: ['\\HasNoChildren'], subscribed: false },
      { name: 'Shared', displayName: 'Shared', delimiter: '/', attributes: ['\\Noselect', '\\HasChildren'], subscribed: false },
    ])
  })
  it('reports unobserved subscriptions instead of inventing them', async () => {
    const f = await peer({ lsubStatus: 'NO' })
    const listed = await f.client.listMailboxes()
    expect(listed.subscriptionsObserved).toBe(false)
    expect(listed.entries.every(entry => entry.subscribed === null)).toBe(true)
  })
  it.each([['* LIST (\\HasNoChildren) "." "INBOX"', '* LIST () "." "inbox"'], ['* LIST (HasNoChildren) "." "x"'], ['* LIST () "." "a" trailing'], ['* LIST () ".." "a"']])('refuses malformed or duplicate LIST responses %s', async (...listLines) => {
    const f = await peer({ listLines })
    await expect(f.client.listMailboxes()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('sends exact CREATE/RENAME/DELETE/SUBSCRIBE commands and exposes only RFC 5530 codes', async () => {
    const f = await peer()
    expect(await f.client.createMailbox('Caf&AOk-')).toEqual({ ok: true, code: null })
    expect(await f.client.createMailbox('Projects')).toEqual({ ok: false, code: 'ALREADYEXISTS' })
    expect(await f.client.renameMailbox('Caf&AOk-', 'Projects.Caf&AOk-')).toEqual({ ok: true, code: null })
    expect(await f.client.setMailboxSubscription('Projects', true)).toEqual({ ok: true, code: null })
    expect(await f.client.deleteMailbox('Projects.Caf&AOk-')).toEqual({ ok: true, code: null })
    expect(f.effects()).toEqual(['CREATE "Caf&AOk-"', 'CREATE "Projects"', 'RENAME "Caf&AOk-" "Projects.Caf&AOk-"', 'SUBSCRIBE "Projects"', 'DELETE "Projects.Caf&AOk-"'])
    expect(f.subscribed.has('Projects')).toBe(true)
  })
  it.each(['', 'a*', 'a%', 'line\r\nDELETE INBOX', 'Café'])('refuses an unsafe wire name %j before any command', async name => {
    const f = await peer()
    await expect(f.client.createMailbox(name)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.effects()).toEqual([])
  })
  it('keeps mailbox isolation for folder mutations', async () => {
    const f = await peer()
    await expect(f.client.deleteMailbox('Projects', 'other@example.test')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.effects()).toEqual([])
  })
})

describe('folder usage observations', () => {
  it('reads strict STATUS including RFC 8438 SIZE', async () => {
    const f = await peer()
    expect(await f.client.mailboxStatus('INBOX', ['MESSAGES', 'UNSEEN', 'SIZE'])).toEqual({ messages: 3, unseen: 1, size: 5_000_400 })
  })
  it.each(['* STATUS "Sent" (MESSAGES 3 UNSEEN 1)', '* STATUS "INBOX" (MESSAGES 3)', '* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 RECENT 0)', '* STATUS "INBOX" (MESSAGES 03 UNSEEN 1)', '* STATUS "INBOX" (MESSAGES 3 MESSAGES 1)'])('refuses a mismatched or malformed STATUS %s', async statusLine => {
    const f = await peer({ statusLine })
    await expect(f.client.mailboxStatus('INBOX', ['MESSAGES', 'UNSEEN'])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('sums RFC822.SIZE for every message, skipping unsolicited flag updates, under one generation', async () => {
    const f = await peer()
    const measured = await f.client.mailboxMessageSizes('INBOX', 50000)
    expect(measured.uidValidity).toBe(17)
    expect([...measured.sizes!.entries()]).toEqual([[1, 100], [2, 5_000_000], [3, 300]])
    expect((await f.client.mailboxMessageSizes('INBOX', 2)).sizes).toBeNull()
  })
  it('refuses a partial size observation as a changed folder', async () => {
    const f = await peer({ omitSizeOf: 2 })
    await expect(f.client.mailboxMessageSizes('INBOX', 50000)).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'imap_folder_changed' } })
  })
  it('builds BEFORE/LARGER/SEEN searches and refuses empty criteria before any command', async () => {
    const f = await peer()
    expect(await f.client.searchMailboxUids('INBOX', { before: '1-Jan-2026', largerThan: 50, seen: true }, 17, 50000)).toEqual({ uidValidity: 17, uids: [1] })
    expect(f.commands).toContain('UID SEARCH BEFORE 1-Jan-2026 LARGER 50 SEEN')
    const sent = f.commands.length
    await expect(f.client.searchMailboxUids('INBOX', {}, 17, 50000)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.client.searchMailboxUids('INBOX', { before: '2026-01-01' }, 17, 50000)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.commands.length).toBe(sent)
  })
  it('refuses a search whose generation changed', async () => {
    const f = await peer({ changeValidityAfterSearch: true })
    await expect(f.client.searchMailboxUids('INBOX', { seen: true }, 17, 50000)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('parses RFC 9208 quota roots and resources and refuses an unanswered quota', async () => {
    const f = await peer()
    expect(await f.client.quotaRootResources()).toEqual({ roots: ['User quota'], resources: [{ root: 'User quota', resource: 'STORAGE', usage: 2048, limit: 1048576 }, { root: 'User quota', resource: 'MESSAGE', usage: 5, limit: 0 }] })
    const g = await peer({ quotaStatus: 'NO' })
    await expect(g.client.quotaRootResources()).rejects.toMatchObject({ detail: { reason: 'imap_quota_unavailable' } })
    const h = await peer({ quotaLines: ['* QUOTA "User quota" (STORAGE 1x 2)'] })
    await expect(h.client.quotaRootResources()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('bulk move and permanent removal identity', () => {
  it('moves exactly the observed UID set with RFC 6851 UID MOVE and proves absence', async () => {
    const f = await peer()
    expect(await f.client.moveUidSet('INBOX', [3, 1], 'Trash', 17)).toEqual({ moved: [1, 3], remaining: [], accepted: true })
    expect(f.effects()).toEqual(['UID MOVE 1,3 "Trash"'])
    expect(f.boxes.get('INBOX')!.messages.has(2)).toBe(true); expect(f.boxes.get('Trash')!.messages.size).toBe(2)
  })
  it('reports partial moves from the re-read instead of claiming success', async () => {
    const f = await peer({ moveOnly: [1] })
    expect(await f.client.moveUidSet('INBOX', [1, 2, 3], 'Trash', 17)).toEqual({ moved: [1], remaining: [2, 3], accepted: true })
    expect(f.effects()).toEqual(['UID MOVE 1:3 "Trash"'])
  })
  it.each([
    { name: 'stale generation', run: (c: ImapProtocolClient) => c.moveUidSet('INBOX', [1], 'Trash', 18), code: 'CONFLICT' },
    { name: 'vanished UID', run: (c: ImapProtocolClient) => c.moveUidSet('INBOX', [1, 9], 'Trash', 17), code: 'CONFLICT' },
    { name: 'same folder', run: (c: ImapProtocolClient) => c.moveUidSet('INBOX', [1], 'inbox', 17), code: 'VALIDATION' },
    { name: 'oversized set', run: (c: ImapProtocolClient) => c.moveUidSet('INBOX', [1, 2, 3], 'Trash', 17, undefined, 2), code: 'VALIDATION' },
    { name: 'duplicate UID', run: (c: ImapProtocolClient) => c.moveUidSet('INBOX', [1, 1], 'Trash', 17), code: 'VALIDATION' },
  ])('refuses a $name before any move with stateChanged false', async ({ run, code }) => {
    const f = await peer()
    await expect(run(f.client)).rejects.toMatchObject({ code, detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('never falls back to COPY/EXPUNGE when MOVE is not advertised', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS' })
    await expect(f.client.moveUidSet('INBOX', [1], 'Trash', 17)).rejects.toMatchObject({ detail: { stateChanged: false, unsupported: true } })
    expect(f.effects()).toEqual([])
  })
  it('permanently removes only the exact set with UID EXPUNGE, never a global EXPUNGE', async () => {
    const f = await peer()
    f.boxes.get('Trash')!.messages.set(5, { size: 10, seen: true, date: OLD, deleted: false })
    f.boxes.get('Trash')!.messages.set(6, { size: 20, seen: true, date: OLD - DAY, deleted: true })
    expect(await f.client.expungeUidSet('Trash', [5], 41)).toEqual({ removed: [5], remaining: [], accepted: true })
    expect(f.effects()).toEqual(['UID STORE 5 +FLAGS.SILENT (\\Deleted)', 'UID EXPUNGE 5'])
    expect(f.boxes.get('Trash')!.messages.has(6)).toBe(true)
  })
  it('refuses permanent removal without observed UIDPLUS', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 MOVE' })
    await expect(f.client.expungeUidSet('Trash', [1], 41)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
})
