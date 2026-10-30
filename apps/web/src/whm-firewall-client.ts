import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

const formatDisplayDateTime = canonicalFormatDisplayDateTime

type FirewallRuleView = { id: string; kind: 'port' | 'ip' | 'forward' | 'icmp' | 'prefix-list'; action: 'accept' | 'drop' | 'reject'; protocol: 'tcp' | 'udp' | 'both' | null; port: string | null; source: string | null; forwardTo: string | null; list: string | null; comment: string; enabled: boolean }
export type FirewallView = { rules: FirewallRuleView[]; prefixLists: { name: string; entries: number }[]; revision: string; sessionIp: string | null; pending: { id: string; deadline: string } | null }
export type BanView = { state: 'read' | 'unavailable'; bans: { address: string; expiresSec: number | null }[] }

/** GET /api/firewall/bans: the live ban sets; unavailable until the host has applied the firewall. */
export function readBanView(value: unknown): BanView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.bans) || value.bans.length > 10000) throw new Error('invalid_bans')
  return { state: value.state as BanView['state'], bans: value.bans.map(raw => {
    if (!object(raw) || typeof raw.address !== 'string' || !/^[0-9a-fA-F.:]{2,45}$/.test(raw.address) || !(raw.expiresSec === null || Number.isSafeInteger(raw.expiresSec))) throw new Error('invalid_bans')
    return { address: raw.address, expiresSec: raw.expiresSec as number | null }
  }) }
}

/** GET /api/firewall and every write response; anything malformed is refused before it is painted. */
export function readFirewallView(value: unknown): FirewallView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item)
  if (!object(value) || !Array.isArray(value.rules) || value.rules.length > 4096 || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.session)) throw new Error('invalid_firewall')
  const rules = value.rules.map(raw => {
    if (!object(raw) || !text(raw.id, 64) || !['port', 'ip', 'forward', 'icmp', 'prefix-list'].includes(String(raw.kind)) || !['accept', 'drop', 'reject'].includes(String(raw.action)) || !(raw.protocol === null || ['tcp', 'udp', 'both'].includes(String(raw.protocol)))
      || !['port', 'source', 'forwardTo', 'list'].every(key => raw[key] === null || text(raw[key], 128)) || !text(raw.comment, 512) || typeof raw.enabled !== 'boolean') throw new Error('invalid_firewall')
    return raw as unknown as FirewallRuleView
  })
  const pending = value.pending
  if (!(pending === null || object(pending) && typeof pending.id === 'string' && /^[0-9a-f-]{36}$/.test(pending.id) && typeof pending.deadline === 'string' && Number.isFinite(Date.parse(pending.deadline)))) throw new Error('invalid_firewall')
  if (!Array.isArray(value.prefixLists) || value.prefixLists.length > 256) throw new Error('invalid_firewall')
  const prefixLists = value.prefixLists.map(raw => {
    if (!object(raw) || typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(raw.name) || !Array.isArray(raw.entries)) throw new Error('invalid_firewall')
    return { name: raw.name, entries: raw.entries.length }
  })
  const ip = value.session.ip
  return { rules, prefixLists, revision: value.revision, sessionIp: typeof ip === 'string' && text(ip, 45) ? ip : null, pending: pending ? { id: String(pending.id), deadline: String(pending.deadline) } : null }
}

