/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

export type UpdatePackageView = { name: string; current: string | null; candidate: string; origin: string; security: boolean; kernel: boolean; held: boolean; newInstall: boolean }
export type UpdatePlanView = {
  state: 'read' | 'unavailable'; source: 'apt' | 'dnf' | null; observedAt: string; revision: string | null; packages: UpdatePackageView[]; holds: string[] | null; excludeKernel: boolean
  rebootRequired: boolean | 'not-read'; counts: { total: number; security: number; kernel: number; held: number | null }; reason: string | null; actions: { refresh: boolean; apply: boolean }
  safety: { state: 'read' | 'unavailable'; writers: { pid: number; command: string }[]; database: 'clean' | 'interrupted' | 'damaged' | 'not-read' }
}

export function readUpdatePlanView(value: unknown): UpdatePlanView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const deb = /^[a-z0-9](?:[a-z0-9+.-]{0,126}[a-z0-9+])?(?::[a-z0-9]{1,16})?$/, rpm = /^[A-Za-z0-9_+](?:[A-Za-z0-9_.+-]{0,126}[A-Za-z0-9_+])?\.(?:noarch|x86_64|aarch64|i686|ppc64le|s390x)$/
  const version = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9.+~:^_-]{1,256}$/.test(item)
  const text = (item: unknown): item is string => typeof item === 'string' && item.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(item)
  if (!object(value) || !object(value.plan) || !object(value.actions) || typeof value.actions.refresh !== 'boolean' || typeof value.actions.apply !== 'boolean') throw new Error('invalid_update_plan')
  const plan = value.plan, read = plan.state === 'read'
  if (plan.excludeKernel !== undefined && plan.excludeKernel !== true) throw new Error('invalid_update_exclusion')
  if (!['read', 'unavailable'].includes(String(plan.state)) || !['apt', 'dnf', null].includes(plan.source as string | null) || typeof plan.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(plan.observedAt) || !Number.isFinite(Date.parse(plan.observedAt))) throw new Error('invalid_update_plan')
  if (read ? typeof plan.revision !== 'string' || !/^[0-9a-f]{64}$/.test(plan.revision) || plan.source === null : plan.revision !== null || typeof plan.reason !== 'string' || !/^[a-z-]{1,64}$/.test(plan.reason) || value.actions.apply) throw new Error('invalid_update_plan')
  if (!Array.isArray(plan.packages) || plan.packages.length > 5000 || !read && plan.packages.length !== 0 || plan.holds !== null && (!Array.isArray(plan.holds) || plan.holds.length > 5000) || ![true, false, 'not-read'].includes(plan.rebootRequired as boolean) || !object(plan.counts)) throw new Error('invalid_update_plan')
  const names = plan.source === 'dnf' ? rpm : deb, seen = new Set<string>()
  const packages = plan.packages.map((item): UpdatePackageView => {
    if (!object(item) || typeof item.name !== 'string' || !names.test(item.name) || seen.has(item.name) || item.current !== null && !version(item.current) || !version(item.candidate) || !text(item.origin) || [item.security, item.kernel, item.held, item.newInstall].some(flag => typeof flag !== 'boolean') || item.newInstall === true && item.current !== null) throw new Error('invalid_update_package')
    seen.add(item.name)
    return { name: item.name, current: item.current as string | null, candidate: item.candidate, origin: item.origin, security: item.security as boolean, kernel: item.kernel as boolean, held: item.held as boolean, newInstall: item.newInstall as boolean }
  })
  const holds = plan.holds === null ? null : (plan.holds as unknown[]).map(item => { if (typeof item !== 'string' || !deb.test(item)) throw new Error('invalid_update_hold'); return item })
  const raw = value.safety
  if (!object(raw) || !['read', 'unavailable'].includes(String(raw.state)) || !['clean', 'interrupted', 'damaged', 'not-read'].includes(String(raw.database)) || !Array.isArray(raw.writers) || raw.writers.length > 256) throw new Error('invalid_update_safety')
  const writers = raw.writers.map(item => { if (!object(item) || !Number.isSafeInteger(item.pid) || (item.pid as number) < 1 || typeof item.command !== 'string' || !/^[a-z][a-z0-9.+-]{0,14}$/.test(item.command)) throw new Error('invalid_update_safety'); return { pid: item.pid as number, command: item.command } })
  if ((value.actions.apply || value.actions.refresh) && (raw.state !== 'read' || writers.length || raw.database !== 'clean')) throw new Error('invalid_update_safety')
  const safety = { state: raw.state as 'read' | 'unavailable', writers, database: raw.database as 'clean' | 'interrupted' | 'damaged' | 'not-read' }
  const counts = plan.counts
  if (counts.total !== packages.length || counts.security !== packages.filter(item => item.security).length || counts.kernel !== packages.filter(item => item.kernel).length || counts.held !== (holds ? holds.length : null)) throw new Error('invalid_update_counts')
  return { state: plan.state as 'read' | 'unavailable', source: plan.source as 'apt' | 'dnf' | null, observedAt: plan.observedAt, revision: plan.revision as string | null, packages, holds, rebootRequired: plan.rebootRequired as boolean | 'not-read', counts: { total: packages.length, security: counts.security, kernel: counts.kernel, held: holds ? holds.length : null }, reason: read ? null : plan.reason as string, actions: { refresh: value.actions.refresh, apply: value.actions.apply }, excludeKernel: plan.excludeKernel === true, safety }
}

