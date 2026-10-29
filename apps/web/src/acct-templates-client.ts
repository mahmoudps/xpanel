/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export type WhmTemplatePage = { title: string; body: string }
export type WhmTemplatePreviewRecord = { name: string; type: string; ttl: number; priority: number | null; content: string }
export type WhmAccountTemplate = { id: string; name: string; zone: string; recordCount: number; defaultPage: WhmTemplatePage; suspendedPage: WhmTemplatePage; planIds: string[]; updatedAt: string; updatedBy: string; preview: WhmTemplatePreviewRecord[] }
export type WhmAccountTemplatesView = { state: 'default' | 'saved' | 'invalid'; revision: string; templates: WhmAccountTemplate[]; plans: { id: string; name: string }[]; applied: true; changed: string | null }

/** Strict reader for /api/server/account-templates (apps/api/src/acct-templates-workspace.ts view). */
export function readWhmAccountTemplatesView(value: unknown): WhmAccountTemplatesView {
  const bad = (): never => { throw new Error('invalid_templates') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && [...item].length <= max
  const page = (item: unknown): WhmTemplatePage => object(item) && text(item.title, 140) && text(item.body, 2000) ? { title: item.title, body: item.body } : bad()
  if (!object(value) || !['default', 'saved', 'invalid'].includes(value.state as string) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Array.isArray(value.templates) || value.templates.length > 20 || (value.state !== 'saved' && value.templates.length > 0) || !Array.isArray(value.plans) || value.plans.length > 5000
    || !object(value.application) || value.application.appliedToNewAccounts !== true || value.application.defaultPagePublished !== false || value.application.suspendedPagePublished !== false || !(value.changed === undefined || uuid(value.changed))) return bad()
  const plans = value.plans.map(item => object(item) && uuid(item.id) && text(item.name, 128) ? { id: item.id, name: item.name } : bad())
  const templates = value.templates.map((item): WhmAccountTemplate => {
    if (!object(item) || !uuid(item.id) || !text(item.name, 64) || !item.name || typeof item.zone !== 'string' || item.zone.length > 60000 || !Array.isArray(item.records) || item.records.length > 50
      || !Array.isArray(item.planIds) || !item.planIds.every(uuid) || typeof item.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.updatedAt)
      || typeof item.updatedBy !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(item.updatedBy) || !Array.isArray(item.preview) || item.preview.length > 200) return bad()
    const preview = item.preview.map(record => object(record) && typeof record.name === 'string' && record.name.length <= 255 && typeof record.type === 'string' && /^[A-Z]{1,5}$/.test(record.type)
      && typeof record.ttl === 'number' && Number.isSafeInteger(record.ttl) && record.ttl >= 0 && (record.priority === null || typeof record.priority === 'number' && Number.isSafeInteger(record.priority)) && typeof record.content === 'string' && record.content.length <= 16384
      ? { name: record.name, type: record.type, ttl: record.ttl, priority: record.priority as number | null, content: record.content } : bad())
    return { id: item.id, name: item.name, zone: item.zone, recordCount: item.records.length, defaultPage: page(item.defaultPage), suspendedPage: page(item.suspendedPage), planIds: [...item.planIds as string[]], updatedAt: item.updatedAt, updatedBy: item.updatedBy, preview }
  })
  if (new Set(templates.map(item => item.id)).size !== templates.length) return bad()
  return { state: value.state as WhmAccountTemplatesView['state'], revision: value.revision, templates, plans, applied: true, changed: value.changed === undefined ? null : value.changed as string }
}

