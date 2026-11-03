import { describe, expect, it } from 'vitest'
import { ACTIVATION_KIND, activationCommandEvidence, completeManagementActivation, parseActivationListeners, parseActivationProcess } from './management-tls-activation.mjs'

// Pure modeled observations exercise real settlement logic. No Linux, reload,
// certificate, process ownership or loaded-route qualification is claimed.
const hash = (letter: string) => letter.repeat(64)
const executable = { path: '/usr/sbin/nginx', sha256: hash('a'), device: '1', inode: '20', size: 50000, mode: 0o755, uid: 0, gid: 0 }
const master = { pid: 50, parentPid: 1, uid: 0, role: 'master', startTicks: '100', commandSha256: hash('b'), executable, networkNamespace: 'net:[4000]' }
const worker = (pid: number, startTicks: string) => ({ ...master, pid, parentPid: master.pid, uid: 33, role: 'worker', startTicks,
  listeners: [2083, 2087, 2096].map(port => ({ inode: String(port + 1000), port, localAddressHex: '0A0200C0' })) })
const command = () => ({ operation: 'nginx-reload', executable: '/usr/bin/systemctl', startedAt: '2026-11-03T02:00:01.000Z', finishedAt: '2026-11-03T02:00:01.100Z', retiredAt: '2026-11-03T02:00:01.101Z', exitCode: 0, signal: null, remainingProcessGroup: false,
  birth: { pid: 700, kernelStartTime: '200', processGroupId: 700, sessionId: 700 }, stdout: 'sensitive diagnostic data', stderr: 'sensitive diagnostic data',
  configurationTest: { operation: 'nginx-config-test', executable: '/usr/sbin/nginx', startedAt: '2026-11-03T02:00:00.000Z', finishedAt: '2026-11-03T02:00:00.100Z', retiredAt: '2026-11-03T02:00:00.101Z', exitCode: 0, signal: null, remainingProcessGroup: false, birth: { pid: 699, kernelStartTime: '199', processGroupId: 699, sessionId: 699 }, stdout: 'private configuration', stderr: 'private configuration' } })
const observation = (workers = [worker(51, '101')]) => ({ bootId: '1d09c9a8-0432-424b-87a2-421bd0828c1c', sourceInputs: [{ relativePath: 'scripts/management-tls.mjs', sha256: hash('c') }],
  files: { managementConfigSha256: hash('d'), ingressSha256: hash('e'), includeSha256: hash('f'), nginxConfigurationSha256: hash('a') }, certificateSha256: hash('b'), invocationId: 'c'.repeat(32), nginxMaster: master, nginxWorkers: workers,
  routes: [{ audience: 'xwhm', origin: 'https://whm.panel.example.org:2087', addresses: ['192.0.2.10'], backend: '127.0.0.1:12087' }] })
const input = () => ({ before: structuredClone(observation()), after: structuredClone(observation([worker(52, '201')])), command: command(), phase: 'prepare', activatedAt: '2026-11-03T02:00:02.000Z' })

