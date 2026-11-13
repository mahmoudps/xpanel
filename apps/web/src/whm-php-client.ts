import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import { assertWhmClientTemplates as canonicalAssertWhmClientTemplates, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate, WHM_CLIENT_TEMPLATE_BINDING } from './whm-client-templates.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest

const formatDisplayDateTime = canonicalFormatDisplayDateTime
const assertWhmClientTemplates = canonicalAssertWhmClientTemplates, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

type PhpPackageView = { name: string; version: string; component: string }
type PhpVersionView = { version: string; supported: boolean; packages: PhpPackageView[]; binary: { state: 'read' | 'unavailable'; scope: 'cli-without-ini'; version?: string; builtInExtensions?: string[] }; extensionEnablement: 'not-read'; fpmRequest: 'not-read' }
export type PhpInventoryView = { state: 'read' | 'unavailable'; source: 'dpkg' | 'rpm' | null; observedAt: string; versions: PhpVersionView[] }
type PhpUsageView = { version: string; domains: { name: string; account: string | null; handler: string }[] }
type PhpManageExtension = { module: string; package: string | null; installed: boolean; enabled: boolean | null }
type PhpManageVersion = { version: string; fpmInstalled: boolean; ini: Record<string, string> | null; extensions: PhpManageExtension[]; lifecycle: string; domainCount: number; accountCount: number }
type PhpException = { account: string; functions: string[]; reason: string; grantedAt: string; grantedBy: string }
type PhpPoolDefaultsClientView = {
  pool: { mode: 'ondemand' | 'dynamic' | 'static'; maxChildren: number; startServers: number; minSpareServers: number; maxSpareServers: number; maxRequests: number; processIdleTimeoutSec: number }
  revision: string
  updatedAt: string | null
  poolCount: number
}
export type PhpManageView = { state: 'read' | 'unavailable'; revision: string | null; manage: boolean; defaultVersion: string; versions: PhpManageVersion[]; installable: string[]; extensionsWritable: boolean; exceptions: PhpException[]; exceptionsRevision: string; poolDefaults?: PhpPoolDefaultsClientView }