function bindWhmAccountTemplates(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, _rtl: boolean): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-acct-templates-workspace]').forEach(root => {
    if (root.dataset.templatesBound === 'true') return
    root.dataset.templatesBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-acct-templates-status]'), loading = one<HTMLElement>('[data-acct-templates-loading]'), rows = one<HTMLElement>('[data-acct-templates-rows]'), empty = one<HTMLElement>('[data-acct-templates-empty]')
    const refresh = one<HTMLButtonElement>('[data-acct-templates-refresh]'), listStatus = one<HTMLElement>('[data-acct-templates-list-status]'), plansBox = one<HTMLElement>('[data-acct-templates-plans]'), preview = one<HTMLElement>('[data-acct-templates-preview]')
    const form = one<HTMLFormElement>('[data-acct-templates-form]'), heading = one<HTMLElement>('[data-acct-templates-editor-heading]'), save = one<HTMLButtonElement>('[data-acct-templates-save]'), cancel = one<HTMLButtonElement>('[data-acct-templates-cancel]'), saveStatus = one<HTMLElement>('[data-acct-templates-save-status]')
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {}
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-acct-templates-input]').forEach(control => { inputs[control.dataset.acctTemplatesInput!] = control })
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const names = ['name', 'zone', 'defaultPage.title', 'defaultPage.body', 'suspendedPage.title', 'suspendedPage.body']
    if (!status || !loading || !rows || !empty || !refresh || !listStatus || !plansBox || !preview || !form || !heading || !save || !cancel || !saveStatus || !names.every(name => inputs[name])) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.templatesCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    let view: WhmAccountTemplatesView | null = null, editing = '', busy = false
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, ltr = false): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (ltr) node.setAttribute('dir', 'ltr'); return node }
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const planBoxes = (): HTMLInputElement[] => Array.from(plansBox.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const lock = (locked: boolean): void => {
      busy = locked
      for (const control of [...Object.values(inputs), ...planBoxes(), refresh, cancel]) control.disabled = locked || !admitted()
      save.disabled = locked || !admitted() || !view || view.state === 'invalid'
      root.setAttribute('aria-busy', String(locked))
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = locked || !admitted() || (button.dataset.action === 'delete' && typeof askDialog !== 'function') })
    }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; message?: string; details?: { verificationRequired?: boolean; stateChanged?: boolean; line?: number } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Refresh the templates before trying again.')
        : failed?.status === 409 ? t('The templates changed, or a plan already uses another template. Refresh, then try again.')
          : failed?.status === 403 ? t('Root authorization is required for account templates.')
            : failed?.status === 404 ? t('That template no longer exists. Refresh the templates.')
              : typeof failed?.details?.line === 'number' ? t('Zone record line {line} was refused. Check its name, TTL, type, priority and placeholders.', { line: failed.details.line })
                : failed?.status === 400 || failed?.status === 422 ? t('The server refused these values. Check the zone records and the page text.') : fallback
    }
    const paintPlans = (selected: readonly string[]): void => {
      if (!view?.plans.length) { plansBox.replaceChildren(element('p', view ? t('No plans exist') : t('Plans have not been read.'))); return }
      plansBox.replaceChildren(...view.plans.map(plan => { const label = element('label'), box = element('input'); box.type = 'checkbox'; box.value = plan.id; box.checked = selected.includes(plan.id); label.append(box, element('bdi', plan.name)); return label }))
    }
    const paintPreview = (template: WhmAccountTemplate | null): void => {
      if (!template) { const row = element('tr'), cell = element('td', t('No template selected')); cell.colSpan = 5; row.append(cell); preview.replaceChildren(row); return }
      preview.replaceChildren(...template.preview.map(record => { const row = element('tr'); for (const value of [record.name, String(record.ttl), record.type, record.priority === null ? '-' : String(record.priority), record.content]) { const cell = element('td'); cell.append(element('bdi', value, true)); row.append(cell) }; return row }))
    }
    const resetForm = (): void => {
      editing = ''
      for (const control of Object.values(inputs)) { control.value = ''; control.removeAttribute('aria-invalid') }
      paintPlans([]); paintPreview(null)
      heading.textContent = t('Create template'); save.textContent = t('Create template'); cancel.hidden = true
      lock(busy)
    }
    const edit = (template: WhmAccountTemplate): void => {
      editing = template.id
      inputs.name!.value = template.name; inputs.zone!.value = template.zone
      inputs['defaultPage.title']!.value = template.defaultPage.title; inputs['defaultPage.body']!.value = template.defaultPage.body
      inputs['suspendedPage.title']!.value = template.suspendedPage.title; inputs['suspendedPage.body']!.value = template.suspendedPage.body
      paintPlans(template.planIds); paintPreview(template)
      heading.textContent = t('Edit template'); save.textContent = t('Save changes'); cancel.hidden = false; saveStatus.hidden = true
      lock(busy); inputs.name!.focus()
    }
    const paint = (next: WhmAccountTemplatesView): void => {
      view = next
      const planName = (id: string): string => next.plans.find(plan => plan.id === id)?.name ?? t('deleted plan')
      rows.replaceChildren(...next.templates.map(template => {
        const row = element('tr'), cell = (...nodes: (Node | string)[]): void => { const node = element('td'); node.append(...nodes); row.append(node) }
        cell(element('bdi', template.name))
        cell(template.planIds.length ? element('bdi', template.planIds.map(planName).join(', ')) : t('No plan'))
        cell(element('bdi', String(template.recordCount), true))
        cell(element('bdi', formatDisplayDateTime(template.updatedAt), true))
        const actions = element('div'); actions.className = 'xp-whm-detail-actions'
        for (const [action, label] of [['edit', t('Edit')], ['delete', t('Delete')]] as const) {
          const button = element('button', label); button.type = 'button'; button.className = action === 'delete' ? 'xp-btn xp-btn--danger' : 'xp-btn'; button.dataset.action = action
          button.setAttribute('aria-label', action === 'edit' ? t('Edit {name}', { name: template.name }) : t('Delete {name}', { name: template.name }))
          button.addEventListener('click', () => void act(action, template)); actions.append(button)
        }
        cell(actions)
        return row
      }))
      if (!next.templates.length) { const row = element('tr'), cell = element('td', next.state === 'invalid' ? t('The saved templates file cannot be read. Nothing is shown and it cannot be changed here.') : t('No templates')); cell.colSpan = 5; row.append(cell); rows.replaceChildren(row) }
      empty.hidden = next.state === 'invalid' || next.templates.length > 0
      note(status, next.state === 'invalid' ? 'failed' : 'ready', next.state === 'invalid' ? t('The saved templates file requires review.') : t('{count, plural, one {{count} template read.} other {{count} templates read.}}', { count: next.templates.length }))
      const current = next.templates.find(template => template.id === editing)
      if (editing && !current) resetForm(); else if (current) { paintPlans(planBoxes().filter(box => box.checked).map(box => box.value)); paintPreview(current) } else paintPlans([])
      lock(false)
    }
    const load = async (): Promise<void> => {
      if (!request) return
      loading.hidden = false; lock(true); note(status, 'reading', t('Reading templates...'))
      try { paint(readWhmAccountTemplatesView(await request('GET', '/api/server/account-templates'))) }
      catch (error) { view = null; rows.replaceChildren(); empty.hidden = true; note(status, 'failed', failText(error, t('Templates could not be read or verified. Nothing was changed.'))); lock(false) }
      finally { loading.hidden = true }
    }
    const act = async (action: string, template: WhmAccountTemplate): Promise<void> => {
      if (busy || !admitted() || !view) return
      if (action === 'edit') { edit(template); return }
      let confirmed = false
      try { confirmed = typeof askDialog === 'function' && await askDialog({ title: t('Delete this template?'), body: template.name, confirm: t('Delete'), danger: true }) === true } catch { confirmed = false }
      if (!confirmed || !view || !request) return
      lock(true); note(listStatus, 'reading', t('Deleting the template...'))
      try {
        const next = readWhmAccountTemplatesView(await request('DELETE', '/api/server/account-templates/' + template.id, { expectedRevision: view.revision }))
        if (next.templates.some(item => item.id === template.id)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next); note(listStatus, 'ok', t('The template is deleted.'))
      } catch (error) { note(listStatus, 'failed', failText(error, t('The template was not deleted.'))); lock(false) }
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !admitted() || !view || !request) return
      const target = editing, body = {
        name: inputs.name!.value.trim(), zone: inputs.zone!.value, planIds: planBoxes().filter(box => box.checked).map(box => box.value),
        defaultPage: { title: inputs['defaultPage.title']!.value.trim(), body: inputs['defaultPage.body']!.value.trim() }, suspendedPage: { title: inputs['suspendedPage.title']!.value.trim(), body: inputs['suspendedPage.body']!.value.trim() },
        expectedRevision: view.revision,
      }
      lock(true); note(saveStatus, 'reading', t('Saving the template...'))
      void (async () => {
        try {
          const next = readWhmAccountTemplatesView(await request(target ? 'PUT' : 'POST', '/api/server/account-templates' + (target ? '/' + target : ''), body))
          const saved = next.templates.find(item => item.id === next.changed)
          if (!saved || (target && saved.id !== target) || saved.name !== body.name) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
          editing = saved.id; paint(next); edit(saved); note(saveStatus, 'ok', t('The template is saved. New accounts on its plans get its zone records.'))
        } catch (error) { note(saveStatus, 'failed', failText(error, t('The template was not saved.'))); lock(false) }
      })()
    })
    cancel.addEventListener('click', () => { if (!busy) resetForm() })
    refresh.addEventListener('click', () => { if (!busy) void load() })
    lock(false)
    if (admitted()) void load()
    else note(status, 'unavailable', t('Account templates are available to the root administrator only.'))
  })
}

export const WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmAccountTemplatesView=${readWhmAccountTemplatesView.toString()};return ${bindWhmAccountTemplates.toString()};})()`
