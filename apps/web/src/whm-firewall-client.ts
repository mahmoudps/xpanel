import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction

const formatDisplayDateTime = canonicalFormatDisplayDateTime

type FirewallRuleView = { id: string; kind: 'port' | 'ip' | 'forward' | 'icmp' | 'prefix-list'; action: 'accept' | 'drop' | 'reject'; protocol: 'tcp' | 'udp' | 'both' | null; port: string | null; source: string | null; forwardTo: string | null; list: string | null; comment: string; enabled: boolean }
type FirewallStagedItemView = {
  change: 'added' | 'changed' | 'removed'
  id: string
  position: number | null
  kind: FirewallRuleView['kind']
  action: FirewallRuleView['action']
  match: string
  source: string | null
  comment: string
  beforeAction: FirewallRuleView['action'] | null
  beforeMatch: string | null
  beforeSource: string | null
  lockoutCheck: 'pass' | 'blocked' | 'unchecked'
}
type FirewallStagedView = {
  baseRevision: string
  updatedAt: string
  actor: string
  stale: boolean
  currentRuleCount: number
  proposedRuleCount: number
  counts: { added: number; changed: number; removed: number; moved: boolean }
  lockout: { checked: boolean; passed: boolean; blockingRuleId: string | null; message: string | null }
  valid: boolean
  errors: string[]
  items: FirewallStagedItemView[]
}
type FirewallApplyStepView = { id: 'lockout-check' | 'apply-generation' | 'session-readback' | 'confirm-or-revert'; state: 'done' | 'current' | 'upcoming' | 'failed' }
export type FirewallView = { rules: FirewallRuleView[]; prefixLists: { name: string; entries: number }[]; revision: string; enabled?: boolean; sessionIp: string | null; pending: { id: string; deadline: string } | null; staged?: FirewallStagedView | null; applySteps?: FirewallApplyStepView[] }
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
  let staged: FirewallStagedView | null | undefined
  if (value.staged === null) {
    staged = null
  } else if (object(value.staged)) {
    const s = value.staged
    if (typeof s.baseRevision !== 'string' || !/^[0-9a-f]{64}$/.test(s.baseRevision) || !text(s.updatedAt, 64) || !text(s.actor, 64) || typeof s.stale !== 'boolean' || !Number.isSafeInteger(s.currentRuleCount) || !Number.isSafeInteger(s.proposedRuleCount) || !object(s.counts) || !object(s.lockout) || typeof s.valid !== 'boolean' || !Array.isArray(s.errors) || !Array.isArray(s.items) || s.items.length > 512) throw new Error('invalid_firewall')
    staged = {
      baseRevision: s.baseRevision,
      updatedAt: s.updatedAt,
      actor: s.actor,
      stale: s.stale,
      currentRuleCount: s.currentRuleCount as number,
      proposedRuleCount: s.proposedRuleCount as number,
      counts: {
        added: Number(s.counts.added ?? 0),
        changed: Number(s.counts.changed ?? 0),
        removed: Number(s.counts.removed ?? 0),
        moved: s.counts.moved === true,
      },
      lockout: {
        checked: s.lockout.checked === true,
        passed: s.lockout.passed === true,
        blockingRuleId: typeof s.lockout.blockingRuleId === 'string' ? s.lockout.blockingRuleId : null,
        message: typeof s.lockout.message === 'string' ? s.lockout.message : null,
      },
      valid: s.valid,
      errors: s.errors.filter((e): e is string => typeof e === 'string').slice(0, 32),
      items: s.items.map(raw => {
        if (!object(raw) || !['added', 'changed', 'removed'].includes(String(raw.change)) || !text(raw.id, 64) || !['port', 'ip', 'forward', 'icmp', 'prefix-list'].includes(String(raw.kind)) || !['accept', 'drop', 'reject'].includes(String(raw.action)) || !text(raw.match, 160) || !(raw.source === null || text(raw.source, 128)) || !text(raw.comment, 512) || !['pass', 'blocked', 'unchecked'].includes(String(raw.lockoutCheck))) throw new Error('invalid_firewall')
        return {
          change: raw.change as FirewallStagedItemView['change'],
          id: raw.id,
          position: Number.isSafeInteger(raw.position) ? raw.position as number : null,
          kind: raw.kind as FirewallRuleView['kind'],
          action: raw.action as FirewallRuleView['action'],
          match: raw.match,
          source: raw.source as string | null,
          comment: raw.comment,
          beforeAction: ['accept', 'drop', 'reject'].includes(String(raw.beforeAction)) ? raw.beforeAction as FirewallRuleView['action'] : null,
          beforeMatch: typeof raw.beforeMatch === 'string' && text(raw.beforeMatch, 160) ? raw.beforeMatch : null,
          beforeSource: typeof raw.beforeSource === 'string' && text(raw.beforeSource, 128) ? raw.beforeSource : null,
          lockoutCheck: raw.lockoutCheck as FirewallStagedItemView['lockoutCheck'],
        }
      }),
    }
  }
  let applySteps: FirewallApplyStepView[] | undefined
  if (Array.isArray(value.applySteps)) {
    applySteps = value.applySteps.flatMap(raw => {
      if (!object(raw) || !['lockout-check', 'apply-generation', 'session-readback', 'confirm-or-revert'].includes(String(raw.id)) || !['done', 'current', 'upcoming', 'failed'].includes(String(raw.state))) return []
      return [{ id: raw.id as FirewallApplyStepView['id'], state: raw.state as FirewallApplyStepView['state'] }]
    })
  }
  return {
    rules,
    prefixLists,
    revision: value.revision,
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    sessionIp: typeof ip === 'string' && text(ip, 45) ? ip : null,
    pending: pending ? { id: String(pending.id), deadline: String(pending.deadline) } : null,
    ...(staged !== undefined ? { staged } : {}),
    ...(applySteps !== undefined ? { applySteps } : {}),
  }
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
      const records: Readonly<Record<'port' | 'ip' | 'forward' | 'prefix' | 'ban', Readonly<Record<string, string>>>> = {
        port: { position: '', action: '', protocol: '', port: '', source: '', purpose: '', origin: '', comment: '' },
        ip: { action: '', source: '', port: '', comment: '', added: '', expires: '' },
        forward: { protocol: '', port: '', destination: '', source: '', comment: '' },
        prefix: { name: '', action: '', entries: '', port: '', file: '', updated: '' },
        ban: { address: '', reason: '', source: '', since: '', expires: '' },
      }
      for (const [kind, fields] of Object.entries(records)) {
        const row = cloneViewRecord(root, 'firewall-' + kind + '-row', 'tr', fields)
        if (kind === 'port') {
          const head = card.querySelector<HTMLTableElement>('[data-whm-firewall-panel="port"] table')?.tHead?.rows[0]
          const purpose = row.querySelector('[data-xp-slot="purpose"]'), origin = row.querySelector('[data-xp-slot="origin"]')
          if (!head || head.cells.length !== 9 || row.children.length !== 9
            || purpose?.tagName !== 'TD' || row.children.item(5) !== purpose || origin?.tagName !== 'TD' || row.children.item(6) !== origin) throw new Error('invalid_firewall_port_columns')
        }
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
    const emptyRow = (body: HTMLElement, columns: number, message: string): void => { const row = cloneViewRecord(root, 'firewall-empty', 'tr', { message }); viewAction<HTMLTableCellElement>(row, 'cell', 'td').colSpan = columns; body.append(row) }; const ruleCount = (body: Element, total: number): void => { const slot = body.closest('[data-whm-firewall-panel]')?.querySelector('[data-firewall-rule-count]'); if (slot) slot.textContent = String(total) } // optional slot: a theme may show a list's size as text
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
    const write = async (method: string, path: string, body: Record<string, unknown>, reviewedRevision?: string): Promise<void> => {
      if (busy || !view) return
      busy = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Checking the rules against your session address and applying them…'))
      try { await confirm(await request(method, path, { ...body, expectedRevision: reviewedRevision ?? view.revision })) }
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

    const values = (rule: FirewallRuleView, index: number): Record<string, string | number> => {
      switch (rule.kind) {
        case 'port': return { position: index + 1, action: action(rule), protocol: rule.protocol ?? '', port: rule.port ?? '', source: rule.source ?? t('Any source'), purpose: t('Not read'), origin: t('Not read'), comment: rule.comment }
        case 'ip': return { action: action(rule), source: rule.source ?? '', port: rule.port ?? t('All ports'), comment: rule.comment, added: '—', expires: '—' }
        case 'forward': return { protocol: rule.protocol ?? '', port: rule.port ?? '', destination: rule.forwardTo ?? '', source: rule.source ?? t('Any source'), comment: rule.comment }
        default: throw new Error('invalid_firewall_record_kind')
      }
    }
    const paint = (): void => {
      if (!view) return
      const rules = view.rules
      for (const kind of ['port', 'ip', 'forward']) {
        const table = card.querySelector<HTMLTableElement>('[data-whm-firewall-panel="' + kind + '"] table')
        if (!table) continue
        const head = table.tHead?.rows[0]
        if (kind === 'port') {
          if (!head || head.cells.length !== 9) throw new Error('invalid_firewall_port_columns')
          const manage = head.cells.item(8)
          if (!manage) throw new Error('invalid_firewall_port_columns')
          manage.dataset.firewallManageHead = ''
        }
        if (head && !head.querySelector('[data-firewall-manage-head]')) { const th = document.createElement('th'); th.scope = 'col'; th.dataset.firewallManageHead = ''; th.textContent = t('Manage'); head.append(th) }
        const columns = head?.cells.length ?? 1
        const body = table.tBodies[0] ?? table.createTBody()
        body.textContent = ''
        const selected = rules.filter(rule => rule.kind === kind)
        for (const rule of selected) {
          const index = rules.indexOf(rule), row = cloneViewRecord(root, 'firewall-' + kind + '-row', 'tr', values(rule, index)) as HTMLTableRowElement
          row.dataset.firewallRuleId = rule.id; row.dataset.listAction = rule.action
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
        if (!selected.length) emptyRow(body, columns, t('No saved rules of this type.')); ruleCount(body, selected.length)
        // the static edit and discard placeholders of this panel are superseded by the live row actions
        table.closest('[data-whm-firewall-panel]')?.querySelectorAll<HTMLElement>(':scope > [data-firewall-static-management]').forEach(node => { node.hidden = true })
      }
      paintLists()
      paintTiles()
      paintReview()
      if (view.pending) {
        note('pending', t('A change is waiting for confirmation. Unless it is kept, the previous rules return at {deadline}.', { deadline: formatDisplayDateTime(view.pending.deadline) }))
        const pending = view.pending
        status.append(' ', button(t('Keep these rules'), () => { void (async () => { busy = true; try { view = readFirewallView(await request('POST', '/api/firewall/confirm', { id: pending.id })); paint(); note('stored', t('The rules were kept.')) } catch (error) { note('failed', failure(error)) } finally { busy = false } })() }))
      }
    }

    const paintTiles = (): void => {
      if (!view) return
      const tiles = root.querySelector<HTMLElement>('[data-firewall-tiles]')
      if (!tiles) return
      const setTile = (index: number, textValue: string, mono = false): void => {
        const dd = tiles.children.item(index)?.querySelector('dd')
        if (!dd) return
        if (mono) {
          const bdi = document.createElement('bdi')
          bdi.dir = 'ltr'
          bdi.textContent = textValue
          dd.replaceChildren(bdi)
        } else {
          dd.textContent = textValue
        }
      }
      if (typeof view.enabled === 'boolean') {
        setTile(1, view.enabled ? t('Enabled') : t('Off'))
        setTile(2, view.enabled ? t('Drop') : t('Allow'))
      }
      if (view.sessionIp) setTile(3, view.sessionIp, true)
      setTile(6, String(view.rules.length), true)
    }

    const paintReview = (): void => {
      if (!view) return
      const reviewSection = root.querySelector<HTMLElement>('[data-whm-ops-section="firewall-review"]')
      if (!reviewSection) return
      const staged = view.staged
      const pill = reviewSection.querySelector<HTMLElement>('[data-firewall-review-pill]')
      if (pill) {
        const diffCount = staged ? staged.counts.added + staged.counts.changed + staged.counts.removed + (staged.counts.moved ? 1 : 0) : 0
        const label = !staged ? t('No pending changes') : t('{count} staged', { count: String(diffCount) })
        const textNode = pill.lastElementChild ?? pill
        textNode.textContent = label
      }
      const reviewStatus = reviewSection.querySelector<HTMLElement>('[data-firewall-review-status]')
      if (reviewStatus && staged !== undefined) {
        reviewStatus.textContent = !staged
          ? t('No staged ruleset is waiting for review. Stage a port rule or JSON import to compare current and proposed rules before applying.')
          : staged.stale
            ? t('Active rules changed since this draft was staged by {actor}. Restage before applying.', { actor: staged.actor })
            : staged.lockout.checked && !staged.lockout.passed
              ? t('Blocked by self-lockout guard: {reason}', { reason: staged.lockout.message ?? '' })
              : t('Staged by {actor}: {current} current rules -> {proposed} proposed rules (+{added} / ~{changed} / -{removed}).', {
                  actor: staged.actor,
                  current: String(staged.currentRuleCount),
                  proposed: String(staged.proposedRuleCount),
                  added: String(staged.counts.added),
                  changed: String(staged.counts.changed),
                  removed: String(staged.counts.removed),
                })
      }
      const cmpCurrent = reviewSection.querySelector<HTMLElement>('[data-firewall-compare-current]')
      const cmpProposed = reviewSection.querySelector<HTMLElement>('[data-firewall-compare-proposed]')
      const cmpDiff = reviewSection.querySelector<HTMLElement>('[data-firewall-compare-diff]')
      if (cmpCurrent) cmpCurrent.textContent = String(staged ? staged.currentRuleCount : view.rules.length)
      if (cmpProposed) cmpProposed.textContent = staged ? String(staged.proposedRuleCount) : '—'
      if (cmpDiff) cmpDiff.textContent = staged ? `+${staged.counts.added} / ~${staged.counts.changed} / -${staged.counts.removed}` : '—'
      const reviewBody = reviewSection.querySelector<HTMLTableSectionElement>('[data-firewall-review-rows]')
      if (reviewBody && staged !== undefined) {
        reviewBody.textContent = ''
        const actLabel = (a: FirewallRuleView['action']): string => a === 'accept' ? t('Allow') : a === 'reject' ? t('Reject') : t('Drop')
        for (const item of staged?.items ?? []) {
          const tr = document.createElement('tr')
          const appendCell = (val: string, technicalVal = false): void => {
            const td = document.createElement('td')
            const el = document.createElement(technicalVal ? 'bdi' : 'span')
            if (technicalVal) el.dir = 'ltr'
            el.textContent = val
            td.append(el)
            tr.append(td)
          }
          appendCell(item.change === 'added' ? t('Added') : item.change === 'changed' ? t('Changed') : t('Removed'))
          appendCell(item.change === 'changed' && item.beforeAction ? actLabel(item.beforeAction) + ' -> ' + actLabel(item.action) : actLabel(item.action))
          appendCell(item.change === 'changed' && item.beforeMatch && item.beforeMatch !== item.match ? item.beforeMatch + ' -> ' + item.match : item.match, true)
          appendCell(item.source ?? t('Any source'), item.source !== null)
          appendCell(item.lockoutCheck === 'pass' ? t('Pass') : item.lockoutCheck === 'blocked' ? t('Blocked') : t('Unchecked'))
          reviewBody.append(tr)
        }
        if (!reviewBody.childElementCount) {
          emptyRow(reviewBody, 5, staged ? t('Rules reordered without field changes.') : t('No staged changes.'))
        }
      }
      if (view.applySteps) {
        for (const step of view.applySteps) {
          reviewSection.querySelectorAll<HTMLElement>('[data-firewall-step]').forEach(el => {
            if (el.dataset.firewallStep === step.id) {
              el.dataset.stepStatus = step.state
              if (step.state === 'current') el.setAttribute('aria-current', 'step')
              else el.removeAttribute('aria-current')
            }
          })
        }
      }
      const discardBtn = reviewSection.querySelector<HTMLButtonElement>('[data-firewall-action="discard-staged"]')
      const applyBtn = reviewSection.querySelector<HTMLButtonElement>('[data-firewall-action="apply-staged"]')
      if (discardBtn) { discardBtn.removeAttribute('data-wiring'); discardBtn.disabled = busy || !staged }
      if (applyBtn) { applyBtn.removeAttribute('data-wiring'); applyBtn.disabled = busy || !staged || !staged.valid || staged.stale }
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
      if (!body.childElementCount) emptyRow(body, 6, t('No prefix lists yet.')); ruleCount(body, view.prefixLists.length)
    }
    const listField = (name: string): HTMLInputElement | HTMLSelectElement | null => listsPanel?.querySelector<HTMLInputElement | HTMLSelectElement>('[name="' + name + '"]') ?? null
    const uploadList = async (replace: boolean): Promise<void> => {
      const name = listField('firewall-prefix-name')?.value.trim() ?? '', file = (listField('firewall-prefix-file') as HTMLInputElement | null)?.files?.[0]
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(name) || !file || file.size > 4 * 1024 * 1024) { note('failed', t('Give the list a name such as blocklist_feed and choose a plain text file of at most 4 MiB.')); return }
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
      if (!body.childElementCount) emptyRow(body, 6, bans.state === 'read' ? t('No address is banned now.') : t('The live ban sets have not been applied on this host yet.')); ruleCount(body, bans.bans.length)
      const tiles = root.querySelector<HTMLElement>('[data-firewall-tiles]')
      const banTile = tiles?.children.item(7)?.querySelector('dd')
      if (banTile) banTile.textContent = bans.state === 'read' ? String(bans.bans.length) : t('Unavailable')
    }
    const unbanHook = bansPanel?.querySelector<HTMLButtonElement>('[data-firewall-action="unban"]')
    if (unbanHook) { unbanHook.removeAttribute('data-wiring'); unbanHook.disabled = false; unbanHook.addEventListener('click', () => { const field = bansPanel!.querySelector<HTMLInputElement>('[name="firewall-unban-address"]'); void unban((field?.value ?? '').split(/[\s,]+/).filter(Boolean)) }) }

    // ---- import and export (format version 1)
    const exchange = root.querySelector<HTMLElement>('[data-whm-ops-section="firewall-import-export"]')
    const json = exchange?.querySelector<HTMLTextAreaElement>('[name="firewall-import-json"]'), file = exchange?.querySelector<HTMLInputElement>('[name="firewall-import-file"]')
    const exportButton = exchange?.querySelector<HTMLButtonElement>('[data-firewall-action="export"]'), importButton = exchange?.querySelector<HTMLButtonElement>('[data-firewall-action="import"]'), stageImportButton = exchange?.querySelector<HTMLButtonElement>('[data-firewall-action="stage-import"]')
    for (const control of [json, file, exportButton, importButton, stageImportButton]) if (control) { control.removeAttribute('data-wiring'); control.disabled = false }
    file?.addEventListener('change', () => { const chosen = file.files?.[0]; if (chosen && json && chosen.size <= 1024 * 1024) void chosen.text().then(text => { json.value = text }) })
    exportButton?.addEventListener('click', () => {
      void request('GET', '/api/firewall/export').then(doc => {
        const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }))
        link.href = url; link.download = 'firewall-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
        note('read', t('Exported. Bans and prefix-list entries are not part of the file.'))
      }, error => note('failed', failure(error)))
    })
    stageImportButton?.addEventListener('click', () => {
      if (busy || !view || !json) return
      let parsed: unknown
      try { parsed = JSON.parse(json.value) } catch { note('failed', t('The file is not valid JSON. Nothing was changed.')); return }
      busy = true; root.setAttribute('aria-busy', 'true')
      void request('PUT', '/api/firewall/staged', { document: parsed, expectedRevision: view.revision })
        .then(res => { view = readFirewallView(res); paint(); note('read', t('Staged for review. Compare current and proposed rules before applying.')) })
        .catch(error => note('failed', failure(error)))
        .finally(() => { busy = false; root.setAttribute('aria-busy', 'false'); paintReview() })
    })
    const stagePortButton = root.querySelector<HTMLButtonElement>('[data-firewall-action="stage-port"]')
    stagePortButton?.addEventListener('click', () => {
      if (busy || !view) return
      const form = stagePortButton.closest<HTMLFormElement>('form[data-firewall-port-rule-form]')
      if (!form) return
      const data = new FormData(form)
      const actionChoice = String(data.get('action') ?? '').trim()
      const protocol = String(data.get('protocol') ?? 'tcp').trim()
      const port = String(data.get('port') ?? '').trim()
      const sourceRaw = String(data.get('source') ?? '').trim()
      const positionChoice = String(data.get('position') ?? 'end').trim()
      const comment = String(data.get('comment') ?? '').trim()
      if (!['accept', 'drop', 'reject'].includes(actionChoice) || !port) { note('failed', t('Choose an action and enter a port or range before staging.')); return }
      busy = true; root.setAttribute('aria-busy', 'true')
      void request('PUT', '/api/firewall/staged', {
        rule: { kind: 'port', action: actionChoice, protocol, port, source: sourceRaw || null, forwardTo: null, list: null, comment, enabled: true },
        position: positionChoice === 'top' ? 'top' : 'end',
        expectedRevision: view.revision,
      })
        .then(res => { view = readFirewallView(res); paint(); note('read', t('Staged for review. Compare current and proposed rules before applying.')) })
        .catch(error => note('failed', failure(error)))
        .finally(() => { busy = false; root.setAttribute('aria-busy', 'false'); paintReview() })
    })
    const discardStagedBtn = root.querySelector<HTMLButtonElement>('[data-firewall-action="discard-staged"]')
    discardStagedBtn?.addEventListener('click', () => {
      if (busy || !view?.staged) return
      busy = true; root.setAttribute('aria-busy', 'true')
      void request('DELETE', '/api/firewall/staged')
        .then(res => { view = readFirewallView(res); paint(); note('read', t('Staged draft discarded.')) })
        .catch(error => note('failed', failure(error)))
        .finally(() => { busy = false; root.setAttribute('aria-busy', 'false'); paintReview() })
    })
    const applyStagedBtn = root.querySelector<HTMLButtonElement>('[data-firewall-action="apply-staged"]')
    applyStagedBtn?.addEventListener('click', () => {
      if (busy || !view?.staged || !view.staged.valid || view.staged.stale) return
      const reviewedRevision = view.revision
      const s = view.staged
      void ask(
        t('Apply staged ruleset?'),
        t('{added} added, {removed} removed, {changed} changed. Applied as one generation and confirmed from this session.', {
          added: String(s.counts.added),
          removed: String(s.counts.removed),
          changed: String(s.counts.changed),
        }),
        s.counts.removed > 0,
      ).then(yes => {
        if (yes && view && view.revision === reviewedRevision) void write('POST', '/api/firewall/staged/apply', {}, reviewedRevision)
      })
    })
    importButton?.addEventListener('click', () => {
      if (busy || !view || !json) return
      const reviewedRevision = view.revision
      let parsed: unknown
      try { parsed = JSON.parse(json.value) } catch { note('failed', t('The file is not valid JSON. Nothing was changed.')); return }
      void (async () => {
        try {
          const check = await request('POST', '/api/firewall/import', { document: parsed, expectedRevision: reviewedRevision, dryRun: true }) as { valid?: boolean; errors?: string[]; diff?: { added?: string[]; removed?: string[]; changed?: string[] } }
          if (!check.valid) { note('failed', t('Not imported: {reason}', { reason: String(check.errors?.[0] ?? '') })); return }
          const yes = await ask(t('Import these rules?'), t('{added} added, {removed} removed, {changed} changed. The import passes the same lockout check before anything applies.', { added: String(check.diff?.added?.length ?? 0), removed: String(check.diff?.removed?.length ?? 0), changed: String(check.diff?.changed?.length ?? 0) }), true)
          if (yes) {
            if (!view || view.revision !== reviewedRevision) {
              note('failed', t("The firewall rules changed after the preview. Preview the import again; this import was not applied.")); return
            }
            await write('POST', '/api/firewall/import', { document: parsed }, reviewedRevision)
          }
        } catch (error) { note('failed', failure(error)) }
      })()
    })

    void loadBans()
    void request('GET', '/api/firewall').then(value => { view = readFirewallView(value); paint(); if (!view.pending) note('read', view.sessionIp ? t('Your session {ip} is checked before every save.', { ip: view.sessionIp }) : t('Rules read.')) }).catch(error => note('failed', failure(error)))
  })
}

export const WHM_FIREWALL_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readFirewallView=${readFirewallView.toString()};const readBanView=${readBanView.toString()};return ${bindWhmFirewall.toString()};})()`
