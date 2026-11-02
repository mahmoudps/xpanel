import { describe, expect, it } from 'vitest'
import { matchesHook, parseMarkup, type HookSelector } from '../../../../markup.ts'
import { renderMailCalendarPage, renderMailCalendarSettingsPage, renderMailContactsPage } from './organizer.ts'
import type { MailWorkspaceInput } from './common.ts'

const owner: MailWorkspaceInput = { route: '/mail/contacts', locale: 'en', mailbox: 'owner@example.test', canRead: true, canManage: true }
const nodes = (html: string) => parseMarkup(html)
const find = (html: string, selector: HookSelector) => nodes(html).find(node => matchesHook(node, selector))
const required = (html: string, selectors: readonly HookSelector[]) => {
  for (const selector of selectors) expect(find(html, selector), selector).toBeDefined()
}

describe('v2 mailbox organizer workspaces', () => {
  it('retains contact fields and the controller actions without fabricating contact rows or capacity', () => {
    const html = renderMailContactsPage(owner)
    required(html, ['[data-mail-contacts]', '[data-contact-form]', '[data-contact-field-group]', '[name="fullName"]', '[name="email"]', '[name="phone"]', '[name="organization"]', '[name="title"]', '[data-contact-save]', '[data-contact-discard]', '[data-contact-delete]', '[data-contact-refresh]', '[data-contact-reload]', '[data-contact-new]', '[data-contact-search]', '[data-contact-selection]', '[data-contact-status]', '[data-contact-count]', '[data-contact-capacity]', '[data-contact-groups]', '[data-contact-access]', '[data-contact-metadata-review]', '[data-contact-table]', '[data-contact-rows]'])
    expect(find(html, '[data-contact-rows]')?.tag).toBe('tbody')
    expect(find(html, '[data-contact-save]')?.attrs.get('type')).toBe('submit')
    expect(find(html, '[name="email"]')?.attrs.get('dir')).toBe('ltr')
    expect(find(html, '[data-contact-status]')?.attrs.get('data-state')).toBe('unread')
    expect(html).toContain('Contacts have not been read.')
    expect(html).not.toContain('data-contact-select=')
    for (const hook of ['[data-contact-save]', '[data-contact-discard]', '[data-contact-delete]', '[data-contact-new]'] as const) expect(find(html, hook)?.attrs.has('disabled'), hook).toBe(true)
  })

  it('keeps exact multiple-selection membership controls and separate group authority', () => {
    const html = renderMailContactsPage(owner)
    required(html, ['[data-mail-contact-groups]', '[data-groups-metadata-review]', '[data-groups-contact-capacity]', '[data-groups-capacity]', '[data-groups-membership-capacity]', '[data-groups-reload]', '[data-groups-new]', '[data-groups-status]', '[data-groups-select]', '[data-groups-name]', '[data-groups-members]', '[data-groups-save]', '[data-groups-delete]', '[data-groups-contact]', '[data-groups-membership]', '[data-groups-membership-save]'])
    expect(find(html, '[data-mail-contact-groups]')?.attrs.get('data-groups-mailbox')).toBe(owner.mailbox)
    expect(find(html, '[data-groups-name]')?.attrs.get('maxlength')).toBe('128')
    for (const hook of ['[data-groups-members]', '[data-groups-membership]'] as const) {
      expect(find(html, hook)?.tag).toBe('select')
      expect(find(html, hook)?.attrs.has('multiple')).toBe(true)
      expect(find(html, hook)?.attrs.get('size')).toBe('6')
    }
  })

  it('retains native vCard import/export and explicit sharing controls without revealing stored data', () => {
    const html = renderMailContactsPage(owner)
    required(html, ['[data-mail-contacts-tools]', '[data-contacts-import-file]', '[data-contacts-import-text]', '[data-contacts-import-preview]', '[data-contacts-import-status]', '[data-contacts-import]', '[data-contacts-export]', '[data-contacts-export-status]', '[data-contacts-share-contact]', '[data-contacts-share-principal]', '[data-contacts-share-permission]', '[data-contacts-share-add]', '[data-contacts-shares]', '[data-contacts-share-status]'])
    expect(find(html, '[data-contacts-import-file]')?.attrs.get('type')).toBe('file')
    expect(find(html, '[data-contacts-import-file]')?.attrs.get('accept')).toBe('.vcf,text/vcard,text/x-vcard')
    expect(find(html, '[data-contacts-import-text]')?.attrs.get('spellcheck')).toBe('false')
    expect(find(html, '[data-contacts-share-principal]')?.attrs.get('dir')).toBe('ltr')
    expect(html).toContain('Nothing is imported until you confirm.')
    expect(html).toContain('CardDAV are not claimed.')
  })

  it('requires independent read and manage decisions before mounting mutable mailbox families', () => {
    for (const renderer of [renderMailContactsPage, renderMailCalendarPage, renderMailCalendarSettingsPage]) {
      for (const input of [{ ...owner, canRead: false }, { ...owner, canManage: false }, { ...owner, canRead: undefined }, { ...owner, mailbox: '' }]) {
        const html = renderer(input)
        const roots = nodes(html).filter(node => [...node.attrs.keys()].some(name => /^data-(?:contact|groups|contacts-tools|calendar|calendar-view)-manage$/.test(name)))
        expect(roots.length).toBeGreaterThan(0)
        for (const root of roots) for (const [name, value] of root.attrs) if (name.endsWith('-manage')) expect(value).toBe('false')
      }
    }
  })

  it('keeps every saved calendar/event/share/import control with its original constraints', () => {
    const html = renderMailCalendarSettingsPage({ ...owner, route: '/mail/settings/calendars' })
    required(html, ['[data-mail-calendar]', '[data-calendar-select]', '[data-calendar-event-select]', '[data-calendar-status]', '[data-calendar-authority-guidance]', '[data-calendar-owner]', '[data-calendar-access]', '[data-calendar-capacity]', '[data-calendar-shares]', '[data-calendar-share-permission]', '[data-calendar-ics]', '[data-calendar-exported]'])
    for (const key of ['refresh', 'new', 'save', 'delete', 'event-new', 'event-save', 'event-delete', 'share', 'import', 'export', 'download', 'name', 'color', 'timezone', 'event-summary', 'event-description', 'event-location', 'event-start', 'event-end', 'event-timezone', 'share-principal']) required(html, [`[data-calendar-${key}]`])
    expect(find(html, '[data-calendar-event-description]')?.attrs.get('maxlength')).toBe('5000')
    expect(find(html, '[data-calendar-ics]')?.attrs.get('maxlength')).toBe('262144')
    expect(find(html, '[data-calendar-exported]')?.attrs.has('readonly')).toBe(true)
    expect(find(html, '[data-calendar-status]')?.attrs.get('data-state')).toBe('unread')
    expect(html).toContain('importing the same UID updates that event without duplicating it')
    expect(html).toContain('synchronization is unavailable here')
  })

  it('retains accessible calendar modes, date fields and hidden event/agenda/editor states', () => {
    const html = renderMailCalendarPage({ ...owner, route: '/mail/calendar' })
    required(html, ['[data-mail-calendar-view]', '[data-calview-range]', '[data-calview-zone]', '[data-calview-status]', '[data-calview-legend]', '[data-calview-unplaced]', '[data-calview-scroll]', '[data-calview-grid]', '[data-calview-detail]', '[data-calview-detail-heading]', '[data-calview-agenda]', '[data-calview-agenda-list]', '[data-calview-event]', '[data-calview-event-facts]', '[data-calview-editor]'])
    for (const key of ['nav', 'mode', 'new', 'refresh', 'close', 'agenda-new', 'edit', 'delete', 'save', 'cancel']) required(html, [`[data-calview-${key}]`])
    for (const key of ['calendar', 'summary', 'all-day', 'start-date', 'start-time', 'end-date', 'end-time', 'timezone', 'location', 'notes']) required(html, [`[data-calview-field="${key}"]`])
    expect(find(html, '[data-calview-grid]')?.attrs.get('role')).toBe('grid')
    expect(find(html, '[data-calview-grid]')?.attrs.get('aria-labelledby')).toBe('mail-calview-range')
    expect(find(html, '[data-calview-field="summary"]')?.attrs.get('maxlength')).toBe('300')
    expect(find(html, '[data-calview-field="start-date"]')?.attrs.get('placeholder')).toBe('YYYY-MM-DD')
    expect(find(html, '[data-calview-field="start-time"]')?.attrs.get('placeholder')).toBe('HH:MM')
    for (const key of ['detail', 'agenda', 'event', 'editor']) expect(find(html, `[data-calview-${key}]`)?.attrs.has('hidden')).toBe(true)
    expect(html).not.toContain('data-calview-item=')
  })

  it('escapes mailbox text and emits unique label targets across the complete organizer views', () => {
    for (const renderer of [renderMailContactsPage, renderMailCalendarPage, renderMailCalendarSettingsPage]) {
      const html = renderer({ ...owner, mailbox: 'box"><img src=x onerror=bad()>@example.test' })
      expect(html).not.toContain('<img')
      const outline = nodes(html)
      const ids = outline.map(node => node.attrs.get('id')).filter(Boolean)
      expect(new Set(ids).size).toBe(ids.length)
      for (const node of outline.filter(node => node.tag === 'label' && node.attrs.has('for'))) expect(ids, node.attrs.get('for')).toContain(node.attrs.get('for'))
      expect(html).not.toMatch(/class="[^"\n]*\bxp-/)
      expect(html).not.toContain('<style>')
    }
  })

  it('retains ASCII date/time guidance and generic Arabic content without fabricating a month', () => {
    const html = renderMailCalendarPage({ ...owner, locale: 'ar', route: '/mail/calendar' })
    expect(html).toMatch(/[\u0600-\u06ff]/)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).toContain('YYYY-MM-DD')
    expect(html).toContain('HH:MM')
    expect(find(html, '[data-calview-grid]')?.attrs.get('data-mode')).toBe('month')
    expect(nodes(html).filter(node => node.attrs.has('data-calview-day'))).toHaveLength(0)
  })
})