function bindWhmFirewall(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-approved-whm-operations="/whm/security/firewall"][data-operation-state="qualified"]').forEach(root => {
    if (root.dataset.firewallManageBound === 'true') return
    root.dataset.firewallManageBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!request || typeof askDialog !== 'function') return
    let view: FirewallView | null = null, busy = false
    const card = root.querySelector<HTMLElement>('[data-whm-ops-section="firewall-rule-categories"]')
    if (!card) return
    const status = card.querySelector<HTMLElement>('[data-firewall-manage-status]')
    if (!status) return
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    try {
      const values = { position: '', action: '', protocol: '', port: '', source: '', comment: '', added: '', expires: '', destination: '', name: '', entries: '', file: '', updated: '', address: '', reason: '', since: '' }
      for (const kind of ['port', 'ip', 'forward', 'prefix', 'ban']) {
        const row = cloneViewRecord(root, 'firewall-' + kind + '-row', 'tr', values)
        if (kind !== 'prefix') viewAction(row, 'actions', 'div')
      }
      const empty = cloneViewRecord(root, 'firewall-empty', 'tr', { message: '' }); viewAction(empty, 'cell', 'td')
      cloneViewRecord(root, 'firewall-action', 'button', { label: '' })
      const editor = cloneViewRecord(root, 'firewall-editor', 'tr', { title: '' })
      viewAction(editor, 'cell', 'td'); viewAction(editor, 'form', 'form'); viewAction(editor, 'fields', 'div'); viewAction(editor, 'actions', 'div')
      for (const kind of ['input', 'select']) { const field = cloneViewRecord(root, 'firewall-edit-' + kind, 'div', { label: '' }); viewAction(field, 'label', 'label'); viewAction(field, 'control', kind) }
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true })
      note('unavailable', t('Saving is unavailable. No changes were sent.')); return
    }
    const failure = (error: unknown): string => { const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null; return typeof message === 'string' && message.length < 300 ? message : t('The request failed. Nothing was changed.') }
    const button = (label: string, run: () => void, disabled = false): HTMLButtonElement => { const node = cloneViewRecord(root, 'firewall-action', 'button', { label }) as HTMLButtonElement; node.disabled = disabled || busy; node.addEventListener('click', () => { if (!busy) run() }); return node }
    const emptyRow = (body: HTMLElement, columns: number, message: string): void => { const row = cloneViewRecord(root, 'firewall-empty', 'tr', { message }); viewAction<HTMLTableCellElement>(row, 'cell', 'td').colSpan = columns; body.append(row) }
    const system = (rule: FirewallRuleView): boolean => rule.id.startsWith('default-')
    const locked = (rule: FirewallRuleView): boolean => /^default-backend(?:-tls)?-/.test(rule.id)
    const action = (rule: FirewallRuleView): string => rule.action === 'accept' ? t('Allow') : rule.action === 'reject' ? t('Reject') : t('Drop')

    /** The readback over this connection proves the session still reaches the panel; only then is the change kept. */
    const confirm = async (result: unknown): Promise<void> => {
      const id = result && typeof result === 'object' ? ((result as { confirmation?: { id?: unknown } }).confirmation?.id) : undefined
      view = readFirewallView(await request('GET', '/api/firewall'))
      if (typeof id === 'string') view = readFirewallView(await request('POST', '/api/firewall/confirm', { id }))
      paint()
      note('stored', t('Applied as one generation, read back and confirmed from this session.'))
    }
    const write = async (method: string, path: string, body: Record<string, unknown>): Promise<void> => {
      if (busy || !view) return
      busy = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Checking the rules against your session address and applying them…'))
      try { await confirm(await request(method, path, { ...body, expectedRevision: view.revision })) }
      catch (error) { note('failed', failure(error)); try { view = readFirewallView(await request('GET', '/api/firewall')); paint() } catch { /* the last read stays on screen */ } }
      finally { busy = false; root.setAttribute('aria-busy', 'false') }
    }
    const ask = async (title: string, body: string, danger = false): Promise<boolean> => { try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } }

    const editor = (rule: FirewallRuleView, row: HTMLTableRowElement, columns: number): void => {
      const existing = row.nextElementSibling
      if (existing instanceof HTMLTableRowElement && existing.dataset.firewallEditor === rule.id) { existing.remove(); return }
      const tr = cloneViewRecord(root, 'firewall-editor', 'tr', { title: system(rule) ? t('Narrow source') : t('Edit') }) as HTMLTableRowElement
      tr.dataset.firewallEditor = rule.id; viewAction<HTMLTableCellElement>(tr, 'cell', 'td').colSpan = columns
      const form = viewAction<HTMLFormElement>(tr, 'form', 'form'), fields = viewAction(tr, 'fields', 'div'), actions = viewAction(tr, 'actions', 'div')
      form.addEventListener('submit', event => event.preventDefault())
      const input = (name: string, label: string, value: string, choices?: readonly (readonly [string, string])[]): void => {
        const wrap = cloneViewRecord(root, choices ? 'firewall-edit-select' : 'firewall-edit-input', 'div', { label }), id = 'fw-edit-' + rule.id + '-' + name
        viewAction<HTMLLabelElement>(wrap, 'label', 'label').htmlFor = id
        const control = choices ? viewAction<HTMLSelectElement>(wrap, 'control', 'select') : viewAction<HTMLInputElement>(wrap, 'control', 'input')
        if (control instanceof HTMLSelectElement) for (const [key, text] of choices!) { const option = document.createElement('option'); option.value = key; option.textContent = text; control.append(option) }
        control.id = id; control.name = name; control.value = value; fields.append(wrap)
      }
      if (!system(rule)) {
        input('action', t('Action'), rule.action, [['accept', t('Allow')], ['drop', t('Drop')], ['reject', t('Reject')]])
        if (rule.protocol !== null) input('protocol', t('Protocol'), rule.protocol, [['tcp', 'TCP'], ['udp', 'UDP'], ['both', t('TCP and UDP')]])
        if (rule.port !== null || rule.kind === 'port') input('port', t('Port or range'), rule.port ?? '')
      }
      input('source', t('Source'), rule.source ?? '')
      if (!system(rule)) input('comment', t('Note'), rule.comment)
      actions.append(button(t('Cancel'), () => tr.remove()), button(t('Check and save'), () => {
        const data = new FormData(form), patch: Record<string, unknown> = {}
        for (const [key, value] of data) patch[key] = typeof value === 'string' ? value.trim() : ''
        if (patch.source === '') patch.source = null
        void write('PATCH', '/api/firewall/rules/' + encodeURIComponent(rule.id), patch)
      }))
      row.after(tr)
    }

    const values = (rule: FirewallRuleView, index: number): Record<string, string | number> => ({ position: index + 1, action: action(rule), protocol: rule.protocol ?? '', port: rule.port ?? (rule.kind === 'ip' ? t('All ports') : ''),
      source: rule.source ?? (rule.kind === 'ip' ? '' : t('Any source')), comment: rule.comment, added: '—', expires: '—', destination: rule.forwardTo ?? '' })
    const paint = (): void => {
      if (!view) return
      const rules = view.rules
      for (const kind of ['port', 'ip', 'forward']) {
        const table = card.querySelector<HTMLTableElement>('[data-whm-firewall-panel="' + kind + '"] table')
        if (!table) continue
        const head = table.tHead?.rows[0]
        if (head && !head.querySelector('[data-firewall-manage-head]')) { const th = document.createElement('th'); th.scope = 'col'; th.dataset.firewallManageHead = ''; th.textContent = t('Manage'); head.append(th) }
        const columns = head?.cells.length ?? 1
        const body = table.tBodies[0] ?? table.createTBody()
        body.textContent = ''
        const selected = rules.filter(rule => rule.kind === kind)
        for (const rule of selected) {
          const index = rules.indexOf(rule), row = cloneViewRecord(root, 'firewall-' + kind + '-row', 'tr', values(rule, index)) as HTMLTableRowElement
          row.dataset.firewallRuleId = rule.id
          const group = viewAction(row, 'actions', 'div')
          if (locked(rule)) group.textContent = t('Locked to loopback')
          else {
            group.append(button(system(rule) ? t('Narrow source') : t('Edit'), () => editor(rule, row, columns)))
            group.append(button(t('Move up'), () => { void write('POST', '/api/firewall/rules/' + encodeURIComponent(rule.id) + '/move', { position: index - 1 }) }, index === 0))
            group.append(button(t('Move down'), () => { void write('POST', '/api/firewall/rules/' + encodeURIComponent(rule.id) + '/move', { position: index + 1 }) }, index === rules.length - 1))
            if (!system(rule)) group.append(button(t('Delete'), () => { void ask(t('Delete this rule?'), t('Rule {position} is removed in the next generation. Saves that would block your session are refused.', { position: String(index + 1) }), true).then(yes => { if (yes) void write('DELETE', '/api/firewall/rules/' + encodeURIComponent(rule.id), {}) }) }))
          }
          body.append(row)
        }
        if (!selected.length) emptyRow(body, columns, t('No saved rules of this type.'))
        // the static edit and discard placeholders of this panel are superseded by the live row actions
        table.closest('[data-whm-firewall-panel]')?.querySelectorAll<HTMLElement>(':scope > [data-firewall-static-management]').forEach(node => { node.hidden = true })
      }
      paintLists()
      if (view.pending) {
        note('pending', t('A change is waiting for confirmation. Unless it is kept, the previous rules return at {deadline}.', { deadline: formatDisplayDateTime(view.pending.deadline) }))
        const pending = view.pending
        status.append(' ', button(t('Keep these rules'), () => { void (async () => { busy = true; try { view = readFirewallView(await request('POST', '/api/firewall/confirm', { id: pending.id })); paint(); note('stored', t('The rules were kept.')) } catch (error) { note('failed', failure(error)) } finally { busy = false } })() }))
      }
    }

    // ---- prefix lists: upload with an action and ports adds the list rule at the top; replace swaps the entries only
    const listsPanel = card.querySelector<HTMLElement>('[data-whm-firewall-panel="prefix-list"]')
    const paintLists = (): void => {
      const body = listsPanel?.querySelector('table')?.tBodies[0]
      if (!body || !view) return
      body.textContent = ''
      for (const item of view.prefixLists) {
        const rule = view.rules.find(entry => entry.kind === 'prefix-list' && entry.list === item.name), row = cloneViewRecord(root, 'firewall-prefix-row', 'tr', { name: item.name, action: rule ? action(rule) : '—', entries: item.entries, port: rule?.port ?? t('All ports'), file: '—', updated: '—' })
        body.append(row)
      }
      if (!body.childElementCount) emptyRow(body, 6, t('No prefix lists yet.'))
    }
    const listField = (name: string): HTMLInputElement | HTMLSelectElement | null => listsPanel?.querySelector<HTMLInputElement | HTMLSelectElement>('[name="' + name + '"]') ?? null
    const uploadList = async (replace: boolean): Promise<void> => {
      const name = listField('firewall-prefix-name')?.value.trim() ?? '', file = (listField('firewall-prefix-file') as HTMLInputElement | null)?.files?.[0]
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(name) || !file || file.size > 4 * 1024 * 1024) { note('failed', t('Give the list a name such as blocklist_feed and choose a plain text file of at most 4 MB.')); return }
      const entries = await file.text(), choice = listField('firewall-prefix-action')?.value ?? ''
      await write('PUT', '/api/firewall/prefix-lists/' + name, { entries, ...(replace || !choice ? {} : { action: choice, ports: listField('firewall-prefix-ports')?.value.trim() ?? '' }) })
    }
    for (const [hookName, replace] of [['upload-list', false], ['replace-list', true]] as const) {
      const control = listsPanel?.querySelector<HTMLButtonElement>('[data-firewall-action="' + hookName + '"]')
      if (control) { control.removeAttribute('data-wiring'); control.disabled = false; control.addEventListener('click', () => { if (!busy) void uploadList(replace) }) }
    }
    for (const name of ['firewall-prefix-name', 'firewall-prefix-file', 'firewall-prefix-ports', 'firewall-prefix-action', 'firewall-unban-address']) { const control = card.querySelector<HTMLInputElement>('[name="' + name + '"]'); if (control) { control.removeAttribute('data-wiring'); control.disabled = false } }

    // ---- bans: live timeout entries; unban one row, or several addresses typed one per line
    const bansPanel = card.querySelector<HTMLElement>('[data-whm-firewall-panel="banned"]')
    const unban = async (addresses: string[]): Promise<void> => {
      if (busy || !addresses.length) return
      if (!await ask(t('Unban {count} addresses?', { count: String(addresses.length) }), addresses.join(', '))) return
      busy = true; note('reading', t('Removing the addresses from the ban sets…'))
      try {
        const result = await request('POST', '/api/firewall/bans/unban', { addresses }) as { unbanned?: string[]; stillBanned?: string[] }
        note(result.stillBanned?.length ? 'failed' : 'stored', result.stillBanned?.length ? t('Still banned after the request: {addresses}', { addresses: result.stillBanned.join(', ') }) : t('Unbanned and read back: {addresses}', { addresses: (result.unbanned ?? []).join(', ') }))
      } catch (error) { note('failed', failure(error)) }
      finally { busy = false; void loadBans() }
    }
    const loadBans = async (): Promise<void> => {
      const body = bansPanel?.querySelector('table')?.tBodies[0]
      if (!body) return
      let bans: BanView
      try { bans = readBanView(await request('GET', '/api/firewall/bans')) } catch { return }
      const head = bansPanel!.querySelector('table')?.tHead?.rows[0]
      if (head && !head.querySelector('[data-firewall-manage-head]')) { const th = document.createElement('th'); th.scope = 'col'; th.dataset.firewallManageHead = ''; th.textContent = t('Manage'); head.append(th) }
      body.textContent = ''
      for (const item of bans.bans) {
        const row = cloneViewRecord(root, 'firewall-ban-row', 'tr', { address: item.address, reason: '—', source: '—', since: '—', expires: item.expiresSec === null ? '—' : t('{seconds} s left', { seconds: String(item.expiresSec) }) })
        viewAction(row, 'actions', 'div').append(button(t('Unban'), () => { void unban([item.address]) })); body.append(row)
      }
      if (!body.childElementCount) emptyRow(body, 6, bans.state === 'read' ? t('No address is banned now.') : t('The live ban sets have not been applied on this host yet.'))
    }
    const unbanHook = bansPanel?.querySelector<HTMLButtonElement>('[data-firewall-action="unban"]')
    if (unbanHook) { unbanHook.removeAttribute('data-wiring'); unbanHook.disabled = false; unbanHook.addEventListener('click', () => { const field = bansPanel!.querySelector<HTMLInputElement>('[name="firewall-unban-address"]'); void unban((field?.value ?? '').split(/[\s,]+/).filter(Boolean)) }) }

    // ---- import and export (format version 1)
    const exchange = root.querySelector<HTMLElement>('[data-whm-ops-section="firewall-import-export"]')
    const json = exchange?.querySelector<HTMLTextAreaElement>('[name="firewall-import-json"]'), file = exchange?.querySelector<HTMLInputElement>('[name="firewall-import-file"]')
    const exportButton = exchange?.querySelector<HTMLButtonElement>('[data-firewall-action="export"]'), importButton = exchange?.querySelector<HTMLButtonElement>('[data-firewall-action="import"]')
    for (const control of [json, file, exportButton, importButton]) if (control) { control.removeAttribute('data-wiring'); control.disabled = false }
    file?.addEventListener('change', () => { const chosen = file.files?.[0]; if (chosen && json && chosen.size <= 1024 * 1024) void chosen.text().then(text => { json.value = text }) })
    exportButton?.addEventListener('click', () => {
      void request('GET', '/api/firewall/export').then(doc => {
        const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }))
        link.href = url; link.download = 'firewall-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
        note('read', t('Exported. Bans and prefix-list entries are not part of the file.'))
      }, error => note('failed', failure(error)))
    })
    importButton?.addEventListener('click', () => {
      if (busy || !view || !json) return
      let parsed: unknown
      try { parsed = JSON.parse(json.value) } catch { note('failed', t('The file is not valid JSON. Nothing was changed.')); return }
      void (async () => {
        try {
          const check = await request('POST', '/api/firewall/import', { document: parsed, expectedRevision: view!.revision, dryRun: true }) as { valid?: boolean; errors?: string[]; diff?: { added?: string[]; removed?: string[]; changed?: string[] } }
          if (!check.valid) { note('failed', t('Not imported: {reason}', { reason: String(check.errors?.[0] ?? '') })); return }
          const yes = await ask(t('Import these rules?'), t('{added} added, {removed} removed, {changed} changed. The import passes the same lockout check before anything applies.', { added: String(check.diff?.added?.length ?? 0), removed: String(check.diff?.removed?.length ?? 0), changed: String(check.diff?.changed?.length ?? 0) }), true)
          if (yes) await write('POST', '/api/firewall/import', { document: parsed })
        } catch (error) { note('failed', failure(error)) }
      })()
    })

    void loadBans()
    void request('GET', '/api/firewall').then(value => { view = readFirewallView(value); paint(); if (!view.pending) note('read', view.sessionIp ? t('Your session {ip} is checked before every save.', { ip: view.sessionIp }) : t('Rules read.')) }, error => note('failed', failure(error)))
  })
}

export const WHM_FIREWALL_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readFirewallView=${readFirewallView.toString()};const readBanView=${readBanView.toString()};return ${bindWhmFirewall.toString()};})()`
