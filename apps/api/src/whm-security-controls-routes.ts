import { join } from 'node:path'
import { DANGEROUS_FUNCTIONS, fail, isXpanelError, PHP_EXCEPTION_FUNCTIONS } from '@xpanel/core'
import type { PhpFunctionException } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { isFail2banAddress, isFail2banJail } from '../../../packages/os/src/security-tools-command.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigRevision, panelJson, readPanelConfigBody, stateConfigFile } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { projectIntrusion, projectUnban } from './security-tools-workspace.ts'

export const PHP_FUNCTIONS_STATE = 'extended/server/php-functions.json'
export const SSH_AUTOBAN_STATE = 'extended/server/ssh-autoban.json'
export const SSH_AUTOBAN_BANS_STATE = 'extended/server/ssh-autoban-bans.json'
export const SSH_AUTOBAN_UNBANS_STATE = 'extended/server/ssh-autoban-unbans.json'

const PHP_FUNCTIONS_NAMESPACE = 'php-functions:v1'
const SSH_AUTOBAN_NAMESPACE = 'ssh-autoban:v1'
const SSH_AUTOBAN_UNBAN_RETENTION_MS = 86_400_000
const SSH_AUTOBAN_ROUTE = '/api/server/sec/ssh-autoban'
const SSH_AUTOBAN_UNBAN_ROUTE = '/api/server/sec/ssh-autoban/unban'
const PHP_FUNCTIONS_ROUTE = '/api/server/sec/php-functions'
const unchanged = { stateChanged: false }

export interface SshAutobanPolicy {
  enabled: boolean
  failures: number
  windowMin: number
  banMin: number
}

export interface SshAutobanEntry {
  address: string
  since: string | null
  until: string | null
  reason: string
  jail: string
}

interface PhpFunctionsRecord {
  version: 1
  disabled: string[]
  updatedAt: string
}

interface SshAutobanRecord extends SshAutobanPolicy {
  version: 1
  updatedAt: string
}

export const DEFAULT_SSH_AUTOBAN_POLICY: SshAutobanPolicy = {
  enabled: false,
  failures: 5,
  windowMin: 10,
  banMin: 60,
}

export interface WhmSecurityControlsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getServerSettings'>
  triggerReconcile?: ExtendedRouteHelpers['triggerReconcile']
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  now?: () => Date
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, field: string, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail('VALIDATION', `${field} must be a whole number from ${min} to ${max}`, unchanged)
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null

/** Canonical list of globally disabled PHP functions, validated against PHP_EXCEPTION_FUNCTIONS. */
export function parseDisabledPhpFunctions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PHP_EXCEPTION_FUNCTIONS.length) {
    return fail('VALIDATION', 'disabled PHP functions must be a bounded list', unchanged)
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !(PHP_EXCEPTION_FUNCTIONS as readonly string[]).includes(item) || seen.has(item)) {
      return fail('VALIDATION', 'each disabled PHP function must be a distinct configurable function name', unchanged)
    }
    seen.add(item)
  }
  return DANGEROUS_FUNCTIONS.filter(fn => seen.has(fn))
}

/** Validates SSH auto-ban rule parameters. */
export function parseSshAutobanPolicy(value: unknown): SshAutobanPolicy {
  if (!object(value) || !exactKeys(value, ['enabled', 'failures', 'windowMin', 'banMin'])) {
    return fail('VALIDATION', 'policy must be { enabled, failures, windowMin, banMin }', unchanged)
  }
  if (typeof value.enabled !== 'boolean') {
    return fail('VALIDATION', 'enabled must be true or false', unchanged)
  }
  return {
    enabled: value.enabled,
    failures: integer(value.failures, 'failures', 1, 500),
    windowMin: integer(value.windowMin, 'windowMin', 1, 1440),
    banMin: integer(value.banMin, 'banMin', 1, 10080),
  }
}

const parsePhpRecord = (raw: unknown): { disabled: string[] } | null => {
  try {
    if (!object(raw) || !exactKeys(raw, ['version', 'disabled', 'updatedAt']) || raw.version !== 1
      || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) {
      return null
    }
    return { disabled: parseDisabledPhpFunctions(raw.disabled) }
  } catch {
    return null
  }
}

