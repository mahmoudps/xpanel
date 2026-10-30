import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmRecoveryToolsPage, V2_WHM_RECOVERY_TOOL_ROUTES } from './index.ts'

const admitted = { canRead: true, canManage: true, root: true } as const
const render = (activeRoute: string) => renderV2WhmRecoveryToolsPage({ activeRoute, locale: 'en' }, admitted)!

describe('V2 WHM guarded recovery tools', () => {
  it.each(V2_WHM_RECOVERY_TOOL_ROUTES)('preserves the real %s workflow with default-denied admission', activeRoute => {
    const html = renderV2WhmRecoveryToolsPage({ activeRoute })!
    expect(html).toContain(`data-whm-detail-route="${activeRoute}"`)
    const nodes = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every(node => node.attrs.has('disabled'))).toBe(true)
    expect(html).not.toContain('<form')
    expect(html).not.toMatch(/class="xp-|style=/)
  })

  it('does not map an unrelated or unknown route to a recovery outage', () => {
    expect(renderV2WhmRecoveryToolsPage({ activeRoute: '/whm/backups/restore-more/guess' }, admitted)).toBeUndefined()
    expect(renderV2WhmRecoveryToolsPage({ activeRoute: '/whm/accounts' }, admitted)).toBeUndefined()
  })

  it('keeps component restore selections and preview acknowledgment locked before a real read', () => {
    const html = render('/whm/backups/restore-more')
    expect(html).toContain('data-restore-more-can-read="true" data-restore-more-can-restore="true"')
    expect(html).toContain('data-restore-more-ack disabled')
    expect(html).toContain('data-restore-more-preview disabled')
    expect(html).toContain('data-restore-more-restore disabled')
    expect(html).toContain('No restore has been reviewed.')
    expect(html).toContain('No restore has run.')
    expect(html).toContain('The selected account and parts must be checked before applying a restore.')
    expect(html).not.toContain('Database dumps and DNS zones are not included in them.')
    expect(html).toContain('Existing messages are never overwritten.')
  })

  it('supplies all strict selected-theme restore templates with exact row and control shapes', () => {
    const nodes = parseMarkup(render('/whm/backups/restore-more'))
    const shapes = { archives: ['created', 'archive', 'bytes', 'integrity', 'open'], components: ['name', 'contents', 'action'], mailboxes: ['select', 'address', 'messages', 'bytes', 'state'], review: ['path', 'bytes'], results: ['path', 'result', 'reason'], empty: ['message'], link: ['label'] }
    for (const [kind, slots] of Object.entries(shapes)) {
      const index = nodes.findIndex(node => node.tag === 'template' && node.attrs.get('data-xp-template') === 'restore-more-' + kind)
      expect(index, kind).toBeGreaterThanOrEqual(0)
      for (const slot of slots) expect(nodes.some(node => node.template === index && node.attrs.get('data-xp-slot') === slot), kind + ':' + slot).toBe(true)
    }
    const checkbox = nodes.find(node => node.attrs.get('data-xp-slot') === 'select')!
    expect(checkbox.tag).toBe('input')
    expect(checkbox.attrs.get('type')).toBe('checkbox')
    const open = nodes.find(node => node.attrs.get('data-xp-slot') === 'open')!
    expect(open.tag).toBe('button')
    for (const [kind, count] of Object.entries({ archives: 5, components: 3, mailboxes: 5, review: 2, results: 3 })) {
      expect(nodes.find(node => node.attrs.has('data-restore-more-' + kind))?.attrs.get('data-xp-columns')).toBe(String(count))
    }
  })

  it('retains file destination choice, SHA checks, non-overwrite acknowledgment and actual result slots', () => {
    const html = render('/whm/backups/files')
    for (const marker of ['account', 'archives', 'entries', 'path', 'folder', 'up', 'clear', 'selection', 'destination', 'preview', 'review', 'ack', 'restore', 'results', 'continue', 'integrity', 'sha256']) expect(html).toContain('data-backup-files-' + marker)
    expect(html).toContain('value="new-folder" checked disabled')
    expect(html).toContain('value="in-place" disabled')
    expect(html).toContain('data-backup-files-ack disabled')
    expect(html).toContain('data-backup-files-restore disabled')
    expect(html).toContain('Existing files are never overwritten.')
    expect(html).toContain('reviewed SHA-256 must still match before anything is written.')
    expect(html).not.toContain('data-account-backups')
  })

  it('requires an actual candidate review and exact-domain confirmation before conversion', () => {
    const html = render('/whm/transfers/convert-addon')
    expect(html).toContain('data-can-manage="true"')
    for (const field of ['domainId', 'username', 'planId', 'confirm']) expect(html).toContain(`data-acct-convert-input="${field}"`)
    expect(html).toContain('data-acct-convert-preview disabled')
    expect(html).toContain('data-acct-convert-apply disabled')
    expect(html).toContain('No conversion has been reviewed.')
    expect(html).toContain('Conversion availability has not been read.')
    for (const kind of ['domains', 'mail', 'dns', 'conflicts']) expect(html).toContain(`data-acct-convert-rows="${kind}"`)
    expect(html).toContain('type="text" autocomplete="off" spellcheck="false" dir="ltr"')
    expect(html).not.toContain('generation 143')
    expect(html).not.toContain('Conversion completed')
  })

  it.each(V2_WHM_RECOVERY_TOOL_ROUTES)('keeps Arabic %s geometry semantics and ASCII step numbers', activeRoute => {
    const html = renderV2WhmRecoveryToolsPage({ activeRoute, locale: 'ar' }, admitted)!
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('class="v2-recovery__step-number" aria-hidden="true">1</span>')
    expect(html).toContain('dir="ltr"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
