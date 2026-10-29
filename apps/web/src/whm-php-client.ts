import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'

const formatDisplayDateTime = canonicalFormatDisplayDateTime

type PhpPackageView = { name: string; version: string; component: string }
type PhpVersionView = { version: string; supported: boolean; packages: PhpPackageView[]; binary: { state: 'read' | 'unavailable'; scope: 'cli-without-ini'; version?: string; builtInExtensions?: string[] }; extensionEnablement: 'not-read'; fpmRequest: 'not-read' }
export type PhpInventoryView = { state: 'read' | 'unavailable'; source: 'dpkg' | 'rpm' | null; observedAt: string; versions: PhpVersionView[] }
type PhpUsageView = { version: string; domains: { name: string; account: string | null; handler: string }[] }

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

function bindWhmPhp(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-php-workspace]').forEach(root => {
    if (root.dataset.phpBound === 'true') return
    root.dataset.phpBound = 'true'
    const page = root.closest<HTMLElement>('[data-whm-detail-route="/whm/software/php"]')
    const status = root.querySelector<HTMLElement>('[data-whm-php-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-php-refresh]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    if (!page || !status || !refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = () => root.isConnected && root.dataset.phpCanRead === 'true' && !root.closest(denied)
    let busy = false, inventory: PhpInventoryView | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), text = document.createElement(technical ? 'bdi' : 'span'); if (technical) text.dir = 'ltr'; text.textContent = value; td.append(text); row.append(td) }
    const empty = (body: HTMLElement | null, count: number, message: string): void => { if (!body) return; body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = count; td.textContent = message; row.append(td); body.append(row) }
    const select = (name: string): HTMLSelectElement | null => page.querySelector<HTMLSelectElement>('[name="' + name + '"]')
    const paintVersion = (version: string): void => {
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
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Reading installed PHP inventory and saved domain assignments…'))
      const results = await Promise.allSettled([request('GET', '/api/server/php/inventory').then(readPhpInventoryView), request('GET', '/api/server/php/usage').then(readPhpUsageView)])
      if (admitted()) {
        const [runtime, usage] = results
        if (runtime.status === 'fulfilled') paintInventory(runtime.value)
        if (usage.status === 'fulfilled') paintUsage(usage.value)
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

export const WHM_PHP_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPhpInventoryView=${readPhpInventoryView.toString()};const readPhpUsageView=${readPhpUsageView.toString()};return ${bindWhmPhp.toString()};})()`
