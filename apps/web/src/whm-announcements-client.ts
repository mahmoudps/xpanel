import { WHM_CLIENT_TEMPLATE_BINDING, whmClientNode as canonicalWhmClientNode, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './whm-client-templates.ts'
const whmClientNode = canonicalWhmClientNode, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { buildAccountAnnouncementNotice, type AccountAnnouncementLabels } from './board-port/account-announcements-banner-client.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

type Text = { en: string; ar: string }
// Module-local alias: the binding source refers to it by this name, defined again in WHM_ANNOUNCEMENTS_CLIENT_BINDING.
const buildNotice = buildAccountAnnouncementNotice
export type WhmAnnouncementAudience = { kind: 'all' } | { kind: 'plan'; planId: string } | { kind: 'reseller'; resellerId: string } | { kind: 'accounts'; usernames: string[] }
export type WhmAnnouncement = {
  id: string; status: 'active' | 'archived'; severity: 'info' | 'warning' | 'maintenance'; title: Text; body: Text; audience: WhmAnnouncementAudience
  startsAt: string | null; endsAt: string | null; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string; phase: 'scheduled' | 'live' | 'ended' | 'archived'
}
export type WhmAnnouncementsView = {
  state: 'default' | 'saved' | 'invalid'; revision: string; announcements: WhmAnnouncement[]
  choices: { plans: { id: string; name: string }[]; resellers: { id: string; username: string }[] }; changed: string | null
}

/** Strict reader for /api/server/announcements (apps/api/src/announcements-workspace.ts manageView). */
export function readWhmAnnouncementsView(value: unknown): WhmAnnouncementsView {
  const bad = (): never => { throw new Error('invalid_announcements') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const stamp = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)
  const actor = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(item)
  const text = (item: unknown, max: number): Text => object(item) && Object.keys(item).sort().join() === 'ar,en' && [item.en, item.ar].every(part => typeof part === 'string' && part.length > 0 && [...part].length <= max) ? { en: item.en as string, ar: item.ar as string } : bad()
  const audience = (item: unknown): WhmAnnouncementAudience => {
    if (!object(item)) return bad()
    const shape = Object.keys(item).sort().join()
    if (item.kind === 'all' && shape === 'kind') return { kind: 'all' }
    if (item.kind === 'plan' && shape === 'kind,planId' && uuid(item.planId)) return { kind: 'plan', planId: item.planId }
    if (item.kind === 'reseller' && shape === 'kind,resellerId' && uuid(item.resellerId)) return { kind: 'reseller', resellerId: item.resellerId }
    const names = item.usernames
    if (item.kind === 'accounts' && shape === 'kind,usernames' && Array.isArray(names) && names.length >= 1 && names.length <= 100 && names.every(name => typeof name === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(name))) return { kind: 'accounts', usernames: [...names as string[]] }
    return bad()
  }
  if (!object(value) || !['default', 'saved', 'invalid'].includes(value.state as string) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Array.isArray(value.announcements) || value.announcements.length > 100 || (value.state !== 'saved' && value.announcements.length > 0)
    || !object(value.choices) || !Array.isArray(value.choices.plans) || !Array.isArray(value.choices.resellers) || value.choices.plans.length > 1000 || value.choices.resellers.length > 1000
    || !(value.changed === undefined || uuid(value.changed))) return bad()
  const announcements = value.announcements.map((item): WhmAnnouncement => {
    if (!object(item) || !uuid(item.id) || (item.status !== 'active' && item.status !== 'archived') || !['info', 'warning', 'maintenance'].includes(item.severity as string)
      || !(item.startsAt === null || stamp(item.startsAt)) || !(item.endsAt === null || stamp(item.endsAt)) || !stamp(item.createdAt) || !stamp(item.updatedAt) || !actor(item.createdBy) || !actor(item.updatedBy)
      || !['scheduled', 'live', 'ended', 'archived'].includes(item.phase as string) || (item.status === 'archived') !== (item.phase === 'archived')) return bad()
    return { id: item.id, status: item.status, severity: item.severity as WhmAnnouncement['severity'], title: text(item.title, 140), body: text(item.body, 2000), audience: audience(item.audience),
      startsAt: item.startsAt as string | null, endsAt: item.endsAt as string | null, createdAt: item.createdAt, createdBy: item.createdBy, updatedAt: item.updatedAt, updatedBy: item.updatedBy, phase: item.phase as WhmAnnouncement['phase'] }
  })
  if (new Set(announcements.map(item => item.id)).size !== announcements.length) return bad()
  const plans = value.choices.plans.map(item => object(item) && uuid(item.id) && typeof item.name === 'string' && item.name.length <= 128 ? { id: item.id, name: item.name } : bad())
  const resellers = value.choices.resellers.map(item => object(item) && uuid(item.id) && typeof item.username === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(item.username) ? { id: item.id, username: item.username } : bad())
  return { state: value.state as WhmAnnouncementsView['state'], revision: value.revision, announcements, choices: { plans, resellers }, changed: value.changed === undefined ? null : value.changed as string }
}

function bindWhmAnnouncements(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  // Authored content is keyed by locale tag; the source locale is always present.
  const pageLocale = document.documentElement.lang
  const localized = (text: Text): string => (text as Readonly<Record<string, string>>)[pageLocale] ?? text.en
  // Each preview carries notice labels in its own language (rendered by the server workspace).
  const previewLabels = (node: HTMLElement): AccountAnnouncementLabels | undefined => { try { return JSON.parse(node.dataset.whmAnnouncementsLabels ?? '') as AccountAnnouncementLabels } catch { return undefined } }
  document.querySelectorAll<HTMLElement>('[data-whm-announcements-workspace]').forEach(root => {
    if (root.dataset.announcementsBound === 'true') return
    root.dataset.announcementsBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-whm-announcements-status]'), loading = one<HTMLElement>('[data-whm-announcements-loading]'), rows = one<HTMLElement>('[data-whm-announcements-rows]')
    const empty = one<HTMLElement>('[data-whm-announcements-empty]'), refresh = one<HTMLButtonElement>('[data-whm-announcements-refresh]'), listStatus = one<HTMLElement>('[data-whm-announcements-list-status]')
    const form = one<HTMLFormElement>('[data-whm-announcements-form]'), heading = one<HTMLElement>('[data-whm-announcements-editor-heading]'), save = one<HTMLButtonElement>('[data-whm-announcements-save]')
    const cancel = one<HTMLButtonElement>('[data-whm-announcements-cancel]'), saveStatus = one<HTMLElement>('[data-whm-announcements-save-status]'), previewEmpty = one<HTMLElement>('[data-whm-announcements-preview-empty]')
    const previews = Array.from(root.querySelectorAll<HTMLElement>('[data-whm-announcements-preview]'))
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {}
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-whm-announcements-input]').forEach(control => { inputs[control.dataset.whmAnnouncementsInput!] = control })
    const names = ['title-en', 'body-en', 'title-ar', 'body-ar', 'severity', 'audience', 'plan', 'reseller', 'usernames', 'starts', 'ends']
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !empty || !refresh || !listStatus || !form || !heading || !save || !cancel || !saveStatus || !previewEmpty || previews.length !== 2 || !names.every(name => inputs[name])) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.announcementsCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    const fields = Object.values(inputs)
    let view: WhmAnnouncementsView | null = null, editing = '', busy = false
    let editingSource: { revision: string; startsAt: string | null; endsAt: string | null } | null = null
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, ltr = false): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag)
      if (content !== undefined) node.textContent = content
      if (ltr) node.setAttribute('dir', 'ltr')
      return node
    }
    // Whole messages keep their word order; each {key} becomes its node.
    const parts = (message: string, nodes: Readonly<Record<string, Node>>): (Node | string)[] => message.split(/(\{\w+\})/).map((part, index) => index % 2 ? nodes[part.slice(1, -1)] ?? part : part).filter(part => part !== '')
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const severityLabel = (value: string): string => value === 'warning' ? t('Warning') : value === 'maintenance' ? t('Maintenance') : t('Notice')
    const phaseLabel = (value: string): string => value === 'scheduled' ? t('Scheduled') : value === 'live' ? t('Live') : value === 'ended' ? t('Ended') : t('Archived')
    const audienceNodes = (audience: WhmAnnouncementAudience): (Node | string)[] => {
      if (audience.kind === 'all') return [t('All accounts')]
      if (audience.kind === 'plan') { const plan = view?.choices.plans.find(item => item.id === audience.planId); return plan ? parts(t('Plan: {name}'), { name: element('bdi', plan.name) }) : [t('Plan: deleted plan')] }
      if (audience.kind === 'reseller') { const reseller = view?.choices.resellers.find(item => item.id === audience.resellerId); return reseller ? parts(t('Reseller: {name}'), { name: element('bdi', reseller.username, true) }) : [t('Reseller: deleted reseller')] }
      const shown = audience.usernames.slice(0, 3).join(', ') + (audience.usernames.length > 3 ? ', ...' : '')
      return parts(t('{count, plural, one {{count} account: {names}} other {{count} accounts: {names}}}', { count: audience.usernames.length }), { names: element('bdi', shown, true) })
    }
    const windowNodes = (item: WhmAnnouncement): (Node | string)[] => {
      const start = item.startsAt ? element('bdi', formatDisplayDateTime(item.startsAt), true) : null, end = item.endsAt ? element('bdi', formatDisplayDateTime(item.endsAt), true) : null
      return start && end ? parts(t('{start} to {end}'), { start, end }) : start ? parts(t('From {start}'), { start }) : end ? parts(t('Until {end}'), { end }) : [t('Always')]
    }
    const lock = (locked: boolean): void => {
      busy = locked
      for (const control of [...fields, refresh, cancel]) control.disabled = locked || !admitted()
      save.disabled = locked || !admitted() || !view
      root.setAttribute('aria-busy', String(locked))
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = locked || !admitted() || (button.dataset.action === 'archive' && typeof askDialog !== 'function') })
    }
    const syncAudience = (): void => { root.querySelectorAll<HTMLElement>('[data-whm-announcements-audience-field]').forEach(field => { field.hidden = field.dataset.whmAnnouncementsAudienceField !== inputs.audience!.value }) }
    const toStamp = (value: string): string | null | undefined => {
      if (!value) return null
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(value)
      return match ? match[1] + ':' + (match[2] ?? '00') + '.000Z' : undefined
    }
    const draftStamp = (name: 'starts' | 'ends'): string | null | undefined => {
      const value = inputs[name]!.value, original = editingSource?.[name === 'starts' ? 'startsAt' : 'endsAt']
      return original && value === original.slice(0, 16) ? original : toStamp(value)
    }
    const texts = (): { title: Text; body: Text } => ({ title: { en: inputs['title-en']!.value.trim(), ar: inputs['title-ar']!.value.trim() }, body: { en: inputs['body-en']!.value.trim(), ar: inputs['body-ar']!.value.trim() } })
    const paintPreview = (): void => {
      const { title, body } = texts(), ready = !!(title.en && title.ar && body.en && body.ar)
      const severity = (['info', 'warning', 'maintenance'].includes(inputs.severity!.value) ? inputs.severity!.value : 'info') as WhmAnnouncement['severity']
      previewEmpty.hidden = ready
      for (const preview of previews) {
        preview.hidden = !ready
        if (!ready) { preview.replaceChildren(); continue }
        const notice = buildNotice({ id: editing || '00000000-0000-4000-8000-000000000000', severity, title, body, startsAt: null, endsAt: draftStamp('ends') ?? null }, preview.dataset.whmAnnouncementsPreview ?? 'en', true, previewLabels(preview))
        notice.removeAttribute('role')
        notice.querySelectorAll('button').forEach(button => { button.disabled = true })
        preview.replaceChildren(notice)
      }
    }
    const fillChoices = (): void => {
      const fill = (select: HTMLSelectElement, items: { id: string; label: string }[], prompt: string, none: string): void => {
        const kept = select.value
        const first = element('option', items.length ? prompt : none)
        first.value = ''
        select.replaceChildren(first, ...items.map(item => { const option = element('option', item.label); option.value = item.id; return option }))
        select.value = items.some(item => item.id === kept) ? kept : ''
      }
      fill(inputs.plan as HTMLSelectElement, (view?.choices.plans ?? []).map(plan => ({ id: plan.id, label: plan.name })), t('Choose a plan'), t('No plans exist'))
      fill(inputs.reseller as HTMLSelectElement, (view?.choices.resellers ?? []).map(reseller => ({ id: reseller.id, label: reseller.username })), t('Choose a reseller'), t('No resellers exist'))
    }
    const resetForm = (): void => {
      editing = ''; editingSource = null
      for (const name of ['title-en', 'body-en', 'title-ar', 'body-ar', 'usernames', 'starts', 'ends', 'plan', 'reseller']) inputs[name]!.value = ''
      inputs.severity!.value = 'info'; inputs.audience!.value = 'all'
      for (const control of fields) control.removeAttribute('aria-invalid')
      heading.textContent = t('Create announcement'); save.textContent = t('Create announcement'); cancel.hidden = true
      syncAudience(); paintPreview()
    }
    const edit = (item: WhmAnnouncement): void => {
      if (!view) return
      editingSource = { revision: view.revision, startsAt: item.startsAt, endsAt: item.endsAt }
      editing = item.id
      inputs['title-en']!.value = item.title.en; inputs['title-ar']!.value = item.title.ar; inputs['body-en']!.value = item.body.en; inputs['body-ar']!.value = item.body.ar
      inputs.severity!.value = item.severity; inputs.audience!.value = item.audience.kind
      inputs.plan!.value = item.audience.kind === 'plan' ? item.audience.planId : ''; inputs.reseller!.value = item.audience.kind === 'reseller' ? item.audience.resellerId : ''
      inputs.usernames!.value = item.audience.kind === 'accounts' ? item.audience.usernames.join('\n') : ''
      inputs.starts!.value = item.startsAt ? item.startsAt.slice(0, 16) : ''; inputs.ends!.value = item.endsAt ? item.endsAt.slice(0, 16) : ''
      heading.textContent = t('Edit announcement'); save.textContent = t('Save changes'); cancel.hidden = false
      saveStatus.hidden = true; syncAudience(); paintPreview(); inputs['title-en']!.focus()
    }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Refresh the list before trying again.')
        : failed?.status === 409 ? t('The announcements changed since they were read. Refresh the list, then try again.')
          : failed?.status === 403 ? t('Root authorization is required for announcements.')
            : failed?.status === 404 ? t('That announcement no longer exists. Refresh the list.')
              : failed?.status === 400 || failed?.status === 422 ? t('The server refused these values. Check the text, audience and times.') : fallback
    }
    const archive = async (item: WhmAnnouncement): Promise<void> => {
      if (busy || !admitted() || !request || !view || typeof askDialog !== 'function') return
      let confirmed = false
      try {
        confirmed = await askDialog({ title: t('Archive this announcement?'), danger: true, confirm: t(msgctxt('whm-announcements-client', 'Archive')), cancel: t('Keep showing'),
          body: t('Account owners stop seeing "{title}" at once. Archived announcements cannot be shown again.', { title: localized(item.title) }) }) === true
      } catch { confirmed = false }
      if (!confirmed || !view) return
      lock(true); note(listStatus, 'reading', t('Archiving the announcement...'))
      try {
        const next = readWhmAnnouncementsView(await request('POST', '/api/server/announcements/' + item.id + '/archive', { expectedRevision: view.revision }))
        if (next.changed !== item.id || next.announcements.find(found => found.id === item.id)?.status !== 'archived') throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next)
        if (editing === item.id) resetForm()
        note(listStatus, 'read', t('Announcement archived. Account owners no longer see it.'))
      } catch (error) { note(listStatus, 'failed', failText(error, t('The announcement was not archived.'))) }
      finally { lock(false) }
    }
    const paintRows = (): void => {
      const list = view?.announcements ?? []
      rows.replaceChildren(...list.map(item => {
        const row = cloneClientTemplate(clientTemplate(root, 'whm-announcement-row'), 'tr', ['titles', 'severity', 'audience', 'window', 'phase', 'updated', 'actions'])
        const titles = whmClientNode(root, 'whm-announcement-cell', 'div')
        const english = element('span', item.title.en); english.lang = 'en'; english.dir = 'ltr'
        const arabic = element('span', item.title.ar); arabic.lang = 'ar'; arabic.dir = 'rtl'
        titles.append(english, arabic); clientTemplateSlot(row, 'titles').append(titles)
        clientTemplateSlot(row, 'severity').textContent = severityLabel(item.severity)
        clientTemplateSlot(row, 'audience').append(...audienceNodes(item.audience))
        clientTemplateSlot(row, 'window').append(...windowNodes(item))
        clientTemplateSlot(row, 'phase').textContent = phaseLabel(item.phase)
        const by = whmClientNode(root, 'whm-announcement-note', 'span'); by.append(...parts(t('by {actor}'), { actor: element('bdi', item.updatedBy, true) }))
        const updated = whmClientNode(root, 'whm-announcement-cell', 'div'); updated.append(element('bdi', formatDisplayDateTime(item.updatedAt), true), by); clientTemplateSlot(row, 'updated').append(updated)
        const actions = whmClientNode(root, 'whm-announcement-actions', 'div')
        if (item.status === 'active') {
          const label = localized(item.title)
          const editButton = whmClientNode(root, 'whm-announcement-button', 'button', t(msgctxt('whm-announcements-client', 'Edit'))); editButton.dataset.action = 'edit'; editButton.setAttribute('aria-label', t('Edit: {title}', { title: label }))
          const archiveButton = whmClientNode(root, 'whm-announcement-button', 'button', t(msgctxt('whm-announcements-client', 'Archive'))); archiveButton.dataset.action = 'archive'; archiveButton.setAttribute('aria-label', t('Archive: {title}', { title: label }))
          editButton.addEventListener('click', () => { if (!busy && admitted()) edit(item) })
          archiveButton.addEventListener('click', () => { void archive(item) })
          actions.append(editButton, archiveButton)
        } else actions.append(element('span', t('Archived')))
        clientTemplateSlot(row, 'actions').append(actions)
        return row
      }))
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || !admitted() || (button.dataset.action === 'archive' && typeof askDialog !== 'function') })
    }
    const paint = (next: WhmAnnouncementsView): void => {
      view = next
      fillChoices(); paintRows()
      empty.hidden = next.announcements.length > 0 || next.state === 'invalid'
      if (editing && !next.announcements.some(item => item.id === editing && item.status === 'active')) resetForm()
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved announcements file could not be verified, so account owners see none of it. Creating an announcement replaces it.')
        : next.announcements.length ? t('Announcements read. Live ones are shown to their audience now.') : t('No announcements have been saved. Account owners see none.'))
    }
    const load = async (): Promise<void> => {
      if (!admitted() || !request || busy) return
      lock(true); if (loading) loading.hidden = false
      note(status, 'reading', t('Reading announcements...'))
      try { paint(readWhmAnnouncementsView(await request('GET', '/api/server/announcements'))) }
      catch (error) { view = null; paintRows(); empty.hidden = true; note(status, 'failed', failText(error, t('Announcements could not be read or verified. Nothing was changed.'))) }
      finally { lock(false); if (loading) loading.hidden = true }
    }
    if (!admitted()) {
      for (const control of [...fields, refresh, save, cancel]) control.disabled = true
      note(status, 'unavailable', t('Announcements are unavailable here. Nothing was read or changed.'))
      return
    }
    form.addEventListener('input', paintPreview)
    form.addEventListener('change', () => { syncAudience(); paintPreview() })
    refresh.addEventListener('click', () => { listStatus.hidden = true; void load() })
    cancel.addEventListener('click', () => { resetForm(); saveStatus.hidden = true })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (busy || !view || !admitted() || !request) return
      for (const control of fields) control.removeAttribute('aria-invalid')
      const refuse = (name: string, message: string): void => { inputs[name]!.setAttribute('aria-invalid', 'true'); note(saveStatus, 'failed', message); inputs[name]!.focus() }
      const { title, body } = texts()
      const blank = ['title-en', 'body-en', 'title-ar', 'body-ar'].find(name => !inputs[name]!.value.trim())
      if (blank) return refuse(blank, t('Enter a title and a message in both English and Arabic.'))
      const markup = ['title-en', 'body-en', 'title-ar', 'body-ar'].find(name => /[<>]/.test(inputs[name]!.value))
      if (markup) return refuse(markup, t('Announcements are plain text. Remove the < and > characters.'))
      const kind = inputs.audience!.value
      let audience: WhmAnnouncementAudience
      if (kind === 'plan') { if (!inputs.plan!.value) return refuse('plan', t('Choose a plan.')); audience = { kind: 'plan', planId: inputs.plan!.value } }
      else if (kind === 'reseller') { if (!inputs.reseller!.value) return refuse('reseller', t('Choose a reseller.')); audience = { kind: 'reseller', resellerId: inputs.reseller!.value } }
      else if (kind === 'accounts') {
        const usernames = inputs.usernames!.value.split(/[\s,;]+/).filter(Boolean)
        if (!usernames.length || usernames.length > 100 || new Set(usernames).size !== usernames.length || !usernames.every(name => /^[a-z][a-z0-9]{0,15}$/.test(name))) return refuse('usernames', t('Enter 1 to 100 different account usernames.'))
        audience = { kind: 'accounts', usernames }
      } else audience = { kind: 'all' }
      const startsAt = draftStamp('starts'), endsAt = draftStamp('ends')
      if (startsAt === undefined) return refuse('starts', t('Enter a valid start time.'))
      if (endsAt === undefined) return refuse('ends', t('Enter a valid end time.'))
      if (startsAt && endsAt && endsAt <= startsAt) return refuse('ends', t('The end must be after the start.'))
      const target = editing, expectedRevision = target ? editingSource?.revision : view.revision
      if (!expectedRevision) return refuse('title-en', t('Select Edit again to review the current announcement.'))
      lock(true); note(saveStatus, 'reading', target ? t('Saving changes...') : t('Creating the announcement...'))
      try {
        const payload = { title, body, severity: inputs.severity!.value, audience, startsAt, endsAt, expectedRevision }
        const next = readWhmAnnouncementsView(await request(target ? 'PUT' : 'POST', '/api/server/announcements' + (target ? '/' + target : ''), payload))
        const saved = next.announcements.find(item => item.id === next.changed)
        if (!saved || (target && saved.id !== target) || saved.status !== 'active' || saved.title.en !== title.en) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next); resetForm()
        note(saveStatus, 'read', target ? t('Changes saved. Account owners see the new text while it is live.')
          : saved.phase === 'live' ? t('Announcement created. Its audience sees it on the xPanel home page now.') : t('Announcement created. It is shown only during its time window.'))
      } catch (error) { note(saveStatus, 'failed', failText(error, t('The announcement was not saved.'))) }
      finally { lock(false) }
    })
    resetForm()
    void load()
  })
}

export const WHM_ANNOUNCEMENTS_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmAnnouncementsView=${readWhmAnnouncementsView.toString()};const buildNotice=${buildAccountAnnouncementNotice.toString()};return ${bindWhmAnnouncements.toString()};})()`