describe('management TLS activation settlement (modeled, no native proof)', () => {
  it('requires command retirement, a new accepting generation and exact source/config bookends', () => {
    const value = completeManagementActivation(input())
    expect(value).toMatchObject({ schemaVersion: 1, kind: ACTIVATION_KIND, phase: 'prepare', applicationReadiness: 'not-claimed', nginxWorkers: [{ pid: 52, startTicks: '201' }] })
    expect(value.command.configurationTest.operation).toBe('nginx-config-test')
    expect(JSON.stringify(value)).not.toMatch(/sensitive diagnostic|private configuration|stdout|stderr/)
    expect(activationCommandEvidence({ ...command(), arbitrarySecret: 'not allowed' })).not.toHaveProperty('arbitrarySecret')
  })
  it('rejects successful reload while the old accepting generation remains', () => {
    const value = input(); value.after.nginxWorkers.push(worker(51, '101'))
    expect(() => completeManagementActivation(value)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
    const retiring = input(); retiring.after.nginxWorkers[0].role = 'retiring-worker'
    expect(() => completeManagementActivation(retiring)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
    const rootWorker = input(); rootWorker.after.nginxWorkers[0].uid = 0
    expect(() => completeManagementActivation(rootWorker)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
  })
  it('rejects an empty or wrong-listener replacement despite successful TLS elsewhere', () => {
    const empty = input(); empty.after.nginxWorkers = []
    expect(() => completeManagementActivation(empty)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
    const wrong = input(); wrong.after.nginxWorkers[0].listeners = wrong.after.nginxWorkers[0].listeners.filter(row => row.port !== 2087)
    expect(() => completeManagementActivation(wrong)).toThrow('ACTIVATION_ACCEPTING_WORKER_UNOBSERVED')
  })
  it.each(['199', '200'])('refuses worker birth %s before or in the same tick as this reload command', startTicks => {
    const value = input(); value.after.nginxWorkers[0].startTicks = startTicks
    expect(() => completeManagementActivation(value)).toThrow('ACTIVATION_WORKER_ORDER_UNPROVEN')
  })
  it.each(['bootId', 'sourceInputs', 'files', 'certificateSha256', 'invocationId', 'routes'])('rejects changed %s instead of issuing stale activation evidence', key => {
    const value: any = input(); value.after[key] = null
    expect(() => completeManagementActivation(value)).toThrow('ACTIVATION_INPUT_CHANGED')
  })
  it('rejects PID reuse and workers outside the master or network namespace', () => {
    const reused = input(); reused.after.nginxMaster.startTicks = '999'
    expect(() => completeManagementActivation(reused)).toThrow('ACTIVATION_MASTER_CHANGED')
    const foreign = input(); foreign.after.nginxWorkers[0].parentPid = 999
    expect(() => completeManagementActivation(foreign)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
    const net = input(); net.after.nginxWorkers[0].networkNamespace = 'net:[4999]'
    expect(() => completeManagementActivation(net)).toThrow('ACTIVATION_NEW_WORKERS_UNOBSERVED')
  })
  it.each(['remainingProcessGroup', 'signal', 'exitCode', 'birth'])('refuses unproven command field %s', key => {
    const value: any = input(); value.command[key] = key === 'remainingProcessGroup' ? true : key === 'signal' ? 'SIGTERM' : key === 'exitCode' ? 1 : null
    expect(() => completeManagementActivation(value)).toThrow('ACTIVATION_COMMAND_UNPROVEN')
  })
  it('rejects missing or reordered configuration-test/retirement timestamps', () => {
    const late = input(); late.command.configurationTest.retiredAt = '2026-11-03T02:00:03.000Z'
    expect(() => completeManagementActivation(late)).toThrow('ACTIVATION_CONFIG_TEST_UNPROVEN')
    const retired = input(); retired.command.retiredAt = 'not-a-time'
    expect(() => completeManagementActivation(retired)).toThrow('ACTIVATION_COMMAND_TIME_INVALID')
    const stale = input(); stale.activatedAt = '2026-11-03T02:05:00.000Z'
    expect(() => completeManagementActivation(stale)).toThrow('ACTIVATION_COMMAND_TIME_INVALID')
  })
  it('records renewals while refusing a verify-only operation as activation', () => {
    const renewed = input(); renewed.phase = 'renew'
    expect(completeManagementActivation(renewed).phase).toBe('renew')
    renewed.phase = 'verify'
    expect(() => completeManagementActivation(renewed)).toThrow('ACTIVATION_PHASE_INVALID')
  })
})

const stat = (pid: number, parent: number, start: string) => {
  const values = Array(50).fill('0'); values[0] = 'S'; values[1] = String(parent); values[19] = start
  return `${pid} (nginx) ${values.join(' ')}`
}
describe('bounded Linux activation record parsers', () => {
  it('reads exact birth, principal and role, including a retiring worker', () => {
    expect(parseActivationProcess(stat(50, 1, '100'), 'Name:\tnginx\nUid:\t0\t0\t0\t0\n', Buffer.from('nginx: master process /usr/sbin/nginx -g daemon on; master_process on;\0'), 50)).toMatchObject({ pid: 50, uid: 0, role: 'master', startTicks: '100' })
    expect(parseActivationProcess(stat(51, 50, '101'), 'Uid:\t33\t33\t33\t33\n', Buffer.from('nginx: worker process is shutting down\0'), 51).role).toBe('retiring-worker')
  })
  it('rejects mismatched PID, partial identity and a master using another config', () => {
    expect(() => parseActivationProcess(stat(50, 1, '100'), 'Uid:\t0\t0\t0\t0\n', Buffer.from('nginx: master process /usr/sbin/nginx\0'), 51)).toThrow('ACTIVATION_PROCESS_INVALID')
    expect(() => parseActivationProcess(stat(51, 50, '101'), 'Uid:\t0\t33\t33\t33\n', Buffer.from('nginx: worker process\0'), 51)).toThrow('ACTIVATION_PROCESS_INVALID')
    expect(() => parseActivationProcess(stat(50, 1, '100'), 'Uid:\t0\t0\t0\t0\n', Buffer.from('nginx: master process /usr/sbin/nginx -c /other.conf\0'), 50)).toThrow('ACTIVATION_NONDEFAULT_NGINX')
    expect(() => parseActivationProcess(stat(50, 1, '100'), 'Uid:\t0\t0\t0\t0\n', Buffer.from('nginx: master process /usr/sbin/nginx -g include /other.conf;\0'), 50)).toThrow('ACTIVATION_NONDEFAULT_NGINX')
    expect(parseActivationProcess(stat(50, 1, '100'), 'Uid:\t0\t0\t0\t0\n', Buffer.from('nginx: master process /usr/sbin/nginx -c /etc/nginx/nginx.conf\0'), 50).role).toBe('master')
  })
  it('takes only management LISTEN socket inodes, never an established connection', () => {
    const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
    const line = (port: string, state: string, inode: string) => `0: 0A0200C0:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 0 0 ${inode}\n`
    expect(parseActivationListeners(header + line('0827', '0A', '55') + line('0827', '01', '56') + line('0016', '0A', '57'))).toEqual([{ port: 2087, inode: '55', localAddressHex: '0A0200C0' }])
    expect(() => parseActivationListeners(header + 'malformed\n')).toThrow('ACTIVATION_LISTENER_INPUT_INVALID')
  })
})
