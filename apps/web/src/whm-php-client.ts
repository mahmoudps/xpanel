import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'

const formatDisplayDateTime = canonicalFormatDisplayDateTime

type PhpPackageView = { name: string; version: string; component: string }
type PhpVersionView = { version: string; supported: boolean; packages: PhpPackageView[]; binary: { state: 'read' | 'unavailable'; scope: 'cli-without-ini'; version?: string; builtInExtensions?: string[] }; extensionEnablement: 'not-read'; fpmRequest: 'not-read' }
export type PhpInventoryView = { state: 'read' | 'unavailable'; source: 'dpkg' | 'rpm' | null; observedAt: string; versions: PhpVersionView[] }
type PhpUsageView = { version: string; domains: { name: string; account: string | null; handler: string }[] }
type PhpManageExtension = { module: string; package: string | null; installed: boolean; enabled: boolean | null }
type PhpManageVersion = { version: string; fpmInstalled: boolean; ini: Record<string, string> | null; extensions: PhpManageExtension[]; lifecycle: string; domainCount: number; accountCount: number }
type PhpException = { account: string; functions: string[]; reason: string; grantedAt: string; grantedBy: string }
export type PhpManageView = { state: 'read' | 'unavailable'; revision: string | null; manage: boolean; defaultVersion: string; versions: PhpManageVersion[]; installable: string[]; extensionsWritable: boolean; exceptions: PhpException[]; exceptionsRevision: string }

/** /api/server/php/manage: host observation plus the saved default and usage; anything malformed is refused. */
export function readPhpManageView(value: unknown): PhpManageView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const version = (item: unknown): item is string => typeof item === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(item)
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !(value.revision === null || typeof value.revision === 'string' && /^[0-9a-f]{64}$/.test(value.revision)) || !version(value.defaultVersion) || !Array.isArray(value.versions) || value.versions.length > 32 || !Array.isArray(value.installable) || !value.installable.every(version) || !object(value.capabilities) || !object(value.actions)) throw new Error('invalid_php_manage')
  const versions = value.versions.map(raw => {
    if (!object(raw) || !version(raw.version) || typeof raw.fpmInstalled !== 'boolean' || !(raw.ini === null || object(raw.ini)) || !Array.isArray(raw.extensions) || raw.extensions.length > 256 || !object(raw.lifecycle) || !Number.isSafeInteger(raw.domainCount) || !Number.isSafeInteger(raw.accountCount)) throw new Error('invalid_php_manage')
    const ini = raw.ini === null ? null : Object.fromEntries(Object.entries(raw.ini).map(([key, item]) => { if (!/^[a-z_.]{1,64}$/.test(key) || typeof item !== 'string' || item.length > 256) throw new Error('invalid_php_manage'); return [key, item] }))
    const extensions = raw.extensions.map(item => {
      if (!object(item) || typeof item.module !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(item.module) || !(item.package === null || typeof item.package === 'string' && /^[a-z0-9-]{1,32}$/.test(item.package)) || typeof item.installed !== 'boolean' || !(item.enabled === null || typeof item.enabled === 'boolean')) throw new Error('invalid_php_manage')
      return { module: item.module, package: item.package as string | null, installed: item.installed, enabled: item.enabled as boolean | null }
    })
    return { version: raw.version, fpmInstalled: raw.fpmInstalled, ini, extensions, lifecycle: String(raw.lifecycle.state), domainCount: raw.domainCount as number, accountCount: raw.accountCount as number }
  })
  if (!Array.isArray(value.exceptions) || value.exceptions.length > 10000 || typeof value.exceptionsRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.exceptionsRevision)) throw new Error('invalid_php_manage')
  const exceptions = value.exceptions.map(raw => {
    if (!object(raw) || typeof raw.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.account) || !Array.isArray(raw.functions) || !raw.functions.every(fn => typeof fn === 'string' && /^[a-z_]{1,32}$/.test(fn)) || typeof raw.reason !== 'string' || raw.reason.length > 200 || typeof raw.grantedAt !== 'string' || !Number.isFinite(Date.parse(raw.grantedAt)) || typeof raw.grantedBy !== 'string' || raw.grantedBy.length > 64) throw new Error('invalid_php_manage')
    return { account: raw.account, functions: raw.functions as string[], reason: raw.reason, grantedAt: raw.grantedAt, grantedBy: raw.grantedBy }
  })
  return { state: value.state as 'read' | 'unavailable', revision: value.revision as string | null, manage: value.actions.manage === true, defaultVersion: value.defaultVersion, versions, installable: value.installable as string[], extensionsWritable: value.capabilities.extensions === true, exceptions, exceptionsRevision: value.exceptionsRevision }
}