export function readUpdateJobView(value: unknown): { id: string; status: string } {
  const job = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).job : null
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('invalid_update_job')
  const { id, status } = job as Record<string, unknown>
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(status))) throw new Error('invalid_update_job')
  return { id, status: String(status) }
}

function bindWhmUpdates(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-updates-workspace]').forEach(root => {
    if (root.dataset.updatesBound === 'true') return
    root.dataset.updatesBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-whm-updates-status]'), rows = root.querySelector<HTMLElement>('[data-whm-updates-rows]')
    const job = root.querySelector<HTMLElement>('[data-whm-updates-job]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-whm-updates-job-link]')
    const excludeKernel = root.querySelector<HTMLInputElement>('[data-whm-updates-exclude-kernel]')
    const button = (key: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>('[data-whm-updates-action="' + key + '"]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !excludeKernel) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.updatesCanRead === 'true' && !root.closest(denied)
    const applicable = (): boolean => admitted() && root.dataset.updatesCanApply === 'true' && typeof askDialog === 'function'
    let plan: ReturnType<typeof readUpdatePlanView> | null = null, busy = false, stale = false
    const selectable = (entry: { held: boolean; newInstall: boolean; kernel: boolean }): boolean => !entry.held && !entry.newInstall && (!plan?.excludeKernel || !entry.kernel)
    const checked = (): string[] => Array.from(rows.querySelectorAll<HTMLInputElement>('input[data-whm-updates-select]:checked'), input => input.value)
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const ready = !busy && !stale && applicable() && !!plan && plan.state === 'read' && plan.actions.apply
      const pending = plan?.packages.filter(selectable) ?? []
      const read = button('read'), refresh = button('refresh'), security = button('security'), selected = button('selected'), all = button('all')
      if (read) read.disabled = busy || !admitted()
      excludeKernel.disabled = busy || !admitted()
      if (refresh) refresh.disabled = busy || !applicable() || !plan?.actions.refresh
      if (security) security.disabled = !ready || !pending.some(entry => entry.security)
      if (all) all.disabled = !ready || pending.length === 0
      if (selected) selected.disabled = !ready || checked().length === 0 || checked().length > 500
      rows.querySelectorAll<HTMLInputElement>('input[data-whm-updates-select]').forEach(input => { input.disabled = input.dataset.selectable !== 'true' || !ready })
      root.setAttribute('aria-busy', String(busy))
    }
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); if (technical) content.dir = 'ltr'; content.textContent = value; td.append(content); row.append(td) }
    const placeholder = (message: string): void => { rows.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 7; td.textContent = message; row.append(td); rows.append(row) }
    const fact = (key: string, value: string): void => { const target = root.querySelector<HTMLElement>('[data-whm-updates-fact="' + key + '"]'); if (target) target.textContent = value }
    const notRead = t('Not read')
    const paint = (value: ReturnType<typeof readUpdatePlanView>): void => {
      plan = value; stale = false
      const read = value.state === 'read'
      fact('source', value.source ?? t('Unavailable')); fact('observed-at', formatDisplayDateTime(value.observedAt))
      fact('total', read ? String(value.counts.total) : notRead); fact('security', read ? String(value.counts.security) : notRead); fact('kernel', read ? String(value.counts.kernel) : notRead)
      fact('held', value.counts.held === null ? notRead : String(value.counts.held))
      fact('reboot', value.rebootRequired === 'not-read' ? notRead : value.rebootRequired ? t('Yes') : t('No'))
      const guard = value.safety, safetyNote = root.querySelector<HTMLElement>('[data-whm-updates-safety]')
      fact('writers', guard.state !== 'read' ? notRead : guard.writers.length ? guard.writers.map(item => item.command + ' (' + String(item.pid) + ')').join(', ') : t('None'))
      fact('database', ({ clean: t('Consistent'), interrupted: t('Interrupted; repair needed'), damaged: t('Damaged; repair needed'), 'not-read': notRead } as Record<string, string>)[guard.database] ?? notRead)
      if (safetyNote) {
        const blocked = guard.state !== 'read' ? t('Other package managers could not be checked, so updates stay unavailable. Nothing was changed.')
          : guard.writers.length ? t('Another package manager is running. Updates stay unavailable until it finishes; nothing was changed.')
          : guard.database !== 'clean' ? t('The package database needs repair before updates. Open the repair center; nothing was changed.') : ''
        safetyNote.hidden = !blocked; safetyNote.textContent = blocked; safetyNote.dataset.state = blocked ? 'blocked' : 'clear'; safetyNote.setAttribute('role', blocked ? 'alert' : 'status')
      }
      const repairLink = root.querySelector<HTMLElement>('[data-whm-updates-repair-link]')
      if (repairLink) repairLink.hidden = guard.state !== 'read' || guard.database === 'clean'
      rows.textContent = ''
      const add = (name: string, installed: string, candidate: string, origin: string, type: string, state: string, selectableRow: boolean): void => {
        const row = document.createElement('tr'), td = document.createElement('td'), input = document.createElement('input')
        input.type = 'checkbox'; input.value = name; input.dataset.whmUpdatesSelect = ''; input.dataset.selectable = String(selectableRow)
        input.setAttribute('aria-label', t('Select {name}', { name })); input.addEventListener('change', lock)
        td.append(input); row.append(td); cell(row, name, true); cell(row, installed, installed !== notRead); cell(row, candidate, candidate !== notRead); cell(row, origin, true); cell(row, type); cell(row, state); rows.append(row)
      }
      for (const entry of value.packages) {
        const type = [entry.security ? t(msgctxt('whm-updates-client', 'Security')) : '', entry.kernel ? t(msgctxt('whm-updates-client', 'Kernel')) : ''].filter(Boolean).join(' · ') || t('Regular')
        const state = value.excludeKernel && entry.kernel ? t('Kernel; excluded from this update plan') : entry.held ? t('Held; excluded from updates') : entry.newInstall ? t('New dependency; installed with its upgraded package') : t('Upgrade pending')
        add(entry.name, entry.current ?? (entry.newInstall ? t('Not installed') : notRead), entry.candidate, entry.origin, type, state, selectable(entry))
      }
      for (const name of value.holds ?? []) if (!value.packages.some(entry => entry.name === name)) add(name, notRead, notRead, '', t('Held'), t('Held; excluded from updates'), false)
      if (!rows.childElementCount) placeholder(read ? t('No package updates are pending.') : t('The update plan is unavailable.'))
      const reasons: Record<string, string> = {
        'unsupported-host': t('System updates are unavailable on this host. Nothing was read or changed.'),
        'package-manager-busy': t('The package manager is busy with another operation. Try again later; nothing was changed.'),
        'package-manager-unavailable': t('The package manager could not be read. Nothing was changed.'),
        'invalid-package-manager-output': t('The package manager output could not be verified. No plan is shown and nothing was changed.'),
      }
      if (!read) note('unavailable', reasons[value.reason ?? ''] ?? reasons['package-manager-unavailable']!)
      else note('read', value.counts.total ? t('Update plan read. Review the packages before applying; nothing has been changed.') : t('The update plan was read and no package updates are pending.'))
      lock()
    }
    const failure = (error: unknown, conflictMessage?: string): void => {
      const details = error && typeof error === 'object' ? (error as { details?: Record<string, unknown>; status?: number }) : {}
      if (details.status === 409 && conflictMessage) { stale = true; note('stale', conflictMessage); return }
      if (details.details?.stateChanged === false && details.details.unknownOutcome !== true) note('failed', t('The request was refused and nothing was changed.'))
      else { stale = true; note('uncertain', t('The outcome is unknown. Check Jobs before trying again.')) }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading the update plan…'))
      try { const value = readUpdatePlanView(await transport!('GET', '/api/server/updates/plan' + (excludeKernel.checked ? '?excludeKernel=true' : ''))); if (value.excludeKernel !== excludeKernel.checked) throw new Error('update_option_mismatch'); if (admitted()) paint(value) }
      catch { if (admitted()) note('failed', t('The update plan could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const handOff = (id: string): void => {
      if (!job || !jobLink) return
      jobLink.href = '/whm/jobs?job=' + encodeURIComponent(id) + '&lang=' + (document.documentElement.lang || 'en'); job.hidden = false
    }
    const confirm = async (title: string, body: string, label: string): Promise<boolean> => {
      if (typeof askDialog !== 'function') { note('failed', t('Confirmation is unavailable; nothing was sent.')); return false }
      busy = true; lock()
      try { return await askDialog({ title, body, confirm: label, danger: false }) === true } catch { return false } finally { busy = false; lock() }
    }
    const submit = async (path: string, body: Record<string, unknown>, message: string, conflictMessage?: string): Promise<void> => {
      if (busy || !applicable()) return
      busy = true; lock(); note('submitting', t('Submitting the host job…'))
      try { const receipt = readUpdateJobView(await transport!('POST', path, body)); stale = true; handOff(receipt.id); note('submitted', message) }
      catch (error) { failure(error, conflictMessage) }
      finally { busy = false; lock() }
    }
    const apply = async (mode: 'security' | 'all' | 'selected'): Promise<void> => {
      if (busy || stale || !applicable() || !plan || plan.state !== 'read' || !plan.revision) return
      const pending = plan.packages.filter(selectable), picked = mode === 'selected' ? checked() : null
      const chosen = picked ? pending.filter(entry => picked.includes(entry.name)) : pending.filter(entry => mode === 'all' || entry.security)
      if (!chosen.length || picked && chosen.length !== picked.length) return
      const count = String(chosen.length), security = String(chosen.filter(entry => entry.security).length), kernel = String(chosen.filter(entry => entry.kernel).length)
      const revision = plan.revision, excluding = plan.excludeKernel
      if (!await confirm(t('Apply package updates?'), t('Packages to upgrade: {count} ({security} security, {kernel} kernel). Held packages and new dependencies are not selected. Services are not restarted automatically; needrestart only lists them. Kernel updates take effect after a reboot.', { count, security, kernel }) + (excluding ? ' ' + t('Kernel packages are excluded for this job. A kernel dependency blocks the transaction; system holds remain unchanged.') : ''), t('Apply updates'))) return
      if (!plan || plan.revision !== revision) return
      await submit('/api/server/updates/apply', { expectedRevision: revision, mode, ...(picked ? { packages: chosen.map(entry => entry.name) } : {}), ...(excluding ? { excludeKernel: true } : {}) },
        t('The update job was submitted. Follow its progress in Jobs and read the plan again after it finishes.'),
        t('The update plan changed on the host. Read it again before applying; nothing was changed.'))
    }
    if (!admitted()) { lock(); note('unavailable', t('System updates are unavailable here. Nothing was read or changed.')); return }
    button('read')?.addEventListener('click', () => { void load() })
    excludeKernel.addEventListener('change', () => { plan = null; stale = true; placeholder(t('Read the update plan again for this kernel option.')); note('stale', t('Kernel option changed. Read the update plan again before applying.')); lock() })
    button('refresh')?.addEventListener('click', () => { void (async () => {
      if (busy || !applicable() || !plan?.actions.refresh) return
      if (!await confirm(t('Refresh package lists?'), t('Package lists are downloaded from the configured repositories. No package is installed or upgraded.'), t('Refresh lists'))) return
      await submit('/api/server/updates/refresh', {}, t('The list refresh job was submitted. Read the plan again after it finishes.'))
    })() })
    for (const mode of ['security', 'all', 'selected'] as const) button(mode)?.addEventListener('click', () => { void apply(mode) })
    lock()
  })
}

export const WHM_UPDATES_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readUpdatePlanView=${readUpdatePlanView.toString()};const readUpdateJobView=${readUpdateJobView.toString()};return ${bindWhmUpdates.toString()};})()`