const parseAutobanRecord = (raw: unknown): SshAutobanPolicy | null => {
  try {
    if (!object(raw) || !exactKeys(raw, ['version', 'enabled', 'failures', 'windowMin', 'banMin', 'updatedAt']) || raw.version !== 1
      || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) {
      return null
    }
    return parseSshAutobanPolicy({ enabled: raw.enabled, failures: raw.failures, windowMin: raw.windowMin, banMin: raw.banMin })
  } catch {
    return null
  }
}

const phpFunctionsFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<{ disabled: string[] }> =>
  stateConfigFile(store, PHP_FUNCTIONS_STATE, PHP_FUNCTIONS_NAMESPACE, parsePhpRecord, () => ({ disabled: [...PHP_EXCEPTION_FUNCTIONS] }))

const sshAutobanFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<SshAutobanPolicy> =>
  stateConfigFile(store, SSH_AUTOBAN_STATE, SSH_AUTOBAN_NAMESPACE, parseAutobanRecord, () => ({ ...DEFAULT_SSH_AUTOBAN_POLICY }))

const sameCaller = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean =>
  left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

async function readStateBans(store: Pick<StateStore, 'rootDir'>, now: Date): Promise<SshAutobanEntry[]> {
  let raw: unknown
  try {
    raw = await readJsonIfExists<unknown>(join(store.rootDir, SSH_AUTOBAN_BANS_STATE))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const nowMs = now.getTime()
  const items: SshAutobanEntry[] = []
  for (const item of raw) {
    if (!object(item) || !isFail2banAddress(item.address)) continue
    const until = isoOrNull(item.until)
    if (until !== null && Date.parse(until) <= nowMs) continue
    const jail = isFail2banJail(item.jail) ? item.jail : 'sshd'
    const reason = typeof item.reason === 'string' && item.reason.length <= 128 && !/[\u0000-\u001f\u007f]/.test(item.reason) ? item.reason : 'sshd'
    items.push({ address: item.address, since: isoOrNull(item.since), until, reason, jail })
    if (items.length >= 500) break
  }
  return items
}

async function clearStateBanAndRecordUnban(
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>,
  address: string,
  now: Date,
  hadConfirmedHostUnban: boolean,
  fresh: () => Promise<AuthenticatedCaller>,
): Promise<{ removedFromState: boolean }> {
  const lease = await store.getWriterLock().acquire()
  try {
    await fresh()
    const bansPath = join(store.rootDir, SSH_AUTOBAN_BANS_STATE)
    const rawBans = await readJsonIfExists<unknown>(bansPath).catch(() => null)
    const filteredBans = Array.isArray(rawBans)
      ? rawBans.filter(item => !object(item) || item.address !== address)
      : null
    const removedFromState = Array.isArray(rawBans) && filteredBans !== null && filteredBans.length !== rawBans.length
    if (!hadConfirmedHostUnban && !removedFromState) return { removedFromState: false }

    const nowMs = now.getTime()
    const minMs = nowMs - SSH_AUTOBAN_UNBAN_RETENTION_MS
    const maxMs = nowMs + 300_000
    const unbansPath = join(store.rootDir, SSH_AUTOBAN_UNBANS_STATE)
    const rawUnbans = await readJsonIfExists<unknown>(unbansPath).catch(() => null)
    const readTimestampMap = (source: unknown): Record<string, string> => {
      const entries = new Map<string, number>()
      if (object(source)) {
        for (const [ip, at] of Object.entries(source)) {
          if (!isFail2banAddress(ip) || typeof at !== 'string' || at.length > 40) continue
          const ms = Date.parse(at)
          if (Number.isFinite(ms) && ms >= minMs && ms <= maxMs) entries.set(ip, ms)
        }
      }
      return Object.fromEntries(
        [...entries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000).map(([ip, ms]) => [ip, new Date(ms).toISOString()]),
      )
    }
    const cutoffEntries = new Map<string, number>(
      Object.entries(readTimestampMap(object(rawUnbans) && rawUnbans.version === 1 ? rawUnbans.cutoffs : null)).map(([ip, at]) => [ip, Date.parse(at)]),
    )
    cutoffEntries.set(address, nowMs)
    const nextCutoffs = Object.fromEntries(
      [...cutoffEntries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1000).map(([ip, ms]) => [ip, new Date(ms).toISOString()]),
    )
    const nextConsumed = readTimestampMap(object(rawUnbans) && rawUnbans.version === 1 ? rawUnbans.consumed : null)

    const fence = async () => { await fresh(); await lease.assertFencingToken() }
    await lease.assertFencingToken()
    if (removedFromState && filteredBans) {
      await atomicWriteJson(bansPath, filteredBans, 0o640, fence)
    }
    await atomicWriteJson(
      unbansPath,
      { version: 1, cutoffs: nextCutoffs, ...(Object.keys(nextConsumed).length ? { consumed: nextConsumed } : {}) },
      0o640,
      fence,
    )
    return { removedFromState }
  } finally {
    await lease.release()
  }
}

async function reconcileOutcome(helpers: Pick<WhmSecurityControlsHelpers, 'triggerReconcile'>, caller: AuthenticatedCaller): Promise<'requested' | 'failed' | 'not_connected' | 'unknown'> {
  if (!helpers.triggerReconcile) return 'not_connected'
  try {
    const result = await helpers.triggerReconcile(caller)
    return result === null ? 'not_connected' : result.ok ? 'requested' : 'failed'
  } catch {
    return 'unknown'
  }
}

/** Root-only WHM Security C1 controls: global PHP disabled functions and SSH auto-ban rule/unban. */
export async function handleWhmSecurityControlsRoute(
  request: Request,
  url: URL,
  method: string,
  helpers: WhmSecurityControlsHelpers,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== PHP_FUNCTIONS_ROUTE && path !== SSH_AUTOBAN_ROUTE && path !== SSH_AUTOBAN_UNBAN_ROUTE) {
    return null
  }
  const isUnban = path === SSH_AUTOBAN_UNBAN_ROUTE
  const allowed = isUnban ? ['POST'] : ['GET', 'PUT']
  if (!allowed.includes(method)) {
    return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  }
  const action = path === PHP_FUNCTIONS_ROUTE
    ? (method === 'GET' ? 'server.sec.php-functions.read' : 'server.sec.php-functions.update')
    : isUnban
      ? 'server.sec.ssh-autoban.unban'
      : (method === 'GET' ? 'server.sec.ssh-autoban.read' : 'server.sec.ssh-autoban.update')

  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) {
    return fail('VALIDATION', 'security controls do not accept query selectors', unchanged)
  }
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    return sameCaller(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged)
  }
  const now = (helpers.now ?? (() => new Date()))()

  if (path === PHP_FUNCTIONS_ROUTE) {
    const file = phpFunctionsFile(helpers.store)
    const readExceptions = async (): Promise<PhpFunctionException[]> => {
      const settings = await helpers.store.getServerSettings()
      return settings?.phpFunctionExceptions ?? []
    }
    const renderView = (raw: unknown, value: { disabled: string[] } | null, exceptions: PhpFunctionException[], reconcile?: string | null) => ({
      state: raw === null ? 'default' : value ? 'saved' : 'invalid',
      disabled: value ? value.disabled : null,
      available: [...PHP_EXCEPTION_FUNCTIONS],
      exceptions,
      updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null,
      revision: panelConfigRevision(PHP_FUNCTIONS_NAMESPACE, raw),
      ...(reconcile !== undefined ? { reconcile } : {}),
    })
    if (method === 'GET') {
      const [{ raw, value }, exceptions] = await Promise.all([file.read(), readExceptions()])
      await fresh()
      return panelJson(renderView(raw, value, exceptions))
    }
    const body = await readPanelConfigBody(request)
    if (!exactKeys(body, ['disabled', 'expectedRevision'])) {
      return fail('VALIDATION', 'exactly disabled and expectedRevision are required', unchanged)
    }
    const expected = assertExpectedRevision(body.expectedRevision)
    const disabled = parseDisabledPhpFunctions(body.disabled)
    const record: PhpFunctionsRecord = { version: 1, disabled, updatedAt: now.toISOString() }
    const saved = await file.write(record as unknown as { disabled: string[] }, expected, async () => { await fresh() })
    const actor = await fresh().catch(() => null)
    try {
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'server.sec.php_functions.updated',
        target: 'server:sec:php-functions',
        principalId: caller.principal.id,
        outcome: 'ok',
        detail: { disabled },
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'PHP functions were saved but the audit record requires review', { stateChanged: true, verificationRequired: true })
    }
    const reconcile = actor ? await reconcileOutcome(helpers, actor) : null
    const exceptions = await readExceptions()
    return panelJson(renderView(saved.raw, saved.value, exceptions, reconcile))
  }

  if (isUnban) {
    const body = await readPanelConfigBody(request, 2048)
    const keys = Object.keys(body).sort().join()
    if (keys !== 'address' && keys !== 'address,jail') {
      return fail('VALIDATION', 'unban requires address and optional jail', unchanged)
    }
    if (!isFail2banAddress(body.address)) {
      return fail('VALIDATION', 'a single valid IP address is required', unchanged)
    }
    const jail = body.jail === undefined ? 'sshd' : isFail2banJail(body.jail) ? body.jail : fail('VALIDATION', 'invalid jail name', unchanged)
    const address = body.address
    const actor = await fresh()

    let agentOutcome: 'confirmed' | 'unknown' | null = null
    if (helpers.callHost) {
      let hostError: unknown = null
      let hadUnknown = false
      const noteHostFailure = (error: unknown): void => {
        const absentOrOffline = isXpanelError(error)
          && error.detail.stateChanged === false
          && (
            error.code === 'CONFLICT'
            || (error.code === 'PRECONDITION_FAILED' && (
              error.message.includes('could not be read')
              || error.message.includes('unavailable')
              || error.message.includes('native Linux host')
            ))
          )
        if (!absentOrOffline) {
          hostError ??= error
          hadUnknown = true
          agentOutcome = 'unknown'
        }
      }
      let shouldUnbanFail2ban = true
      try {
        const intrusion = projectIntrusion(await helpers.callHost(actor, '/host/security-tools/intrusion'))
        if (intrusion.state === 'not_installed' || intrusion.state === 'unavailable') {
          shouldUnbanFail2ban = false
        } else if (intrusion.state === 'read') {
          const targetJail = intrusion.jails.find(j => j.name === jail)
          if (!targetJail || (targetJail.state === 'read' && !targetJail.truncated && !targetJail.banned.includes(address))) {
            shouldUnbanFail2ban = false
          }
        }
      } catch {
        /* keep direct unban attempt if intrusion pre-read is unavailable */
      }
      if (shouldUnbanFail2ban) {
        try {
          const raw = await helpers.callHost(actor, '/host/security-tools/intrusion/unban', { jail, address })
          const res = projectUnban(raw, { jail, address })
          if (res.outcome === 'confirmed') agentOutcome ??= 'confirmed'
          else { agentOutcome = 'unknown'; hadUnknown = true }
        } catch (error) {
          noteHostFailure(error)
        }
      }

      let shouldUnbanFirewall = true
      try {
        const fwRead = await helpers.callHost(actor, '/host/firewall/bans') as { state?: unknown; bans?: Array<{ address?: unknown }> } | null
        if (fwRead?.state === 'unavailable') {
          shouldUnbanFirewall = false
        } else if (fwRead?.state === 'read' && Array.isArray(fwRead.bans) && !fwRead.bans.some(entry => entry?.address === address)) {
          shouldUnbanFirewall = false
        }
      } catch {
        /* keep direct firewall unban attempt if pre-read is unavailable */
      }
      if (shouldUnbanFirewall) {
        try {
          const fw = await helpers.callHost(actor, '/host/firewall/bans/unban', { addresses: [address] }) as { unbanned?: unknown[]; stillBanned?: unknown[] } | null
          if (Array.isArray(fw?.stillBanned) && fw.stillBanned.includes(address)) {
            agentOutcome = 'unknown'
            hadUnknown = true
          } else if (Array.isArray(fw?.unbanned) && fw.unbanned.includes(address)) {
            if (!hadUnknown) agentOutcome = 'confirmed'
          }
        } catch (error) {
          noteHostFailure(error)
        }
      }
      if (hostError) {
        await helpers.emitAudit({
          actor: actor.principal.username,
          action: 'server.sec.ssh_autoban.unban',
          target: `ssh:${jail}:${address}`,
          principalId: actor.principal.id,
          outcome: 'failed',
          detail: { address, jail, outcome: 'unknown' },
        }).catch(() => {})
        throw hostError
      }
    }

    const { removedFromState } = agentOutcome === 'unknown'
      ? { removedFromState: false }
      : await clearStateBanAndRecordUnban(helpers.store, address, now, agentOutcome === 'confirmed', fresh)
    if (!agentOutcome && !removedFromState) {
      return fail('NOT_FOUND', 'the address is not in the saved SSH ban list and no host intrusion agent unbanned it', unchanged)
    }

    const outcome = agentOutcome ?? 'confirmed'
    try {
      await helpers.emitAudit({
        actor: actor.principal.username,
        action: 'server.sec.ssh_autoban.unban',
        target: `ssh:${jail}:${address}`,
        principalId: actor.principal.id,
        outcome: outcome === 'confirmed' ? 'ok' : 'failed',
        detail: { address, jail, outcome, removedFromState },
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'the unban completed but its audit record requires review', { stateChanged: true, verificationRequired: true })
    }
    return panelJson({ address, jail, outcome })
  }

  const file = sshAutobanFile(helpers.store)
  const renderAutoban = (raw: unknown, value: SshAutobanPolicy | null, banned: SshAutobanEntry[], source: 'agent' | 'state' | 'not_connected', reconcile?: string | null) => ({
    state: raw === null ? 'default' : value ? 'saved' : 'invalid',
    policy: value,
    updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null,
    revision: panelConfigRevision(SSH_AUTOBAN_NAMESPACE, raw),
    banned,
    source,
    ...(reconcile !== undefined ? { reconcile } : {}),
  })

  if (method === 'GET') {
    const [{ raw, value }, stateBans] = await Promise.all([file.read(), readStateBans(helpers.store, now)])
    const byAddress = new Map<string, SshAutobanEntry>()
    for (const item of stateBans) byAddress.set(item.address, item)
    let source: 'agent' | 'state' | 'not_connected' = stateBans.length ? 'state' : 'not_connected'
    if (helpers.callHost) {
      try {
        const intrusion = projectIntrusion(await helpers.callHost(caller, '/host/security-tools/intrusion'))
        if (intrusion.state === 'read') {
          source = 'agent'
          for (const jail of intrusion.jails) {
            if (!/^sshd?$/i.test(jail.name)) continue
            for (const address of jail.banned) {
              if (!byAddress.has(address)) {
                byAddress.set(address, { address, since: null, until: null, reason: jail.name, jail: jail.name })
              }
            }
          }
        }
      } catch {
        /* keep state bans when fail2ban observation is unavailable */
      }
      try {
        const fw = await helpers.callHost(caller, '/host/firewall/bans') as { state?: string; bans?: Array<{ address?: unknown; timeoutSec?: unknown }> } | null
        if (fw?.state === 'read' && Array.isArray(fw.bans)) {
          source = 'agent'
          for (const entry of fw.bans) {
            if (!isFail2banAddress(entry?.address)) continue
            if (!byAddress.has(entry.address)) {
              const until = typeof entry.timeoutSec === 'number' && Number.isFinite(entry.timeoutSec) && entry.timeoutSec > 0
                ? new Date(now.getTime() + entry.timeoutSec * 1000).toISOString()
                : null
              byAddress.set(entry.address, { address: entry.address, since: null, until, reason: 'ssh-autoban', jail: 'sshd' })
            }
          }
        }
      } catch {
        /* keep existing bans when firewall ban set read is unavailable */
      }
    }
    await fresh()
    return panelJson(renderAutoban(raw, value, [...byAddress.values()], source))
  }

  const body = await readPanelConfigBody(request)
  if (!exactKeys(body, ['expectedRevision', 'policy'])) {
    return fail('VALIDATION', 'exactly policy and expectedRevision are required', unchanged)
  }
  const expected = assertExpectedRevision(body.expectedRevision)
  const policy = parseSshAutobanPolicy(body.policy)
  const record: SshAutobanRecord = { version: 1, ...policy, updatedAt: now.toISOString() }
  const saved = await file.write(record as unknown as SshAutobanPolicy, expected, async () => { await fresh() })
  const actor = await fresh().catch(() => null)
  try {
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'server.sec.ssh_autoban.updated',
      target: 'server:sec:ssh-autoban',
      principalId: caller.principal.id,
      outcome: 'ok',
      detail: policy as unknown as Record<string, unknown>,
    })
  } catch {
    return fail('SERVICE_UNAVAILABLE', 'SSH auto-ban policy was saved but its audit record requires review', { stateChanged: true, verificationRequired: true })
  }
  const reconcile = actor ? await reconcileOutcome(helpers, actor) : null
  const stateBans = await readStateBans(helpers.store, now)
  return panelJson(renderAutoban(saved.raw, saved.value, stateBans, stateBans.length ? 'state' : 'not_connected', reconcile))
}
