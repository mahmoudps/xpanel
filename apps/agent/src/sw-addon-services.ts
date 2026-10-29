import { createHash } from 'node:crypto'
import { fail, isXpanelError, msgid } from '@xpanel/core'
import { isSwAddonAction, SW_ADDON_SERVICES, swAddonActionArgv, swAddonService, swAddonShowArgv } from '../../../packages/os/src/sw-addon-command.ts'
import type { SwAddonAction, SwAddonService, SwAddonServiceRow, SwAddonServicesView } from '../../../packages/os/src/sw-addon-command.ts'
import type { HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'

export type SwAddonRun = (argv: readonly string[]) => Promise<{ ok: boolean; code?: number | null; stdout: string; stderr: string }>
export interface SwAddonRouteContext {
  assertRoot(action: string): Promise<{ actor: string }>
  /** null off a qualified native Linux host. */
  run: SwAddonRun | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<void>
  now?: () => Date
}
interface UnitState { load: string; active: string; sub: string; boot: string | null }
const unchanged = { stateChanged: false }
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

/** systemctl(1) show --property emits KEY=VALUE lines; an unknown unit reports LoadState=not-found with an empty UnitFileState. */
export function parseSwAddonUnit(text: string, unit: string): UnitState {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error('invalid_unit_properties')
  const data: Record<string, string> = {}
  for (const line of text.split('\n').filter(item => item.trim() !== '')) {
    const match = /^(Id|Names|LoadState|ActiveState|SubState|UnitFileState)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(data, match[1]!)) throw new Error('invalid_unit_properties')
    data[match[1]!] = match[2]!
  }
  if (Object.keys(data).length !== 6 || data.Id !== unit || !data.Names!.split(' ').includes(unit) || ![data.LoadState, data.ActiveState, data.SubState].every(item => TOKEN.test(item ?? '')) || data.UnitFileState !== '' && !TOKEN.test(data.UnitFileState!)
    || data.UnitFileState === '' && data.LoadState !== 'not-found') throw new Error('invalid_unit_properties')
  return { load: data.LoadState!, active: data.ActiveState!, sub: data.SubState!, boot: data.UnitFileState === '' ? null : data.UnitFileState! }
}
const unitRevision = (service: SwAddonService, unit: UnitState): string => sha(JSON.stringify([service.unit, unit.load, unit.active, unit.sub, unit.boot]))
async function observe(run: SwAddonRun, service: SwAddonService): Promise<UnitState | null> {
  try { const result = await run(swAddonShowArgv(service)); return result.ok ? parseSwAddonUnit(result.stdout, service.unit) : null } catch { return null }
}

export async function readSwAddonServices(ctx: Pick<SwAddonRouteContext, 'run' | 'now'>, control: boolean): Promise<SwAddonServicesView> {
  const observedAt = (ctx.now?.() ?? new Date()).toISOString()
  if (!ctx.run) return { scope: 'host-addon-services', state: 'unavailable', reason: 'unsupported-host', observedAt, services: [], actions: { control: false, configure: false } }
  const run = ctx.run
  const services: SwAddonServiceRow[] = await Promise.all(SW_ADDON_SERVICES.map(async service => {
    const unit = await observe(run, service)
    return unit ? { id: service.id, unit: service.unit, componentId: service.componentId, state: 'read' as const, ...unit, revision: unitRevision(service, unit) }
      : { id: service.id, unit: service.unit, componentId: service.componentId, state: 'unavailable' as const, load: null, active: null, sub: null, boot: null, revision: null }
  }))
  return { scope: 'host-addon-services', state: 'read', reason: null, observedAt, services, actions: { control, configure: false } }
}

