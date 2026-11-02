import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../markup.ts'
import { v2Messages } from '../messages.ts'
import { formField, switchRow } from '../components/form-field.ts'
import { notice } from '../components/notice.ts'
import { factList } from './common.ts'
import { editorPage } from './editor-page.ts'
import { logPage } from './log-page.ts'
import { matrixTable, type MatrixChannel, type MatrixPageProps } from './matrix-page.ts'

const t = v2Messages.translator('en')
const header = { breadcrumb: [{ label: 'Home', href: '/' }], route: '/', title: 'Page' }
const matrix = (channels: readonly MatrixChannel[], cellsHtml?: readonly string[]): MatrixPageProps['matrix'] => ({
  title: 'Events', titleId: 'events', caption: 'Notifications', eventColumn: 'Event', leadColumns: ['Recorded by'], channels,
  groups: [{ label: 'Accounts', switches: [{ label: 'Email for accounts', hooks: { 'data-group-email': true } }, { label: 'Webhook for accounts' }],
    events: [{ label: 'Account created', cellsHtml, switches: [{ label: 'Email for account created' }, { label: 'Webhook for account created' }] }] }],
})

describe('v2 shared presentation contracts', () => {
  it('keeps bounded numeric and local date query inputs as actual native constraints', () => {
    const numeric = parseMarkup(formField({ id: 'lines', label: 'Entries', control: { kind: 'input', type: 'number', min: 1, max: 500, step: 1, value: '100', dir: 'ltr' } })).find(node => node.tag === 'input')!
    expect(Object.fromEntries(numeric.attrs)).toMatchObject({ type: 'number', min: '1', max: '500', step: '1', value: '100', dir: 'ltr' })
    const date = parseMarkup(formField({ id: 'since', label: 'Since, UTC', control: { kind: 'input', type: 'datetime-local', value: '2026-10-22T11:00', min: '2026-01-01T00:00', readonly: true } })).find(node => node.tag === 'input')!
    expect(Object.fromEntries(date.attrs)).toMatchObject({ type: 'datetime-local', value: '2026-10-22T11:00', min: '2026-01-01T00:00', readonly: '' })
    const technical = parseMarkup(formField({ id: 'password', label: 'Password', control: { kind: 'input', type: 'password', minlength: 8, maxlength: 1024, spellcheck: false } })).find(node => node.tag === 'input')!
    expect(Object.fromEntries(technical.attrs)).toMatchObject({ minlength: '8', maxlength: '1024', spellcheck: 'false' })
    expect(formField({ id: 'path', label: 'Path', control: { kind: 'textarea', maxlength: 512, spellcheck: false } })).toContain('maxlength="512" spellcheck="false"')
    const privateKey = parseMarkup(formField({ id: 'key', label: 'Private key', control: { kind: 'textarea', autocomplete: 'off', spellcheck: false, dir: 'ltr', maxlength: 65536 } })).find(node => node.tag === 'textarea')!
    expect(Object.fromEntries(privateKey.attrs)).toMatchObject({ autocomplete: 'off', spellcheck: 'false', dir: 'ltr', maxlength: '65536' })
    expect(formField({ id: 'escaped-autocomplete', label: 'Value', control: { kind: 'textarea', autocomplete: 'off" autofocus="true' } })).toContain('autocomplete="off&quot; autofocus=&quot;true"')
  })

  it('announces draft annotations with the control and escapes their text', () => {
    const field = formField({ id: 'score', label: 'Score', help: 'A number.', change: 'Changed · was <7>', control: { kind: 'input' } })
    const nodes = parseMarkup(field)
    expect(nodes.find(node => node.tag === 'input')?.attrs.get('aria-describedby')).toBe('score-help score-change')
    expect(field).toContain('Changed · was &lt;7&gt;')
    expect(switchRow({ id: 'spam', label: 'Spam', change: 'Changed · was off' })).toContain('aria-describedby="spam-change"')
  })

  it('renders an operation as a button and navigation as a link', () => {
    const operation = parseMarkup(notice(t, { tone: 'warn', text: 'Read failed.', action: { kind: 'button', label: 'Retry', hooks: { 'data-retry': true }, disabled: true } }))
    const control = operation.find(node => node.attrs.has('data-retry'))!
    expect(control.tag).toBe('button')
    expect(Object.fromEntries(control.attrs)).toMatchObject({ type: 'button', disabled: '' })
    expect(control.attrs.has('href')).toBe(false)
    const link = parseMarkup(notice(t, { tone: 'info', text: 'Account settings.', action: { label: 'Open', href: '/account/security' } })).find(node => node.tag === 'a')!
    expect(link.attrs.get('href')).toBe('/account/security')
  })

  it('keeps technical fact direction inside the value rather than on its field block', () => {
    const nodes = parseMarkup(factList([{ label: 'Reference', value: 'INV-2026-0001', ltr: true }, { label: 'Path', value: '/home/alice', mono: true }]))
    const values = nodes.filter(node => node.tag === 'dd')
    expect(values).toHaveLength(2)
    for (const value of values) {
      expect(value.attrs.has('dir')).toBe(false)
      expect(value.attrs.has('class')).toBe(false)
      expect(nodes.find(node => node.parent === nodes.indexOf(value) && node.tag === 'bdi')?.attrs.get('dir')).toBe('ltr')
    }
  })

  it('spans initial fixed channels in grouped headers and preserves later channel positions', () => {
    const fixed = { label: 'Audit', fixed: 'Always on', all: { label: 'Must not toggle fixed audit', hooks: { 'data-forbidden-toggle': true } } }
    const variants = [
      { channels: [fixed, { label: 'Email' }], span: '3', remaining: 1 },
      { channels: [fixed, fixed], span: '4', remaining: 0 },
      { channels: [{ label: 'Email' }, fixed, { label: 'Webhook' }], span: '2', remaining: 3 },
      { channels: [{ label: 'Email' }], span: '2', remaining: 1 },
    ]
    for (const variant of variants) {
      const nodes = parseMarkup(matrixTable(t, matrix(variant.channels)))
      const group = nodes.findIndex(node => node.tag === 'th' && node.attrs.get('scope') === 'rowgroup')
      expect(nodes[group]!.attrs.get('colspan')).toBe(variant.span)
      expect(nodes.filter(node => node.parent === nodes[group]!.parent && node.tag === 'td')).toHaveLength(variant.remaining)
      expect(nodes.some(node => node.attrs.has('data-forbidden-toggle'))).toBe(false)
    }
  })

  it('pads missing lead values and rejects overflow rather than shifting channel values', () => {
    const props = matrix([{ label: 'Audit', fixed: 'Always on' }, { label: 'Email' }])
    const nodes = parseMarkup(matrixTable(t, props))
    const eventHeader = nodes.find(node => node.tag === 'th' && node.attrs.get('scope') === 'row')!
    expect(nodes.filter(node => node.parent === eventHeader.parent && node.tag === 'td')).toHaveLength(3)
    expect(() => matrixTable(t, matrix(props.channels, ['Reconciler', 'overflow']))).toThrow('more cells than declared lead columns')
  })

  it('uses an explicit observed follow state while protecting it against generic hook overrides', () => {
    const html = logPage(t, { header, stream: { title: 'Logs', titleId: 'logs', table: { id: 'entries', caption: 'Logs', columns: [{ label: 'Line' }], rows: [] },
      streamHooks: { 'data-log-follow-state': 'stopped' }, follow: { state: 'following', status: 'Following nginx.service.' } } })
    expect(html).toContain('aria-pressed="true" data-log-follow')
    expect(html).toContain('data-log-follow-state="following"')
    expect(html).not.toContain('Not following.')
    expect(html).toContain('Following nginx.service.')
  })

  it('renders structured rules separately from their read-only generated block', () => {
    const html = editorPage(t, { header, editor: { title: 'Generated block', titleId: 'block-title', field: { id: 'block', label: '.htaccess', value: 'ErrorDocument 404 /404.html', hooks: { 'data-generated-block': true } },
      rules: { title: 'Rules', titleId: 'rules-title', table: { id: 'rules', caption: 'Draft rules', columns: [{ label: 'Status' }, { label: 'Path' }], rows: [{ cellsHtml: ['404', '/404.html'] }] } } },
      test: { titleId: 'test-title', status: { tone: 'neutral', label: 'Not tested' }, run: { label: 'Test draft', hooks: {} }, outputLabel: 'Result' }, save: { label: 'Save', ready: false, hooks: {} } })
    expect(html).toContain('<table id="rules"')
    expect(html).toContain('data-generated-block><div class="v2-code__head"><code>.htaccess</code>')
    expect(html).not.toContain('<textarea')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('The draft passed its test.')
  })

  it('does not invent a prior test when the protected save validates the structured draft', () => {
    const props = { header, editor: { title: 'Generated block', titleId: 'block-title', field: { id: 'block', label: '.htaccess', value: 'ErrorDocument 404 /404.html' },
      rules: { title: 'Rules', titleId: 'rules-title', table: { id: 'rules', caption: 'Draft rules', columns: [{ label: 'Status' }], rows: [{ cellsHtml: ['404'] }] } } },
      save: { kind: 'validate-on-save' as const, statusText: 'The protected save validates the draft before writing.', label: 'Save', ready: true, hooks: { 'data-save': true } } }
    const html = editorPage(t, props)
    expect(html).toContain(props.save.statusText)
    expect(html).not.toContain('Test before the switch')
    expect(html).not.toContain('The draft passed its test.')
    expect(html).not.toContain('aria-disabled="true"')
    expect(() => editorPage(t, { ...props, snippets: { title: 'Snippets', titleId: 'snippets', items: [{ label: 'Insert', code: 'raw' }] } })).toThrow('do not accept raw insert snippets')
  })
})
