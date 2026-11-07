import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

/**
 * Small MongoDB client: OP_MSG, the BSON types its command replies use, and SCRAM-SHA-256. mongosh is a separate
 * vendor package that starts a Node process per command, and it reads a password only from argv or a prompt.
 */
export type BsonValue = string | number | boolean | null | Date | Buffer | BsonValue[] | { [key: string]: BsonValue }
export type BsonDoc = { [key: string]: BsonValue }
export class MongoCommandError extends Error {
  readonly code: number
  readonly codeName: string
  constructor(message: string, code: number, codeName: string) { super(message); this.code = code; this.codeName = codeName }
}
const MAX_MESSAGE = 16 * 1024 * 1024
const OP_MSG = 2013

const encodeValue = (key: string, value: BsonValue): Buffer => {
  const name = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])])
  const entry = (type: number, ...body: Buffer[]): Buffer => Buffer.concat([Buffer.from([type]), name, ...body])
  const int32 = (number: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(number); return bytes }
  if (value === null) return entry(0x0a)
  if (typeof value === 'boolean') return entry(0x08, Buffer.from([value ? 1 : 0]))
  if (typeof value === 'string') { const bytes = Buffer.from(value, 'utf8'); return entry(0x02, int32(bytes.length + 1), bytes, Buffer.from([0])) }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) return entry(0x10, int32(value))
    const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); return entry(0x01, bytes)
  }
  if (Buffer.isBuffer(value)) return entry(0x05, int32(value.length), Buffer.from([0]), value)
  if (Array.isArray(value)) return entry(0x04, encodeBson(Object.fromEntries(value.map((item, index) => [String(index), item]))))
  if (value instanceof Date) { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(value.getTime())); return entry(0x09, bytes) }
  return entry(0x03, encodeBson(value))
}
export function encodeBson(doc: BsonDoc): Buffer {
  const body = Buffer.concat(Object.entries(doc).map(([key, value]) => encodeValue(key, value)))
  const head = Buffer.alloc(4); head.writeInt32LE(body.length + 5)
  return Buffer.concat([head, body, Buffer.from([0])])
}
export function decodeBson(buffer: Buffer, start = 0): BsonDoc {
  const doc: BsonDoc = {}, end = start + buffer.readInt32LE(start) - 1
  let at = start + 4
  while (at < end) {
    const type = buffer[at++]!, stop = buffer.indexOf(0, at), key = buffer.toString('utf8', at, stop)
    at = stop + 1
    switch (type) {
      case 0x01: doc[key] = buffer.readDoubleLE(at); at += 8; break
      case 0x02: { const size = buffer.readInt32LE(at); doc[key] = buffer.toString('utf8', at + 4, at + 3 + size); at += 4 + size; break }
      case 0x03: case 0x04: {
        const size = buffer.readInt32LE(at), inner = decodeBson(buffer, at)
        doc[key] = type === 0x04 ? Object.values(inner) : inner
        at += size
        break
      }
      case 0x05: { const size = buffer.readInt32LE(at); doc[key] = Buffer.from(buffer.subarray(at + 5, at + 5 + size)); at += 5 + size; break }
      case 0x07: doc[key] = buffer.toString('hex', at, at + 12); at += 12; break
      case 0x08: doc[key] = buffer[at++] === 1; break
      case 0x09: doc[key] = new Date(Number(buffer.readBigInt64LE(at))); at += 8; break
      case 0x0a: doc[key] = null; break
      case 0x10: doc[key] = buffer.readInt32LE(at); at += 4; break
      case 0x11: doc[key] = Number(buffer.readBigUInt64LE(at)); at += 8; break
      case 0x12: doc[key] = Number(buffer.readBigInt64LE(at)); at += 8; break
      default: throw new Error('unsupported_bson_type')
    }
  }
  return doc
}
export function encodeMessage(requestId: number, doc: BsonDoc): Buffer {
  const body = encodeBson(doc), head = Buffer.alloc(21)
  head.writeInt32LE(21 + body.length, 0); head.writeInt32LE(requestId, 4); head.writeInt32LE(0, 8); head.writeInt32LE(OP_MSG, 12); head.writeUInt32LE(0, 16); head[20] = 0
  return Buffer.concat([head, body])
}