export function readPhpInventoryView(value: unknown): PhpInventoryView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !['dpkg', 'rpm', null].includes(value.source as 'dpkg' | 'rpm' | null) || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.versions) || value.versions.length > 32) throw new Error('invalid_php_inventory')
  if (value.state === 'read' && value.source === null || value.state === 'unavailable' && value.versions.length !== 0) throw new Error('invalid_php_inventory')
  const seen = new Set<string>()
  const versions = value.versions.map(raw => {
    if (!object(raw) || typeof raw.version !== 'string' || !/^[5-9]\.[0-9]{1,2}$/.test(raw.version) || seen.has(raw.version) || typeof raw.supported !== 'boolean' || !Array.isArray(raw.packages) || raw.packages.length > 256 || raw.extensionEnablement !== 'not-read' || raw.fpmRequest !== 'not-read' || !object(raw.binary) || !['read', 'unavailable'].includes(String(raw.binary.state)) || raw.binary.scope !== 'cli-without-ini') throw new Error('invalid_php_version')
    seen.add(raw.version)
    const packages = raw.packages.map(item => {
      if (!object(item) || typeof item.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+_.:-]{0,127}$/.test(item.name) || typeof item.version !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,256}$/.test(item.version) || typeof item.component !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.component)) throw new Error('invalid_php_package')
      return { name: item.name, version: item.version, component: item.component }
    })
    let binary: PhpVersionView['binary'] = { state: 'unavailable', scope: 'cli-without-ini' }
    if (raw.binary.state === 'read') {
      const probe = raw.binary
      if (typeof probe.version !== 'string' || !probe.version.startsWith(raw.version + '.') || !/^[5-9]\.[0-9]{1,2}\.[0-9]{1,3}(?:[-+.a-zA-Z0-9_]{0,64})$/.test(probe.version) || probe.sapi !== 'cli' || !Array.isArray(probe.builtInExtensions) || probe.builtInExtensions.length > 256 || probe.builtInExtensions.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_ -]{0,63}$/.test(item))) throw new Error('invalid_php_binary')
      binary = { state: 'read', scope: 'cli-without-ini', version: probe.version, builtInExtensions: probe.builtInExtensions as string[] }
    }
    return { version: raw.version, supported: raw.supported, packages, binary, extensionEnablement: 'not-read' as const, fpmRequest: 'not-read' as const }
  })
  return { state: value.state as 'read' | 'unavailable', source: value.source as 'dpkg' | 'rpm' | null, observedAt: value.observedAt, versions }
}

export function readPhpUsageView(value: unknown): PhpUsageView[] {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || value.scope !== 'saved-domain-configuration' || value.observedRuntime !== false || !Array.isArray(value.usage) || value.usage.length > 32) throw new Error('invalid_php_usage')
  const seen = new Set<string>()
  return value.usage.map(raw => {
    if (!object(raw) || typeof raw.version !== 'string' || !/^[5-9]\.[0-9]{1,2}$/.test(raw.version) || seen.has(raw.version) || !Array.isArray(raw.domains) || raw.domains.length > 10000 || raw.domainCount !== raw.domains.length) throw new Error('invalid_php_usage')
    seen.add(raw.version)
    const domains = raw.domains.map(item => {
      if (!object(item) || typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.name) || item.account !== null && (typeof item.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(item.account)) || typeof item.handler !== 'string' || !['fpm', 'cgi', 'suphp', 'lsphp'].includes(item.handler)) throw new Error('invalid_php_usage')
      return { name: item.name, account: item.account as string | null, handler: item.handler }
    })
    return { version: raw.version, domains }
  })
}

