import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapProtocolClient } from './imap.ts'

// Real loopback wire protocol with a declared synthetic IMAP peer. This does not
// authenticate a native mailbox or qualify a deployed service.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const outcomes = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Synthetic IMAP peer cleanup failed')
})

async function peer(options: { validity?: string | null; advertised?: boolean; literal?: Buffer; declaredBytes?: number; resetOnSelect?: boolean; closeOnSelect?: boolean; appendStatusText?: string; moveStatus?: 'OK' | 'NO' | 'BAD'; moveStatusText?: string; moveUntagged?: string; searchResponse?: string | null; maxLiteralBytes?: number; maxResponseLineBytes?: number; maxSearchResults?: number; omitSize?: boolean; advertisedSize?: number; bodySection?: string; attributePrefix?: string } = {}) {
  const sockets = new Set<Socket>()
  const received: Buffer[] = []
  let active: Socket | undefined
  const literal = options.literal ?? Buffer.from('From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Wire fixture\r\n\r\nSynthetic body\r\n')
  const server = createServer(socket => {
    sockets.add(socket); active = socket
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.write('* OK synthetic IMAP peer\r\n')
    let input = '', appendTag: string | null = null, searchTag: string | null = null, selected = 'INBOX', moved = false
    socket.on('data', chunk => {
      received.push(Buffer.from(chunk))
      input += chunk.toString('utf8')
      for (;;) {
        const end = input.indexOf('\r\n')
        if (end < 0) break
        const line = input.slice(0, end); input = input.slice(end + 2)
        if (appendTag) { socket.write(appendTag + ' OK ' + (options.appendStatusText ?? '[APPENDUID 17 23] stored') + '\r\n'); appendTag = null; continue }
        if (searchTag) { socket.write((options.searchResponse === null ? '' : (options.searchResponse ?? '* SEARCH 1 9') + '\r\n') + searchTag + ' OK searched\r\n'); searchTag = null; continue }
        const separator = line.indexOf(' '), tag = line.slice(0, separator), command = line.slice(separator + 1)
        if (command.startsWith('LOGIN ')) socket.write(tag + ' OK logged in\r\n')
        else if (command === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 MOVE\r\n' + tag + ' OK capabilities\r\n')
        else if (command.startsWith('SELECT ')) {
          if (options.resetOnSelect) { socket.resetAndDestroy(); return }
          if (options.closeOnSelect) { socket.end(); return }
          selected = /^SELECT "([^"]+)"/.exec(command)?.[1] ?? 'INBOX'
          socket.write('* ' + (selected === 'Trash' ? (moved ? 1 : 0) : (moved ? 0 : 1)) + ' EXISTS\r\n')
          if (options.validity !== null || selected === 'Trash') socket.write((options.advertised === false ? '* OK informational text ' : '* OK ') + '[UIDVALIDITY ' + (selected === 'Trash' ? '41' : (options.validity ?? '17')) + '] synthetic\r\n')
          socket.write(tag + ' OK selected\r\n')
        } else if (command.startsWith('APPEND ')) { appendTag = tag; socket.write('+ ready for synthetic literal\r\n') }
        else if (command.startsWith('UID MOVE ')) {
          if ((options.moveStatus ?? 'OK') === 'OK') moved = true
          socket.write((options.moveUntagged ? options.moveUntagged + '\r\n' : '') + tag + ' ' + (options.moveStatus ?? 'OK') + ' ' + (options.moveStatusText ?? '[COPYUID 41 1 23] moved') + '\r\n')
        } else if (/^UID SEARCH UID [1-9][0-9]*$/.test(command)) {
          const uid = Number(command.slice('UID SEARCH UID '.length)), present = selected === 'Trash' ? moved && uid === 23 : !moved && uid === 1
          socket.write('* SEARCH' + (present ? ' ' + uid : '') + '\r\n' + tag + ' OK searched\r\n')
        } else if (command === 'UID SEARCH ALL') socket.write((options.searchResponse === null ? '' : (options.searchResponse ?? '* SEARCH 1 9') + '\r\n') + tag + ' OK searched\r\n')
        else if (command.startsWith('UID SEARCH ')) { searchTag = tag; socket.write('+ ready for synthetic search\r\n') }
        else if (command.startsWith('UID FETCH ')) {
          const count = options.declaredBytes ?? literal.length
          socket.write('* 1 FETCH (' + (options.attributePrefix ?? '') + 'UID 1 FLAGS () ' + (options.omitSize ? '' : 'RFC822.SIZE ' + (options.advertisedSize ?? count) + ' ') + (options.bodySection ?? 'BODY[]') + ' {' + count + '}\r\n')
          if (options.declaredBytes === undefined) {
            socket.write(literal); socket.write(')\r\n' + tag + ' OK fetched\r\n')
          }
        } else if (command === 'LOGOUT') socket.end('* BYE\r\n' + tag + ' OK logout\r\n')
        else socket.write(tag + ' BAD unsupported synthetic command\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  cleanup.push(() => new Promise((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic IMAP peer has no TCP address')
  const client = new ImapProtocolClient({ host: '127.0.0.1', port: address.port, timeoutMs: 500, maxLiteralBytes: options.maxLiteralBytes ?? (options.declaredBytes === undefined ? literal.length : 32),
    maxResponseLineBytes: options.maxResponseLineBytes, maxSearchResults: options.maxSearchResults })
  cleanup.push(() => client.logout())
  await client.connect(); await client.login('reader@example.test', 'synthetic-wire-password')
  return { client, literal, received, drop: () => active?.resetAndDestroy(), pushUntilClosed: (bytes: Buffer) => new Promise<void>((resolve, reject) => {
    if (!active) return reject(new Error('Synthetic peer has no active socket'))
    active.once('close', () => resolve()); active.write(bytes)
  }) }
}

describe('bounded search IMAP identity and socket boundaries', () => {
  it('observes an actual valid SELECT UIDVALIDITY', async () => {
    const f = await peer()
    expect(await f.client.selectFolder('INBOX')).toMatchObject({ uidValidity: 17, uidValidityObserved: true })
  })
  it.each([{ validity: null, expected: 1 }, { validity: '0', expected: 0 }, { validity: '4294967296', expected: 4294967296 }, { validity: '17', advertised: false, expected: 17 }])('does not qualify missing/invalid/informational identity $validity', async options => {
    const f = await peer(options)
    expect(await f.client.selectFolder('INBOX')).toMatchObject({ uidValidity: options.expected, uidValidityObserved: false })
  })
  it('refuses a declared oversized literal before waiting for literal content', async () => {
    const f = await peer({ declaredBytes: 1000000 })
    await expect(f.client.fetchMessagesByUid('INBOX', 1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'imap_literal_limit' } })
    await expect(f.client.selectFolder('INBOX')).rejects.toThrow(/not open|not connected/)
  })
  it('accepts an exactly bounded literal and preserves the authoritative bytes', async () => {
    const literal = Buffer.concat([Buffer.from('From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Raw bytes\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'), Buffer.from([0x41, 0xe9, 0xff, 0x0d, 0x0a])])
    const f = await peer({ literal })
    const fetched = await f.client.fetchMessagesByUid('INBOX', 1)
    expect(fetched.messages[0]?.rawMimeBytes).toEqual(literal)
    expect(fetched.messages[0]).toMatchObject({ rfc822SizeObserved: true, bodyComplete: true, sizeBytes: literal.byteLength })
    expect(fetched.state.uidValidityObserved).toBe(true)
  })
  it('uses actual raw byte size without qualifying absent RFC822.SIZE metadata', async () => {
    const literal = Buffer.concat([Buffer.from('From: sender@example.test\r\nTo: reader@example.test\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'), Buffer.from([0xff, 0xe9, 0x0d, 0x0a])])
    const f = await peer({ literal, omitSize: true }), fetched = await f.client.fetchMessagesByUid('INBOX', 1)
    expect(fetched.messages[0]?.rawMimeBytes).toEqual(literal)
    expect(fetched.messages[0]).toMatchObject({ sizeBytes: literal.byteLength, rfc822SizeObserved: false, bodyComplete: false })
    expect(Buffer.byteLength(fetched.messages[0]!.rawMime, 'utf8')).toBeGreaterThan(literal.byteLength)
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('refuses an invalid trusted literal limit %s', maxLiteralBytes => {
    expect(() => new ImapProtocolClient({ host: '127.0.0.1', port: 143, maxLiteralBytes })).toThrow()
  })
  it.each([{ resetOnSelect: true }, { closeOnSelect: true }])('rejects an active read after socket loss %s', async options => {
    const f = await peer(options)
    await expect(f.client.selectFolder('INBOX')).rejects.toThrow(/IMAP/)
  })
  it('handles socket loss after authentication without unhandled error or fake success', async () => {
    const f = await peer(); f.drop()
    await expect(f.client.selectFolder('INBOX')).rejects.toThrow(/IMAP/)
  })
  it.each([
    { status: '[APPENDUID 17 23] stored', uid: 23, validity: 17 },
    { status: 'stored without UIDPLUS', uid: null, validity: null },
    { status: '[APPENDUID 0 23] stored', uid: null, validity: null },
    { status: '[APPENDUID 17 0] stored', uid: null, validity: null },
    { status: '[APPENDUID 4294967296 23] stored', uid: null, validity: null },
    { status: '[APPENDUID 17 23:24] stored', uid: null, validity: null },
    { status: '[APPENDUID 17 00023] stored', uid: null, validity: null },
    { status: 'informational [APPENDUID 17 23] text', uid: null, validity: null },
  ])('retains only a valid server APPENDUID identity: $status', async value => {
    const f = await peer({ appendStatusText: value.status })
    expect(await f.client.appendMessage('Drafts', 'fixture', ['\\Draft'])).toMatchObject({ appendedUid: value.uid, appendedUidValidity: value.validity })
  })
  it.each([{ response: '* SEARCH', uids: [] }, { response: '* SEARCH 4294967295 2', uids: [4294967295, 2] }])('accepts an actually observed SEARCH collection $response', async value => {
    const f = await peer({ searchResponse: value.response })
    expect(await f.client.searchByUtf8Query('INBOX', 'fixture')).toEqual(value.uids)
  })
  it.each([null, '* SEARCH 1junk', '* SEARCH 0', '* SEARCH 01', '* SEARCH 4294967296'])('refuses a missing or malformed SEARCH identity %s', async searchResponse => {
    const f = await peer({ searchResponse })
    await expect(f.client.searchByUtf8Query('INBOX', 'fixture')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('accepts an exactly bounded response line and result count', async () => {
    const f = await peer({ searchResponse: '* SEARCH 1 2 3'.padEnd(64, ' '), maxResponseLineBytes: 64, maxSearchResults: 3 })
    expect(await f.client.searchByUtf8Query('INBOX', 'fixture')).toEqual([1, 2, 3])
  })
  it('refuses an overlong response line before tokenizing its results', async () => {
    const f = await peer({ searchResponse: '* SEARCH 1'.padEnd(65, ' '), maxResponseLineBytes: 64 })
    await expect(f.client.searchByUtf8Query('INBOX', 'fixture')).rejects.toMatchObject({ detail: { reason: 'imap_response_line_limit' } })
  })
  it('refuses excess SEARCH identities before growing the result array', async () => {
    const f = await peer({ searchResponse: '* SEARCH 1 2 3 4', maxResponseLineBytes: 64, maxSearchResults: 3 })
    await expect(f.client.searchByUtf8Query('INBOX', 'fixture')).rejects.toMatchObject({ detail: { reason: 'imap_search_result_limit' } })
  })
  it('closes an idle connection before unsolicited data exceeds the combined pending bound', async () => {
    const f = await peer({ maxLiteralBytes: 32, maxResponseLineBytes: 64 })
    await f.pushUntilClosed(Buffer.alloc(99, 0x78))
    await expect(f.client.selectFolder('INBOX')).rejects.toThrow(/not open|not connected/)
  })
  it.each([0, -1, Number.NaN, 1.5])('validates trusted line/result limits %s', value => {
    for (const field of ['maxResponseLineBytes', 'maxSearchResults']) expect(() => new ImapProtocolClient({ host: '127.0.0.1', port: 143, [field]: value })).toThrow()
  })
  it.each([{ omitSize: true }, { advertisedSize: 1 }, { bodySection: 'BODY[HEADER]' }, { bodySection: 'BODY[]<0>' }])('does not invent complete-source proof from missing/mismatched/partial attributes %s', async options => {
    const f = await peer(options), fetched = await f.client.fetchMessagesByUid('INBOX', 1)
    expect(fetched.messages[0]?.bodyComplete).toBe(false)
    if (options.omitSize) {
      expect(fetched.messages[0]?.rfc822SizeObserved).toBe(false)
      expect(fetched.messages[0]?.sizeBytes).toBe(f.literal.byteLength)
    }
  })
  it('never uses quoted/nested words as UID or source-size attributes', async () => {
    const f = await peer({ attributePrefix: 'FLAGS (UID 99) BODYSTRUCTURE ("APPLICATION" "PDF" ("NAME" "UID 999 RFC822.SIZE 0 BODY[]") NIL NIL "8BIT" 5) ' })
    const fetched = await f.client.fetchMessagesByUid('INBOX', 1)
    expect(fetched.messages[0]).toMatchObject({ uid: 1, sizeBytes: f.literal.byteLength, rfc822SizeObserved: true, bodyComplete: true })
  })
  it('sends UTF-8 query bytes with their byte count as an IMAP literal', async () => {
    const f = await peer(), query = 'فاتورة 42'
    await f.client.searchByUtf8Query('INBOX', query)
    const bytes = Buffer.concat(f.received)
    expect(bytes.includes(Buffer.from(query, 'utf8'))).toBe(true)
    expect(bytes.includes(Buffer.from('TEXT {' + Buffer.byteLength(query, 'utf8') + '}'))).toBe(true)
  })
  it.each([{ moveStatusText: '[COPYUID 41 1 23] moved' }, { moveUntagged: '* OK [COPYUID 41 1 23] moved', moveStatusText: 'done' }])('observes the exact native MOVE mapping %s', async options => {
    const f = await peer(options)
    expect(await f.client.moveByUidWithIdentity('Drafts', 1, 'Trash', 17, 'reader@example.test')).toEqual({ sourceUid: 1, destinationUid: 23, destinationUidValidity: 41 })
    expect(Buffer.concat(f.received).toString()).not.toMatch(/UID COPY|UID STORE|EXPUNGE/)
  })
  it.each(['NO', 'BAD'] as const)('never falls back to global EXPUNGE after rejected native MOVE %s', async moveStatus => {
    const f = await peer({ moveStatus })
    await expect(f.client.moveByUidWithIdentity('Drafts', 1, 'Trash', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true } })
    expect(Buffer.concat(f.received).toString()).not.toMatch(/UID COPY|UID STORE|EXPUNGE/)
  })
  it.each(['done', 'informational [COPYUID 41 1 23]', '[COPYUID 0 1 23] moved', '[COPYUID 41 2 23] moved', '[COPYUID 41 01 23] moved', '[COPYUID 41 1 23:24] moved', '[COPYUID 4294967296 1 23] moved'])('refuses unobserved or malformed MOVE mapping %s', async moveStatusText => {
    const f = await peer({ moveStatusText })
    await expect(f.client.moveByUidWithIdentity('Drafts', 1, 'Trash', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true } })
  })
  it('refuses conflicting observed MOVE maps', async () => {
    const f = await peer({ moveUntagged: '* OK [COPYUID 41 1 24] moved' })
    await expect(f.client.moveByUidWithIdentity('Drafts', 1, 'Trash', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it.each([{ validity: null }, { validity: '18' }])('refuses missing or stale source identity before native MOVE %s', async options => {
    const f = await peer(options)
    await expect(f.client.moveByUidWithIdentity('Drafts', 1, 'Trash', 17)).rejects.toThrow()
    expect(Buffer.concat(f.received).toString()).not.toContain('UID MOVE')
  })
})