const TITLES: Readonly<Record<SwAddonAction, string>> = { start: msgid('Start {service}'), stop: msgid('Stop {service}'), restart: msgid('Restart {service}') }
export function buildSwAddonJobPlan(input: { service: SwAddonService; action: SwAddonAction; expectedRevision: string; revalidate: { run: SwAddonRun; assertActor(): Promise<void> } }): HostJobPlan {
  const { service, action } = input, argv = swAddonActionArgv(action, service), show = swAddonShowArgv(service)
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])
  const current = async (run: HostJobRun | SwAddonRun): Promise<UnitState> => { const result = await run(show); if (!result.ok) throw new Error('unit_readback_unavailable'); return parseSwAddonUnit(result.stdout, service.unit) }
  return {
    kind: 'software.addon.' + action, summary: action + ' ' + service.unit, accountId: null,
    fingerprint: { service: service.id, unit: service.unit, action, expectedRevision: input.expectedRevision }, detail: { service: service.id, unit: service.unit, action },
    steps: [{ id: 'addon-' + action, title: TITLES[action], titleValues: { service: service.name }, argv, timeoutMs: 120_000, mutates: true }],
    policy: candidate => same(candidate, argv) || same(candidate, show),
    beforeStep: async () => {
      await input.revalidate.assertActor()
      const unit = await current(input.revalidate.run)
      if (unitRevision(service, unit) !== input.expectedRevision) return fail('CONFLICT', 'the service changed after review', unchanged)
      await input.revalidate.assertActor()
    },
    verify: async run => {
      const unit = await current(run), ok = action === 'stop' ? unit.active === 'inactive' : unit.active === 'active' && unit.sub === 'running'
      return { ok, detail: { active: unit.active, sub: unit.sub, verificationRequired: !ok } }
    },
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleSwAddonServicesRoute(req: Request, url: URL, method: string, ctx: SwAddonRouteContext): Promise<Response | null> {
  const operation = url.pathname === '/host/software/addon-services' ? 'read' : url.pathname === '/host/software/addon-services/action' ? 'action' : null
  if (!operation) return null
  const label = 'software.addon_services.' + operation, first = await ctx.assertRoot(label), expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'add-on service requests do not accept selectors', unchanged)
  const fresh = async (): Promise<string> => { const now = await ctx.assertRoot(label); if (now.actor !== first.actor) return fail('FORBIDDEN', 'add-on service authority changed', unchanged); return now.actor }
  if (operation === 'read') { const view = await readSwAddonServices(ctx, ctx.submitJob !== null); await fresh(); return json(200, view) }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 512 ? JSON.parse(text) : null } catch { body = null }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  const service = swAddonService(record?.serviceId)
  if (!record || Object.keys(record).sort().join() !== 'action,expectedRevision,serviceId' || !service || !isSwAddonAction(record.action) || typeof record.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(record.expectedRevision)) return fail('VALIDATION', 'a listed add-on service, start/stop/restart and the observed revision are required', unchanged)
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'add-on service changes require a supported native Linux host', unchanged)
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no service change was submitted', unchanged)
  const unit = await observe(ctx.run, service)
  if (!unit) return fail('PRECONDITION_FAILED', 'the service could not be observed', unchanged)
  if (unitRevision(service, unit) !== record.expectedRevision) return fail('CONFLICT', 'the service changed since it was read', unchanged)
  if (unit.load !== 'loaded' || unit.boot === 'masked' || record.action === 'start' && unit.active === 'active' || record.action === 'stop' && unit.active !== 'active') return fail('PRECONDITION_FAILED', 'the service is not installed or is already in the requested state', unchanged)
  const run = ctx.run, plan = buildSwAddonJobPlan({ service, action: record.action, expectedRevision: record.expectedRevision, revalidate: { run, assertActor: async () => { await fresh() } } })
  const actor = await fresh()
  await ctx.audit({ actor, action: 'software.addon.change_requested', target: service.unit, outcome: 'ok', detail: { action: record.action } })
  let job: HostJobView
  try { job = await ctx.submitJob(plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail?.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'service job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== plan.kind) return fail('SERVICE_UNAVAILABLE', 'service job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job })
}
