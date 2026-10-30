/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import './i18n.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

function enhancementClientTemplates(root: HTMLElement) {
  const locate = (name: string, tag: string, slots: readonly string[]) => {
    const template = clientTemplate(root, name)
    cloneClientTemplate(template, tag, slots)
    return () => cloneClientTemplate(template, tag, slots)
  }
  return { definition: locate('enhancement-definition-row', 'tr', ['id', 'label', 'kind', 'range', 'edit', 'delete']),
    assignment: locate('enhancement-assignment-row', 'tr', ['target', 'label', 'value', 'actions']),
    limit: locate('enhancement-limit-row', 'tr', ['reseller', 'label', 'limit', 'used', 'actions']),
    remove: locate('enhancement-remove', 'button', ['label']), emptyFive: locate('enhancement-empty-five', 'tr', ['message']), emptyFour: locate('enhancement-empty-four', 'tr', ['message']) }
}

export type WhmEnhancementDefinition = { id: string; label: string; kind: 'flag' | 'limit'; min: number | null; max: number | null }
export type WhmEnhancementValues = Record<string, true | number>
export type WhmEnhancementsDocument = { definitions: WhmEnhancementDefinition[]; planAssignments: Record<string, WhmEnhancementValues>; accountAssignments: Record<string, WhmEnhancementValues>; resellerLimits: Record<string, Record<string, number | null>> }
export type WhmEnhancementsView = {
  state: 'default' | 'saved' | 'invalid'; revision: string; document: WhmEnhancementsDocument
  directory: { plans: { id: string; name: string }[]; accounts: { id: string; username: string; planId: string; ownerId: string | null }[]; resellers: { id: string; username: string }[] }
}

/** Strict reader for /api/server/account-enhancements (apps/api/src/acct-enhancements-workspace.ts view). */
export function readWhmEnhancementsView(value: unknown): WhmEnhancementsView {
  const bad = (): never => { throw new Error('invalid_enhancements') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const amount = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000_000
  if (!object(value) || !['default', 'saved', 'invalid'].includes(value.state as string) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !object(value.document) || !object(value.directory) || !object(value.application) || value.application.enforced !== false || value.application.resellerAssignment !== false) return bad()
  const doc = value.document, dir = value.directory
  if (!Array.isArray(doc.definitions) || doc.definitions.length > 50 || (value.state !== 'saved' && doc.definitions.length > 0)) return bad()
  const definitions = doc.definitions.map((item): WhmEnhancementDefinition => object(item) && typeof item.id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(item.id) && typeof item.label === 'string' && item.label.length > 0 && [...item.label].length <= 80
    && (item.kind === 'flag' && item.min === null && item.max === null || item.kind === 'limit' && amount(item.min) && amount(item.max) && item.min <= item.max) ? { id: item.id as string, label: item.label as string, kind: item.kind as WhmEnhancementDefinition['kind'], min: item.min as number | null, max: item.max as number | null } : bad())
  const byId = new Map(definitions.map(item => [item.id, item]))
  if (byId.size !== definitions.length) return bad()
  const values = (raw: unknown): WhmEnhancementValues => {
    if (!object(raw)) return bad()
    const out: WhmEnhancementValues = {}
    for (const [id, item] of Object.entries(raw)) { const definition = byId.get(id); if (!definition || (definition.kind === 'flag' ? item !== true : !amount(item) || item < definition.min! || item > definition.max!)) return bad(); out[id] = item as true | number }
    return out
  }
  const targets = <T>(raw: unknown, read: (item: unknown) => T): Record<string, T> => { if (!object(raw) || Object.keys(raw).length > 5000) return bad(); const out: Record<string, T> = {}; for (const [id, item] of Object.entries(raw)) out[uuid(id) ? id : bad()] = read(item); return out }
  const document: WhmEnhancementsDocument = { definitions, planAssignments: targets(doc.planAssignments, values), accountAssignments: targets(doc.accountAssignments, values),
    resellerLimits: targets(doc.resellerLimits, item => { if (!object(item)) return bad(); const out: Record<string, number | null> = {}; for (const [id, limit] of Object.entries(item)) out[byId.has(id) && (limit === null || amount(limit)) ? id : bad()] = limit as number | null; return out }) }
  if (!Array.isArray(dir.plans) || !Array.isArray(dir.accounts) || !Array.isArray(dir.resellers) || [dir.plans, dir.accounts, dir.resellers].some(list => (list as unknown[]).length > 10000)) return bad()
  return { state: value.state as WhmEnhancementsView['state'], revision: value.revision, document, directory: {
    plans: dir.plans.map(item => object(item) && uuid(item.id) && typeof item.name === 'string' && item.name.length <= 128 ? { id: item.id, name: item.name } : bad()),
    accounts: dir.accounts.map(item => object(item) && uuid(item.id) && typeof item.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item.username) && uuid(item.planId) && (item.ownerId === null || uuid(item.ownerId)) ? { id: item.id, username: item.username, planId: item.planId, ownerId: item.ownerId as string | null } : bad()),
    resellers: dir.resellers.map(item => object(item) && uuid(item.id) && typeof item.username === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(item.username) ? { id: item.id, username: item.username } : bad()),
  } }
}

