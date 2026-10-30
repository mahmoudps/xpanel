import { describe, expect, it } from 'vitest'
import { v2Messages } from '../../../messages.ts'
import { renderV2EmailForwardersPage, type EmailForwardersPageProps } from './forwarders.ts'

const t = v2Messages.translator('en')
const render = (patch: Partial<EmailForwardersPageProps> = {}): string => renderV2EmailForwardersPage(t, {
  domains: [{ name: 'example.test' }], mailboxes: ['sales@example.test'], canManage: true, ...patch,
})

describe('v2 email routing', () => {
  it('preserves all three controller roots, read status, row targets and form contracts', () => {
    const html = render()
    for (const key of ['forwarder', 'autoresponder', 'default']) {
      expect(html).toContain(`data-${key}-workspace`)
      expect(html).toContain(`data-${key}-manage="true"`)
      expect(html).toContain(`data-${key}-status`)
    }
    for (const key of ['forwarder', 'autoresponder']) {
      expect(html).toContain(`<tbody data-${key}-rows>`)
      expect(html).toContain(`data-${key}-empty`)
    }
    for (const name of ['source', 'forwarder-mode', 'destinations', 'rejectMessage', 'address', 'subject', 'body', 'interval', 'start', 'end', 'noEnd', 'domain', 'default-kind', 'destination']) expect(html).toContain(`name="${name}"`)
    expect(html).toContain('data-forwarder-reject-field hidden')
    expect(html).toContain('data-default-destination-field hidden')
    expect(html).toContain('data-autoresponder-submit')
    expect(html).toContain('data-autoresponder-cancel hidden')
    expect(html).toContain('type="datetime-local" step="60"')
  })

  it('keeps read-only refresh and read status without mutation forms or row deletes', () => {
    const html = render({ canManage: false, forwarders: [{ id: 'route-private', source: 'info@example.test', destinations: ['owner@destination.test'] }] })
    expect(html).toContain('data-forwarder-refresh')
    expect(html).toContain('data-forwarder-manage="false"')
    expect(html).not.toContain('data-forwarder-create')
    expect(html).not.toContain('data-autoresponder-form')
    expect(html).not.toContain('data-default-form')
    expect(html).not.toContain('data-forwarder-delete=')
    expect(html).toContain('owner@destination.test')
  })

  it('does not imply a successful read or application when initial records are absent', () => {
    const unread = render()
    const empty = render({ forwarders: [] })
    expect(unread).toContain('Records have not been read.')
    expect(unread).not.toContain('No forwarders.')
    expect(empty).toContain('No forwarders.')
    expect(unread).not.toContain('data-routing-state="applied"')
  })

  it('omits address-dependent autoresponder/default forms when no account domain exists', () => {
    const html = render({ domains: [] })
    expect(html).toContain('No domains read')
    expect(html).not.toContain('data-autoresponder-form')
    expect(html).not.toContain('data-default-form')
  })

  it('escapes source, destinations, IDs and mailbox suggestions without exposing internal row IDs as references', () => {
    const attack = '"><img src=x onerror=alert(1)>'
    const html = render({ domains: [{ name: attack }], mailboxes: [attack], forwarders: [{ id: 'private-route-id', source: attack, destinations: [attack] }] })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('data-forwarder-delete="private-route-id"')
    expect(html).not.toContain('>private-route-id<')
    expect(html).not.toContain('class="xp-')
  })
})
