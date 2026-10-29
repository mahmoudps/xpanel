/// <reference lib="dom" />
import {
  createDomainWorkspace, domainCanonicalName, domainObject, domainPhpLabel, domainPhpSettings,
  domainRoot, domainSafeText, domainStable, domainWriteUncertain, readDomainWorkspace,
} from './domain-workspace-client.ts'
import type { DomainWorkspaceState, DomainWorkspaceRow } from './domain-workspace-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
export interface WhmDomainAccount { id: string; username: string; home: string; status: string }
export interface WhmDomainWorkspaceOptions {
  account: WhmDomainAccount
  request: (method: string, path: string, body?: unknown) => Promise<unknown>
  admitted: () => boolean
  changed?: (state: DomainWorkspaceState) => void
}

/** Pins administrative reads and creates to the selected authorized account. Server authorization remains authoritative. */
function makeWhmDomainWorkspace(options: WhmDomainWorkspaceOptions, runtime: { createDomainWorkspace: typeof createDomainWorkspace; domainObject: typeof domainObject }) {
  const { createDomainWorkspace, domainObject } = runtime
  const account = { ...options.account }
  return createDomainWorkspace({ accountId: account.id, home: account.home, changed: options.changed,
    request: (method, path, body) => {
      if (!options.admitted()) return Promise.reject({ details: { stateChanged: false } })
      if (method === 'GET' && path === '/api/domains') return options.request(method, '/api/domains?accountId=' + encodeURIComponent(account.id) + '&workspace=1')
      if (method === 'POST' && path === '/api/domains') {
        if (!domainObject(body)) return Promise.reject({ details: { stateChanged: false } })
        return options.request(method, path, { ...body, accountId: account.id })
      }
      if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/domains\/[^/]+$/.test(path)) return options.request(method, path, body)
      return Promise.reject({ details: { stateChanged: false } })
    },
  })
}

export const createWhmDomainWorkspace = (options: WhmDomainWorkspaceOptions) => makeWhmDomainWorkspace(options, { createDomainWorkspace, domainObject })

type Runtime = { createWhmDomainWorkspace: typeof createWhmDomainWorkspace; domainStable: typeof domainStable; domainPhpLabel: typeof domainPhpLabel }
type Transport = WhmDomainWorkspaceOptions['request']