function bindWhmEnhancements(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-acct-enh-workspace]').forEach(root => {
    if (root.dataset.enhBound === 'true') return
    root.dataset.enhBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-acct-enh-status]'), loading = one<HTMLElement>('[data-acct-enh-loading]'), refresh = one<HTMLButtonElement>('[data-acct-enh-refresh]'), saveStatus = one<HTMLElement>('[data-acct-enh-save-status]'), empty = one<HTMLElement>('[data-acct-enh-empty]')
    const rows = { definitions: one<HTMLElement>('[data-acct-enh-rows="definitions"]'), assignments: one<HTMLElement>('[data-acct-enh-rows="assignments"]'), limits: one<HTMLElement>('[data-acct-enh-rows="limits"]') }
    const forms = { definition: one<HTMLFormElement>('[data-acct-enh-form="definition"]'), assignment: one<HTMLFormElement>('[data-acct-enh-form="assignment"]'), limit: one<HTMLFormElement>('[data-acct-enh-form="limit"]') }
    const valueField = one<HTMLElement>('[data-acct-enh-value-field]')
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {}
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-acct-enh-input]').forEach(control => { inputs[control.dataset.acctEnhInput!] = control })
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const names = ['id', 'label', 'kind', 'min', 'max', 'assign-scope', 'assign-target', 'assign-enhancement', 'assign-value', 'limit-reseller', 'limit-enhancement', 'limit-value']
    if (!status || !loading || !refresh || !saveStatus || !empty || !valueField || Object.values(rows).some(node => !node) || Object.values(forms).some(node => !node) || !names.every(name => inputs[name])) return
    let templates: ReturnType<typeof enhancementClientTemplates>
    try { templates = enhancementClientTemplates(root) } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = t('Account enhancements are available to the root administrator only.'); return
    }
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.enhCanManage === 'true' && !root.closest(denied) && Object.values(forms).every(form => form!.tagName === 'FORM') && typeof request === 'function'
    let view: WhmEnhancementsView | null = null, busy = false
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, ltr = false): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (ltr) node.setAttribute('dir', 'ltr'); return node }
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (locked: boolean): void => {
      busy = locked
      for (const control of [...Object.values(inputs), refresh]) control.disabled = locked || !admitted()
      root.querySelectorAll<HTMLButtonElement>('[data-acct-enh-submit], [data-acct-enh-rows] button').forEach(button => { button.disabled = locked || !admitted() || !view || view.state === 'invalid' })
      root.setAttribute('aria-busy', String(locked))
    }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean; limit?: number } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Refresh before trying again.')
        : failed?.status === 409 ? t('The enhancements changed since they were read. Refresh, then try again.')
          : failed?.status === 403 ? t('Root authorization is required for account enhancements.')
            : typeof failed?.details?.limit === 'number' ? t("The reseller's accounts already hold this enhancement more often than the limit allows. Remove assignments first.")
              : failed?.status === 400 || failed?.status === 422 ? t('The server refused these values. Check the ID, the range and the selected plan, account or reseller.') : fallback
    }
    const label = (id: string): string => view?.document.definitions.find(item => item.id === id)?.label ?? id
    const fill = (select: HTMLSelectElement, items: { id: string; label: string }[], none: string): void => {
      const kept = select.value, first = element('option', items.length ? t('Choose one') : none)
      first.value = ''
      select.replaceChildren(first, ...items.map(item => { const option = element('option', item.label); option.value = item.id; return option }))
      select.value = items.some(item => item.id === kept) ? kept : ''
    }
    const syncChoices = (): void => {
      const enhancements = (view?.document.definitions ?? []).map(item => ({ id: item.id, label: item.label }))
      const scope = inputs['assign-scope']!.value
      fill(inputs['assign-target'] as HTMLSelectElement, scope === 'plan' ? (view?.directory.plans ?? []).map(plan => ({ id: plan.id, label: plan.name })) : (view?.directory.accounts ?? []).map(account => ({ id: account.id, label: account.username })), scope === 'plan' ? t('No plans exist') : t('No accounts exist'))
      fill(inputs['assign-enhancement'] as HTMLSelectElement, enhancements, t('No enhancements defined'))
      fill(inputs['limit-enhancement'] as HTMLSelectElement, enhancements, t('No enhancements defined'))
      fill(inputs['limit-reseller'] as HTMLSelectElement, (view?.directory.resellers ?? []).map(reseller => ({ id: reseller.id, label: reseller.username })), t('No resellers exist'))
      valueField.hidden = view?.document.definitions.find(item => item.id === inputs['assign-enhancement']!.value)?.kind !== 'limit'
    }
    const removeButton = (accessible: string, change: (document: WhmEnhancementsDocument) => void): HTMLButtonElement => {
      const button = templates.remove() as HTMLButtonElement; clientTemplateSlot(button, 'label').textContent = t('Remove'); button.setAttribute('aria-label', accessible)
      button.addEventListener('click', () => { if (!busy && view) void save(change, t('Removed.')) }); return button
    }
    const fillRow = (make: () => HTMLElement, cells: Record<string, Node | string>): HTMLElement => { const tr = make(); for (const [key, value] of Object.entries(cells)) clientTemplateSlot(tr, key).replaceChildren(value); return tr }
    const emptyRow = (body: HTMLElement, columns: number, message: string): void => { body.replaceChildren(fillRow(columns === 4 ? templates.emptyFour : templates.emptyFive, { message })) }
    const paint = (next: WhmEnhancementsView): void => {
      view = next
      const doc = next.document, plan = (id: string): string => next.directory.plans.find(item => item.id === id)?.name || t('Not available'), account = (id: string): string => next.directory.accounts.find(item => item.id === id)?.username ?? t('Not available')
      rows.definitions!.replaceChildren(...doc.definitions.map(item => {
        const tr = fillRow(templates.definition, { id: item.id, label: item.label, kind: item.kind === 'flag' ? t('On or off') : t('Number'), range: item.kind === 'flag' ? '-' : `${item.min} - ${item.max}` })
        const edit = clientTemplateSlot(tr, 'edit', 'button') as HTMLButtonElement; edit.textContent = t('Edit'); edit.setAttribute('aria-label', t('Edit {name}', { name: item.label }))
        edit.addEventListener('click', () => { inputs.id!.value = item.id; inputs.label!.value = item.label; inputs.kind!.value = item.kind; inputs.min!.value = item.min === null ? '' : String(item.min); inputs.max!.value = item.max === null ? '' : String(item.max); inputs.label!.focus() })
        const remove = clientTemplateSlot(tr, 'delete', 'button') as HTMLButtonElement; remove.textContent = t('Delete'); remove.setAttribute('aria-label', t('Delete {name}', { name: item.label }))
        remove.addEventListener('click', () => void deleteDefinition(item))
        return tr
      }))
      if (!doc.definitions.length) emptyRow(rows.definitions!, 5, next.state === 'invalid' ? t('The saved enhancements file cannot be read. It cannot be changed here.') : t('No enhancements'))
      empty.hidden = next.state === 'invalid' || doc.definitions.length > 0
      const assignments = [...Object.entries(doc.planAssignments).map(([id, values]) => ['plan', id, values] as const), ...Object.entries(doc.accountAssignments).map(([id, values]) => ['account', id, values] as const)]
        .flatMap(([scope, id, values]) => Object.entries(values).map(([enhancement, value]) => {
          const target = scope === 'plan' ? t('Plan: {name}', { name: plan(id) }) : t('Account: {name}', { name: account(id) })
          return fillRow(templates.assignment, { target, label: label(enhancement), value: value === true ? t('On') : String(value), actions: removeButton(t('Remove {name} from {target}', { name: label(enhancement), target }), document => {
            const map = scope === 'plan' ? document.planAssignments : document.accountAssignments, kept = { ...map[id] }
            delete kept[enhancement]
            if (Object.keys(kept).length) map[id] = kept; else delete map[id]
          }) })
        }))
      rows.assignments!.replaceChildren(...assignments)
      if (!assignments.length) emptyRow(rows.assignments!, 4, t('No assignments'))
      const limits = Object.entries(doc.resellerLimits).flatMap(([resellerId, values]) => Object.entries(values).map(([enhancement, limit]) => {
        const reseller = next.directory.resellers.find(item => item.id === resellerId)?.username ?? t('Not available')
        const used = next.directory.accounts.filter(item => item.ownerId === resellerId && doc.accountAssignments[item.id]?.[enhancement] !== undefined).length
        return fillRow(templates.limit, { reseller, label: label(enhancement), limit: limit === null ? t('Unlimited') : String(limit), used: String(used), actions: removeButton(t('Remove the {name} limit for {reseller}', { name: label(enhancement), reseller }), document => {
          const kept = { ...document.resellerLimits[resellerId] }
          delete kept[enhancement]
          if (Object.keys(kept).length) document.resellerLimits[resellerId] = kept; else delete document.resellerLimits[resellerId]
        }) })
      }))
      rows.limits!.replaceChildren(...limits)
      if (!limits.length) emptyRow(rows.limits!, 5, t('No reseller limits'))
      note(status, next.state === 'invalid' ? 'failed' : 'ready', next.state === 'invalid' ? t('The saved enhancements file requires review.') : t('{count, plural, one {{count} enhancement read.} other {{count} enhancements read.}}', { count: doc.definitions.length }))
      syncChoices(); lock(false)
    }
    const load = async (): Promise<void> => {
      if (!request) return
      loading.hidden = false; lock(true); note(status, 'reading', t('Reading enhancements...'))
      try { paint(readWhmEnhancementsView(await request('GET', '/api/server/account-enhancements'))) }
      catch (error) { view = null; note(status, 'failed', failText(error, t('Enhancements could not be read or verified. Nothing was changed.'))); lock(false) }
      finally { loading.hidden = true }
    }
    const save = async (change: (document: WhmEnhancementsDocument) => void, done: string): Promise<void> => {
      if (busy || !admitted() || !view || !request || view.state === 'invalid') return
      const draft = JSON.parse(JSON.stringify(view.document)) as WhmEnhancementsDocument
      change(draft)
      lock(true); note(saveStatus, 'reading', t('Saving enhancements...'))
      try {
        const next = readWhmEnhancementsView(await request('PUT', '/api/server/account-enhancements', { expectedRevision: view.revision, ...draft }))
        if (JSON.stringify(next.document.definitions) !== JSON.stringify(draft.definitions) || Object.keys(next.document.accountAssignments).length !== Object.keys(draft.accountAssignments).length) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next); note(saveStatus, 'ok', done)
      } catch (error) { note(saveStatus, 'failed', failText(error, t('The enhancements were not saved.'))); lock(false) }
    }
    const deleteDefinition = async (item: WhmEnhancementDefinition): Promise<void> => {
      if (busy || !view || typeof askDialog !== 'function') return
      let confirmed = false
      try { confirmed = await askDialog({ title: t('Delete this enhancement?'), body: t('{name} is also removed from every plan, account and reseller limit that uses it.', { name: item.label }), confirm: t('Delete'), danger: true }) === true } catch { confirmed = false }
      if (!confirmed) return
      await save(document => {
        document.definitions = document.definitions.filter(definition => definition.id !== item.id)
        for (const map of [document.planAssignments, document.accountAssignments, document.resellerLimits] as Record<string, Record<string, unknown>>[])
          for (const [target, values] of Object.entries(map)) { delete values[item.id]; if (!Object.keys(values).length) delete map[target] }
      }, t('The enhancement is deleted.'))
    }
    const whole = (raw: string): number | null => /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : null
    forms.definition!.addEventListener('submit', event => {
      event.preventDefault()
      const kind = inputs.kind!.value === 'limit' ? 'limit' : 'flag', min = whole(inputs.min!.value), max = whole(inputs.max!.value)
      if (kind === 'limit' && (min === null || max === null)) { note(saveStatus, 'failed', t('A number enhancement needs a whole minimum and maximum.')); return }
      const definition: WhmEnhancementDefinition = { id: inputs.id!.value.trim(), label: inputs.label!.value.trim(), kind, min: kind === 'limit' ? min : null, max: kind === 'limit' ? max : null }
      void save(document => { const at = document.definitions.findIndex(item => item.id === definition.id); if (at >= 0) document.definitions[at] = definition; else document.definitions.push(definition) }, t('The enhancement is saved.'))
    })
    forms.assignment!.addEventListener('submit', event => {
      event.preventDefault()
      const scope = inputs['assign-scope']!.value, target = inputs['assign-target']!.value, id = inputs['assign-enhancement']!.value, definition = view?.document.definitions.find(item => item.id === id)
      if (!target || !definition) { note(saveStatus, 'failed', t('Choose where to assign and which enhancement.')); return }
      const value = definition.kind === 'flag' ? true : whole(inputs['assign-value']!.value)
      if (value === null) { note(saveStatus, 'failed', t('Enter a whole number for this enhancement.')); return }
      void save(document => { const map = scope === 'plan' ? document.planAssignments : document.accountAssignments; map[target] = { ...map[target], [id]: value } }, t('The assignment is saved.'))
    })
    forms.limit!.addEventListener('submit', event => {
      event.preventDefault()
      const reseller = inputs['limit-reseller']!.value, id = inputs['limit-enhancement']!.value, raw = inputs['limit-value']!.value.trim(), limit = raw ? whole(raw) : null
      if (!reseller || !id) { note(saveStatus, 'failed', t('Choose a reseller and an enhancement.')); return }
      if (raw && limit === null) { note(saveStatus, 'failed', t('Enter a whole number, or leave the limit empty for unlimited.')); return }
      void save(document => { document.resellerLimits[reseller] = { ...document.resellerLimits[reseller], [id]: limit } }, t('The reseller limit is saved.'))
    })
    for (const name of ['assign-scope', 'assign-enhancement']) inputs[name]!.addEventListener('change', syncChoices)
    refresh.addEventListener('click', () => { if (!busy) void load() })
    lock(false); syncChoices()
    if (admitted()) void load()
    else note(status, 'unavailable', t('Account enhancements are available to the root administrator only.'))
  })
}

export const WHM_ENHANCEMENTS_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};${enhancementClientTemplates.toString()};const readWhmEnhancementsView=${readWhmEnhancementsView.toString()};return ${bindWhmEnhancements.toString()};})()`