function bindWhmPhp(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-php-workspace]').forEach(root => {
    if (root.dataset.phpBound === 'true') return
    root.dataset.phpBound = 'true'
    const page = root.closest<HTMLElement>('[data-whm-detail-route="/whm/software/php"]')
    const status = root.querySelector<HTMLElement>('[data-whm-php-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-php-refresh]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!page || !status || !refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = () => root.isConnected && root.dataset.phpCanRead === 'true' && !root.closest(denied)
    let busy = false, inventory: PhpInventoryView | null = null, manage: PhpManageView | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), text = document.createElement(technical ? 'bdi' : 'span'); if (technical) text.dir = 'ltr'; text.textContent = value; td.append(text); row.append(td) }
    const empty = (body: HTMLElement | null, count: number, message: string): void => { if (!body) return; body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = count; td.textContent = message; row.append(td); body.append(row) }
    const select = (name: string): HTMLSelectElement | null => page.querySelector<HTMLSelectElement>('[name="' + name + '"]')
    const paintVersion = (version: string): void => {
      if (manage?.state === 'read') { paintManagedExtensions(version); return }
      const current = inventory?.versions.find(item => item.version === version)
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-extensions"] tbody')
      if (!current) { empty(body, 4, t('No selected version has been read.')); return }
      if (body) {
        body.textContent = ''
        const builtIn = current.binary.builtInExtensions ?? []
        for (const name of builtIn) { const row = document.createElement('tr'); cell(row, name, true); cell(row, current.binary.version ?? current.version, true); cell(row, t('CLI without INI only')); cell(row, t('Built into the probed binary; FPM not read')); body.append(row) }
        for (const item of current.packages.filter(item => !['cli', 'fpm', 'cgi', 'common', 'dev', 'dbg', 'embed', 'runtime', 'phpdbg'].includes(item.component))) { const row = document.createElement('tr'); cell(row, item.name, true); cell(row, item.version, true); cell(row, t('Not read')); cell(row, t('Package installed; enablement not read')); body.append(row) }
        if (!body.childElementCount) empty(body, 4, t('No extension observation was returned; enablement remains unread.'))
      }
      const message = root.querySelector<HTMLElement>('[data-whm-php-binary-status]')
      if (message) message.textContent = current.binary.state === 'read'
        ? t('CLI binary read without php.ini: {version}. This is not FPM extension enablement or application request verification.', { version: String(current.binary.version) })
        : t('Packages were read, but this version’s binary probe is unavailable. FPM enablement and application requests remain unread.')
    }
    const paintInventory = (value: PhpInventoryView): void => {
      inventory = value
      const source = root.querySelector<HTMLElement>('[data-whm-php-source]'), observedAt = root.querySelector<HTMLElement>('[data-whm-php-observed-at]')
      // Human status text leaves the technical mono font; observed values keep it.
      const fact = (node: HTMLElement | null, text: string, human: boolean): void => { if (!node) return; node.textContent = text; node.toggleAttribute('data-human', human) }
      fact(source, value.source ?? t('Unavailable'), value.source === null)
      fact(observedAt, formatDisplayDateTime(value.observedAt), false)
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-versions"] tbody:not([data-whm-php-usage])')
      if (body) {
        body.textContent = ''
        for (const version of value.versions) { const row = document.createElement('tr'); cell(row, version.version, true); cell(row, t('Not read')); cell(row, !version.supported ? t('Package installed; version outside supported provisioning') : version.binary.state === 'read' ? t('Package + CLI binary; FPM unverified') : t('Package installed; binary unverified')); body.append(row) }
        if (!value.versions.length) empty(body, 3, value.state === 'read' ? t('No installed PHP runtime packages were returned.') : t('Installed PHP inventory is unavailable.'))
      }
      for (const name of ['php-selected-version', 'php-extension-version', 'php-version']) {
        const control = select(name)
        if (!control) continue
        const previous = control.value; control.textContent = ''
        for (const version of value.versions) { const option = document.createElement('option'); option.value = version.version; option.textContent = version.version; control.append(option) }
        if (value.versions.some(version => version.version === previous)) control.value = previous
        control.disabled = value.state !== 'read' || value.versions.length === 0 || !admitted()
      }
      paintVersion(select('php-selected-version')?.value ?? value.versions[0]?.version ?? '')
    }
    const paintUsage = (usage: PhpUsageView[]): void => {
      const body = root.querySelector<HTMLElement>('[data-whm-php-usage]')
      if (!body) return
      body.textContent = ''
      for (const item of usage) for (const domain of item.domains) { const row = document.createElement('tr'); cell(row, item.version, true); cell(row, domain.name, true); cell(row, domain.account ?? t('Account not read')); cell(row, domain.handler, true); body.append(row) }
      if (!body.childElementCount) empty(body, 4, t('The saved domain read returned no PHP assignments.'))
    }
    // ---- server-wide writes: every host change is previewed, confirmed and submitted as a tested job
    const writable = (): boolean => admitted() && manage?.state === 'read' && manage.manage && typeof askDialog === 'function'
    const hook = (name: string): HTMLButtonElement | null => page.querySelector<HTMLButtonElement>('[data-php-action="' + name + '"]')
    const live = (control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement | null, on: boolean): void => { if (!control) return; control.removeAttribute('data-wiring'); control.disabled = !on }
    const sectionNote = (section: string, state: string, message: string): void => {
      const card = page.querySelector<HTMLElement>('[data-whm-detail-section="' + section + '"]')
      if (!card) return
      let node = card.querySelector<HTMLElement>('[data-php-manage-status]')
      if (!node) { node = document.createElement('p'); node.className = 'xp-whm-detail-status'; node.dataset.phpManageStatus = ''; card.append(node) }
      node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status')
    }
    const failure = (error: unknown): string => { const detail = error && typeof error === 'object' ? (error as { message?: unknown }).message : null; return typeof detail === 'string' && detail.length < 300 ? detail : t('The request failed. Nothing was changed.') }
    const confirmed = async (title: string, body: string, danger = false): Promise<boolean> => { try { return await askDialog!({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } }
    const paintManagedExtensions = (version: string): void => {
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-extensions"] tbody')
      const current = manage?.versions.find(item => item.version === version)
      if (!body) return
      if (!current) { empty(body, 4, t('No selected version has been read.')); return }
      body.textContent = ''
      for (const item of current.extensions) {
        const row = document.createElement('tr'); cell(row, item.module, true); cell(row, item.package ? 'php' + version + '-' + item.package : '—', true)
        const td = document.createElement('td'), box = document.createElement('input'); box.type = 'checkbox'; box.checked = item.enabled === true; box.dataset.phpExtension = item.module
        box.setAttribute('aria-label', t('Enable {extension} for PHP {version}', { extension: item.module, version }))
        box.disabled = !writable() || !manage!.extensionsWritable || item.enabled === null || (!item.installed && !item.package)
        box.addEventListener('change', () => { void switchExtension(version, item.module, box) })
        td.append(box); row.append(td)
        cell(row, !item.installed ? t('Package not installed') : item.enabled ? t('On') : t('Off')); body.append(row)
      }
      page.querySelectorAll<HTMLElement>('[data-whm-detail-section="php-extensions"] [data-php-extension-draft-grid]').forEach(grid => { grid.hidden = true })
    }
    const paintManage = (): void => {
      if (!manage) return
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-versions"] tbody:not([data-whm-php-usage])')
      if (body && manage.state === 'read') {
        body.textContent = ''
        for (const item of manage.versions) {
          const row = document.createElement('tr'); cell(row, item.version, true); cell(row, item.version === manage.defaultVersion ? t('Default') : '—')
          const life = item.lifecycle === 'end-of-life' ? t('End of life') : item.lifecycle === 'security' ? t('Security fixes') : item.lifecycle === 'active' ? t('Active support') : t('Not read')
          cell(row, (item.fpmInstalled ? '' : t('FPM not installed') + ' · ') + life + ' · ' + (item.domainCount ? t('Used by {domains} domains · {accounts} accounts', { domains: String(item.domainCount), accounts: String(item.accountCount) }) : t('No domains'))); body.append(row)
        }
      }
      const installed = manage.versions.filter(item => item.fpmInstalled).map(item => item.version)
      for (const name of ['php-selected-version', 'php-extension-version', 'php-version']) {
        const control = select(name)
        if (!control || manage.state !== 'read') continue
        const previous = control.value; control.textContent = ''
        for (const version of name === 'php-selected-version' ? manage.versions.map(item => item.version) : installed) { const option = document.createElement('option'); option.value = version; option.textContent = version; control.append(option) }
        control.value = previous && [...control.options].some(option => option.value === previous) ? previous : manage.defaultVersion
        if (!control.value && control.options.length) control.selectedIndex = 0
        live(control, admitted() && control.options.length > 0)
      }
      const install = page.querySelector<HTMLInputElement>('[name="php-install-request"]')
      if (install) { live(install, writable()); install.placeholder = manage.installable.join(', ') }
      for (const name of ['set-default', 'reinstall-version', 'remove-version', 'confirm-remove', 'cancel-remove', 'install-version', 'apply-ini', 'discard-ini']) live(hook(name), writable())
      paintIni()
      paintVersion(select('php-extension-version')?.value ?? '')
      paintExceptions()
      if (!writable()) sectionNote('php-versions', 'unavailable', t('PHP management is unavailable on this host. Nothing was changed.'))
    }
    const INI_FIELDS = ['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars'] as const
    const paintIni = (): void => {
      const current = manage?.versions.find(item => item.version === select('php-version')?.value)
      for (const name of INI_FIELDS) { const input = page.querySelector<HTMLInputElement>('[name="' + name + '"]'); if (input) { input.value = current?.ini?.[name] ?? ''; live(input, writable() && current?.ini !== null) } }
      if (current && current.ini === null) sectionNote('php-configure', 'failed', t('The managed php.ini file was changed outside xPanel. Fix it on the host before saving here.'))
    }
    /** Preview on the host, confirm with the user, then submit the reviewed job. */
    const submit = async (section: string, input: Record<string, unknown>, title: string, body: string, danger = false): Promise<void> => {
      if (!writable() || busy || !manage?.revision) return
      busy = true; root.setAttribute('aria-busy', 'true'); sectionNote(section, 'reading', t('Checking the change on the host…'))
      try {
        const payload = { ...input, expectedRevision: manage.revision }
        const result = await request!('POST', '/api/server/php/manage/preview', payload) as { preview?: { state?: string; reason?: string | null } }
        if (result.preview?.state !== 'ready') { sectionNote(section, 'failed', t('Not applied: {reason}', { reason: String(result.preview?.reason ?? 'unknown') })); return }
        busy = false
        if (!await confirmed(title, body, danger)) { sectionNote(section, 'read', t('Cancelled. Nothing was changed.')); return }
        busy = true
        const applied = await request!('POST', '/api/server/php/manage/apply', payload) as { job?: { referenceCode?: unknown } }
        const reference = applied.job?.referenceCode
        sectionNote(section, 'stored', t('Submitted as job {reference}. php-fpm -t runs before pools reload; a failed test restores the previous configuration.', { reference: typeof reference === 'string' && reference.trim() ? reference : t('Unnumbered') }))
      } catch (error) { sectionNote(section, 'failed', failure(error)) }
      finally { busy = false; root.setAttribute('aria-busy', 'false') }
    }
    const switchExtension = async (version: string, extension: string, box: HTMLInputElement): Promise<void> => {
      const enabled = box.checked
      box.checked = !enabled
      await submit('php-extensions', { operation: 'set-extension', version, extension, enabled }, enabled ? t('Enable {extension} for PHP {version}', { extension, version }) : t('Disable {extension} for PHP {version}', { extension, version }), t('The account pools on PHP {version} reload after php-fpm -t passes.', { version }))
    }
    const selectedVersion = (): string | null => { const value = select('php-selected-version')?.value; return value ? value : (sectionNote('php-versions', 'failed', t('Choose a version first.')), null) }
    const wire = (name: string, run: () => void): void => { hook(name)?.addEventListener('click', () => { if (writable()) run() }) }
    wire('set-default', () => {
      const version = selectedVersion(); if (!version || !manage?.revision) return
      busy = true
      request!('PUT', '/api/server/php/default', { version, expectedRevision: manage.revision })
        .then(() => { sectionNote('php-versions', 'stored', t('PHP {version} is now the default for new domains. Existing domains keep their version.', { version })); busy = false; return load() })
        .catch(error => { busy = false; sectionNote('php-versions', 'failed', failure(error)) })
    })
    wire('remove-version', () => { const details = hook('confirm-remove')?.closest('details'); if (details) details.open = true })
    wire('cancel-remove', () => { const details = hook('confirm-remove')?.closest('details'); if (details) details.open = false })
    wire('confirm-remove', () => { const version = selectedVersion(); if (version) void submit('php-versions', { operation: 'remove-version', version }, t('Remove PHP {version}?', { version }), t('This removes its packages. No domain uses it.'), true) })
    wire('reinstall-version', () => { const version = selectedVersion(); if (version) void submit('php-versions', { operation: 'install-version', version }, t('Install PHP {version}?', { version }), t('Existing domains keep their version.')) })
    wire('install-version', () => {
      const version = page.querySelector<HTMLInputElement>('[name="php-install-request"]')?.value.trim() ?? ''
      if (!manage?.installable.includes(version)) { sectionNote('php-install', 'failed', t('Choose one of: {versions}', { versions: manage?.installable.join(', ') ?? '' })); return }
      void submit('php-install', { operation: 'install-version', version }, t('Install PHP {version}?', { version }), t('Existing domains keep their version.'))
    })
    wire('discard-ini', () => paintIni())
    wire('apply-ini', () => {
      const version = select('php-version')?.value, current = manage?.versions.find(item => item.version === version)
      if (!version || !current?.ini) return
      const ini: Record<string, string> = { ...current.ini }
      for (const name of INI_FIELDS) { const value = page.querySelector<HTMLInputElement>('[name="' + name + '"]')?.value.trim() ?? ''; if (value) ini[name] = value; else delete ini[name] }
      void submit('php-configure', { operation: 'set-ini', version, ini }, t('Change php.ini for PHP {version}?', { version }), t('Saved and checked with php-fpm -t before pools reload.'))
    })
    select('php-version')?.addEventListener('change', () => paintIni())
    // ---- dangerous-function exceptions: desired state, rendered into every pool of the account and tested by the reconciler
    const EXCEPTION_FUNCTIONS = ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen']
    const exceptionWrite = async (method: string, path: string, body: Record<string, unknown>, done: string): Promise<void> => {
      if (!writable() || busy || !manage) return
      busy = true; sectionNote('php-functions', 'reading', t('Checking the change on the host…'))
      try {
        await request!(method, path, { ...body, expectedRevision: manage.exceptionsRevision })
        sectionNote('php-functions', 'stored', done)
        busy = false; await load()
      } catch (error) { sectionNote('php-functions', 'failed', failure(error)) }
      finally { busy = false }
    }
    const paintExceptions = (): void => {
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-functions"] tbody')
      if (!body || !manage) return
      body.textContent = ''
      for (const item of manage.exceptions) {
        const row = document.createElement('tr'); cell(row, item.account, true); cell(row, item.functions.join(', '), true); cell(row, item.reason)
        const td = document.createElement('td'), revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'xp-btn'; revoke.textContent = t('Revoke'); revoke.disabled = !writable()
        revoke.setAttribute('aria-label', t('Revoke {functions} for {account}', { functions: item.functions.join(', '), account: item.account }))
        revoke.addEventListener('click', () => { void confirmed(t('Revoke {functions} for {account}', { functions: item.functions.join(', '), account: item.account }), t('Their pools reload without the exception after php-fpm -t passes.'), true).then(yes => { if (yes) void exceptionWrite('DELETE', '/api/server/php/exceptions/' + item.account, {}, t('Revoked. Every account runs with these functions disabled unless granted.')) }) })
        td.append(revoke); row.append(td); body.append(row)
      }
      if (!body.childElementCount) empty(body, 4, t('No exceptions. Every account runs with all six functions disabled.'))
      for (const name of ['php-exception-account', 'php-exception-reason', ...EXCEPTION_FUNCTIONS.map(fn => 'php-exception-' + fn)]) live(page.querySelector<HTMLInputElement>('[name="' + name + '"]'), writable())
      live(hook('add-exception'), writable()); live(hook('grant-exception'), writable())
    }
    wire('add-exception', () => { const details = hook('grant-exception')?.closest('details'); if (details) details.open = true })
    wire('grant-exception', () => {
      const account = select('php-exception-account')?.value ?? '', reason = page.querySelector<HTMLTextAreaElement>('[name="php-exception-reason"]')?.value.trim() ?? ''
      const functions = EXCEPTION_FUNCTIONS.filter(fn => page.querySelector<HTMLInputElement>('[name="php-exception-' + fn + '"]')?.checked)
      if (!account || !reason || !functions.length) { sectionNote('php-functions', 'failed', t('Choose an account, at least one function and a reason.')); return }
      void confirmed(t('Allow {functions} for {account}?', { functions: functions.join(', '), account }), t('Recorded in the audit log with your name. The account pools reload after php-fpm -t passes.'), true)
        .then(yes => { if (yes) void exceptionWrite('POST', '/api/server/php/exceptions', { account, functions, reason }, t('Exception saved. The account pools reload with it.')) })
    })
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Reading installed PHP inventory and saved domain assignments…'))
      const results = await Promise.allSettled([request('GET', '/api/server/php/inventory').then(readPhpInventoryView), request('GET', '/api/server/php/usage').then(readPhpUsageView), request('GET', '/api/server/php/manage').then(readPhpManageView)])
      if (admitted()) {
        const [runtime, usage, managed] = results
        manage = managed.status === 'fulfilled' ? managed.value : null
        if (runtime.status === 'fulfilled') paintInventory(runtime.value)
        if (usage.status === 'fulfilled') paintUsage(usage.value)
        paintManage()
        const complete = runtime.status === 'fulfilled' && runtime.value.state === 'read' && usage.status === 'fulfilled'
        note(complete ? 'read' : 'failed', complete
          ? t('Package inventory and saved assignments read. FPM extension enablement, global defaults and application requests remain unverified.')
          : t('Some PHP reads are unavailable. Any retained observations are from the last successful read; no installed runtime or applied change is assumed.'))
      }
      busy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false')
    }
    if (!request || !admitted()) { refresh.disabled = true; note('unavailable', t('PHP inventory is unavailable here. Nothing was read or changed.')); return }
    for (const name of ['php-selected-version', 'php-extension-version', 'php-version']) select(name)?.addEventListener('change', event => { const control = event.target as HTMLSelectElement; if (admitted() && !control.disabled) paintVersion(control.value) })
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}

export const WHM_PHP_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPhpInventoryView=${readPhpInventoryView.toString()};const readPhpUsageView=${readPhpUsageView.toString()};const readPhpManageView=${readPhpManageView.toString()};return ${bindWhmPhp.toString()};})()`
