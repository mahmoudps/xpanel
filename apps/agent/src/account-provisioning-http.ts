import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { createConnection, Socket } from 'node:net'
import { fail, isXpanelError, type Account } from '@xpanel/core'
import { ACCOUNT_PROBE_HOLD_SECONDS, ACCOUNT_PROBE_ROUTE, accountProbePaths } from '../../../packages/render/src/system/account-probe.ts'
import { canonicalProvisioningIdentity, parseProvisioningReconcileRequest } from '../../../packages/core/src/account-provisioning-contract.ts'
import { assertProvisioningProcessBinding, openNativeProvisioningProcess, parseProvisioningProcessFiles, type HeldProvisioningHttpRequest, type ProvisioningProcessIdentity, type ReadonlyAccountObservationOptions } from './account-provisioning-observer.ts'
import { captureCanarySource, type HeldCanarySource, type HeldHttpConnection, type NativeAccountHttpSubject, type NativeProvisioningHttpOptions } from './account-provisioning-http-source.ts'
import type { ProvisioningDatabaseReaderPort } from './account-provisioning-database-reader.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'
import type { NativePeerIdentityAddon, KernelPeerCredentials } from './peer-identity.ts'
import { assertUnixSocketPeerHeldByProcess, inspectHeldUnixSocketPeer, type UnixSocketPeerPin } from './unix-socket-peer.ts'
import { FASTCGI, FastCgiDecoder, assertCanaryIngress, fastCgiCanaryRequest, fastCgiRecord, isCompletedFastCgiEnd, matchesCanaryAdmission, matchesCanaryCallback, parseFastCgiParams } from './provisioning-fastcgi.ts'

type HttpInput = Parameters<NonNullable<ReadonlyAccountObservationOptions['openCorrelatedHttpRequest']>>[0]
type NativeHttpPort = Required<Pick<ReadonlyAccountObservationOptions, 'assertHttpAvailable' | 'openCorrelatedHttpRequest'>>
export interface NativeAccountHttpOptions extends NativeProvisioningHttpOptions { readonly addon: NativePeerIdentityAddon
  /** Trusted startup composition; present in the live daemon so no observation reads the writable handle. */
  readonly databaseReader?: ProvisioningDatabaseReaderPort }
export interface HeldNativeAccountHttpRequest extends HeldProvisioningHttpRequest {
  readonly observedProcess: ProvisioningProcessIdentity
  readonly unit: string
  readonly mainPid: number
}
const refused: (reason: string) => never = reason => fail('PRECONDITION_FAILED', 'the held account HTTP request did not verify', { verificationRequired: true, reason })
/** Code, message and reason identifier, or the first line of a system error; never request bytes. */
const describeFailure = (error: unknown): string => isXpanelError(error)
  ? `${error.code}: ${error.message}${typeof error.detail.reason === 'string' ? ` (${error.detail.reason})` : ''}`
  : error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'unexpected failure'
const socketFd = (socket: Socket): number => {
  const handle: unknown = Reflect.get(socket, '_handle')
  if (handle === null || typeof handle !== 'object') return refused('held_socket_unavailable')
  const fd: unknown = Reflect.get(handle, 'fd')
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) return refused('held_socket_unavailable')
  return fd
}
const write = (socket: Socket, bytes: Buffer | string): Promise<void> => new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()))
const deferred = <T>() => {
  let resolveValue: (value: T) => void = () => {}, rejectValue: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject })
  // Event-driven failures can precede the consuming await; keep the original rejecting promise.
  void promise.catch(() => {})
  return { promise, resolve: resolveValue, reject: rejectValue }
}
const closed = (socket: Socket): Promise<void> => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', () => resolve()))

/** Destroy without Error still emits close. Every connect await must settle on that path too. */
export function waitForNativeSocketConnect(socket: Socket, signal: AbortSignal, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer)
      socket.off('connect', connected); socket.off('error', failed); socket.off('close', disconnected); signal.removeEventListener('abort', aborted)
      if (error) { socket.destroy(); reject(error) } else resolve()
    }
    const connected = () => finish()
    const failed = (error: Error) => finish(error)
    const disconnected = () => finish(new Error('native socket closed before connect'))
    const aborted = () => finish(new Error('native socket connect cancelled'))
    const expired = () => finish(new Error('native socket connect deadline'))
    const timer = setTimeout(expired, Math.max(1, deadline - performance.now()))
    socket.once('connect', connected); socket.once('error', failed); socket.once('close', disconnected); signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (performance.now() >= deadline) expired()
    else if (!socket.connecting && !socket.pending && !socket.destroyed) connected()
    else if (socket.destroyed) disconnected()
  })
}

