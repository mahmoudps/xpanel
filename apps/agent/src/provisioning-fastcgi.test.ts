import { describe, expect, it } from 'vitest'
import { FASTCGI, CANARY_PHP_ADMIN_VALUE, FastCgiDecoder, assertCanaryIngress, fastCgiCanaryRequest, fastCgiParams, fastCgiRecord, matchesCanaryAdmission, matchesCanaryCallback, parseFastCgiParams } from './provisioning-fastcgi.ts'
import { canaryHttpPeerInode, type HeldHttpConnection } from './account-provisioning-http-source.ts'
import { Socket } from 'node:net'
import { waitForNativeSocketConnect } from './account-provisioning-http.ts'

const challenge = 'a'.repeat(64), binding = 'b'.repeat(64), admission = 'c'.repeat(64)
const ingress = () => new Map(Object.entries({ REQUEST_METHOD: 'GET', SCRIPT_NAME: '/.well-known/xpanel-provisioning', REQUEST_URI: '/.well-known/xpanel-provisioning',
  SERVER_NAME: 'example.test', HTTP_HOST: 'example.test', CONTENT_LENGTH: '0', HTTP_X_XPANEL_PROBE_ADMISSION: admission }))
describe('bounded private canary protocol', { tags: ['unit'] }, () => {
  it('retains a fragmented binary frame until its complete record arrives', () => {
    const bytes = fastCgiRecord(FASTCGI.stdout, 7, Buffer.from('value')), decoder = new FastCgiDecoder()
    expect(decoder.push(bytes.subarray(0, 5))).toEqual([])
    expect(decoder.push(bytes.subarray(5))).toEqual([{ type: FASTCGI.stdout, requestId: 7, content: Buffer.from('value') }])
    expect(() => decoder.finish()).not.toThrow()
  })
  it('refuses a truncated record rather than treating EOF as successful completion', () => {
    const decoder = new FastCgiDecoder(); decoder.push(fastCgiRecord(FASTCGI.stdout, 1, Buffer.from('data')).subarray(0, 9))
    expect(() => decoder.finish()).toThrow()
  })
  it('refuses a management record, invalid version and reserved header byte', () => {
    for (const index of [0, 2, 7]) {
      const bytes = fastCgiRecord(FASTCGI.stdout, 1); bytes[index] = index === 0 ? 2 : index === 7 ? 1 : 0
      if (index === 2) bytes[3] = 0
      expect(() => new FastCgiDecoder().push(bytes)).toThrow()
    }
  })
  it('refuses an unbounded response and oversized record', () => {
    expect(() => new FastCgiDecoder().push(Buffer.alloc(32769))).toThrow()
    expect(() => fastCgiRecord(FASTCGI.stdout, 1, Buffer.alloc(16385))).toThrow()
  })
  it('round-trips bounded long-form lengths and rejects duplicate parameter names', () => {
    const encoded = fastCgiParams({ HTTP_HOST: 'x'.repeat(128) })
    expect(parseFastCgiParams(encoded).get('HTTP_HOST')).toBe('x'.repeat(128))
    expect(() => parseFastCgiParams(Buffer.concat([encoded, encoded]))).toThrow()
  })
  it('refuses malformed UTF-8, truncated lengths and injected newline values', () => {
    for (const bytes of [Buffer.from([0x80]), Buffer.from([1, 1, 65, 0xff]), Buffer.from([1, 1, 65, 10])]) expect(() => parseFastCgiParams(bytes)).toThrow()
    expect(() => fastCgiParams({ HTTP_HOST: 'example.test\nPHP_VALUE=x' })).toThrow()
  })
  it('builds one responder request using fixed admin settings and no admission secret', () => {
    const decoder = new FastCgiDecoder(), records = decoder.push(fastCgiCanaryRequest('/home/alice/.xpanel-probe/probe.php', '/.well-known/xpanel-provisioning', 'example.test', challenge, binding))
    expect(records.map(record => record.type)).toEqual([FASTCGI.begin, FASTCGI.params, FASTCGI.params, FASTCGI.stdin])
    expect(records.every(record => record.requestId === 1)).toBe(true)
    const params = records[1]
    if (!params) throw new Error('missing outgoing params')
    const source = params.content.toString('utf8')
    expect(source).toContain(CANARY_PHP_ADMIN_VALUE)
    expect(source).toContain('opcache.enable=0')
    expect(source).not.toContain('HTTP_X_XPANEL_PROBE_ADMISSION')
    expect(source).not.toContain(admission)
  })
  it('refuses arbitrary multiline admin directives even on the private encoder', () => {
    expect(() => fastCgiParams({ PHP_ADMIN_VALUE: 'auto_prepend_file=/home/alice/evil.php\n' })).toThrow()
    expect(() => fastCgiParams({ PHP_VALUE: CANARY_PHP_ADMIN_VALUE })).toThrow()
  })
  it('admits only the exact compiled ingress request and existing host', () => {
    expect(() => assertCanaryIngress(ingress(), 'example.test')).not.toThrow()
    const emptyLength = ingress(); emptyLength.set('CONTENT_LENGTH', '')
    expect(() => assertCanaryIngress(emptyLength, 'example.test')).not.toThrow()
  })
  it('refuses changed method, target, host, content and injected script authority', () => {
    const mutations: Array<readonly [string, string]> = [['REQUEST_METHOD', 'POST'], ['SCRIPT_NAME', '/index.php'], ['REQUEST_URI', '/.well-known/xpanel-provisioning?nonce=x'],
      ['SERVER_NAME', 'foreign.test'], ['HTTP_HOST', 'foreign.test'], ['CONTENT_LENGTH', '1'], ['SCRIPT_FILENAME', '/home/alice/evil.php'], ['PHP_ADMIN_VALUE', 'x']]
    for (const [name, value] of mutations) {
      const values = ingress(); values.set(name, value)
      expect(() => assertCanaryIngress(values, 'example.test')).toThrow()
    }
  })
  it('compares admission as an exact nonempty private nonce', () => {
    expect(matchesCanaryAdmission(admission, admission)).toBe(true)
    for (const value of [undefined, '', challenge, admission.toUpperCase(), 'c'.repeat(63)]) expect(matchesCanaryAdmission(value, admission)).toBe(false)
  })
  it('accepts only the immutable canary frame and not a reported process identity', () => {
    const frame = JSON.stringify({ schemaVersion: 1, challenge, binding }) + '\n'
    expect(matchesCanaryCallback(Buffer.from(frame), challenge, binding)).toBe(true)
    for (const value of [frame + '\n', frame.replace(challenge, admission), frame.replace(binding, admission), frame.replace('"schemaVersion":1', '"schemaVersion":"1"'),
      frame.replace('}', ',"pid":123}'), frame.replace('}', ',"challenge":"' + challenge + '"}')]) expect(matchesCanaryCallback(Buffer.from(value), challenge, binding)).toBe(false)
  })
  const connection: HeldHttpConnection = { fd: 7, localAddress: '127.0.0.1', localPort: 40000, remoteAddress: '127.0.0.1', remotePort: 80 }
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
  const clientRow = '0: 0100007F:9C40 0100007F:0050 01 00000000:00000000 00:00000000 00000000 0 0 101 1\n'
  const serverRow = '1: 0100007F:0050 0100007F:9C40 01 00000000:00000000 00:00000000 00000000 0 0 202 1\n'
  it('binds the live held HTTP client inode to the exact reverse kernel TCP tuple', () => {
    expect(canaryHttpPeerInode(header + clientRow + serverRow, '101', connection)).toBe('202')
  })
  it('refuses a different Root HTTP socket or a second-request relay tuple', () => {
    expect(() => canaryHttpPeerInode(header + clientRow + serverRow, '303', connection)).toThrow()
    expect(() => canaryHttpPeerInode(header + clientRow + serverRow.replace('9C40', '9C41'), '101', connection)).toThrow()
  })
  it('refuses closed, duplicated and truncated TCP peer records', () => {
    for (const text of [header + clientRow + serverRow.replace(' 01 ', ' 08 '), header + clientRow + serverRow + serverRow,
      header + clientRow + '1: malformed\n', header + clientRow + serverRow.replace(' 202 ', ' 0 ')]) expect(() => canaryHttpPeerInode(text, '101', connection)).toThrow()
  })
  it('refuses non-kernel headers, unsupported IPv6 and excessive observation input', () => {
    expect(() => canaryHttpPeerInode(clientRow + serverRow, '101', connection)).toThrow()
    expect(() => canaryHttpPeerInode(header + clientRow + serverRow, '101', { ...connection, localAddress: '::1' })).toThrow()
    expect(() => canaryHttpPeerInode('x'.repeat(2097153), '101', connection)).toThrow()
  })
  it('settles a pending connect when destroy closes it without an error event', async () => {
    const socket = new Socket(), controller = new AbortController()
    const connected = waitForNativeSocketConnect(socket, controller.signal, performance.now() + 1000)
    socket.destroy()
    await expect(connected).rejects.toThrow('closed before connect')
    expect(socket.listenerCount('connect')).toBe(0)
  })
  it('settles and destroys a pending connect on caller cancellation', async () => {
    const socket = new Socket(), controller = new AbortController()
    const connected = waitForNativeSocketConnect(socket, controller.signal, performance.now() + 1000)
    controller.abort()
    await expect(connected).rejects.toThrow('connect cancelled')
    expect(socket.destroyed).toBe(true)
  })
  it('rejects an already elapsed connect deadline without waiting for a socket error', async () => {
    const socket = new Socket()
    await expect(waitForNativeSocketConnect(socket, new AbortController().signal, performance.now() - 1)).rejects.toThrow('connect deadline')
    expect(socket.destroyed).toBe(true)
  })
  it('propagates operation-failure cancellation and retires connect listeners exactly once', async () => {
    const socket = new Socket(), caller = new AbortController(), operation = new AbortController()
    const connected = waitForNativeSocketConnect(socket, AbortSignal.any([caller.signal, operation.signal]), performance.now() + 1000)
    operation.abort(); caller.abort()
    await expect(connected).rejects.toThrow('connect cancelled')
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })
})
