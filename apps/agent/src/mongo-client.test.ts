import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { MongoCommandError, connectMongo, decodeBson, encodeBson, encodeMessage, scramClient } from './mongo-client.ts'
import type { BsonDoc } from './mongo-client.ts'

const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0)) close() })
const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest()
const sha = (data: Buffer): Buffer => createHash('sha256').update(data).digest()

/** An OP_MSG server that checks real SCRAM-SHA-256 proofs, so the client is tested against the RFC arithmetic. */
async function fakeMongod(password: string): Promise<number> {
  const salt = randomBytes(16), rounds = 4096, salted = pbkdf2Sync(password, salt, rounds, 32, 'sha256')
  const server = createServer((socket: Socket) => {
    let bare = '', first = '', authenticated = false, buffer: Buffer = Buffer.alloc(0)
    const reply = (to: number, doc: BsonDoc): void => { const message = encodeMessage(1, doc); message.writeInt32LE(to, 8); socket.write(message) }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0)) {
        const id = buffer.readInt32LE(4), doc = decodeBson(buffer, 21)
        buffer = buffer.subarray(buffer.readInt32LE(0))
        if (doc.saslStart) {
          bare = (doc.payload as Buffer).toString().slice(3)
          first = `r=${bare.split('r=')[1]}server,s=${salt.toString('base64')},i=${rounds}`
          reply(id, { ok: 1, conversationId: 7, done: false, payload: Buffer.from(first) })
        } else if (doc.saslContinue && !authenticated) {
          const final = (doc.payload as Buffer).toString(), without = final.slice(0, final.lastIndexOf(',p=')), proof = Buffer.from(final.slice(final.lastIndexOf(',p=') + 3), 'base64')
          const message = `${bare},${first},${without}`, clientKey = hmac(salted, 'Client Key'), signature = hmac(sha(clientKey), message)
          if (!Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]!)).equals(proof)) { reply(id, { ok: 0, code: 18, codeName: 'AuthenticationFailed', errmsg: 'Authentication failed.' }); continue }
          authenticated = true
          reply(id, { ok: 1, conversationId: 7, done: true, payload: Buffer.from('v=' + hmac(hmac(salted, 'Server Key'), message).toString('base64')) })
        } else if (doc.listDatabases && !authenticated) reply(id, { ok: 0, code: 13, codeName: 'Unauthorized', errmsg: 'requires authentication' })
        else reply(id, { ok: 1, databases: [{ name: 'shop', sizeOnDisk: 8192, empty: false }], totalSize: 8192 })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return (server.address() as AddressInfo).port
}

describe('BSON', () => {
  it('keeps every type the commands use', () => {
    const doc: BsonDoc = { text: 'سلام', int: 5, big: 2 ** 40, ok: 1.5, yes: true, none: null, list: ['a', 2], nested: { a: { b: 'c' } }, bin: Buffer.from([1, 2, 3]) }
    const back = decodeBson(encodeBson(doc))
    expect(back).toEqual(doc)
  })
  it('reads the types replies carry', () => {
    const body = Buffer.concat([Buffer.from([0x12]), Buffer.from('n\0'), Buffer.from(Int32Array.of(5, 0).buffer), Buffer.from([0x11]), Buffer.from('t\0'), Buffer.alloc(8), Buffer.from([0x07]), Buffer.from('o\0'), Buffer.alloc(12, 0xab)])
    const head = Buffer.alloc(4); head.writeInt32LE(body.length + 5)
    expect(decodeBson(Buffer.concat([head, body, Buffer.from([0])]))).toEqual({ n: 5, t: 0, o: 'ab'.repeat(12) })
  })
})

describe('SCRAM', () => {
  it('matches the RFC 7677 test vector', () => {
    const client = scramClient('user', 'pencil', 'rOprNGfwEbeRWgbNEkqO')
    expect(client.first).toBe('n,,n=user,r=rOprNGfwEbeRWgbNEkqO')
    const answer = client.respond('r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096')
    expect(answer.final).toBe('c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=')
    expect(answer.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')).toBe(true)
    expect(answer.verify('v=AAAA')).toBe(false)
  })
  it('refuses a server nonce that does not extend its own', () => {
    expect(() => scramClient('user', 'pencil', 'abc').respond('r=xyz,s=AAAA,i=4096')).toThrow('invalid_scram_challenge')
  })
})

describe('connection', () => {
  it('signs in and runs commands', async () => {
    const port = await fakeMongod('right-password')
    const client = await connectMongo({ host: '127.0.0.1', port, credential: { user: 'xpanel-admin', password: 'right-password' } })
    const reply = await client.command('admin', { listDatabases: 1 })
    expect((reply.databases as BsonDoc[])[0]).toMatchObject({ name: 'shop', sizeOnDisk: 8192 })
    client.close()
  })
  it('fails a wrong password and an unauthenticated list', async () => {
    const port = await fakeMongod('right-password')
    await expect(connectMongo({ host: '127.0.0.1', port, credential: { user: 'xpanel-admin', password: 'wrong' } })).rejects.toBeInstanceOf(MongoCommandError)
    const anonymous = await connectMongo({ host: '127.0.0.1', port, credential: null })
    await expect(anonymous.command('admin', { listDatabases: 1 })).rejects.toMatchObject({ code: 13 })
    anonymous.close()
  })
})
