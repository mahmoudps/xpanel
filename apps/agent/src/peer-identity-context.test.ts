import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { contextualPeerIdentityAddon, type NativePeerIdentityAddon } from './peer-identity.ts'

const fakeNative = () => {
  const readable: (() => void)[] = []
  const native: NativePeerIdentityAddon = {
    openListener: (_path, _gid, _mode, _backlog, onReadable) => { readable.push(onReadable); return { listener: readable.length } },
    acceptPeer: () => null,
    verifyListenerSocket: () => true,
    closeListener: () => undefined,
    closeFd: () => undefined,
    getSocketPeerCred: fd => ({ uid: fd, gid: fd, pid: fd }),
  }
  return { native, readable }
}

describe('native peer identity listener context', () => {
  it('runs each readable callback in the async context that opened its listener', () => {
    const scope = new AsyncLocalStorage<string>(), { native, readable } = fakeNative(), seen: (string | undefined)[] = []
    const addon = contextualPeerIdentityAddon(native)
    scope.run('opener', () => addon.openListener('/run/x.sock', 0, 0o600, 1, () => { seen.push(scope.getStore()) }))
    // libuv calls back with no context, or with whatever context happens to be current.
    scope.exit(() => readable[0]!())
    scope.run('other', () => readable[0]!())
    expect(seen).toEqual(['opener', 'opener'])
  })

  it('passes every other call through and exposes the optional peer reader only when the build has it', () => {
    const { native } = fakeNative()
    const plain = contextualPeerIdentityAddon(native)
    expect(plain.getSocketPeerCred(7)).toEqual({ uid: 7, gid: 7, pid: 7 })
    expect(plain.verifyListenerSocket({})).toBe(true)
    expect(plain.getUnixSocketPeer).toBeUndefined()
    const withPeer = contextualPeerIdentityAddon({ ...native, getUnixSocketPeer: fd => ({ fd }) })
    expect(withPeer.getUnixSocketPeer?.(3)).toEqual({ fd: 3 })
    expect(Object.isFrozen(plain)).toBe(true)
  })
})
