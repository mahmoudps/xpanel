import { describe, expect, it } from 'vitest'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2DirectoryPrivacyPage, renderV2FilesPage, V2_FILES_CSS } from './index.ts'

const account: NonNullable<PanelSurfaceProps['account']> = {
  id: 'account-private-id', username: 'alice', uid: 2000, gid: 2000, home: '/home/alice',
  primaryDomain: 'alice.test', planId: 'plan-private-id', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.1', shell: 'none',
  createdAt: '2026-10-29T00:00:00.000Z',
}
const t = v2Messages.translator('en')
const render = (surface: PanelSurfaceProps = {}, canManage = true): string => renderV2FilesPage(t, { surface: { account, ...surface }, canManage })

describe('v2 account files pages', () => {
  it('keeps unobserved contents separate from a verified empty result', () => {
    expect(render()).toContain('Directory contents have not been read.')
    expect(render({ files: [] })).toContain('This directory is empty.')
    expect(render()).not.toContain('This directory is empty.')
  })

  it('preserves controller roots, editor safety and the authoritative account context', () => {
    const html = render()
    for (const hook of ['data-file-manager="browse"', 'data-account-username="alice"', 'data-file-manager-table', 'data-file-table-wrap', 'data-file-current-path', 'data-file-selected-path', 'data-file-status', 'data-file-upload', 'id="jailed-code-editor"', 'id="chmod-octal-input"']) expect(html).toContain(hook)
    for (const action of ['parent-directory', 'refresh-files', 'new-file', 'new-folder', 'upload-file', 'empty-trash', 'save-file', 'reload-file']) expect(html).toContain(`data-action="${action}"`)
    expect(html).toMatch(/data-action="save-file" disabled/)
    expect(html).toMatch(/data-action="reload-file" disabled/)
    expect(html).not.toContain(account.id)
    for (const name of ['file-row', 'file-action', 'file-empty-row', 'trash-row', 'trash-action', 'trash-purge-action']) expect(html).toContain(`data-xp-template="${name}"`)
  })

  it('escapes account paths and records while retaining inline technical isolation', () => {
    const html = render({ account: { ...account, home: '/home/<script>bad</script>' }, files: [{ name: '<img src=x>', path: 'a" onfocus="bad', kind: 'file', sizeBytes: 123, modeOctal: '0640', modifiedAt: '2026-10-29T12:00:00.000Z' }] })
    expect(html).not.toContain('<script>bad</script>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('data-file-path="a&quot; onfocus=&quot;bad"')
    expect(html).toContain('<bdi dir="ltr" class="v2-mono">123 B</bdi>')
  })

  it('shows only the matching browse/trash snapshot and never synthesizes a trash receipt', () => {
    const files = [{ name: 'live.txt', path: 'live.txt', kind: 'file' as const, sizeBytes: 1, modeOctal: '0640', modifiedAt: '2026-10-29T12:00:00.000Z' }, { name: 'gone.txt', path: 'gone.txt', kind: 'file' as const, sizeBytes: 2, modeOctal: '0640', modifiedAt: '2026-10-29T12:00:00.000Z', trashed: true }]
    expect(render({ files })).toContain('live.txt')
    expect(render({ files })).not.toContain('gone.txt')
    const trash = render({ files, activeRoute: '/files/trash' })
    expect(trash).toContain('gone.txt')
    expect(trash).not.toContain('live.txt')
    expect(trash).toContain('data-trash-empty hidden')
    expect(trash).not.toContain('data-trash-id')
    expect(trash).not.toContain('jailed-code-editor')
    expect(trash).not.toContain('<time datetime=')
  })

  it('uses read-only admission and unavailable states without creating an account identity', () => {
    const readonly = render({}, false)
    expect(readonly).toContain('data-read-only="true"')
    expect(readonly).toMatch(/data-action="upload-file" disabled/)
    const missing = renderV2FilesPage(t, { surface: {}, canManage: true })
    expect(missing).toContain('File operations are unavailable.')
    expect(missing).not.toContain('data-account-username')
    expect(missing).toContain('data-file-manager=')
    expect(missing).toContain('jailed-code-editor')
    expect(missing).toContain('data-action="upload-file" disabled')
  })

  it('renders privacy as unread configuration, with fresh-password fields and all controller hooks', () => {
    const html = renderV2DirectoryPrivacyPage(t, { surface: { account }, canManage: true })
    for (const hook of ['data-directory-privacy', 'data-account-username="alice"', 'data-directory-privacy-path', 'data-directory-privacy-prompt', 'data-directory-privacy-username', 'data-directory-privacy-password', 'data-directory-privacy-add', 'data-directory-privacy-save', 'data-directory-privacy-status', 'data-directory-privacy-rows', 'data-directory-privacy-preview-wrap', 'data-directory-privacy-preview']) expect(html).toContain(hook)
    expect(html).toContain('Protected folders have not been read.')
    expect(html).toContain('Saved configuration only; web-server protection is not verified here.')
    expect(html).not.toContain('Saved rules read.')
    expect(html).not.toContain('type="password" value=')
    expect(html).not.toContain('No protected folders are saved.')
  })

  it('keeps Arabic technical fields and table columns aligned to their content edge', () => {
    const html = renderV2FilesPage(v2Messages.translator('ar'), { surface: { account, files: [] }, canManage: true })
    expect(html).toContain('<bdi dir="ltr" class="v2-mono" data-file-home-path>/home/alice</bdi>')
    expect(V2_FILES_CSS).toContain('text-align:start')
    expect(V2_FILES_CSS).toContain('gap:var(--space-2)')
    expect(V2_FILES_CSS).toContain('gap:var(--space-3)')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