// RFC 5802 and RFC 7677. MongoDB sends the password through SASLprep; only generated and validated ASCII passwords reach here.
const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest()
const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()
const fields = (text: string): Record<string, string> => Object.fromEntries(text.split(',').map(part => [part[0]!, part.slice(2)]))
export interface ScramStep { first: string; respond(serverFirst: string): { final: string; verify(serverFinal: string): boolean } }
export function scramClient(user: string, password: string, nonce = randomBytes(24).toString('base64')): ScramStep {
  const name = user.replaceAll('=', '=3D').replaceAll(',', '=2C'), bare = `n=${name},r=${nonce}`
  return {
    first: 'n,,' + bare,
    respond(serverFirst) {
      const { r, s, i } = fields(serverFirst), rounds = Number(i)
      if (!r?.startsWith(nonce) || !s || !Number.isInteger(rounds) || rounds < 4096) throw new Error('invalid_scram_challenge')
      const salted = pbkdf2Sync(password, Buffer.from(s, 'base64'), rounds, 32, 'sha256')
      const clientKey = hmac(salted, 'Client Key'), without = `c=biws,r=${r}`, message = `${bare},${serverFirst},${without}`
      const signature = hmac(sha256(clientKey), message), proof = clientKey.map((byte, index) => byte ^ signature[index]!)
      return {
        final: `${without},p=${Buffer.from(proof).toString('base64')}`,
        verify: serverFinal => { const v = Buffer.from(fields(serverFinal).v ?? '', 'base64'), expected = hmac(hmac(salted, 'Server Key'), message); return v.length === expected.length && timingSafeEqual(v, expected) },
      }
    },
  }
}

export interface MongoClient { command(database: string, doc: BsonDoc): Promise<BsonDoc>; close(): void }
export interface MongoCredential { user: string; password: string }

export function connectMongo(input: { host: string; port: number; credential: MongoCredential | null; timeoutMs?: number }): Promise<MongoClient> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: input.host, port: input.port })
    let buffer: Buffer = Buffer.alloc(0), id = 0
    const waiting = new Map<number, { resolve(doc: BsonDoc): void; reject(error: Error): void }>()
    const stop = (error: Error): void => { for (const item of waiting.values()) item.reject(error); waiting.clear(); socket.destroy() }
    socket.setTimeout(input.timeoutMs ?? 10_000, () => stop(new Error('mongodb_timeout')))
    socket.on('error', error => { stop(error); reject(error) })
    socket.on('close', () => stop(new Error('mongodb_closed')))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0)) {
          const size = buffer.readInt32LE(0)
          if (size < 21 || size > MAX_MESSAGE || buffer.readInt32LE(12) !== OP_MSG) throw new Error('invalid_mongodb_reply')
          const replyTo = buffer.readInt32LE(8), doc = decodeBson(buffer, 21), item = waiting.get(replyTo)
          buffer = buffer.subarray(size)
          waiting.delete(replyTo)
          if (doc.ok === 1) item?.resolve(doc)
          else item?.reject(new MongoCommandError(String(doc.errmsg ?? 'command failed').slice(0, 256), Number(doc.code ?? 0), String(doc.codeName ?? '')))
        }
      } catch (error) { stop(error as Error) }
    })
    const client: MongoClient = {
      command: (database, doc) => new Promise((done, failed) => { const requestId = ++id; waiting.set(requestId, { resolve: done, reject: failed }); socket.write(encodeMessage(requestId, { ...doc, $db: database })) }),
      close: () => { socket.removeAllListeners('close'); socket.destroy() },
    }
    socket.once('connect', () => {
      if (!input.credential) return resolve(client)
      void (async () => {
        const scram = scramClient(input.credential!.user, input.credential!.password)
        const first = await client.command('admin', { saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: Buffer.from(scram.first), autoAuthorize: 1, options: { skipEmptyExchange: true } })
        const answer = scram.respond((first.payload as Buffer).toString('utf8'))
        const final = await client.command('admin', { saslContinue: 1, conversationId: first.conversationId!, payload: Buffer.from(answer.final) })
        if (!answer.verify((final.payload as Buffer).toString('utf8'))) throw new Error('mongodb_server_signature_invalid')
        if (final.done !== true) await client.command('admin', { saslContinue: 1, conversationId: first.conversationId!, payload: Buffer.alloc(0) })
        resolve(client)
      })().catch(error => { socket.destroy(); reject(error) })
    })
  })
}
