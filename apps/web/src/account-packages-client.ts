import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
interface PackageItem { name: string; version: string; requires: { name: string; version: string }[] }
export interface AccountPackagesClientView { revision: string; catalogRevision: string | null; inventory: 'verified' | 'recovery-required'; packages: PackageItem[]; available: (PackageItem & { summary: string })[]; recovery: string; capabilities: { install: boolean; remove: boolean; recover: boolean } }
function packageObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function packageName(value: unknown): value is string { return typeof value === 'string' && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(value) }
function packageVersion(value: unknown): value is string { return typeof value === 'string' && /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}(?:(?:alpha|beta|RC)[0-9]{1,3})?$/.test(value) }
function packageAscii(value: string): string { return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, char => String(char.charCodeAt(0) - (char.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660))) }
/** Independent account/operation/checksum-shape checks never trust an acknowledgement as an install result alone. */
export function readAccountPackagesView(raw: unknown, accountId: string, sent: Record<string, unknown>): AccountPackagesClientView {
  const bad = (): never => { throw new Error('invalid_account_packages_reply') }, sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  if (!packageObject(raw) || [raw, packageObject(raw.details) ? raw.details : {}, packageObject(raw.detail) ? raw.detail : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true) || !packageObject(raw.context) || raw.context.accountId !== accountId || typeof raw.context.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.context.username) || raw.ecosystem !== 'pear' || raw.scope !== 'managed-private-library' || raw.library !== '.xpanel-packages/pear/library' || !sha(raw.revision) || !(raw.catalogRevision === null || sha(raw.catalogRevision)) || !['verified', 'recovery-required'].includes(raw.inventory as string) || !['none', 'prepared', 'needs-review', 'committed', 'rolled-back'].includes(raw.recovery as string) || !Array.isArray(raw.packages) || raw.packages.length > 32 || !Array.isArray(raw.available) || raw.available.length > 32 || !packageObject(raw.capabilities) || ['install', 'remove', 'recover'].some(key => typeof (raw.capabilities as Record<string, unknown>)[key] !== 'boolean') || !packageObject(raw.application) || raw.application.op !== sent.op || raw.application.state !== (sent.op === 'read' ? 'read' : 'verified') || raw.application.verificationRequired !== false) return bad()
  const parse = (value: unknown, available: boolean): PackageItem & { summary: string } => {
    if (!packageObject(value) || !packageName(value.name) || !packageVersion(value.version) || value.source !== 'https://pear.php.net/get/' + value.name + '-' + value.version + '.tgz' || !Array.isArray(value.requires) || value.requires.length > 32) return bad()
    const requires = value.requires.map(item => { if (!packageObject(item) || !packageName(item.name) || !packageVersion(item.version)) return bad(); return { name: item.name, version: item.version } })
    if (new Set(requires.map(item => item.name)).size !== requires.length) return bad()
    if (available && (typeof value.summary !== 'string' || value.summary.length > 300 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.summary))) return bad()
    if (!available && (!sha(value.archiveSha256) || !Array.isArray(value.files) || !value.files.length || value.files.length > 32 || value.files.some(file => !packageObject(file) || typeof file.path !== 'string' || file.path.length > 200 || !/^[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)*\.php$/.test(file.path) || !sha(file.sha256)))) return bad()
    return { name: value.name, version: value.version, requires, summary: available ? value.summary as string : '' }
  }
  const packages = raw.packages.map(item => parse(item, false)), available = raw.available.map(item => parse(item, true)), pending = ['prepared', 'needs-review'].includes(raw.recovery as string)
  const filePaths = raw.packages.flatMap(item => (item as { files: { path: string }[] }).files.map(file => file.path))
  if (new Set(packages.map(item => item.name)).size !== packages.length || new Set(available.map(item => item.name)).size !== available.length || new Set(filePaths).size !== filePaths.length || packages.some(item => item.requires.some(dependency => !packages.some(target => target.name === dependency.name && target.version === dependency.version))) || pending !== (raw.inventory === 'recovery-required') || pending && packages.length !== 0 || pending && (raw.capabilities.install || raw.capabilities.remove) || raw.capabilities.recover && !pending || raw.catalogRevision === null && (available.length !== 0 || raw.capabilities.install)) return bad()
  if (sent.op !== 'read' && (pending || raw.revision === sent.expectedRevision) || sent.op === 'install' && !packages.some(item => item.name === sent.name && available.some(artifact => artifact.name === item.name && artifact.version === item.version)) || sent.op === 'remove' && packages.some(item => item.name === sent.name)) return bad()
  return { revision: raw.revision, catalogRevision: raw.catalogRevision, inventory: raw.inventory as AccountPackagesClientView['inventory'], packages, available, recovery: raw.recovery as string, capabilities: { install: raw.capabilities.install as boolean, remove: raw.capabilities.remove as boolean, recover: raw.capabilities.recover as boolean } }
}
function bindAccountPackages(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-packages]').forEach(root => {
    if (root.dataset.packagesBound === 'true') return
    root.dataset.packagesBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const eligible = (): boolean => root.isConnected && root.dataset.packagesManage === 'true' && !root.closest('[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const get = <T extends HTMLElement>(name: string): T => root.querySelector<T>('[data-packages-' + name + ']')!
    const status = get('status'), installed = get('installed'), available = get('available'), search = get<HTMLInputElement>('search'), refresh = get<HTMLButtonElement>('refresh'), recover = get<HTMLButtonElement>('recover')
    if (!status || !installed || !available || !search || !refresh || !recover) return
    let view: AccountPackagesClientView | null = null, busy = false, uncertain = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => {
      root.setAttribute('aria-busy', String(busy)); refresh.disabled = busy || !eligible(); search.disabled = busy || !eligible(); recover.disabled = busy || !eligible() || uncertain || !view?.capabilities.recover
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-op]')) { const op = button.dataset.packageOp, name = button.dataset.packageName, item = view?.available.find(item => item.name === name)
        button.disabled = busy || !eligible() || uncertain || !view || (op === 'install' ? !view.capabilities.install || view.packages.some(item => item.name === name) || !item || item.requires.some(dependency => !view!.packages.some(value => value.name === dependency.name && value.version === dependency.version)) : !view.capabilities.remove || view.packages.some(item => item.requires.some(dependency => dependency.name === name)))
      }
    }
    const cell = (value: string, technical = false): HTMLTableCellElement => { const td = document.createElement('td'), span = document.createElement(technical ? 'bdi' : 'span'); if (technical) span.dir = 'ltr'; span.textContent = packageAscii(value); td.append(span); return td }
    const empty = (target: HTMLElement, columns: number, message: string): void => { const row = document.createElement('tr'), td = cell(message); td.colSpan = columns; row.append(td); target.append(row) }
    const paint = (): void => {
      if (!view) return
      get('inventory').textContent = view.inventory === 'verified' ? t('Verified from library files') : t('Recovery required')
      installed.textContent = ''; available.textContent = ''
      for (const item of view.packages) { const row = document.createElement('tr'), action = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn xp-btn--danger'; button.dataset.packageOp = 'remove'; button.dataset.packageName = item.name; button.textContent = t('Remove'); action.append(button); row.append(cell(item.name, true), cell(item.version, true), cell(item.requires.map(value => value.name + ' ' + value.version).join(', ') || '-', true), action); installed.append(row) }
      if (!view.packages.length) empty(installed, 4, view.inventory === 'verified' ? t('No packages are managed in this private library.') : t('Restore the pending operation before reading the installed inventory.'))
      const query = search.value.slice(0, 100).trim().toLowerCase(), filtered = view.available.filter(item => (item.name + ' ' + item.summary).toLowerCase().includes(query))
      for (const item of filtered) { const row = document.createElement('tr'), action = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.dataset.packageOp = 'install'; button.dataset.packageName = item.name; button.textContent = t('Install'); action.append(button); row.append(cell(item.name, true), cell(item.version, true), cell(item.summary), cell(item.requires.map(value => value.name + ' ' + value.version).join(', ') || '-', true), action); available.append(row) }
      if (!filtered.length) empty(available, 5, view.catalogRevision === null ? t('A pinned reviewed package catalog is unavailable.') : t('No reviewed package matches this filter.'))
      get('capability').textContent = view.capabilities.install ? t('Install exact reviewed versions. Required packages must already be installed.') : t('Installation is unavailable until a pinned catalog and account-confined provider are qualified.')
      lock()
    }
    async function perform(op: string, name?: string): Promise<void> {
      if (!eligible() || busy || typeof send !== 'function' || op !== 'read' && (!view || uncertain)) return
      const sent: Record<string, unknown> = { op, ...(name ? { name } : {}), ...(op === 'read' ? {} : { expectedRevision: view!.revision }) }, mutation = op !== 'read'
      if (mutation) {
        if (!askDialog) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
        busy = true; lock(); let confirmed = false
        try { confirmed = await askDialog({ title: t('Confirm private package action'), body: (name ?? t('Recover pending operation')) + '\n' + t('A recovery snapshot protects the managed library. Continue?'), confirm: t('Confirm'), danger: op === 'remove' }) === true } catch { confirmed = false }
        if (!confirmed || !eligible()) { busy = false; lock(); return }
      }
      busy = true; lock(); note('reading', t('Reading or applying the package action…'))
      try { const raw = await send(mutation ? 'POST' : 'GET', '/api/account/packages', mutation ? sent : undefined); view = readAccountPackagesView(raw, root.dataset.account ?? '', sent); if (!mutation) uncertain = false; paint(); note('read', mutation ? t('Private library change verified.') : t('Private library read.')) }
      catch (error) { const record = packageObject(error) ? error : {}, details = packageObject(record.details) ? record.details : packageObject(record.detail) ? record.detail : {}
        if (mutation && ([record, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true) || ![record, details].some(part => part.stateChanged === false))) uncertain = true
        note('failed', uncertain ? t('The result needs review. Read packages to discover pending recovery before retrying.') : t('Packages are unavailable, changed or not permitted. Read again before retrying.'))
      } finally { busy = false; lock() }
    }
    refresh.addEventListener('click', () => { void perform('read') }); recover.addEventListener('click', () => { if (view?.capabilities.recover) void perform('recover') }); search.addEventListener('input', paint)
    root.addEventListener('click', event => { const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-package-op]'); if (!button || !root.contains(button) || button.disabled || !packageName(button.dataset.packageName)) return; const op = button.dataset.packageOp; if (op === 'install' || op === 'remove') void perform(op, button.dataset.packageName) })
    if (typeof send !== 'function' || !eligible() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(root.dataset.account ?? '')) { for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = true; note('unavailable', t('Private packages are unavailable here. Nothing was read or changed.')); return }
    lock(); void perform('read')
  })
}
export const ACCOUNT_PACKAGES_CLIENT_BINDING = `(()=>{const packageObject=${packageObject.toString()};const packageName=${packageName.toString()};const packageVersion=${packageVersion.toString()};const packageAscii=${packageAscii.toString()};const readAccountPackagesView=${readAccountPackagesView.toString()};return ${bindAccountPackages.toString()};})()`