/** /api/server/php/manage: host observation plus the saved default and usage; anything malformed is refused. */
export function readPhpManageView(value: unknown): PhpManageView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const version = (item: unknown): item is string => typeof item === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(item)
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !(value.revision === null || typeof value.revision === 'string' && /^[0-9a-f]{64}$/.test(value.revision)) || !version(value.defaultVersion) || !Array.isArray(value.versions) || value.versions.length > 32 || !Array.isArray(value.installable) || !value.installable.every(version) || !object(value.capabilities) || !object(value.actions)) throw new Error('invalid_php_manage')
  if (value.installable.length > 32 || new Set(value.installable).size !== value.installable.length) throw new Error('invalid_php_manage')
  const seenVersions = new Set<string>()
  const versions = value.versions.map(raw => {
    if (!object(raw) || !version(raw.version) || typeof raw.fpmInstalled !== 'boolean' || !(raw.ini === null || object(raw.ini)) || !Array.isArray(raw.extensions) || raw.extensions.length > 256 || !object(raw.lifecycle) || !Number.isSafeInteger(raw.domainCount) || !Number.isSafeInteger(raw.accountCount)) throw new Error('invalid_php_manage')
    if (seenVersions.has(raw.version) || (raw.domainCount as number) < 0 || (raw.accountCount as number) < 0) throw new Error('invalid_php_manage')
    seenVersions.add(raw.version)
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
  let poolDefaults: PhpPoolDefaultsClientView | undefined
  if (value.poolDefaults !== undefined) {
    const pd = value.poolDefaults
    if (!object(pd) || !object(pd.pool) || typeof pd.revision !== 'string' || !/^[0-9a-f]{64}$/.test(pd.revision) || !(pd.updatedAt === null || typeof pd.updatedAt === 'string' && Number.isFinite(Date.parse(pd.updatedAt))) || !Number.isSafeInteger(pd.poolCount) || (pd.poolCount as number) < 0) throw new Error('invalid_php_manage')
    const p = pd.pool
    if (!['ondemand', 'dynamic', 'static'].includes(String(p.mode)) || !['maxChildren', 'startServers', 'minSpareServers', 'maxSpareServers', 'maxRequests', 'processIdleTimeoutSec'].every(k => Number.isSafeInteger(p[k]) && (p[k] as number) >= 1)) throw new Error('invalid_php_manage')
    poolDefaults = {
      pool: {
        mode: p.mode as 'ondemand' | 'dynamic' | 'static',
        maxChildren: p.maxChildren as number,
        startServers: p.startServers as number,
        minSpareServers: p.minSpareServers as number,
        maxSpareServers: p.maxSpareServers as number,
        maxRequests: p.maxRequests as number,
        processIdleTimeoutSec: p.processIdleTimeoutSec as number,
      },
      revision: pd.revision,
      updatedAt: pd.updatedAt as string | null,
      poolCount: pd.poolCount as number,
    }
  }
  return { state: value.state as 'read' | 'unavailable', revision: value.revision as string | null, manage: value.actions.manage === true, defaultVersion: value.defaultVersion, versions, installable: value.installable as string[], extensionsWritable: value.capabilities.extensions === true, exceptions, exceptionsRevision: value.exceptionsRevision, ...(poolDefaults ? { poolDefaults } : {}) }
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
    const transport = frameRequest(root)
    if (!page || !status || !refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    let templateContractIntact = true, domDirty = true
    const observedFragments = new WeakSet<DocumentFragment>()
    const observeOpts = { subtree: true, childList: true, attributes: true, characterData: true } as const
    const domObserver = new MutationObserver(() => {
      if (!root.isConnected) { domObserver.disconnect(); return }
      domDirty = true
    })
    domObserver.observe(document, observeOpts)
    const syncClean = <T>(fn: () => T): T => {
      const wasDirty = domDirty || domObserver.takeRecords().length > 0
      try { return fn() } finally {
        if (!wasDirty) { domObserver.takeRecords(); domDirty = false }
        else domDirty = true
      }
    }
    const unsafePhpTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'TEXTAREA', 'SELECT', 'A', 'IMG', 'AUDIO', 'VIDEO', 'SOURCE', 'LINK', 'META', 'BASE', 'BUTTON'])
    const unsafePhpAttrs = new Set(['id', 'api-url', 'data-api-url', 'data-action', 'data-xp-action', 'data-php-action', 'data-presentation-tabs', 'data-presentation-tab', 'data-presentation-tab-link', 'href', 'src', 'srcset', 'formaction', 'contenteditable'])
    const admitted = () => templateContractIntact && root.isConnected && root.dataset.phpCanRead === 'true' && typeof transport === 'function'
    let busy = false, confirmationPending = false, inventory: PhpInventoryView | null = null, manage: PhpManageView | null = null, savedUsage: PhpUsageView[] | null = null
    const note = (state: string, message: string): void => syncClean(() => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') })
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), text = document.createElement(technical ? 'bdi' : 'span'); if (technical) text.dir = 'ltr'; text.textContent = value; td.append(text); row.append(td) }
    const empty = (body: HTMLElement | null, count: number, message: string): void => { if (!body) return; body.textContent = ''; const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = count; td.textContent = message; row.append(td); body.append(row) }
    const select = (name: string): HTMLSelectElement | null => page.querySelector<HTMLSelectElement>('[name="' + name + '"]')
    const layout = root.dataset.phpVersionLayout, entries = root.querySelector<HTMLElement>('[data-whm-php-version-entries]')
    const disableNative = (): void => {
      page.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => {
        if (control instanceof HTMLButtonElement && control.type === 'button' && control.getAttribute('role') === 'tab' && control.hasAttribute('data-presentation-tab') && control.closest('[data-php-editor-modes][data-presentation-tabs]') && !control.matches('[data-php-action],[data-php-version-command],[data-php-install-pick],[data-php-exception-revoke]')) return
        control.disabled = true
      })
    }
    const verifyTemplates = (): boolean => {
      if (!admitted()) { if (!root.isConnected) domObserver.disconnect(); disableNative(); note('unavailable', t('Unavailable')); return false }
      if (domObserver.takeRecords().length > 0) domDirty = true
      if (!domDirty) return true
      try {
        if (!['cards', 'table'].includes(layout ?? '') || root.dataset.phpVersionLayout !== layout || !entries || entries.tagName !== (layout === 'cards' ? 'DIV' : 'TBODY')) throw new Error('invalid_php_workspace')
        for (const [selector, expected, tag] of [['[data-whm-php-status]', status, 'P'], ['[data-whm-php-refresh]', refresh, 'BUTTON'], ['[data-whm-php-version-entries]', entries, layout === 'cards' ? 'DIV' : 'TBODY']] as const) {
          const nodes = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-whm-php-workspace]') === root)
          if (nodes.length !== 1 || nodes[0] !== expected || expected.tagName !== tag) throw new Error('invalid_php_workspace')
        }
        if (refresh.type !== 'button') throw new Error('invalid_php_workspace')
        const contracts = [
          ['whm-php-version-entry', layout === 'cards' ? 'article' : 'tr', { version: 'bdi', 'default-holder': 'span', 'default-label': 'span', lifecycle: 'span', binary: 'span', fpm: 'span', usage: 'span', packages: 'div', actions: 'div' }],
          ['whm-php-versions-empty', layout === 'cards' ? 'p' : 'tr', { content: 'span' }],
          ['whm-php-status', 'p', { content: 'span' }], ['whm-php-revoke', 'button', { content: 'span' }],
          ['whm-php-extension-switch', 'div', { input: 'input', state: 'span' }],
          ['whm-php-version-action', 'button', { content: 'span' }], ['whm-php-version-remove', 'button', { content: 'span' }], ['whm-php-version-tab', 'button', { content: 'bdi' }],
        ] as const
        assertWhmClientTemplates(root, contracts)
        for (const [name, tag] of contracts) {
          const template = clientTemplate(root, name), node = cloneClientTemplate(template, tag, [])
          if (template.closest('[data-whm-php-workspace]') !== root) throw new Error('invalid_php_template')
          if (!observedFragments.has(template.content)) { domObserver.observe(template.content, observeOpts); observedFragments.add(template.content) }
          let inputCount = 0
          for (const stack: Element[] = [node]; stack.length;) {
            const item = stack.pop()!, itemTag = item.tagName
            if (item !== node) {
              if (unsafePhpTags.has(itemTag)) throw new Error('invalid_php_template')
              if (itemTag === 'INPUT') inputCount++
            }
            for (let i = 0; i < item.attributes.length; i++) {
              const attrName = item.attributes[i]!.name
              if (/^on/i.test(attrName) || unsafePhpAttrs.has(attrName)) throw new Error('invalid_php_template')
            }
            for (let child = item.firstElementChild; child; child = child.nextElementSibling) stack.push(child)
          }
          if (node instanceof HTMLButtonElement && (node.type !== 'button' || !node.disabled || name !== 'whm-php-version-tab' && node.hasAttribute('role') && node.getAttribute('role') !== 'button')) throw new Error('invalid_php_button')
          if (name === 'whm-php-version-entry' && (clientTemplateSlot(node, 'version', 'bdi').getAttribute('dir') !== 'ltr' || layout === 'table' && (node.children.length !== 6 || [...node.children].some(cell => cell.tagName !== 'TD')))) throw new Error('invalid_php_version_template')
          if (name === 'whm-php-versions-empty' && layout === 'table' && (node.children.length !== 1 || node.firstElementChild?.tagName !== 'TD' || (node.firstElementChild as HTMLTableCellElement).colSpan !== 6)) throw new Error('invalid_php_empty_template')
          if (name === 'whm-php-version-tab' && (node.getAttribute('role') !== 'tab' || clientTemplateSlot(node, 'content', 'bdi').getAttribute('dir') !== 'ltr')) throw new Error('invalid_php_version_tab')
          if (name === 'whm-php-extension-switch') { const input = clientTemplateSlot(node, 'input', 'input') as HTMLInputElement; if (input.type !== 'checkbox' || !input.disabled || input.hasAttribute('role') || inputCount !== 1) throw new Error('invalid_php_extension_switch') }
          else if (inputCount > 0) throw new Error('invalid_php_template')
        }
        for (const name of ['php-selected-version', 'php-extension-version', 'php-version', 'php-install-request', 'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'php-exception-account', 'php-exception-reason', 'php-pool-mode', 'php-pool-max-children', 'php-pool-idle-timeout', 'php-pool-start-servers', 'php-pool-min-spare', 'php-pool-max-spare', 'php-pool-max-requests']) if (page.querySelectorAll('[name="' + name + '"]').length > 1) throw new Error('ambiguous_php_control')
        for (const name of ['set-default', 'reinstall-version', 'remove-version', 'confirm-remove', 'cancel-remove', 'install-version', 'apply-ini', 'discard-ini', 'add-exception', 'grant-exception', 'apply-pool', 'discard-pool']) if (page.querySelectorAll('[data-php-action="' + name + '"]').length > 1) throw new Error('ambiguous_php_action')
        const lists = page.querySelectorAll<HTMLElement>('[data-php-version-tabs]'), panels = page.querySelectorAll<HTMLElement>('[data-php-version-panel]')
        if (lists.length || panels.length) {
          if (lists.length !== 1 || panels.length !== 1 || lists[0]!.tagName !== 'DIV' || panels[0]!.tagName !== 'DIV' || !/^[a-z][a-z0-9-]{0,95}$/.test(panels[0]!.id) || [...document.querySelectorAll('[id]')].filter(node => node.id === panels[0]!.id).length !== 1) throw new Error('invalid_php_version_panel')
        }
        domObserver.takeRecords()
        domDirty = false
        return true
      } catch { templateContractIntact = false; domObserver.disconnect(); disableNative(); note('unavailable', t('Unavailable')); return false }
    }
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!verifyTemplates()) throw new Error('php_workspace_unavailable')
      const result = body === undefined ? await transport!(method, path) : await transport!(method, path, body)
      if (!verifyTemplates()) throw new Error('php_workspace_unavailable')
      return result
    }
    const technical = (text: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = text; return node }
    const visualButton = (name: 'whm-php-version-action' | 'whm-php-version-remove' | 'whm-php-revoke', label: string): HTMLButtonElement => {
      const node = cloneClientTemplate(clientTemplate(root, name), 'button', ['content']) as HTMLButtonElement
      clientTemplateSlot(node, 'content', 'span').textContent = label; return node
    }
    const paintEntries = (): void => {
      if (!entries) return
      const previous = document.activeElement instanceof HTMLElement && entries.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-php-version-entry]')?.dataset.phpVersionEntry : undefined
      const versions = inventory?.state === 'read' ? inventory.versions : []
      const result = document.createDocumentFragment(), replacements = new Map<string, HTMLElement>()
      for (const item of versions) {
        const node = cloneClientTemplate(clientTemplate(root, 'whm-php-version-entry'), layout === 'cards' ? 'article' : 'tr', [])
        node.dataset.phpVersionEntry = item.version; node.tabIndex = -1; replacements.set(item.version, node)
        const current = manage?.state === 'read' ? manage.versions.find(version => version.version === item.version) : undefined
        const isDefault = !!current && manage?.defaultVersion === item.version
        clientTemplateSlot(node, 'version', 'bdi').textContent = 'PHP ' + item.version
        clientTemplateSlot(node, 'default-holder', 'span').hidden = !isDefault; clientTemplateSlot(node, 'default-label', 'span').textContent = t('Default')
        node.dataset.phpDefault = String(isDefault)
        const lifecycle = current?.lifecycle ?? 'not-read'; node.dataset.phpLifecycle = ['active', 'security', 'end-of-life'].includes(lifecycle) ? lifecycle : 'not-read'
        clientTemplateSlot(node, 'lifecycle', 'span').textContent = current?.lifecycle === 'active' ? t('Active support') : current?.lifecycle === 'security' ? t('Security fixes') : current?.lifecycle === 'end-of-life' ? t('End of life') : t('Not read')
        const binary = clientTemplateSlot(node, 'binary', 'span'); binary.replaceChildren(item.binary.state === 'read' ? technical(String(item.binary.version)) : t('Not read'))
        clientTemplateSlot(node, 'fpm', 'span').textContent = current ? current.fpmInstalled ? t('FPM package installed') : t('FPM not installed') : t('Not read')
        const assignment = savedUsage?.find(row => row.version === item.version)
        clientTemplateSlot(node, 'usage', 'span').textContent = current ? t('Used by {domains} domains · {accounts} accounts', { domains: String(current.domainCount), accounts: String(current.accountCount) }) : savedUsage ? t('Domains') + ': ' + String(assignment?.domains.length ?? 0) : t('Not read')
        const packages = clientTemplateSlot(node, 'packages', 'div')
        for (const pkg of item.packages) packages.append(technical(pkg.name + ' ' + pkg.version))
        if (!item.packages.length) packages.textContent = t('No installed PHP runtime packages were returned.')
        if (!item.supported) { const warning = document.createElement('p'); warning.textContent = t('Package installed; version outside supported provisioning'); packages.append(warning) }
        const actions = clientTemplateSlot(node, 'actions', 'div')
        for (const [command, label] of [['set-default', t('Set as default')], ['remove-version', t('Remove version')]] as const) {
          const action = visualButton(command === 'remove-version' ? 'whm-php-version-remove' : 'whm-php-version-action', label)
          action.dataset.phpVersionCommand = command; action.disabled = !writable() || !current || (command === 'set-default' ? isDefault || !current.fpmInstalled : isDefault || current.domainCount !== 0)
          action.addEventListener('click', () => {
            if (action.disabled || busy || confirmationPending || !action.isConnected || !page.contains(action) || !verifyTemplates() || !writable()) return
            const selected = select('php-selected-version'), target = hook(command)
            if (!selected || selected.disabled || ![...selected.options].some(option => option.value === item.version) || !target || target.disabled) return
            selected.value = item.version; target.click()
          })
          actions.append(action)
        }
        if (!current || isDefault || current.domainCount !== 0) { const reason = document.createElement('p'); reason.textContent = !current ? t('Not read') : isDefault ? t('Default') : t('Used by {domains} domains · {accounts} accounts', { domains: String(current.domainCount), accounts: String(current.accountCount) }); actions.append(reason) }
        result.append(node)
      }
      if (!versions.length) {
        const empty = cloneClientTemplate(clientTemplate(root, 'whm-php-versions-empty'), layout === 'cards' ? 'p' : 'tr', ['content'])
        clientTemplateSlot(empty, 'content', 'span').textContent = inventory?.state === 'read' ? t('No installed PHP runtime packages were returned.') : t('Installed PHP inventory is unavailable.'); result.append(empty)
      }
      entries.replaceChildren(result)
      if (previous) replacements.get(previous)?.focus()
    }
    const paintInstallable = (): void => {
      const list = page.querySelector<HTMLElement>('[data-whm-php-installable]'); if (!list) return
      list.replaceChildren()
      for (const version of manage?.state === 'read' ? manage.installable : []) {
        const row = document.createElement('li'), label = technical('PHP ' + version), action = visualButton('whm-php-version-action', t('Install selected PHP version'))
        action.dataset.phpInstallPick = version; action.disabled = !writable()
        action.addEventListener('click', () => { if (action.disabled || busy || confirmationPending || !action.isConnected || !verifyTemplates() || !writable() || !manage?.installable.includes(version)) return; const input = page.querySelector<HTMLInputElement>('[name="php-install-request"]'), target = hook('install-version'); if (input && !input.disabled && target && !target.disabled) { input.value = version; target.click() } })
        row.append(label, action); list.append(row)
      }
      if (!list.childElementCount) { const row = document.createElement('li'); row.textContent = manage?.state === 'read' ? t('None') : t('Not read'); list.append(row) }
    }
    const paintHandlerMatrix = (): void => {
      const body = page.querySelector<HTMLTableSectionElement>('[data-whm-php-handler-rows]'), head = body?.closest('table')?.tHead?.rows[0]
      if (!body || !head) return
      const versions = inventory?.state === 'read' ? inventory.versions.map(item => item.version) : []
      const columns = versions.length ? versions : [t('Not read')]
      head.replaceChildren(); body.replaceChildren()
      for (const [index, label] of [t('Handler'), t('Runs as'), t('Where it runs'), ...columns, t('Domains'), t('Offered to accounts')].entries()) { const cell = document.createElement('th'); cell.scope = 'col'; if (versions.length && index >= 3 && index < 3 + versions.length) cell.append(technical(label)); else cell.textContent = label; head.append(cell) }
      for (const [name, key, engine, identity] of [['PHP-FPM', 'fpm', 'Apache', t('Per-account pool')], ['CGI / suexec', 'cgi', 'Apache', t('Account UID')], ['suPHP', 'suphp', 'Apache', t('Account UID')], ['lsphp', 'lsphp', 'OpenLiteSpeed', t('Account external app')]] as const) {
        const row = document.createElement('tr'); cell(row, name, true); cell(row, identity); cell(row, engine, true)
        for (const _version of columns) cell(row, t('Not read'))
        cell(row, savedUsage ? String(savedUsage.flatMap(item => item.domains).filter(domain => domain.handler === key).length) : t('Not read'), savedUsage !== null)
        const td = document.createElement('td'), control = visualButton('whm-php-version-action', t('Not read')); control.disabled = true; control.dataset.phpUnavailable = 'handler'; td.append(control); row.append(td); body.append(row)
      }
    }
    const paintVersion = (version: string): void => {
      if (manage?.state === 'read') { paintManagedExtensions(version); return }
      const current = inventory?.versions.find(item => item.version === version)
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-extensions"] tbody')
      if (!current) { empty(body, 4, t('No selected version has been read.')); return }
      if (body) {
        body.textContent = ''
        const builtIn = current.binary.builtInExtensions ?? []
        for (const name of builtIn) { const row = document.createElement('tr'); cell(row, name, true); cell(row, t('Not read')); cell(row, t('Not read')); cell(row, t('Built into the probed binary; FPM not read')); body.append(row) }
        for (const item of current.packages.filter(item => !['cli', 'fpm', 'cgi', 'common', 'dev', 'dbg', 'embed', 'runtime', 'phpdbg'].includes(item.component))) { const row = document.createElement('tr'); cell(row, item.name, true); cell(row, item.name + ' ' + item.version, true); cell(row, t('Not read')); cell(row, t('Package installed; enablement not read')); body.append(row) }
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
      savedUsage = usage
      const body = root.querySelector<HTMLElement>('[data-whm-php-usage]')
      if (!body) return
      body.textContent = ''
      for (const item of usage) for (const domain of item.domains) { const row = document.createElement('tr'); cell(row, item.version, true); cell(row, domain.name, true); cell(row, domain.account ?? t('Account not read')); cell(row, domain.handler, true); body.append(row) }
      if (!body.childElementCount) empty(body, 4, t('The saved domain read returned no PHP assignments.'))
    }
    // ---- server-wide writes: every host change is previewed, confirmed and submitted as a tested job
    const writable = (): boolean => admitted() && !root.closest(denied) && manage?.state === 'read' && manage.manage && typeof askDialog === 'function'
    const hook = (name: string): HTMLButtonElement | null => page.querySelector<HTMLButtonElement>('[data-php-action="' + name + '"]')
    const live = (control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement | null, on: boolean): void => { if (!control) return; control.removeAttribute('data-wiring'); control.disabled = !on }
    const sectionNote = (section: string, state: string, message: string): void => {
      if (!verifyTemplates()) return
      syncClean(() => {
        const card = page.querySelector<HTMLElement>('[data-whm-detail-section="' + section + '"]')
        if (!card) return
        let node = card.querySelector<HTMLElement>('[data-php-manage-status]')
        if (!node) { node = cloneClientTemplate(clientTemplate(root, 'whm-php-status'), 'p', ['content']); card.append(node) }
        const content = node.querySelector<HTMLElement>('[data-php-status-content]')
        if (node.tagName !== 'P' || !content || content.tagName !== 'SPAN') { templateContractIntact = false; domObserver.disconnect(); disableNative(); note('unavailable', t('Unavailable')); return }
        node.dataset.state = state; content.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status')
      })
    }
    const failure = (error: unknown): string => { const detail = error && typeof error === 'object' ? (error as { message?: unknown }).message : null; return typeof detail === 'string' && detail.length < 300 ? detail : t('The request failed. Nothing was changed.') }
    const confirmed = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (confirmationPending || !writable() || !verifyTemplates()) return false
      confirmationPending = true
      try {
        const yes = await askDialog!({ title, body, danger, confirm: t('Confirm') })
        // A frame that turned read-only during the dialog keeps its saved values; its write controls close now.
        if (verifyTemplates() && !writable() && manage) paintManage()
        return verifyTemplates() && writable() && yes === true
      } catch { return false } finally { confirmationPending = false }
    }
    const paintManagedExtensions = (version: string): void => {
      const body = page.querySelector<HTMLElement>('[data-whm-detail-section="php-extensions"] tbody')
      const current = manage?.versions.find(item => item.version === version)
      if (!body) return
      if (!current) { empty(body, 4, t('No selected version has been read.')); return }
      body.textContent = ''
      for (const item of current.extensions) {
        const row = document.createElement('tr'); cell(row, item.module, true); cell(row, item.package ? 'php' + version + '-' + item.package : '—', true); cell(row, t('Not read'))
        const td = document.createElement('td'), control = cloneClientTemplate(clientTemplate(root, 'whm-php-extension-switch'), 'div', ['input', 'state']), box = clientTemplateSlot(control, 'input', 'input') as HTMLInputElement
        box.checked = item.enabled === true; box.indeterminate = item.enabled === null; box.dataset.phpExtension = item.module
        if (item.enabled !== null) box.setAttribute('role', 'switch')
        box.setAttribute('aria-label', t('Enable {extension} for PHP {version}', { extension: item.module, version }))
        box.disabled = !writable() || !manage!.extensionsWritable || item.enabled === null || (!item.installed && !item.package)
        box.addEventListener('change', () => { if (box.disabled || busy || confirmationPending || !verifyTemplates() || !writable()) { box.checked = item.enabled === true; return }; void switchExtension(version, item.module, box) })
        clientTemplateSlot(control, 'state', 'span').textContent = item.enabled === null ? t('Not read') : !item.installed ? t('Package not installed') : item.enabled ? t('On') : t('Off')
        td.append(control); row.append(td); body.append(row)
      }
      if (!body.childElementCount) empty(body, 4, t('No extension observation was returned; enablement remains unread.'))
      page.querySelectorAll<HTMLElement>('[data-whm-detail-section="php-extensions"] [data-php-extension-draft-grid]').forEach(grid => { grid.hidden = true })
    }
    const paintManage = (): void => {
      if (!manage) return
      const defaultValue = page.querySelector<HTMLElement>('[data-whm-php-default]'); if (defaultValue && manage.state === 'read') { defaultValue.textContent = manage.defaultVersion; defaultValue.setAttribute('data-php-default-known', ''); defaultValue.dir = 'ltr' }
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
      paintPool()
      paintIni()
      paintVersion(select('php-extension-version')?.value ?? '')
      paintExceptions()
      if (!writable()) sectionNote('php-versions', 'unavailable', t('PHP management is unavailable on this host. Nothing was changed.'))
    }
    const paintPool = (): void => {
      const pd = manage?.poolDefaults
      const poolsCount = page.querySelector<HTMLElement>('[data-whm-php-pools-count]')
      if (poolsCount && pd) poolsCount.textContent = String(pd.poolCount)
      const savedPm = page.querySelector<HTMLElement>('[data-whm-php-saved-pm]')
      if (savedPm && pd) { savedPm.textContent = pd.pool.mode; savedPm.dir = 'ltr' }
      const factEntries: ReadonlyArray<readonly [HTMLElement | null, string | undefined]> = [
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="mode"]'), pd?.pool.mode],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="maxChildren"]'), pd ? String(pd.pool.maxChildren) : undefined],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="processIdleTimeoutSec"]'), pd ? String(pd.pool.processIdleTimeoutSec) + 's' : undefined],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="startServers"]'), pd ? String(pd.pool.startServers) : undefined],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="minSpareServers"]'), pd ? String(pd.pool.minSpareServers) : undefined],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="maxSpareServers"]'), pd ? String(pd.pool.maxSpareServers) : undefined],
        [page.querySelector<HTMLElement>('[data-whm-php-pool-fact="maxRequests"]'), pd ? String(pd.pool.maxRequests) : undefined],
      ]
      for (const [node, val] of factEntries) {
        if (node && val !== undefined) { node.textContent = val; node.dir = 'ltr' }
      }
      const canEditPool = writable() && !!pd
      const modeSelect = select('php-pool-mode')
      if (modeSelect) {
        if (pd) modeSelect.value = pd.pool.mode
        live(modeSelect, canEditPool)
      }
      const fieldPairs: ReadonlyArray<readonly [HTMLInputElement | null, number | undefined]> = [
        [page.querySelector<HTMLInputElement>('[name="php-pool-max-children"]'), pd?.pool.maxChildren],
        [page.querySelector<HTMLInputElement>('[name="php-pool-idle-timeout"]'), pd?.pool.processIdleTimeoutSec],
        [page.querySelector<HTMLInputElement>('[name="php-pool-start-servers"]'), pd?.pool.startServers],
        [page.querySelector<HTMLInputElement>('[name="php-pool-min-spare"]'), pd?.pool.minSpareServers],
        [page.querySelector<HTMLInputElement>('[name="php-pool-max-spare"]'), pd?.pool.maxSpareServers],
        [page.querySelector<HTMLInputElement>('[name="php-pool-max-requests"]'), pd?.pool.maxRequests],
      ]
      for (const [ctrl, val] of fieldPairs) {
        if (ctrl) {
          if (val !== undefined) ctrl.value = String(val)
          live(ctrl, canEditPool)
        }
      }
      live(hook('discard-pool'), canEditPool)
      live(hook('apply-pool'), canEditPool)
    }
    const INI_FIELDS = ['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars'] as const
    const iniDrafts = new Map<string, Record<string, string>>()
    let iniShownVersion = '', iniDraftRevision: string | null = null
    const rememberIniDraft = (): void => {
      if (iniShownVersion && iniDraftRevision === manage?.revision) iniDrafts.set(iniShownVersion, Object.fromEntries(INI_FIELDS.map(name => [name, page.querySelector<HTMLInputElement>('[name="' + name + '"]')?.value ?? ''])))
    }
    const paintIni = (): void => {
      if (iniDraftRevision !== (manage?.revision ?? null)) { iniDrafts.clear(); iniDraftRevision = manage?.revision ?? null }
      const version = select('php-version')?.value ?? '', current = manage?.versions.find(item => item.version === version), draft = iniDrafts.get(version)
      const savedIniCells: Record<(typeof INI_FIELDS)[number], HTMLElement | null> = {
        memory_limit: page.querySelector<HTMLElement>('[data-whm-php-saved-ini="memory_limit"]'),
        upload_max_filesize: page.querySelector<HTMLElement>('[data-whm-php-saved-ini="upload_max_filesize"]'),
        post_max_size: page.querySelector<HTMLElement>('[data-whm-php-saved-ini="post_max_size"]'),
        max_execution_time: page.querySelector<HTMLElement>('[data-whm-php-saved-ini="max_execution_time"]'),
        max_input_vars: page.querySelector<HTMLElement>('[data-whm-php-saved-ini="max_input_vars"]'),
      }
      for (const name of INI_FIELDS) {
        const input = page.querySelector<HTMLInputElement>('[name="' + name + '"]')
        if (input) { input.value = draft?.[name] ?? current?.ini?.[name] ?? ''; live(input, writable() && !!current?.ini) }
        const savedCell = savedIniCells[name]
        if (savedCell) { savedCell.textContent = current?.ini?.[name] ?? t('Not read'); if (current?.ini?.[name]) savedCell.dir = 'ltr' }
      }
      const displayErrors = page.querySelector<HTMLInputElement>('[data-php-display-errors]'); if (displayErrors) { displayErrors.value = current?.ini?.display_errors ?? ''; displayErrors.disabled = true }
      const savedDisplayErrors = page.querySelector<HTMLElement>('[data-whm-php-saved-ini="display_errors"]')
      if (savedDisplayErrors) { savedDisplayErrors.textContent = current?.ini?.display_errors ?? t('Not read'); if (current?.ini?.display_errors) savedDisplayErrors.dir = 'ltr' }
      iniShownVersion = version
      live(hook('apply-ini'), writable() && !!current?.ini); live(hook('discard-ini'), writable() && !!current?.ini)
      if (current && current.ini === null) sectionNote('php-configure', 'failed', t('The managed php.ini file was changed outside xPanel. Fix it on the host before saving here.'))
    }
    let versionButtons: HTMLButtonElement[] = []
    const chooseConfigurationVersion = (version: string, captureDraft = true): boolean => {
      if (captureDraft && (busy || confirmationPending) || !verifyTemplates() || !inventory?.versions.some(item => item.version === version)) return false
      if (captureDraft) rememberIniDraft()
      for (const name of ['php-extension-version', 'php-version']) {
        const control = select(name); if (!control) continue
        control.value = [...control.options].some(option => option.value === version) ? version : ''
        control.disabled = !admitted() || control.options.length === 0
      }
      paintVersion(version); paintIni()
      const selected = versionButtons.find(button => button.dataset.phpVersionPick === version)
      for (const button of versionButtons) { button.setAttribute('aria-selected', String(button === selected)); button.tabIndex = button === selected ? 0 : -1 }
      const panel = page.querySelector<HTMLElement>('[data-php-version-panel]')
      if (panel && selected) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', selected.id) }
      return true
    }
    const paintVersionTabs = (): void => {
      const list = page.querySelector<HTMLElement>('[data-php-version-tabs]'), panel = page.querySelector<HTMLElement>('[data-php-version-panel]'), state = page.querySelector<HTMLElement>('[data-php-version-tabs-status]')
      if (!list || !panel) return
      const focusedVersion = versionButtons.find(button => button === document.activeElement)?.dataset.phpVersionPick
      list.replaceChildren(); versionButtons = []
      const versions = inventory?.state === 'read' ? inventory.versions.map(item => item.version) : []
      if (state) { state.hidden = versions.length > 0; state.textContent = t('Not read') }
      if (!versions.length) { list.removeAttribute('role'); panel.setAttribute('role', 'region'); panel.removeAttribute('aria-labelledby'); return }
      list.setAttribute('role', 'tablist')
      for (const version of versions) {
        const button = cloneClientTemplate(clientTemplate(root, 'whm-php-version-tab'), 'button', ['content']) as HTMLButtonElement
        button.id = panel.id + '-tab-' + version.replace('.', '-'); button.dataset.phpVersionPick = version; button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-selected', 'false'); button.tabIndex = -1; button.disabled = !admitted()
        clientTemplateSlot(button, 'content', 'bdi').textContent = 'PHP ' + version
        button.addEventListener('click', () => { if (!button.disabled && button.isConnected && list.contains(button)) chooseConfigurationVersion(version) })
        button.addEventListener('keydown', event => {
          if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const usable = versionButtons.filter(item => !item.disabled && item.isConnected && list.contains(item))
          if (!usable.length || !usable.includes(button)) return
          const rtl = (getComputedStyle(list).direction || document.documentElement.dir) === 'rtl', index = usable.indexOf(button)
          const next = event.key === 'Home' ? usable[0]! : event.key === 'End' ? usable[usable.length - 1]! : usable[(index + ((event.key === 'ArrowRight') !== rtl ? 1 : -1) + usable.length) % usable.length]!
          event.preventDefault(); if (chooseConfigurationVersion(next.dataset.phpVersionPick ?? '')) next.focus()
        })
        versionButtons.push(button); list.append(button)
      }
      const prior = select('php-version')?.value || select('php-extension-version')?.value
      chooseConfigurationVersion(prior && versions.includes(prior) ? prior : versions[0]!, false)
      if (focusedVersion) versionButtons.find(button => button.dataset.phpVersionPick === focusedVersion && !button.disabled)?.focus()
    }
    /** Preview on the host, confirm with the user, then submit the reviewed job. */
    const submit = async (section: string, input: Record<string, unknown>, title: string, body: string, danger = false): Promise<void> => {
      if (!writable() || busy || !manage?.revision) return
      busy = true; syncClean(() => { root.setAttribute('aria-busy', 'true') }); sectionNote(section, 'reading', t('Checking the change on the host…'))
      try {
        const payload = { ...input, expectedRevision: manage.revision }
        const result = await request!('POST', '/api/server/php/manage/preview', payload) as { preview?: { state?: string; reason?: string | null } }
        if (result.preview?.state !== 'ready') { sectionNote(section, 'failed', t('Not applied: {reason}', { reason: String(result.preview?.reason ?? 'unknown') })); return }
        if (!await confirmed(title, body, danger)) { sectionNote(section, 'read', t('Cancelled. Nothing was changed.')); return }
        busy = true
        const applied = await request!('POST', '/api/server/php/manage/apply', payload) as { job?: { referenceCode?: unknown } }
        const reference = applied.job?.referenceCode
        sectionNote(section, 'stored', t('Submitted as job {reference}. php-fpm -t runs before pools reload; a failed test restores the previous configuration.', { reference: typeof reference === 'string' && reference.trim() ? reference : t('Unnumbered') }))
      } catch (error) { sectionNote(section, 'failed', failure(error)) }
      finally { busy = false; syncClean(() => { root.setAttribute('aria-busy', 'false') }) }
    }
    const switchExtension = async (version: string, extension: string, box: HTMLInputElement): Promise<void> => {
      const enabled = box.checked
      box.checked = !enabled
      await submit('php-extensions', { operation: 'set-extension', version, extension, enabled }, enabled ? t('Enable {extension} for PHP {version}', { extension, version }) : t('Disable {extension} for PHP {version}', { extension, version }), t('The account pools on PHP {version} reload after php-fpm -t passes.', { version }))
    }
    const selectedVersion = (): string | null => { const value = select('php-selected-version')?.value; return value ? value : (sectionNote('php-versions', 'failed', t('Choose a version first.')), null) }
    const wire = (name: string, run: () => void): void => { const button = hook(name); button?.addEventListener('click', () => { if (!button.disabled && button.isConnected && !button.closest('[hidden],[inert]') && !busy && !confirmationPending && writable() && verifyTemplates()) run() }) }
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
    wire('discard-ini', () => { iniDrafts.delete(select('php-version')?.value ?? ''); paintIni() })
    wire('discard-pool', () => { paintPool(); sectionNote('php-pool', 'read', t('Cancelled. Nothing was changed.')) })
    wire('apply-pool', () => {
      const pd = manage?.poolDefaults
      if (!pd) return
      const mode = select('php-pool-mode')?.value ?? ''
      const readInt = (el: HTMLInputElement | null): number => Number.parseInt(el?.value.trim() ?? '', 10)
      const maxChildren = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-max-children"]'))
      const processIdleTimeoutSec = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-idle-timeout"]'))
      const startServers = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-start-servers"]'))
      const minSpareServers = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-min-spare"]'))
      const maxSpareServers = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-max-spare"]'))
      const maxRequests = readInt(page.querySelector<HTMLInputElement>('[name="php-pool-max-requests"]'))
      if (!['ondemand', 'dynamic', 'static'].includes(mode) || ![maxChildren, processIdleTimeoutSec, startServers, minSpareServers, maxSpareServers, maxRequests].every(n => Number.isSafeInteger(n) && n >= 1)) {
        sectionNote('php-pool', 'failed', t('Enter positive whole numbers for every pool setting.'))
        return
      }
      void confirmed(t('Save global PHP-FPM pool defaults?'), t('Inherited account pools reload after php-fpm -t passes.')).then(async yes => {
        if (!yes || !writable() || busy || !manage?.poolDefaults) return
        busy = true; root.setAttribute('aria-busy', 'true'); sectionNote('php-pool', 'reading', t('Checking the change on the host…'))
        try {
          const result = await request!('PUT', '/api/server/php/pool-defaults', {
            mode,
            maxChildren,
            startServers,
            minSpareServers,
            maxSpareServers,
            maxRequests,
            processIdleTimeoutSec,
            expectedRevision: manage.poolDefaults.revision,
          }) as { poolDefaults?: PhpPoolDefaultsClientView }
          if (result?.poolDefaults && manage) {
            manage.poolDefaults = result.poolDefaults
            paintPool()
          }
          sectionNote('php-pool', 'stored', t('Global PHP-FPM pool defaults saved and reconciled.'))
        } catch (error) {
          sectionNote('php-pool', 'failed', failure(error))
        } finally {
          busy = false; root.setAttribute('aria-busy', 'false')
        }
      })
    })
    wire('apply-ini', () => {
      const version = select('php-version')?.value, current = manage?.versions.find(item => item.version === version)
      if (!version || !current?.ini) return
      const ini: Record<string, string> = { ...current.ini }
      for (const name of INI_FIELDS) { const value = page.querySelector<HTMLInputElement>('[name="' + name + '"]')?.value.trim() ?? ''; if (value) ini[name] = value; else delete ini[name] }
      void submit('php-configure', { operation: 'set-ini', version, ini }, t('Change php.ini for PHP {version}?', { version }), t('Saved and checked with php-fpm -t before pools reload.'))
    })
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
        const row = document.createElement('tr'); cell(row, item.account, true); cell(row, item.functions.join(', '), true); cell(row, item.reason); cell(row, formatDisplayDateTime(item.grantedAt), true)
        const td = document.createElement('td'), revoke = visualButton('whm-php-revoke', t('Revoke')); revoke.dataset.phpExceptionRevoke = item.account; revoke.disabled = !writable()
        revoke.setAttribute('aria-label', t('Revoke {functions} for {account}', { functions: item.functions.join(', '), account: item.account }))
        revoke.addEventListener('click', () => { if (revoke.disabled || busy || confirmationPending || !revoke.isConnected || !verifyTemplates() || !writable()) return; void confirmed(t('Revoke {functions} for {account}', { functions: item.functions.join(', '), account: item.account }), t('Their pools reload without the exception after php-fpm -t passes.'), true).then(yes => { if (yes) void exceptionWrite('DELETE', '/api/server/php/exceptions/' + item.account, {}, t('Revoked. Every account runs with these functions disabled unless granted.')) }) })
        td.append(revoke); row.append(td); body.append(row)
      }
      if (!body.childElementCount) empty(body, 5, t('No exceptions. Every account runs with all six functions disabled.'))
      for (const name of ['php-exception-account', 'php-exception-reason', ...EXCEPTION_FUNCTIONS.map(fn => 'php-exception-' + fn)]) live(page.querySelector<HTMLInputElement>('[name="' + name + '"]'), writable())
      live(hook('add-exception'), writable()); live(hook('grant-exception'), writable())
    }
    wire('add-exception', () => { const details = hook('grant-exception')?.closest('details'); if (details) { details.open = true; const account = select('php-exception-account'); if (account && !account.disabled) account.focus() } })
    wire('grant-exception', () => {
      const account = select('php-exception-account')?.value ?? '', reason = page.querySelector<HTMLTextAreaElement>('[name="php-exception-reason"]')?.value.trim() ?? ''
      const functions = EXCEPTION_FUNCTIONS.filter(fn => page.querySelector<HTMLInputElement>('[name="php-exception-' + fn + '"]')?.checked)
      if (!account || !reason || !functions.length) { sectionNote('php-functions', 'failed', t('Choose an account, at least one function and a reason.')); return }
      void confirmed(t('Allow {functions} for {account}?', { functions: functions.join(', '), account }), t('Recorded in the audit log with your name. The account pools reload after php-fpm -t passes.'), true)
        .then(yes => { if (yes) void exceptionWrite('POST', '/api/server/php/exceptions', { account, functions, reason }, t('Exception saved. The account pools reload with it.')) })
    })
    const load = async (): Promise<void> => {
      if (busy || !transport || !verifyTemplates()) return
      busy = true; syncClean(() => { refresh.disabled = true; root.setAttribute('aria-busy', 'true') }); note('reading', t('Reading installed PHP inventory and saved domain assignments…'))
      const results = await Promise.allSettled([request('GET', '/api/server/php/inventory').then(readPhpInventoryView), request('GET', '/api/server/php/usage').then(readPhpUsageView), request('GET', '/api/server/php/manage').then(readPhpManageView)])
      if (verifyTemplates()) {
        const [runtime, usage, managed] = results
        manage = managed.status === 'fulfilled' ? managed.value : null
        if (runtime.status === 'fulfilled') paintInventory(runtime.value)
        if (usage.status === 'fulfilled') paintUsage(usage.value)
        paintManage()
        paintEntries(); paintInstallable(); paintHandlerMatrix(); paintVersionTabs()
        const complete = runtime.status === 'fulfilled' && runtime.value.state === 'read' && usage.status === 'fulfilled'
        note(complete ? 'read' : 'failed', complete
          ? t('Package inventory and saved assignments read. FPM extension enablement, global defaults and application requests remain unverified.')
          : t('Some PHP reads are unavailable. Any retained observations are from the last successful read; no installed runtime or applied change is assumed.'))
      }
      busy = false; syncClean(() => { refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false') })
    }
    if (!transport || !admitted()) { refresh.disabled = true; note('unavailable', t('PHP inventory is unavailable here. Nothing was read or changed.')); return }
    if (!verifyTemplates()) return
    for (const name of ['php-extension-version', 'php-version']) select(name)?.addEventListener('change', event => { const control = event.target as HTMLSelectElement; if (!control.disabled) chooseConfigurationVersion(control.value) })
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}

export const WHM_PHP_CLIENT_BINDING = withFrameRequest(`(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPhpInventoryView=${readPhpInventoryView.toString()};const readPhpUsageView=${readPhpUsageView.toString()};const readPhpManageView=${readPhpManageView.toString()};return ${bindWhmPhp.toString()};})()`)
