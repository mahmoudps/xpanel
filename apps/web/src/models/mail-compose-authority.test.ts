import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { renderMailSurface, type MailSurfaceProps } from '../surfaces/xmail.ts'
import { renderV2MailCompose } from '../themes/v2/pages/xmail/compose.ts'
import { v2Messages } from '../themes/v2/messages.ts'
import { projectMailView, type MailComposeView } from './mail.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'mail-owner', username: 'owner', accountId: 'mail-account' }, disabledFeatures: new Set() }
const base: MailSurfaceProps = { mailbox: 'owner@example.test', activeRoute: '/mail/compose', visibility, catalog }
const compose = (props: MailSurfaceProps): MailComposeView => {
  const view = projectMailView(props)
  if (view?.kind !== 'compose') throw new Error('Expected compose authority to remain available')
  return view
}
const restrict = (ids: readonly string[]): readonly CatalogTool[] => catalog.map(tool => ids.includes(tool.id) ? { ...tool, delivery: { ...tool.delivery, status: 'implemented' } } : tool)

describe('mail compose independent capability authority', () => {
  it.each([
    ['team allowlist', { ...base, visibility: { ...visibility, allowedToolIds: new Set(['webmail-compose']) } }],
    ['disabled features', { ...base, visibility: { ...visibility, disabledFeatures: new Set(['webmail-attachments', 'webmail-autoresponder']) } }],
    ['unqualified delivery', { ...base, catalog: restrict(['webmail-attachments', 'webmail-autoresponder']) }],
  ] as const)('keeps attachments and vacation closed despite compose admission: %s', (_name, props) => {
    const view = compose(props)
    expect(view).toMatchObject({ canSend: true, canSaveDraft: true, canUseAttachments: false, canManageVacation: false })
    for (const html of [renderMailSurface(props), renderV2MailCompose(v2Messages.translator('en'), view)]) {
      expect(html).toContain('data-compose-attachment-enabled="false"')
      expect(html).toContain('data-vacation-manage="false"')
      expect(html).toContain('data-compose-send-enabled="true"')
    }
  })

  it('keeps independently admitted attachments available when vacation is denied', () => {
    const props = { ...base, visibility: { ...visibility, allowedToolIds: new Set(['webmail-compose', 'webmail-attachments']) } }
    const view = compose(props)
    expect(view).toMatchObject({ canUseAttachments: true, canManageVacation: false })
    for (const html of [renderMailSurface(props), renderV2MailCompose(v2Messages.translator('en'), view)]) {
      expect(html).toContain('data-compose-attachment-enabled="true"')
      expect(html).toContain('data-vacation-manage="false"')
    }
  })

  it('keeps independently admitted vacation management available when attachments are denied', () => {
    const props = { ...base, catalog: restrict(['webmail-attachments']) }
    const view = compose(props)
    expect(view).toMatchObject({ canUseAttachments: false, canManageVacation: true })
    for (const html of [renderMailSurface(props), renderV2MailCompose(v2Messages.translator('en'), view)]) {
      expect(html).toContain('data-compose-attachment-enabled="false"')
      expect(html).toContain('data-vacation-manage="true"')
    }
  })

  it('requires an admitted mailbox and compose document before projecting any auxiliary authority', () => {
    expect(projectMailView({ ...base, mailbox: undefined })).toBeUndefined()
    expect(projectMailView({ ...base, visibility: { ...visibility, disabledFeatures: new Set(['webmail-compose']) } })).toBeUndefined()
  })
})
