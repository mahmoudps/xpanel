import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import type { NativePeerIdentityAddon } from '@xpanel/agent'
// @ts-expect-error build.mjs is an untyped Node build script
import { buildPeerIdentityAddon } from '../../../../helpers/peer-identity/build.mjs'
import type { ApiApp, TransportContext } from '../server.ts'
import { listenCliApiSocket } from './socket.ts'

const work = mkdtempSync(join(tmpdir(), 'xpanel-cli-peer-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('command-line API socket on Linux', { tags: ['feature'] }, () => {
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/gcc'))('names the caller by the kernel SO_PEERCRED UID of the connection', async () => {
    const built = buildPeerIdentityAddon({ outputPath: join(work, 'xpanel-peer-identity.node'), chownRoot: false })
    const mod = { exports: {} as NativePeerIdentityAddon }
    process.dlopen(mod, built.binaryPath)
    const seen: TransportContext[] = []
    const app = { fetch: async (_req: Request, context?: TransportContext) => { seen.push(context!); return Response.json({ ok: true }) } } as unknown as ApiApp
    const socketPath = join(work, 'xuapi.sock')
    // The same descriptor lookup main.ts uses in production.
    const peerUid = (socket: Socket) => mod.exports.getSocketPeerCred((socket as unknown as { _handle?: { fd?: number } })._handle?.fd ?? -1).uid
    const listener = await listenCliApiSocket(app, { socketPath, origin: 'https://panel.example.test:2083', peerUid })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ socketPath, agent: false, path: '/api/auth/me' }, res => { res.resume(); resolve(res.statusCode ?? 0) })
        req.once('error', reject)
        req.end()
      })
      expect(status).toBe(200)
      expect(seen).toEqual([{ remoteAddress: '127.0.0.1', socketRemoteAddress: null, cliPeer: { uid: process.getuid!(), actAs: null } }])
    } finally {
      await listener.close()
    }
  })
})
