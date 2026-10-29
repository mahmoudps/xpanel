import { createHash } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobRun } from './host-job-contract.ts'
import { isServiceManagerBootUnit, isServiceManagerCommand, isServiceManagerUnit, serviceManagerCat, serviceManagerRestartTest, serviceManagerShow, SERVICE_MANAGER_FILES, SERVICE_MANAGER_LIST, SERVICE_MANAGER_REBOOT, SERVICE_MANAGER_SYSTEMCTL } from '../../../packages/os/src/service-manager-command.ts'

export type ServiceManagerRun = (argv: readonly string[]) => Promise<{ ok: boolean; code?: number | null; stdout: string; stderr: string }>
export type ServiceManagerAction = 'enable' | 'disable' | 'restart' | 'reboot'
export interface ServiceManagerRow { unit: string; load: string | null; active: string | null; sub: string | null; boot: string | null; restart: boolean; bootEditable: boolean }
export interface ServiceManagerView { state: 'read' | 'unavailable'; observedAt: string; revision: string | null; bootTime: number | null; units: ServiceManagerRow[]; manage: boolean }
export interface ServiceManagerTarget { unit: string; names: string[]; load: string; active: string; sub: string; boot: string }
export type ServiceManagerPlan = HostJobPlan & { beforeStep: (step: HostJobCommandStep) => Promise<void> }
const token = /^[a-z][a-z0-9-]{0,63}$/
const states = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad'])
const lines = (text: string): string[] => {
  if (Buffer.byteLength(text) > 1024 * 1024 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error('invalid_service_output')
  const result = text.split('\n').filter(line => line.trim() !== '')
  if (result.length > 4096) throw new Error('too_many_services')
  return result
}
/** systemctl(1) --plain --no-legend emits UNIT LOAD ACTIVE SUB DESCRIPTION; list-unit-files emits UNIT STATE [PRESET]. */
export function parseServiceManagerLists(unitsText: string, filesText: string): ServiceManagerRow[] {
  const rows = new Map<string, ServiceManagerRow>(), seen = new Set<string>()
  for (const line of lines(unitsText)) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+.*)?$/.exec(line)
    if (!match || !isServiceManagerUnit(match[1]) || ![match[2], match[3], match[4]].every(value => token.test(value!)) || rows.has(match[1])) throw new Error('invalid_service_row')
    rows.set(match[1], { unit: match[1], load: match[2]!, active: match[3]!, sub: match[4]!, boot: null, restart: false, bootEditable: false })
  }
  for (const line of lines(filesText)) {
    const match = /^\s*(\S+)\s+(\S+)(?:\s+(enabled|disabled|-))?\s*$/.exec(line)
    if (!match || !isServiceManagerUnit(match[1]) || !states.has(match[2]!) || seen.has(match[1])) throw new Error('invalid_unit_file_row')
    seen.add(match[1])
    const row = rows.get(match[1]) ?? { unit: match[1], load: null, active: null, sub: null, boot: null, restart: false, bootEditable: false }
    row.boot = match[2]!
    row.restart = row.load === 'loaded' && serviceManagerRestartTest(row.unit) !== null
    row.bootEditable = row.load === 'loaded' && isServiceManagerBootUnit(row.unit) && ['enabled', 'disabled'].includes(row.boot)
    rows.set(row.unit, row)
  }
  if (rows.size === 0) throw new Error('empty_service_inventory')
  return [...rows.values()].sort((a, b) => a.unit.localeCompare(b.unit, 'en'))
}
export function parseServiceManagerTarget(text: string, unit: string): ServiceManagerTarget {
  const data: Record<string, string> = {}
  for (const line of lines(text)) {
    const match = /^(Id|Names|LoadState|ActiveState|SubState|UnitFileState)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(data, match[1]!)) throw new Error('invalid_service_properties')
    data[match[1]!] = match[2]!
  }
  const names = data.Names?.split(' ') ?? []
  if (Object.keys(data).length !== 6 || data.Id !== unit || names.length === 0 || names.some(name => !isServiceManagerUnit(name)) || !names.includes(unit) || ![data.LoadState, data.ActiveState, data.SubState].every(value => token.test(value ?? '')) || !states.has(data.UnitFileState ?? '')) throw new Error('invalid_service_properties')
  return { unit, names, load: data.LoadState!, active: data.ActiveState!, sub: data.SubState!, boot: data.UnitFileState! }
}
/** disable also removes Alias/Also links; refuse them, continuations and unexpected section syntax rather than touching related units. */
export function serviceManagerInstallSafe(text: string): boolean {
  if (!text.trim() || text.includes('\ufffd') || /^\s*(?:Alias|Also)\s*=/m.test(text)) return false
  let install = false, wanted = false
  try { for (const raw of lines(text)) {
    const line = raw.trim()
    if (!line || /^[#;]/.test(line)) continue
    if (line.endsWith('\\')) return false
    if (line.startsWith('[')) { if (!/^\[[A-Za-z][A-Za-z0-9]*\]$/.test(line)) return false; install = line === '[Install]'; continue }
    if (!install) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line)
    if (!match || ['Alias', 'Also', 'DefaultInstance'].includes(match[1]!)) return false
    if (match[1] === 'WantedBy') { if (match[2] !== 'multi-user.target') return false; wanted = true }
    else if (match[1] !== 'RequiredBy' || match[2] !== '') return false
  } } catch { return false }
  return wanted
}
export function parseServiceManagerBootTime(text: string | null): number | null {
  if (!text || text.length > 256 * 1024) return null
  const found = text.split('\n').filter(line => line.startsWith('btime '))
  if (found.length !== 1 || !/^btime [1-9][0-9]{0,10}$/.test(found[0]!)) return null
  const value = Number(found[0]!.slice(6))
  return Number.isSafeInteger(value) && value > 0 && value < 8640000000000 ? value : null
}
export async function readServiceManager(input: { run: ServiceManagerRun; readFile: (path: string) => Promise<string | null>; now?: () => Date; manage?: boolean }): Promise<ServiceManagerView> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const bootTime = await input.readFile('/proc/stat').then(parseServiceManagerBootTime, () => null)
  try {
    const units = await input.run(SERVICE_MANAGER_LIST), files = await input.run(SERVICE_MANAGER_FILES)
    if (!units.ok || !files.ok) throw new Error('service_inventory_unavailable')
    const rows = parseServiceManagerLists(units.stdout, files.stdout)
    return { state: 'read', observedAt, revision: createHash('sha256').update(JSON.stringify({ units: rows, bootTime })).digest('hex'), bootTime, units: rows, manage: input.manage === true }
  } catch { return { state: 'unavailable', observedAt, revision: null, bootTime, units: [], manage: false } }
}
export async function readServiceManagerTarget(run: ServiceManagerRun, unit: string): Promise<ServiceManagerTarget> {
  const result = await run(serviceManagerShow(unit))
  if (!result.ok) return fail('PRECONDITION_FAILED', 'the selected service could not be observed', { stateChanged: false })
  try { return parseServiceManagerTarget(result.stdout, unit) } catch { return fail('PRECONDITION_FAILED', 'the selected service properties could not be verified', { stateChanged: false }) }
}
export async function assertServiceManagerTarget(run: ServiceManagerRun, action: ServiceManagerAction, unit: string): Promise<ServiceManagerTarget> {
  const target = await readServiceManagerTarget(run, unit)
  if (target.load !== 'loaded') return fail('PRECONDITION_FAILED', 'the selected service is not loaded', { stateChanged: false })
  if (action === 'restart') {
    if (!serviceManagerRestartTest(unit) || target.names.some(name => !serviceManagerRestartTest(name))) return fail('FORBIDDEN', 'this service restart is not reviewed', { stateChanged: false })
  } else {
    if (!isServiceManagerBootUnit(unit) || target.names.length !== 1 || target.names[0] !== unit || !['enabled', 'disabled'].includes(target.boot)) return fail('FORBIDDEN', 'this service boot state is protected or not reviewed', { stateChanged: false })
    const cat = await run(serviceManagerCat(unit))
    if (!cat.ok || !serviceManagerInstallSafe(cat.stdout)) return fail('PRECONDITION_FAILED', 'the service install links are not safe for an isolated boot change', { stateChanged: false })
  }
  return target
}
export function buildServiceManagerPlan(input: { action: ServiceManagerAction; unit?: string; expectedRevision: string; bootTime: number | null; run: ServiceManagerRun; assertFresh: () => Promise<void> }): ServiceManagerPlan {
  const { action } = input, unit = input.unit ?? null
  if (action !== 'reboot' && (!unit || !isServiceManagerUnit(unit) || (action === 'restart' ? !serviceManagerRestartTest(unit) : !isServiceManagerBootUnit(unit)))) return fail('VALIDATION', 'unsupported service selection', { stateChanged: false })
  const test = unit && action === 'restart' ? serviceManagerRestartTest(unit) : null
  const mutation = action === 'reboot' ? [...SERVICE_MANAGER_REBOOT] : [SERVICE_MANAGER_SYSTEMCTL, action, '--', unit!]
  const steps: HostJobCommandStep[] = [...(test ? [{ id: 'config-test', title: msgid('Check configuration'), argv: test, timeoutMs: 30000, mutates: false }] : []), { id: action, title: action === 'reboot' ? msgid('Request server reboot') : action === 'restart' ? msgid('Restart service') : msgid('Change service boot state'), argv: mutation, timeoutMs: 60000, mutates: true }]
  const exact = steps.map(step => JSON.stringify(step.argv))
  return { kind: `services.manager.${action}`, summary: action === 'reboot' ? 'Request server reboot; confirm boot time after reconnection' : `${action} ${unit}`, accountId: null,
    fingerprint: { action, unit, revision: input.expectedRevision }, detail: { action, unit, bootTimeBefore: input.bootTime, verificationRequired: true }, steps,
    policy: argv => isServiceManagerCommand(argv) && exact.includes(JSON.stringify(argv)),
    beforeStep: async step => {
      if (!step.mutates) { await input.assertFresh(); return }
      if (unit) {
        const target = await assertServiceManagerTarget(input.run, action, unit)
        if (action === 'enable' && target.boot !== 'disabled' || action === 'disable' && target.boot !== 'enabled') return fail('CONFLICT', 'service boot state changed while the job was queued', { stateChanged: false })
      }
      await input.assertFresh()
    },
    verify: async (run: HostJobRun) => {
      if (action === 'reboot') return { ok: false, detail: { outcome: 'attempted', verificationRequired: true, bootTimeBefore: input.bootTime } }
      try {
        const target = await readServiceManagerTarget(run, unit!)
        const ok = target.load === 'loaded' && (action === 'restart' ? target.active === 'active' : target.boot === (action === 'enable' ? 'enabled' : 'disabled'))
        return { ok, detail: { unit, active: target.active, boot: target.boot, verificationRequired: !ok } }
      } catch { return { ok: false, detail: { unit, verificationRequired: true } } }
    },
  }
}