/** Existing observation port, concrete native implementation. No RPC-supplied paths, observer or success flags. */
export function createNativeHeldAccountHttp(options: NativeAccountHttpOptions) {
  const busy = new Set<number>(), quarantined = new Set<number>()
  const root = async (context: HostEffectAuthority): Promise<void> => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || context.readOnly !== true
      || context.signal.aborted || typeof options.addon.getUnixSocketPeer !== 'function') refused('native_kernel_transport_unavailable')
    await context.assertAuthority()
    if (context.signal.aborted) refused('native_kernel_transport_unavailable')
  }
  return {
    async assertAvailable(account: Account, context: HostEffectAuthority): Promise<void> {
      await root(context)
      if (Buffer.byteLength(accountProbePaths(account).callbackInNamespace) > 107) refused('account_canary_socket_path_too_long')
      // Exercise the actual kernel operation before account host effects. No fixture evidence is returned.
      const parent = await open('/run/xpanel', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      let listener: unknown, client: Socket | undefined, acceptedFd: number | undefined
      const accepted = deferred<number>(), path = '/run/xpanel/probe-diag-' + randomBytes(12).toString('hex') + '.sock', expires = performance.now() + 1500
      const cancellation = new AbortController()
      const abort = () => { cancellation.abort(); accepted.reject(new Error('native peer query cancelled')); client?.destroy() }
      context.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, 1500)
      try {
        const metadata = await parent.stat(), named = await lstat('/run/xpanel')
        if (metadata.uid !== 0 || !metadata.isDirectory() || !named.isDirectory() || metadata.dev !== named.dev || metadata.ino !== named.ino || (metadata.mode & 0o022) !== 0) refused('native_runtime_parent_unprotected')
        await root(context)
        listener = options.addon.openListener(path, account.gid, 0o600, 1, () => {
          try { if (listener === undefined) return; const peer = options.addon.acceptPeer(listener); if (peer) {
            if (acceptedFd !== undefined) { options.addon.closeFd(peer.fd); return }
            acceptedFd = peer.fd; accepted.resolve(peer.fd)
          } }
          catch (error) { accepted.reject(error) }
        })
        client = createConnection(path)
        client.once('error', error => accepted.reject(error))
        await waitForNativeSocketConnect(client, AbortSignal.any([context.signal, cancellation.signal]), expires); await accepted.promise
        inspectHeldUnixSocketPeer(options.addon, socketFd(client)); await root(context)
        if (performance.now() >= expires) refused('native_kernel_query_deadline')
      } catch { return fail('SERVICE_UNAVAILABLE', 'the native account HTTP transport is unavailable', { verificationRequired: true, reason: 'native_kernel_transport_unavailable' }) }
      finally {
        clearTimeout(timer); context.signal.removeEventListener('abort', abort)
        if (client) { const done = closed(client); client.destroy(); await done }
        if (acceptedFd !== undefined) options.addon.closeFd(acceptedFd)
        if (listener !== undefined) options.addon.closeListener(listener)
        await parent.close()
      }
    },
    async open(input: NativeAccountHttpSubject, context: HostEffectAuthority): Promise<HeldNativeAccountHttpRequest> {
      await root(context)
      const account = input.account
      if (!/^[a-f0-9]{64}$/.test(input.challenge) || busy.has(account.uid) || quarantined.has(account.uid)) refused('account_probe_busy_or_quarantined')
      busy.add(account.uid)
      const admission = randomBytes(32).toString('hex'), deadline = performance.now() + ACCOUNT_PROBE_HOLD_SECONDS * 1000, paths = accountProbePaths(account)
      const sockets = new Set<Socket>(), tasks = new Set<Promise<void>>()
      const httpReady = deferred<void>(), httpDone = deferred<void>(), workerReady = deferred<ProvisioningProcessIdentity>()
      const fastCgiDone = deferred<void>(), ingressDone = deferred<void>(), callbackDone = deferred<void>()
      const connectCancellation = new AbortController()
      let source: HeldCanarySource | undefined, ingressListener: unknown, callbackListener: unknown
      let backend: Socket | undefined, callback: Socket | undefined, ingress: Socket | undefined, httpSocket: Socket | undefined, ingressPeer: KernelPeerCredentials | undefined, http: ClientRequest | undefined, response: IncomingMessage | undefined
      let backendPin: UnixSocketPeerPin | undefined
      let failure: unknown, ended = false, releasing = false, claimed = false, acceptedCount = 0, closePromise: Promise<void> | undefined
      const prefix = Buffer.from('XPANEL-PROBE/1 ' + input.challenge + '\n'), expectedBody = Buffer.concat([prefix, Buffer.from('done\n')])
      const failOperation = (error: unknown): void => {
        if (failure === undefined) failure = error
        connectCancellation.abort()
        for (const socket of sockets) socket.destroy()
        http?.destroy(); response?.destroy()
        for (const value of [httpReady, httpDone, workerReady, fastCgiDone, ingressDone, callbackDone]) value.reject(failure)
      }
      const guard = async (): Promise<void> => {
        if (failure !== undefined) throw failure
        if (ended || performance.now() >= deadline || context.signal.aborted) return refused('account_probe_authority_or_deadline')
        await root(context)
        if (performance.now() >= deadline || context.signal.aborted) return refused('account_probe_authority_or_deadline')
      }
      const nativeContext: HostEffectAuthority = { readOnly: true, signal: context.signal, assertAuthority: guard }
      // Which hops completed tells the operator where the exchange stalled.
      const started = performance.now(), marks: string[] = []
      const mark = (name: string): void => { marks.push(`${name}@${Math.round(performance.now() - started)}ms`) }
      const stages = (): string => `ingress=${ingress ? 'admitted' : 'none'} backend=${backend ? 'connected' : 'none'} callback=${callback ? 'received' : 'none'} response=${response?.statusCode ?? 'none'} ${marks.join(' ')} now@${Math.round(performance.now() - started)}ms`
      const timer = setTimeout(() => failOperation(new Error(`held account HTTP deadline (${stages()})`)), ACCOUNT_PROBE_HOLD_SECONDS * 1000)
      const abort = () => failOperation(new Error('held account HTTP cancelled'))
      context.signal.addEventListener('abort', abort, { once: true })
      const ownSocket = (socket: Socket): Socket => {
        sockets.add(socket); socket.setTimeout(Math.max(1, deadline - performance.now()), () => failOperation(new Error('held socket deadline')))
        socket.on('error', error => { if (!ended) failOperation(error) })
        return socket
      }
      const heldHttpConnection = (): HeldHttpConnection => {
        const live = httpSocket
        if (!live || live.destroyed || live.localAddress === undefined || live.localPort === undefined || live.remoteAddress === undefined || live.remotePort === undefined) return refused('held_http_connection_unavailable')
        return { fd: socketFd(live), localAddress: live.localAddress, localPort: live.localPort, remoteAddress: live.remoteAddress, remotePort: live.remotePort }
      }
      const track = (work: Promise<void>): void => {
        tasks.add(work)
        void work.then(() => tasks.delete(work), error => { tasks.delete(work); failOperation(error) })
      }
      const adopt = (peer: KernelPeerCredentials & { fd: number }): Socket => {
        let adopted: Socket | undefined
        try { const live = new Socket({ fd: peer.fd, readable: true, writable: true }); adopted = live; return ownSocket(live) }
        catch (error) { if (adopted) adopted.destroy(); else options.addon.closeFd(peer.fd); throw error }
      }
      const cleanup = async (): Promise<void> => {
        ended = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort)
        http?.destroy(); response?.destroy()
        const pendingClose = [...sockets].map(socket => { const done = closed(socket); socket.destroy(); return done })
        const errors: unknown[] = []
        for (const listener of [ingressListener, callbackListener]) if (listener !== undefined) {
          try { options.addon.closeListener(listener) } catch (error) { errors.push(error) }
        }
        const results = await Promise.allSettled([...pendingClose, ...tasks, Promise.resolve().then(() => source?.close())])
        if (errors.length || results.some(result => result.status === 'rejected')) { quarantined.add(account.uid); refused('account_probe_release_uncertain') }
        busy.delete(account.uid)
      }
      const readWorker = async (peer: KernelPeerCredentials, live: Socket): Promise<void> => {
        let bytes: Buffer = Buffer.alloc(0)
        for await (const chunk of live) {
          bytes = Buffer.concat([bytes, Buffer.from(chunk)])
          if (bytes.length > 256) refused('callback_frame_limit')
          const at = bytes.indexOf(10)
          if (at < 0) continue
          if (at !== bytes.length - 1 || callback !== undefined) refused('callback_replay_or_extra_frame')
          if (!matchesCanaryCallback(bytes, input.challenge, input.binding)) { live.destroy(); return }
          callback = live; mark('callback')
          await guard()
          const heldSource = source, heldBackend = backend
          if (!heldSource || !heldBackend || peer.uid !== account.uid || peer.gid !== account.gid) refused('callback_not_bound_to_fpm')
          // A peer inode is meaningful only after FPM accepted the connection. The canary callback proves acceptance happened.
          const pin = inspectHeldUnixSocketPeer(options.addon, socketFd(heldBackend)); backendPin = pin
          const files = await openNativeProvisioningProcess(peer.pid)
          let observed: ProvisioningProcessIdentity
          try {
            const [stat, status, cgroup] = await Promise.all([files.read('stat'), files.read('status'), files.read('cgroup')])
            observed = parseProvisioningProcessFiles(peer.pid, { stat, status, cgroup })
            assertProvisioningProcessBinding(observed, account, heldSource.unit, heldSource.mainPid)
            await heldSource.assertWorkerNamespace(observed); await heldSource.assertCurrent()
            await assertUnixSocketPeerHeldByProcess(options.addon, socketFd(heldBackend), pin, observed, nativeContext)
            await files.assertCurrent(); await guard()
          } finally { await files.close() }
          mark('worker-verified'); workerReady.resolve(observed)
          // Keep the actual callback/request alive. Any further callback bytes invalidate the one-shot frame.
          for await (const extra of live) { if (Buffer.byteLength(extra) !== 0) refused('callback_replayed') }
          if (!releasing) refused('callback_closed_before_release')
          callbackDone.resolve(); return
        }
      }
      const relay = async (peer: KernelPeerCredentials, live: Socket): Promise<void> => {
        const heldSource = source
        if (!heldSource) return refused('source_not_captured')
        await heldSource.assertIngressPeer(peer, heldHttpConnection()); await heldSource.assertCurrent(); await guard()
        const decoder = new FastCgiDecoder(), parameters: Buffer[] = []
        let requestId: number | undefined, begun = false, paramsEnded = false, running = false
        for await (const chunk of live) {
          for (const record of decoder.push(Buffer.from(chunk))) {
            if (requestId !== undefined && record.requestId !== requestId) refused('ingress_multiplexing_refused')
            requestId = record.requestId
            if (record.type === FASTCGI.begin && !begun && record.content.equals(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]))) { begun = true; continue }
            if (record.type === FASTCGI.params && begun && !paramsEnded) {
              if (record.content.length) { parameters.push(record.content); if (parameters.reduce((size, bytes) => size + bytes.length, 0) > 8192) refused('ingress_parameter_limit') }
              else paramsEnded = true
              continue
            }
            if (record.type !== FASTCGI.stdin || !begun || !paramsEnded || running || record.content.length !== 0) refused('ingress_protocol_refused')
            const values = parseFastCgiParams(Buffer.concat(parameters))
            if (!matchesCanaryAdmission(values.get('HTTP_X_XPANEL_PROBE_ADMISSION'), admission)) { live.destroy(); return }
            if (claimed) refused('admission_nonce_already_consumed')
            assertCanaryIngress(values, account.primaryDomain)
            claimed = true; running = true; ingress = live; ingressPeer = peer; mark('ingress')
            await heldSource.assertCurrent(); await guard()
            const stream = ownSocket(createConnection(heldSource.backendSocket))
            backend = stream
            await waitForNativeSocketConnect(stream, AbortSignal.any([context.signal, connectCancellation.signal]), deadline); await guard()
            await heldSource.assertBackendPeer(options.addon.getSocketPeerCred(socketFd(stream))); mark('backend')
            await guard()
            const outgoing = new FastCgiDecoder(), targetId = record.requestId
            track((async () => {
              let complete = false, stdoutClosed = false
              for await (const responseChunk of stream) for (const item of outgoing.push(Buffer.from(responseChunk))) {
                if (item.requestId !== 1 || complete || (item.type !== FASTCGI.stdout && item.type !== FASTCGI.stderr && item.type !== FASTCGI.end)) refused('backend_protocol_refused')
                if (item.type === FASTCGI.stderr && item.content.length) refused('backend_canary_error')
                if (item.type === FASTCGI.stdout) { if (stdoutClosed) refused('backend_stdout_reopened'); if (!item.content.length) stdoutClosed = true }
                if (item.type === FASTCGI.end) {
                  if (!releasing || !isCompletedFastCgiEnd(item)) refused('backend_ended_before_proof')
                  complete = true
                }
                await write(live, fastCgiRecord(item.type, targetId, item.content))
                if (complete) live.end()
              }
              outgoing.finish()
              if (!complete) refused('backend_request_incomplete')
              fastCgiDone.resolve()
            })())
            await write(stream, fastCgiCanaryRequest(paths.script, ACCOUNT_PROBE_ROUTE, account.primaryDomain, input.challenge, input.binding))
          }
        }
        decoder.finish()
        if (live === ingress && releasing) ingressDone.resolve()
        else if (live === ingress) refused('ingress_closed_before_release')
      }
      const listen = (path: string, gid: number, mode: number, callbackConnection: boolean): unknown => {
        let listener: unknown
        listener = options.addon.openListener(path, gid, mode, 4, () => {
          try {
            if (listener === undefined || ended || !options.addon.verifyListenerSocket(listener)) return refused('native_listener_replaced')
            for (;;) {
              const peer = options.addon.acceptPeer(listener)
              if (!peer) break
              if (++acceptedCount > 12) { options.addon.closeFd(peer.fd); refused('native_listener_connection_limit') }
              const live = adopt(peer)
              track(callbackConnection ? readWorker(peer, live) : relay(peer, live))
            }
          } catch (error) { failOperation(error) }
        })
        return listener
      }
      try {
        const heldSource = await captureCanarySource(options, input, nativeContext); source = heldSource; await guard(); mark('source')
        callbackListener = listen(paths.callback, account.gid, 0o660, true)
        ingressListener = listen(paths.ingress, heldSource.nginxGid, 0o660, false)
        await guard()
        let received: Buffer = Buffer.alloc(0)
        http = httpRequest({ host: account.ipv4, family: 4, port: 80, path: ACCOUNT_PROBE_ROUTE, method: 'GET', agent: false,
          headers: { Host: account.primaryDomain, 'X-XPanel-Probe-Admission': admission, Connection: 'close' }, timeout: ACCOUNT_PROBE_HOLD_SECONDS * 1000 - 1000 }, actual => {
          response = actual; mark('response')
          try {
            const challengeHeaders = actual.rawHeaders.filter((_, index) => index % 2 === 0 && actual.rawHeaders[index]?.toLowerCase() === 'x-xpanel-probe-challenge')
            if (actual.statusCode !== 200 || actual.rawHeaders.length > 64 || challengeHeaders.length !== 1 || actual.headers['x-xpanel-probe-challenge'] !== input.challenge
              || actual.headers['content-length'] !== String(expectedBody.length) || actual.headers['transfer-encoding'] !== undefined) refused('actual_http_headers_not_verified')
            actual.on('data', bytes => {
              try {
                received = Buffer.concat([received, Buffer.from(bytes)])
                if (received.length > expectedBody.length || (!releasing && received.length > prefix.length)
                  || !expectedBody.subarray(0, received.length).equals(received)) refused('actual_http_body_not_verified')
                if (received.equals(prefix)) httpReady.resolve()
              } catch (error) { failOperation(error) }
            })
            actual.once('end', () => { if (!releasing || !received.equals(expectedBody) || !actual.complete) failOperation(new Error('actual HTTP request incomplete')); else httpDone.resolve() })
            actual.once('aborted', () => failOperation(new Error('actual HTTP response aborted')))
            actual.once('error', failOperation)
          } catch (error) { failOperation(error) }
        })
        http.once('socket', socket => { httpSocket = ownSocket(socket) })
        http.once('timeout', () => failOperation(new Error('actual HTTP request deadline'))); http.once('error', failOperation); http.end()
        const [observed] = await Promise.all([workerReady.promise, httpReady.promise]); await guard(); mark('ready')
        const assertCurrent = async (): Promise<void> => {
          try {
            await guard()
            if (releasing || !source || !backend || !backendPin || !callback || !ingress || !ingressPeer || callback.destroyed || backend.destroyed || ingress.destroyed || response?.complete) refused('held_http_request_not_live')
            if (!options.addon.verifyListenerSocket(ingressListener) || !options.addon.verifyListenerSocket(callbackListener)) refused('held_listener_changed')
            await source.assertWorkerNamespace(observed)
            await source.assertIngressPeer(ingressPeer, heldHttpConnection())
            await source.assertCurrent()
            await assertUnixSocketPeerHeldByProcess(options.addon, socketFd(backend), backendPin, observed, nativeContext)
            await guard()
          } catch (error) {
            console.error('xpanel-agent held account HTTP request changed:', describeFailure(error), stages())
            return refused('held_http_request_changed')
          }
        }
        await assertCurrent()
        return {
          requestBinding: input.binding, challenge: input.challenge, status: 200, pid: observed.pid, assertCurrent,
          observedProcess: Object.freeze({ ...observed, uids: Object.freeze([...observed.uids]), gids: Object.freeze([...observed.gids]) }),
          unit: heldSource.unit, mainPid: heldSource.mainPid,
          close() {
            if (!closePromise) closePromise = (async () => {
              let rejected = false
              try {
                await assertCurrent()
                const live = callback
                if (!live) refused('callback_not_live')
                releasing = true; mark('release'); await write(live, 'release\n')
                await Promise.all([httpDone.promise, fastCgiDone.promise, ingressDone.promise, callbackDone.promise])
                await source?.assertCurrent(); await guard()
              } catch (error) {
                rejected = true; failOperation(error); quarantined.add(account.uid)
                console.error('xpanel-agent held account HTTP release failed:', describeFailure(failure), stages())
                return refused('held_http_release_not_verified')
              }
              finally { try { await cleanup() } catch (error) { if (!rejected) throw error } }
            })()
            return closePromise
          },
        }
      } catch (error) {
        failOperation(error); quarantined.add(account.uid)
        // The refusal is generic; the operator needs the first failure to find the host prerequisite.
        console.error('xpanel-agent account HTTP correlation failed:', describeFailure(failure), stages())
        try { await cleanup() } catch { /* Preserve the primary failed observation; the UID remains quarantined. */ }
        return refused('held_http_correlation_not_verified')
      }
    },
  }
}

/** Existing provisioning port: preserve its real job/request binding and reuse the concrete exchange. */
export function createNativeAccountProvisioningHttp(options: NativeAccountHttpOptions): NativeHttpPort {
  const exchange = createNativeHeldAccountHttp(options)
  // No reader is held across the native exchange: the canary source opens a short pinned reader for each
  // generation read, because any live control write during a held reader refuses that reader.
  const bound = (input: Parameters<NativeHttpPort['assertHttpAvailable']>[0]) => {
    const request = parseProvisioningReconcileRequest(input.request), account = input.account
    if (canonicalProvisioningIdentity(request.authority.account) !== canonicalProvisioningIdentity({
      id: account.id, username: account.username, ownerId: account.ownerId, planId: account.planId, uid: account.uid, gid: account.gid,
      home: account.home, primaryDomain: account.primaryDomain,
    })) refused('account_http_request_binding_changed')
    return { account, sourceChecksum: request.authority.desired.checksum, binding: request.binding }
  }
  return {
    async assertHttpAvailable(input, context) { await exchange.assertAvailable(bound(input).account, context) },
    async openCorrelatedHttpRequest(input: HttpInput, context) {
      return exchange.open({ ...bound(input), challenge: input.challenge }, context)
    },
  }
}
