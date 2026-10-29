import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapProtocolClient } from './imap.ts'

// Actual loopback IMAP commands against a declared synthetic server. No native
// mailbox authentication, deployed service or Linux qualification is claimed.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Synthetic message safety peer cleanup failed')
})

interface PeerOptions {
  capabilityLine?: string | null
  sourceValidity?: number | null
  searchAllLine?: string | null
  searchUidLine?: string | null
  maxSearchResults?: number
  emptySource?: boolean
  copyUidText?: string | null
  moveStatus?: 'OK' | 'NO' | 'BAD'
  copyStatus?: 'OK' | 'NO' | 'BAD'
  storeStatus?: 'OK' | 'NO' | 'BAD'
  expungeStatus?: 'OK' | 'NO' | 'BAD'
  applyMoveOnFailure?: boolean
  keepSourceOnExpunge?: boolean
  targetLookupMissing?: boolean
  resetAfterSearch?: boolean
  resetAfterUidLookup?: boolean
  resetAfterStore?: boolean
  resetSourceAfterCopy?: boolean
}
async function peer(options: PeerOptions = {}) {
  const sockets = new Set<Socket>(), commands: string[] = []
  const folders = new Map<string, Map<number, Set<string>>>([
    ['INBOX', new Map([[1, new Set<string>()], [2, new Set(['\\Deleted'])]])], ['Trash', new Map()], ['Archive', new Map()],
  ])
  if (options.emptySource) folders.get('INBOX')!.clear()
  const validities = new Map<string, number | null>([['INBOX', options.sourceValidity === undefined ? 17 : options.sourceValidity], ['Trash', 41], ['Archive', 51]])
  let nextUid = 23
  const server = createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket))
    const reply = (tag: string, status: string, text: string, lines: string[] = []) => socket.write([...lines, tag + ' ' + status + ' ' + text, ''].join('\r\n'))
    socket.write('* OK synthetic bounded message peer\r\n')
    let selected = 'INBOX', input = ''
    socket.on('data', chunk => {
      input += chunk.toString('utf8')
      for (;;) {
        const end = input.indexOf('\r\n')
        if (end < 0) return
        const line = input.slice(0, end); input = input.slice(end + 2)
        const split = line.indexOf(' '), tag = line.slice(0, split), command = line.slice(split + 1)
        commands.push(command.startsWith('LOGIN ') ? 'LOGIN [redacted]' : command)
        if (command.startsWith('LOGIN ')) reply(tag, 'OK', 'authenticated synthetic mailbox')
        else if (command === 'CAPABILITY') reply(tag, 'OK', 'capabilities', options.capabilityLine === null ? [] : [options.capabilityLine ?? '* CAPABILITY IMAP4rev1 MOVE UIDPLUS'])
        else if (command.startsWith('SELECT ')) {
          selected = /^SELECT "([^"]+)"$/.exec(command)?.[1] ?? ''
          if (!folders.has(selected)) { reply(tag, 'NO', 'no such synthetic folder'); continue }
          const validity = validities.get(selected)
          reply(tag, 'OK', 'selected', ['* ' + folders.get(selected)!.size + ' EXISTS', ...(validity === null ? [] : ['* OK [UIDVALIDITY ' + validity + '] observed'])])
        } else if (command === 'UID SEARCH ALL') {
          const uids = [...folders.get(selected)!.keys()]
          const observed = '* SEARCH' + (uids.length ? ' ' + uids.join(' ') : '')
          reply(tag, 'OK', 'searched', options.searchAllLine === null ? [] : [options.searchAllLine ?? observed])
          if (options.resetAfterSearch) validities.set(selected, 18)
        } else if (/^UID SEARCH UID [1-9][0-9]*$/.test(command)) {
          const uid = Number(command.slice('UID SEARCH UID '.length))
          const present = folders.get(selected)!.has(uid) && !(options.targetLookupMissing && selected !== 'INBOX')
          reply(tag, 'OK', 'searched', options.searchUidLine === null ? [] : [options.searchUidLine ?? ('* SEARCH' + (present ? ' ' + uid : ''))])
          if (options.resetAfterUidLookup && selected === 'INBOX') validities.set(selected, 18)
        } else if (/^UID (?:MOVE|COPY) /.test(command)) {
          const match = /^UID (MOVE|COPY) ([1-9][0-9]*) "([^"]+)"$/.exec(command)
          if (!match) { reply(tag, 'BAD', 'malformed synthetic transfer'); continue }
          const move = match[1] === 'MOVE', uid = Number(match[2]), destination = match[3]!
          const status = move ? (options.moveStatus ?? 'OK') : (options.copyStatus ?? 'OK')
          const source = folders.get(selected)!, target = folders.get(destination)!, flags = source.get(uid), assigned = nextUid++
          if (flags && (status === 'OK' || (move && options.applyMoveOnFailure))) {
            target.set(assigned, new Set(flags)); if (move) source.delete(uid)
          }
          const mapping = options.copyUidText === null ? 'completed without UIDPLUS mapping' : options.copyUidText ?? ('[COPYUID ' + validities.get(destination) + ' ' + uid + ' ' + assigned + '] transferred')
          reply(tag, status, mapping)
          if (!move && options.resetSourceAfterCopy) validities.set(selected, 18)
        } else if (command.startsWith('UID STORE ')) {
          const match = /^UID STORE ([1-9][0-9]*) ([+-]?FLAGS\.SILENT) \(([^)]*)\)$/.exec(command)
          const status = options.storeStatus ?? 'OK'
          if (match && status === 'OK') {
            const uid = Number(match[1]), flags = folders.get(selected)!.get(uid), values = match[3]!.split(' ').filter(Boolean)
            if (flags) {
              if (match[2] === 'FLAGS.SILENT') flags.clear()
              for (const value of values) { if (match[2] === '-FLAGS.SILENT') flags.delete(value); else flags.add(value) }
            }
          }
          reply(tag, status, 'stored')
          if (status === 'OK' && options.resetAfterStore) validities.set(selected, 18)
        } else if (/^UID EXPUNGE [1-9][0-9]*$/.test(command)) {
          const uid = Number(command.slice('UID EXPUNGE '.length)), status = options.expungeStatus ?? 'OK'
          if (status === 'OK' && !options.keepSourceOnExpunge && folders.get(selected)!.get(uid)?.has('\\Deleted')) folders.get(selected)!.delete(uid)
          reply(tag, status, 'UID expunge completed')
        } else if (command === 'EXPUNGE') {
          // Deliberately model the dangerous real semantics, so regression tests
          // fail on both the wire command and loss of the unrelated Deleted UID.
          for (const [uid, flags] of folders.get(selected)!) if (flags.has('\\Deleted')) folders.get(selected)!.delete(uid)
          reply(tag, 'OK', 'global expunge completed')
        } else if (command === 'LOGOUT') { reply(tag, 'OK', 'logout', ['* BYE']); socket.end() }
        else reply(tag, 'BAD', 'unsupported synthetic command')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  cleanup.push(() => new Promise((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic safety peer has no TCP address')
  const client = new ImapProtocolClient({ host: '127.0.0.1', port: address.port, timeoutMs: 1000, maxLiteralBytes: 1024, maxResponseLineBytes: 4096, maxSearchResults: options.maxSearchResults ?? 50000 })
  cleanup.push(() => client.logout())
  await client.connect(); await client.login('reader@example.test', randomBytes(24).toString('hex'))
  return { client, folders, commands, effects: () => commands.filter(command => /^(?:UID (?:STORE|COPY|MOVE|EXPUNGE) |EXPUNGE$)/.test(command)) }
}

describe('canonical per-message identity and expunge safety', () => {
  it.each(['delete', 'store', 'move', 'copy'] as const)('refuses omitted expected UIDVALIDITY before %s effects', async operation => {
    const f = await peer()
    const run = operation === 'delete' ? () => f.client.deleteByUid('INBOX', 1) : operation === 'store' ? () => f.client.storeFlagsByUid('INBOX', 1, 'add', ['\\Seen']) : () => f.client.moveOrCopyByUid('INBOX', 1, 'Trash', operation)
    await expect(run()).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it.each([null, 0, 18])('refuses missing, invalid or stale source generation %s before deletion', async sourceValidity => {
    const f = await peer({ sourceValidity })
    await expect(f.client.deleteByUid('INBOX', 1, undefined, 17)).rejects.toThrow()
    expect(f.effects()).toEqual([])
  })
  it.each([null, '* OK informational [CAPABILITY UIDPLUS]', '* CAPABILITY IMAP4rev1 MOVE'])('refuses unobserved or unsupported UIDPLUS before STORE/delete: %s', async capabilityLine => {
    const f = await peer({ capabilityLine })
    await expect(f.client.deleteByUid('INBOX', 1, undefined, 17)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('never sets Deleted through the public flag API without observed UIDPLUS', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 MOVE' })
    await expect(f.client.storeFlagsByUid('INBOX', 1, 'add', ['\\Deleted'], undefined, 17)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('updates ordinary flags with observed source identity on a base IMAP server', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1' })
    await f.client.storeFlagsByUid('INBOX', 1, 'add', ['\\Seen', '\\Flagged'], undefined, 17)
    expect(f.folders.get('INBOX')!.get(1)).toEqual(new Set(['\\Seen', '\\Flagged']))
    expect(f.folders.get('INBOX')!.get(2)).toEqual(new Set(['\\Deleted']))
  })
  it('expunges exactly the requested UID and preserves unrelated messages already Deleted', async () => {
    const f = await peer()
    await f.client.deleteByUid('INBOX', 1, undefined, 17)
    expect(f.commands).toContain('UID EXPUNGE 1'); expect(f.commands).not.toContain('EXPUNGE')
    expect(f.folders.get('INBOX')!.has(1)).toBe(false); expect(f.folders.get('INBOX')!.get(2)).toEqual(new Set(['\\Deleted']))
  })
  it('uses advertised native MOVE once and returns only verified destination identity', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 MOVE' })
    expect(await f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).toEqual({ sourceUid: 1, sourceUidValidity: 17, sourceUidValidityObserved: true, destinationUid: 23, destinationUidValidity: 41, destinationUidValidityObserved: true })
    expect(f.effects()).toEqual(['UID MOVE 1 "Trash"']); expect(f.folders.get('INBOX')!.has(2)).toBe(true)
  })
  it.each(['NO', 'BAD'] as const)('never retries COPY after failed native MOVE %s even if the server moved the source', async moveStatus => {
    const f = await peer({ moveStatus, applyMoveOnFailure: true })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
    expect(f.effects()).toEqual(['UID MOVE 1 "Trash"']); expect(f.folders.get('INBOX')!.has(1)).toBe(false)
    expect(f.folders.get('Trash')!.has(23)).toBe(true); expect(f.folders.get('INBOX')!.has(2)).toBe(true)
  })
  it('uses a verified COPY followed only by UID STORE and UID EXPUNGE when MOVE is absent', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS' })
    expect(await f.client.moveOrCopyByUid('INBOX', 1, 'Trash', 'move', undefined, 17)).toBe(23)
    expect(f.effects()).toEqual(['UID COPY 1 "Trash"', 'UID STORE 1 +FLAGS.SILENT (\\Deleted)', 'UID EXPUNGE 1'])
    expect(f.folders.get('INBOX')!.has(1)).toBe(false); expect(f.folders.get('INBOX')!.get(2)).toEqual(new Set(['\\Deleted']))
    expect(f.folders.get('Trash')!.has(23)).toBe(true)
  })
  it('refuses unsupported move before copying or marking any source message', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1' })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('keeps COPY as a real copy and preserves its mapped-number legacy return grammar', async () => {
    const f = await peer()
    expect(await f.client.moveOrCopyByUid('INBOX', 1, 'Archive', 'copy', undefined, 17)).toBe(23)
    expect(f.effects()).toEqual(['UID COPY 1 "Archive"']); expect(f.folders.get('INBOX')!.has(1)).toBe(true)
    expect(f.folders.get('Archive')!.has(23)).toBe(true); expect(f.folders.get('INBOX')!.get(2)).toEqual(new Set(['\\Deleted']))
  })
  it('supports an actual singleton UID-set COPYUID without expanding arbitrary ranges', async () => {
    const f = await peer({ copyUidText: '[COPYUID 51 1:1 23:23] copied' })
    expect(await f.client.moveOrCopyByUid('INBOX', 1, 'Archive', 'copy', undefined, 17)).toBe(23)
  })
  it('preserves legitimate same-folder COPY', async () => {
    const f = await peer()
    expect(await f.client.moveOrCopyByUid('INBOX', 1, 'INBOX', 'copy', undefined, 17)).toBe(23)
    expect(f.folders.get('INBOX')!.has(1)).toBe(true); expect(f.folders.get('INBOX')!.has(23)).toBe(true)
  })
  it('never fabricates a mapped UID when a successful base COPY omits COPYUID', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1', copyUidText: null })
    expect(await f.client.moveOrCopyByUid('INBOX', 1, 'Archive', 'copy', undefined, 17)).toBeUndefined()
    expect(f.folders.get('Archive')!.has(23)).toBe(true); expect(f.folders.get('INBOX')!.has(1)).toBe(true)
  })
  it('makes missing destination mapping explicit in the rich native MOVE outcome', async () => {
    const f = await peer({ copyUidText: null })
    expect(await f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).toMatchObject({ destinationUid: null, destinationUidValidity: null, destinationUidValidityObserved: false, unknownOutcome: true, verificationRequired: true })
    expect(f.effects()).toEqual(['UID MOVE 1 "Trash"'])
  })
  it.each([null, '[COPYUID 42 1 23] wrong generation', '[COPYUID 41 2 23] wrong source', '[COPYUID 41 1 23:24] extra destination', '[COPYUID 41 01 23] repaired source', '[COPYUID 4294967296 1 23] out of range'])('never marks the original Deleted without a verified fallback destination: %s', async copyUidText => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS', copyUidText })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
    expect(f.effects()).toEqual(['UID COPY 1 "Trash"']); expect(f.folders.get('INBOX')!.get(1)).toEqual(new Set())
    expect(f.folders.get('INBOX')!.get(2)).toEqual(new Set(['\\Deleted']))
  })
  it('requires the actual mapped target UID to exist before fallback deletion', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS', targetLookupMissing: true })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
    expect(f.effects()).toEqual(['UID COPY 1 "Trash"'])
  })
  it.each([{ expungeStatus: 'NO' as const }, { keepSourceOnExpunge: true }])('does not claim deletion when UID EXPUNGE fails or the UID remains %s', async options => {
    const f = await peer(options)
    await expect(f.client.deleteByUid('INBOX', 1, undefined, 17)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
    expect(f.folders.get('INBOX')!.has(1)).toBe(true); expect(f.folders.get('INBOX')!.has(2)).toBe(true)
    expect(f.commands).not.toContain('EXPUNGE')
  })
  it('does not proceed to UID EXPUNGE when fallback STORE fails', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS', storeStatus: 'NO' })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
    expect(f.effects()).toEqual(['UID COPY 1 "Trash"', 'UID STORE 1 +FLAGS.SILENT (\\Deleted)'])
    expect(f.folders.get('INBOX')!.has(1)).toBe(true); expect(f.folders.get('Trash')!.has(23)).toBe(true)
  })
  it.each([null, '* SEARCH 1junk', '* SEARCH 0', '* SEARCH 01', '* SEARCH 4294967296'])('refuses absent or invalid SEARCH ALL authority %s', async searchAllLine => {
    const f = await peer({ searchAllLine })
    await expect(f.client.searchAllUids('INBOX')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('returns genuinely observed empty SEARCH ALL only under a stable generation', async () => {
    const f = await peer({ emptySource: true })
    expect(await f.client.searchAllUids('INBOX', undefined, 17)).toEqual([])
    expect(f.commands.filter(command => command === 'SELECT "INBOX"')).toHaveLength(2)
  })
  it('uses the same authoritative SEARCH ALL path for an empty UTF-8 query', async () => {
    const f = await peer({ searchAllLine: null })
    await expect(f.client.searchByUtf8Query('INBOX', '   ')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('refuses a changed generation even for genuinely empty SEARCH ALL', async () => {
    const f = await peer({ emptySource: true, resetAfterSearch: true })
    await expect(f.client.searchAllUids('INBOX', undefined, 17)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('enforces the configured SEARCH ALL result bound through the canonical parser', async () => {
    const f = await peer({ maxSearchResults: 1 })
    await expect(f.client.searchAllUids('INBOX')).rejects.toMatchObject({ detail: { reason: 'imap_search_result_limit' } })
    await expect(f.client.selectFolder('INBOX')).rejects.toThrow(/not open|not connected/)
  })
  it.each([null, '* SEARCH 1 2', '* SEARCH 2'])('refuses invalid targeted SEARCH proof before STORE %s', async searchUidLine => {
    const f = await peer({ searchUidLine })
    await expect(f.client.storeFlagsByUid('INBOX', 1, 'add', ['\\Seen'], undefined, 17)).rejects.toThrow()
    expect(f.effects()).toEqual([])
  })
  it('bounds capability results before any mutating command', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY UIDPLUS ' + 'X '.repeat(257) })
    await expect(f.client.deleteByUid('INBOX', 1, undefined, 17)).rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('retains authenticated mailbox isolation before per-message effects', async () => {
    const f = await peer()
    await expect(f.client.deleteByUid('INBOX', 1, 'other@example.test', 17)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('refuses a reused source generation after presence lookup before setting flags', async () => {
    const f = await peer({ resetAfterUidLookup: true })
    await expect(f.client.storeFlagsByUid('INBOX', 1, 'add', ['\\Seen'], undefined, 17)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(f.effects()).toEqual([])
  })
  it('never expunges a reused source UID after the generation changes following STORE', async () => {
    const f = await peer({ resetAfterStore: true })
    await expect(f.client.deleteByUid('INBOX', 1, undefined, 17)).rejects.toMatchObject({ code: 'CONFLICT', detail: { unknownOutcome: true } })
    expect(f.effects()).toEqual(['UID STORE 1 +FLAGS.SILENT (\\Deleted)'])
    expect(f.folders.get('INBOX')!.has(1)).toBe(true); expect(f.folders.get('INBOX')!.has(2)).toBe(true)
  })
  it('keeps a newly reused source UID intact when generation changes after fallback COPY', async () => {
    const f = await peer({ capabilityLine: '* CAPABILITY IMAP4rev1 UIDPLUS', resetSourceAfterCopy: true })
    await expect(f.client.moveOrCopyByUidWithIdentity('INBOX', 1, 'Trash', 'move', 17)).rejects.toMatchObject({ code: 'CONFLICT', detail: { unknownOutcome: true } })
    expect(f.effects()).toEqual(['UID COPY 1 "Trash"'])
    expect(f.folders.get('INBOX')!.has(1)).toBe(true); expect(f.folders.get('Trash')!.has(23)).toBe(true)
  })
})