function bindWhmDomains(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, runtime: Runtime): void {
  const { createWhmDomainWorkspace, domainStable, domainPhpLabel } = runtime
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-domains-workspace]').forEach(root => {
    if (root.dataset.whmDomainsBound === 'true') return
    root.dataset.whmDomainsBound = 'true'
    const accountSelect = root.querySelector<HTMLSelectElement>('[data-whm-domain-account]')!
    const domainSelect = root.querySelector<HTMLSelectElement>('[data-whm-domain-selected]')!
    const createForm = root.querySelector<HTMLFormElement>('[data-whm-domain-create]')!
    const settingsForm = root.querySelector<HTMLFormElement>('[data-whm-domain-settings]')!
    const status = root.querySelector<HTMLElement>('[data-whm-domain-status]')!
    const details = root.querySelector<HTMLElement>('[data-whm-domain-details]')!
    const facts = root.querySelector<HTMLDListElement>('[data-whm-domain-facts]')!
    const limits = root.querySelector<HTMLDListElement>('[data-whm-domain-limits]')!
    const button = (name: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-whm-domain-' + name + ']')!
    const input = (name: string): HTMLInputElement | HTMLSelectElement => createForm.querySelector<HTMLInputElement | HTMLSelectElement>('[name="' + name + '"]')!
    const rootInput = settingsForm?.querySelector<HTMLInputElement>('[name="docRoot"]')!
    if (!accountSelect || !domainSelect || !createForm || !settingsForm || !status || !facts || !limits || !rootInput) return
    const transport = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const blocked = (): boolean => !root.isConnected || !!root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[data-capability-state="unavailable"],[data-capability-state="soon"],[aria-disabled="true"],fieldset:disabled')
    let account: WhmDomainAccount | null = null, workspace: ReturnType<typeof createWhmDomainWorkspace> | null = null
    let generation = 0, confirming = false, painted = '', lastSaved = ''
    const manageable = (): boolean => !blocked() && root.dataset.whmDomainsManage === 'true' && account?.status === 'active'
    const readAllowed = (): boolean => !blocked() && !!transport && !!account
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const fact = (list: HTMLElement, label: string, value: string, technical = false): void => {
      const field = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd')
      dt.textContent = label
      if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; dd.append(bdi) } else dd.textContent = value
      field.append(dt, dd); list.append(field)
    }
    const messages: Record<DomainWorkspaceState['status'], string> = {
      unread: t('Saved domain configuration has not been read.'),
      reading: t('Reading saved account domains…'),
      read: t('Saved account domains read. Serving, DNS and TLS remain unverified.'),
      saving: t('Saving and verifying the persisted readback…'),
      saved: t('Saved configuration and readback verified. Serving, DNS and TLS remain unverified.'),
      stale: t('Saved configuration changed. Your draft is kept. Explicitly reload before another change.'),
      failed: t('The request could not complete. Your draft is kept; no automatic retry was sent.'),
      uncertain: t('The outcome requires review. Your draft is kept. Explicitly reload saved configuration before retrying.'),
    }
    const updateOverview = (state: DomainWorkspaceState): void => {
      const view = state.observed
      const page = root.closest('[data-whm-detail-route="/whm/domains"]')
      const body = page?.querySelector<HTMLTableSectionElement>('[data-whm-filter-table] tbody')
      if (!body || !view || !account) return
      for (const row of Array.from(body.rows)) {
        const record = row.querySelector<HTMLElement>('[data-whm-filter-row]')
        if (!record || record.dataset.account === account.username) row.remove()
      }
      for (const row of view.domains) {
        const tr = document.createElement('tr'), name = document.createElement('span'), isolated = document.createElement('bdi')
        name.dataset.whmFilterRow = ''; name.dataset.kind = row.kind; name.dataset.account = account.username
        name.dataset.ssl = row.certificateId ? 'assigned' : 'unassigned'; name.dataset.php = row.php.version
        name.dataset.status = row.suspended ? 'suspended' : 'active'; name.dataset.search = row.name + ' ' + account.username
        isolated.dir = 'ltr'; isolated.textContent = row.name; name.append(isolated)
        const nameCell = document.createElement('td'); nameCell.append(name); tr.append(nameCell)
        const values: [string, boolean][] = [[account.username, false], [row.kind, false], [row.siteType, false], [row.docRoot, true], [domainPhpLabel(row), row.siteType === 'php'], [row.wildcard ? t('Yes') : t('No'), false], [row.certificateId ? t('Assigned') : t('Unassigned'), false], [row.suspended ? t('Suspended') : t('Active desired state'), false]]
        for (const [value, technical] of values) { const td = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) } else td.textContent = value; tr.append(td) }
        body.append(tr)
      }
      if (!body.rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 9; td.textContent = t('No loaded domain rows.'); tr.append(td); body.append(tr) }
      page!.dispatchEvent(new CustomEvent('xpanel:whm-domain-rows-changed', { bubbles: true }))
    }
    const paint = (state: DomainWorkspaceState): void => {
      announce(state.status, messages[state.status])
      root.setAttribute('aria-busy', String(state.busy || state.reading || confirming))
      const view = state.observed, busy = state.busy || state.reading || confirming
      const readOnly = !manageable() || !state.view || state.uncertain || busy || state.status === 'stale'
      const permission = root.querySelector<HTMLElement>('[data-whm-domain-permission]')
      if (permission) { permission.hidden = manageable(); permission.textContent = account?.status !== 'active' ? t('The account is not active. Domain configuration is read-only here.') : t('Read-only configuration. Domain management permission is required to edit.') }
      accountSelect.disabled = blocked() || busy
      domainSelect.disabled = blocked() || busy || !view
      button('refresh').disabled = blocked() || busy || !transport
      button('reload').disabled = blocked() || busy || !transport || !state.view && !state.uncertain
      createForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = readOnly || state.mode === 'settings' })
      for (const key of ['name', 'kind', 'parentId', 'docRoot', 'siteType'] as const) { const control = input(key); if (control.value !== state.draft[key]) control.value = state.draft[key] }
      const alias = state.draft.kind === 'alias', parent = view?.domains.find(row => row.id === state.draft.parentId)
      root.querySelector<HTMLElement>('[data-whm-domain-parent-field]')!.hidden = state.draft.kind === 'addon'
      root.querySelector<HTMLElement>('[data-whm-domain-alias-help]')!.hidden = !alias
      if (alias) { input('docRoot').value = parent?.docRoot ?? ''; input('siteType').value = parent?.siteType ?? 'php'; input('docRoot').disabled = true; input('siteType').disabled = true }
      button('create-submit').disabled = readOnly || state.mode !== 'create' || !state.dirty
      button('create-cancel').disabled = readOnly || !state.dirty
      if (view && domainStable(view) !== painted) {
        painted = domainStable(view); domainSelect.textContent = ''
        const empty = document.createElement('option'); empty.value = ''; empty.textContent = t('Choose a domain to manage'); domainSelect.append(empty)
        const parents = input('parentId') as HTMLSelectElement; parents.textContent = ''
        const noParent = document.createElement('option'); noParent.value = ''; noParent.textContent = t('Choose a parent domain'); parents.append(noParent)
        for (const row of view.domains) {
          const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; domainSelect.append(option)
          if (row.kind !== 'alias') { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; parents.append(option) }
        }
        parents.value = state.draft.parentId
        limits.textContent = ''
        for (const [kind, key, label] of [['addon', 'addonDomains', t('Addon domains')], ['alias', 'aliasDomains', t('Aliases')], ['subdomain', 'subdomains', t('Subdomains')]] as const) fact(limits, label, String(view.domains.filter(row => row.kind === kind).length) + ' / ' + (view.limits[key] === 'unlimited' ? t('Unlimited') : String(view.limits[key])), true)
        updateOverview(state)
      }
      domainSelect.value = state.selected?.id ?? ''
      details.hidden = !state.selected
      facts.textContent = ''
      if (state.selected) {
        const row = state.selected
        fact(facts, t('Domain'), row.name, true); fact(facts, t('Account'), account?.username ?? t(msgctxt('whm-domains-client', 'Not read')))
        fact(facts, t('Kind'), row.kind); fact(facts, t('Site type'), row.siteType, true)
        fact(facts, t('PHP'), domainPhpLabel(row), row.siteType === 'php')
        fact(facts, t('Certificate'), row.certificateId ? t('Assigned; coverage unverified') : t('Unassigned'))
        if (rootInput.value !== state.rootDraft) rootInput.value = state.rootDraft
      }
      rootInput.disabled = readOnly || state.selected?.kind === 'alias'
      button('save-root').disabled = readOnly || !state.dirty || state.selected?.kind === 'alias'
      button('cancel').disabled = blocked() || state.busy || confirming || state.uncertain
      const removal = view?.removals.find(row => row.domainId === state.selected?.id)
      button('remove').disabled = readOnly || state.dirty || !removal?.canRemove
      const reason = root.querySelector<HTMLElement>('[data-whm-domain-removal-reason]')!
      reason.textContent = !state.selected ? '' : state.selected.kind === 'primary' ? t('A primary domain is managed through account lifecycle; removal is unavailable here.') : !removal?.canRemove ? t('Dependent records prevent removal: {count}', { count: (removal?.childCount ?? 0) + (removal?.serviceUserCount ?? 0) }) : ''
      const application = state.application ?? view?.application
      root.querySelector<HTMLElement>('[data-whm-domain-application]')!.textContent = application?.status === 'global_configuration_applied'
        ? t('A global application receipt was returned. This domain’s serving, DNS and TLS remain unverified.')
        : t('Native serving, DNS and TLS have not been verified.')
      if (state.status === 'saved' && view && view.revision !== lastSaved) { lastSaved = view.revision; root.dispatchEvent(new CustomEvent('xpanel:whm-domain-saved', { bubbles: true, detail: { accountId: view.context.accountId, revision: view.revision } })) }
    }
    const confirm = async (options: Record<string, unknown>): Promise<unknown> => {
      if (!askDialog || confirming) { announce('failed', t('Confirmation is unavailable; nothing was changed.')); return null }
      confirming = true; if (workspace) paint(workspace.state)
      try { return await askDialog(options) } catch { return null }
      finally { confirming = false; if (workspace) paint(workspace.state) }
    }
    const discard = (): Promise<unknown> => confirm({ title: t('Discard this draft?'), body: t('Saved configuration will be read again. No previous mutation is retried.'), confirm: t('Discard and continue'), danger: true })
    const switchAccount = async (): Promise<void> => {
      if (blocked() || confirming || workspace?.state.busy || workspace?.state.reading) { if (account) accountSelect.value = account.id; return }
      const next = accountSelect.selectedOptions[0]
      if (!next?.value || !next.dataset.home) return
      const desired = { id: next.value, username: next.textContent ?? '', home: next.dataset.home, status: next.dataset.status ?? '' }
      if (account) accountSelect.value = account.id
      if (workspace && (workspace.state.dirty || workspace.state.uncertain) && await discard() !== true) return
      if (blocked()) return
      account = desired; accountSelect.value = desired.id; painted = ''; lastSaved = ''
      domainSelect.textContent = ''; limits.textContent = ''; facts.textContent = ''; details.hidden = true; rootInput.value = ''
      const token = ++generation
      workspace = createWhmDomainWorkspace({ account, admitted: readAllowed, request: (method, path, body) => {
        if (!transport || method !== 'GET' && !manageable()) return Promise.reject({ details: { stateChanged: false } })
        return body === undefined ? transport(method, path) : transport(method, path, body)
      }, changed: state => { if (token === generation) paint(state) } })
      await workspace.refresh()
    }
    const reviewMutation = async (kind: 'create' | 'root'): Promise<void> => {
      const current = workspace
      if (!current || confirming || !manageable() || current.state.busy || current.state.reading || current.state.uncertain || current.state.status === 'stale') return
      const title = kind === 'create' ? t('Create saved domain') : t('Save domain document root')
      const body = kind === 'create' ? current.state.draft.name : current.state.selected?.name ?? ''
      if (await confirm({ title, body: body + '\n' + t('Serving, DNS and TLS remain separately unverified.'), confirm: t('Confirm') }) !== true || workspace !== current || !manageable()) return
      if (kind === 'create') await current.create(); else await current.saveRoot()
    }
    createForm.addEventListener('input', event => {
      const target = event.target
      if (!manageable() || !(target instanceof HTMLInputElement) || target.disabled) return
      if (['name', 'docRoot'].includes(target.name)) workspace?.editCreate({ [target.name]: target.value })
    })
    createForm.addEventListener('change', event => {
      const target = event.target
      if (!manageable() || !(target instanceof HTMLSelectElement) || target.disabled) return
      if (['kind', 'parentId', 'siteType'].includes(target.name)) workspace?.editCreate({ [target.name]: target.value })
    })
    createForm.addEventListener('submit', event => { event.preventDefault(); if (manageable() && createForm instanceof HTMLFormElement && createForm.reportValidity()) void reviewMutation('create') })
    rootInput.addEventListener('input', () => { if (manageable() && !rootInput.disabled) workspace?.editRoot(rootInput.value) })
    settingsForm.addEventListener('submit', event => { event.preventDefault(); if (manageable() && settingsForm instanceof HTMLFormElement && settingsForm.reportValidity()) void reviewMutation('root') })
    accountSelect.addEventListener('change', () => { void switchAccount() })
    domainSelect.addEventListener('change', () => { const id = domainSelect.value; domainSelect.value = workspace?.state.selected?.id ?? ''; if (blocked() || !id || confirming) return; void workspace?.select(id, discard) })
    button('refresh').addEventListener('click', () => { if (!blocked() && !confirming) void workspace?.refresh() })
    button('reload').addEventListener('click', () => { if (!blocked() && !confirming) void workspace?.reload(discard) })
    for (const name of ['cancel', 'create-cancel']) button(name).addEventListener('click', () => { if (!blocked() && !confirming) void workspace?.cancel(discard) })
    button('remove').addEventListener('click', () => { const selected = workspace?.state.selected; if (!selected || !manageable() || button('remove').disabled) return; void workspace!.remove(selected.id, (row: Readonly<DomainWorkspaceRow>) => confirm({ title: t('Remove saved domain'), body: row.name, label: t('Type the exact domain name'), input: true, value: '', preserveWhitespace: true, confirm: t('Remove saved domain'), danger: true })) })
    window.addEventListener('beforeunload', event => { if (workspace?.state.dirty || workspace?.state.uncertain) { event.preventDefault(); event.returnValue = '' } })
    if (!transport || blocked() || !accountSelect.options.length) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      announce('unavailable', t('An authorized account and session transport are required. Nothing was read or changed.')); return
    }
    void switchAccount()
  })
}

export const WHM_DOMAINS_CLIENT_BINDING = `(()=>{const domainObject=${domainObject.toString()};const domainSafeText=${domainSafeText.toString()};const domainCanonicalName=${domainCanonicalName.toString()};const domainRoot=${domainRoot.toString()};const domainStable=${domainStable.toString()};const domainWriteUncertain=${domainWriteUncertain.toString()};const domainPhpSettings=${domainPhpSettings.toString()};const domainPhpLabel=${domainPhpLabel.toString()};const readDomainWorkspace=${readDomainWorkspace.toString()};const createDomainWorkspace=${createDomainWorkspace.toString()};const createWhmDomainWorkspace=options=>(${makeWhmDomainWorkspace.toString()})(options,{createDomainWorkspace,domainObject});return (askDialog)=>(${bindWhmDomains.toString()})(askDialog,{createWhmDomainWorkspace,domainStable,domainPhpLabel});})()`
