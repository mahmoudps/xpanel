import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmRecoveryToolsPage, V2_WHM_RECOVERY_TOOL_ROUTES } from './index.ts'

const admitted = { canRead: true, canManage: true, root: true } as const
const render = (activeRoute: string) => renderV2WhmRecoveryToolsPage({ activeRoute, locale: 'en' }, admitted)!

describe('V2 WHM guarded recovery tools', () => {
  it('marks every recovery table for two-column phone rows and names the stacked cells in the row templates', () => {
    for (const route of V2_WHM_RECOVERY_TOOL_ROUTES) {
      const tables = render(route).match(/<table[^>]*>/g) ?? []
      expect(tables.length).toBeGreaterThan(0)
      for (const table of tables) expect(table).toMatch(/^<table data-phone-value="[1-4]"(?: data-phone-name="2")?>$/)
    }
    const files = render('/whm/backups/files')
    expect(files).toContain('<td data-phone-label="Created (UTC)"><bdi dir="ltr" class="v2-mono" data-xp-slot="created"></bdi></td>')
    expect(files).toContain('<td data-xp-slot="reason" data-phone-label="Reason"></td>')
    expect(render('/whm/backups/restore-more')).toContain('<td data-xp-slot="state" data-phone-label="Mailbox now"></td>')
    expect(renderV2WhmRecoveryToolsPage({ activeRoute: '/whm/backups/files', locale: 'ar' }, admitted)).not.toContain('data-phone-label="Reason"')
  })

  it.each(V2_WHM_RECOVERY_TOOL_ROUTES)('preserves the real %s workflow with default-denied admission', activeRoute => {
    const html = renderV2WhmRecoveryToolsPage({ activeRoute })!
    expect(html).toContain(`data-whm-detail-route="${activeRoute}"`)
    const nodes = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every(node => node.attrs.has('disabled'))).toBe(true)
    expect(html).not.toContain('<form')
    expect(html).not.toMatch(/class="xp-|style=/)
  })

  it.each(V2_WHM_RECOVERY_TOOL_ROUTES)('puts the checked rules of %s beside its first card inside the scoped body', activeRoute => {
    const html = render(activeRoute)
    const body = html.slice(html.indexOf('class="v2-recovery-tools v2-recovery__column"'))
    const grid = body.slice(body.indexOf('<div class="v2-recovery__grid">'))
    expect(grid.indexOf('<section class="v2-card"')).toBeLessThan(grid.indexOf('<aside class="v2-recovery__column">'))
    const rules = body.match(/<ul class="v2-recovery__rules">.*?<\/ul>/s)?.[0] ?? ''
    expect(rules.match(/<li><svg\b/g)).toHaveLength(5)
    expect(body.match(/<ol class="v2-recovery__steps"/g)).toHaveLength(1)
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


describe('backup capability source parity', () => {
  for (const route of ['/whm/backups/restore-more','/whm/backups/files'] as const) for (const locale of ['en','ar'] as const) {
    it('binds ' + route + ' capability to existing context in ' + locale, { tags: ['unit'] }, () => {
      const variants=[
        {canRead:true,canManage:true,unavailable:false},
        {canRead:true,canManage:false,unavailable:false},
        {canRead:false,canManage:true,unavailable:false},
        {canRead:true,canManage:true,unavailable:true},
      ];
      for(const variant of variants){
        const html=renderV2WhmRecoveryToolsPage({activeRoute:route,locale,capabilityUnavailable:variant.unavailable},{canRead:variant.canRead,canManage:variant.canManage,root:true});
        if(!html)throw new Error('Missing real recovery page');
        const nodes=parseMarkup(html),owners=nodes.filter(node=>node.attrs.get('data-whm-detail-route')===route);
        expect(owners).toHaveLength(1);
        const owner=owners[0];if(!owner)throw new Error('Missing recovery root');
        const readable=variant.canRead&&!variant.unavailable;
        expect(owner.attrs.get('data-capability-state')).toBe(readable?'authorized':'unavailable');
        const component=route==='/whm/backups/restore-more',hook=component?'data-whm-restore-more-workspace':'data-whm-backup-files-workspace';
        const workspace=nodes.find(node=>node.attrs.has(hook));
        if(!workspace)throw new Error('Missing real restore workspace');
        expect(workspace.attrs.get(component?'data-restore-more-can-read':'data-backup-files-can-read')).toBe(String(readable));
        expect(workspace.attrs.get(component?'data-restore-more-can-restore':'data-backup-files-can-restore')).toBe(String(readable&&variant.canManage));
        expect(html).toContain(component?'data-restore-more-ack disabled':'data-backup-files-ack disabled');
      }
      const denied=renderV2WhmRecoveryToolsPage({activeRoute:route,locale});
      if(!denied)throw new Error('Missing default-denied recovery page');
      expect(denied).toContain('data-capability-state="unavailable"');
    });
  }
});
