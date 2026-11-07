import { isUtf8 } from 'node:buffer'
import { connect } from 'node:net'

/**
 * Small RESP2 client over one local socket. redis-cli would put the password in argv or a child environment
 * and start one process per key; this keeps the key browser cheap on 1 vCPU and the secret inside the agent.
 */
export type RespValue = string | number | null | RespValue[]
export class RedisReplyError extends Error {}
const MAX_REPLY = 16 * 1024 * 1024
const CRLF = Buffer.from('\r\n')

/** One complete reply at `start`, or null while more bytes are needed. Bulk strings are decoded as UTF-8, or null when they are not valid text. */
export function parseResp(buffer: Buffer, start = 0): { value: RespValue | RedisReplyError; next: number } | null {
  const end = buffer.indexOf(CRLF, start)
  if (end < 0) return null
  const kind = String.fromCharCode(buffer[start]!), line = buffer.toString('utf8', start + 1, end), next = end + 2
  if (kind === '+') return { value: line, next }
  if (kind === '-') return { value: new RedisReplyError(line.slice(0, 256)), next }
  if (kind === ':') return { value: Number(line), next }
  if (kind === '$') {
    const size = Number(line)
    if (size === -1) return { value: null, next }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REPLY) throw new Error('invalid_redis_reply')
    if (buffer.length < next + size + 2) return null
    const bytes = buffer.subarray(next, next + size)
    return { value: isUtf8(bytes) ? bytes.toString('utf8') : null, next: next + size + 2 }
  }
  if (kind === '*') {
    const count = Number(line)
    if (count === -1) return { value: null, next }
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) throw new Error('invalid_redis_reply')
    const items: RespValue[] = []
    let at = next
    for (let index = 0; index < count; index++) {
      const item = parseResp(buffer, at)
      if (!item) return null
      if (item.value instanceof RedisReplyError) throw item.value
      items.push(item.value)
      at = item.next
    }
    return { value: items, next: at }
  }
  throw new Error('invalid_redis_reply')
}
export const encodeResp = (args: readonly string[]): Buffer => Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap(arg => { const bytes = Buffer.from(arg, 'utf8'); return [Buffer.from(`$${bytes.length}\r\n`), bytes, CRLF] })])

export interface RedisClient { command(...args: string[]): Promise<RespValue>; close(): void }
export type RedisTarget = { path: string } | { host: string; port: number }

export function connectRedis(target: RedisTarget, password: string | null, timeoutMs = 5000): Promise<RedisClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(target)
    let buffer: Buffer = Buffer.alloc(0)
    const waiting: { resolve(value: RespValue): void; reject(error: Error): void }[] = []
    const stop = (error: Error): void => { for (const item of waiting.splice(0)) item.reject(error); socket.destroy() }
    socket.setTimeout(timeoutMs, () => stop(new Error('redis_timeout')))
    socket.on('error', error => { stop(error); reject(error) })
    socket.on('close', () => stop(new Error('redis_closed')))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_REPLY * 2) return stop(new Error('redis_reply_too_large'))
      try {
        for (let reply = parseResp(buffer); reply; reply = parseResp(buffer)) {
          buffer = buffer.subarray(reply.next)
          const item = waiting.shift()
          if (reply.value instanceof RedisReplyError) item?.reject(reply.value)
          else item?.resolve(reply.value)
        }
      } catch (error) { stop(error as Error) }
    })
    const client: RedisClient = {
      command: (...args) => new Promise((done, failed) => { waiting.push({ resolve: done, reject: failed }); socket.write(encodeResp(args)) }),
      close: () => { socket.removeAllListeners('close'); socket.destroy() },
    }
    socket.once('connect', () => {
      if (password === null) return resolve(client)
      client.command('AUTH', password).then(() => resolve(client), error => { socket.destroy(); reject(error) })
    })
  })
}
