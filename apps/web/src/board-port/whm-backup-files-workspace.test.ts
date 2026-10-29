import { describe, expect, it } from 'vitest'
import { renderWhmBackupFilesWorkspace } from './whm-backup-files-workspace.ts'

const html = (locale: 'en' | 'ar', canRead = true, canRestore = true): string => { const view = renderWhmBackupFilesWorkspace({ locale, canRead, canRestore }); return view.main + view.aside }

describe('WHM restore files renderer', () => {
  it('renders the English wizard with every step, table and inert control before an authorized read', () => {
    const page = html('en')
    expect(page).toContain('data-whm-backup-files-workspace data-backup-files-can-read="true" data-backup-files-can-restore="true" lang="en" dir="ltr"')
    for (const label of ['Account', 'Backup', 'Files', 'Review', 'Result', 'Account and backup', 'Files in the backup', 'Restore to', 'Restore files', 'What a file restore does', 'Accounts have not been read.'])
      expect(page).toContain(label)
    for (const marker of ['account', 'archives', 'entries', 'up', 'path', 'selection', 'destination', 'folder', 'clear', 'preview', 'review', 'ack', 'restore', 'results', 'continue', 'steps', 'status'])
      expect(page).toContain('data-backup-files-' + marker)
    // Same rule as the approved-xwhm unavailable-mode suite: every control is disabled until an authorized read.
    expect(page.match(/<(?:select|button|input|textarea|fieldset)\b[^>]*>/g)!.every(tag => /\bdisabled\b/.test(tag))).toBe(true)
    expect(page).toContain('value="new-folder" checked disabled')
    expect(page).toContain('<bdi dir="ltr" data-backup-files-path>/</bdi>')
    expect(page).not.toMatch(/<form|innerHTML|style="/)
  })
  it('renders Arabic RTL copy with ASCII digits and isolated technical values', () => {
    const page = html('ar')
    expect(page).toContain('lang="ar" dir="rtl"')
    for (const label of ['الحساب والنسخة', 'الملفات في النسخة', 'الاستعادة إلى', 'استعادة الملفات', 'ماذا تفعل استعادة الملفات', 'لم تُقرأ الحسابات بعد.']) expect(page).toContain(label)
    expect(page).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(page).toContain('<bdi dir="ltr" data-backup-files-folder>restored-…</bdi>')
    expect(page).toContain('2 MiB')
    expect(page).not.toContain('Files in the backup')
  })
  it('keeps the unavailable workspace visible without read or restore authority', () => {
    for (const locale of ['en', 'ar'] as const) {
      const page = html(locale, false, true)
      expect(page).toContain('data-backup-files-can-read="false" data-backup-files-can-restore="false"')
      expect(page).toContain('data-state="unavailable"')
      expect(page).toContain(locale === 'en' ? 'Nothing was read or changed.' : 'لم يُقرأ أو يُغيّر شيء.')
    }
    expect(html('en', true, false)).toContain('data-backup-files-can-restore="false"')
  })
})
