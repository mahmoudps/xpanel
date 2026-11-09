import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deliverHeldRelease, watchHeldCallbackEnd } from './account-provisioning-http.ts'

// Real Unix stream sockets stand in for the canary's callback connection; no root, addon, FPM or HTTP is involved.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function callbackPair(canary: (peer: Socket, received: Buffer[]) => void) {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-release-')), path = join(root, 'callback.sock'), received: Buffer[] = []
  const server: Server = createServer(peer => { peer.on('data', chunk => received.push(Buffer.from(chunk))); peer.on('error', () => {}); canary(peer, received) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  const client = createConnection(path)
  // The agent always consumes the callback stream, so the peer's end is observed as it is in the daemon.
  client.on('error', () => {}); client.resume()
  await new Promise<void>(resolve => client.once('connect', () => resolve()))
  cleanups.push(async () => {
    client.destroy(); await new Promise(resolve => server.close(resolve))
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('xpanel-release-')) throw new Error('test cleanup escaped its fixture')
    rmSync(root, { recursive: true, force: true })
  })
  return { client, received }
}
const reasonOf = (work: Promise<unknown>) => work.then(() => 'released', (error: { detail?: { reason?: string }; message?: string }) => error.detail?.reason ?? error.message)

describe('release of the held account callback', { tags: ['unit'] }, () => {
  it('refuses by name a callback the canary ended after its verified frame and before release', async () => {
    const { client, received } = await callbackPair(peer => peer.end())
    await new Promise(resolve => client.once('end', resolve))
    let began = false
    expect(await reasonOf(deliverHeldRelease(client, () => { began = true }))).toBe('callback_closed_before_release')
    expect(began).toBe(false)
    expect(Buffer.concat(received).length).toBe(0)
    // The journal symptom: a plain release write after the peer's end, which is how close() used to report this case.
    const raw = await new Promise<Error | null | undefined>(resolve => client.write('release\n', resolve))
    expect(raw?.message).toBe('This socket has been ended by the other party')
  })

  it('never releases a callback whose peer already closed, whichever side of the event the release lands on', async () => {
    const { client } = await callbackPair(peer => peer.destroy())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(['callback_closed_before_release', 'callback_release_not_delivered']).toContain(await reasonOf(deliverHeldRelease(client, () => {})))
  })

  it('releases a canary that holds until release, even when it closes at once after reading it', async () => {
    for (let round = 0; round < 100; round++) {
      const { client, received } = await callbackPair((peer, bytes) => peer.on('data', () => { if (Buffer.concat(bytes).toString() === 'release\n') peer.end() }))
      let began = false
      expect(await reasonOf(deliverHeldRelease(client, () => { began = true }))).toBe('released')
      await new Promise(resolve => client.once('end', resolve))
      expect(began).toBe(true)
      expect(Buffer.concat(received).toString()).toBe('release\n')
      await cleanups.pop()!()
    }
  })
})

describe('why a held callback ended', { tags: ['unit'] }, () => {
  it('records which side ended first, how, and whether release had started', async () => {
    const marks: string[] = []
    const canary = await callbackPair(peer => peer.end())
    watchHeldCallbackEnd(canary.client, mark => marks.push(mark), () => false)
    await new Promise(resolve => canary.client.once('end', resolve))
    expect(marks).toEqual(['callback-end:canary-eof:before-release'])

    marks.length = 0
    let releasing = false
    const agent = await callbackPair(() => {})
    const agentEnds = watchHeldCallbackEnd(agent.client, mark => marks.push(mark), () => releasing)
    releasing = true; agentEnds(); agentEnds(); agent.client.destroy()
    expect(marks).toEqual(['callback-end:agent:after-release'])

    // A peer that closes with our bytes unread resets the connection (Linux AF_UNIX) instead of ending it.
    marks.length = 0
    const root = mkdtempSync(join(tmpdir(), 'xpanel-release-')), path = join(root, 'reset.sock')
    let peer: Socket | undefined
    const server = createServer({ pauseOnConnect: true }, socket => { peer = socket; socket.on('error', () => {}) })
    await new Promise<void>(resolve => server.listen(path, resolve))
    const client = createConnection(path); client.on('error', () => {}); client.resume()
    cleanups.push(async () => { client.destroy(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) })
    await new Promise(resolve => client.once('connect', resolve))
    watchHeldCallbackEnd(client, mark => marks.push(mark), () => false)
    await new Promise<void>(resolve => client.write('unread by the canary', () => resolve()))
    while (!peer) await new Promise(resolve => setTimeout(resolve, 5))
    peer.destroy()
    await new Promise(resolve => client.once('close', resolve))
    expect(marks).toEqual(['callback-end:canary-reset:before-release'])
  })
})
