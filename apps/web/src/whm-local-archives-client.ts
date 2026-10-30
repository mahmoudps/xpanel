/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import './i18n.ts'

/** Local archive listing never applies a restore: the separate file workflow owns review and acknowledgement. */
function bindLocalArchives(): void {
  document.querySelectorAll<HTMLElement>('[data-account-backups]').forEach(root => {
    if (root.dataset.localArchivesBound === 'true') return
    root.dataset.localArchivesBound = 'true'
    const account = root.querySelector<HTMLSelectElement>('[data-backup-account]'), rows = root.querySelector<HTMLElement>('[data-backup-files]'), status = root.querySelector<HTMLElement>('[data-backup-status]'), create = root.querySelector<HTMLButtonElement>('[data-backup-create]'), refresh = root.querySelector<HTMLButtonElement>('[data-backup-local-read]')
    if (!account || !rows || !status || !create || !refresh) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const admitted = (): boolean => root.isConnected && root.dataset.backupManage === 'true' && typeof transport === 'function' && !root.closest('[data-readonly="true"],[data-read-only="true"],[data-wiring="soon"],[data-wiring="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const note = (message: string, failed = false): void => { status.textContent = message; status.setAttribute('role', failed ? 'alert' : 'status') }
    let template: HTMLTemplateElement
    try { template = clientTemplate(root, 'whm-local-archive-row'); cloneClientTemplate(template, 'tr', ['archive', 'bytes', 'review']); clientTemplateSlot(cloneClientTemplate(template, 'tr', ['review']), 'review', 'a') }
    catch { account.disabled = true; create.disabled = true; refresh.disabled = true; note(xpT('Backup runs could not be read. No changes were made.'), true); return }
    let busy = false, reviewRequired = false
    const lock = (): void => { account.disabled = !admitted() || busy; refresh.disabled = !admitted() || busy; create.disabled = !admitted() || busy || reviewRequired || !/^[a-z][a-z0-9]{0,15}$/.test(account.value); root.setAttribute('aria-busy', String(busy)) }
    const list = async (): Promise<void> => {
      if (!admitted() || busy) return
      const username = account.value
      rows.replaceChildren()
      if (!/^[a-z][a-z0-9]{0,15}$/.test(username)) { lock(); return }
      busy = true; lock()
      try {
        const raw = await transport!('GET', '/api/backups/accounts/' + encodeURIComponent(username)) as { backups?: unknown }
        if (!raw || !Array.isArray(raw.backups) || raw.backups.length > 10000) throw new Error('invalid_local_archives')
        const names = new Set<string>()
        const rendered = raw.backups.map((value: unknown) => {
          const item = value as { file?: unknown; bytes?: unknown }
          if (!item || typeof item.file !== 'string' || !new RegExp('^xpanel-backup-' + username + '-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$').test(item.file) || names.has(item.file) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) throw new Error('invalid_local_archive')
          names.add(item.file)
          const row = cloneClientTemplate(template, 'tr', ['archive', 'bytes', 'review'])
          clientTemplateSlot(row, 'archive').textContent = item.file
          clientTemplateSlot(row, 'bytes').textContent = String(item.bytes)
          const review = clientTemplateSlot(row, 'review', 'a') as HTMLAnchorElement
          review.href = '/whm/backups/files?lang=' + (document.documentElement.lang === 'ar' ? 'ar' : 'en')
          review.textContent = xpT('Restore files') + ': ' + item.file
          return row
        })
        if (!admitted() || account.value !== username) return
        rows.replaceChildren(...rendered)
        note(xpT('Choose an account to list its backups.'))
      } catch { note(xpT('Backup runs could not be read. No changes were made.'), true) }
      finally { busy = false; lock() }
    }
    account.addEventListener('change', () => { if (!busy) void list() })
    refresh.addEventListener('click', () => { if (!refresh.disabled) void list() })
    create.addEventListener('click', () => {
      if (create.disabled || !admitted() || busy) return
      const username = account.value; busy = true; lock(); note(xpT('Creating the backup. This can take a while.'))
      void transport!('POST', '/api/backups/accounts/' + encodeURIComponent(username), { op: 'create' }).then(value => {
        const run = (value as { run?: { id?: unknown; state?: unknown } } | null)?.run
        if (!run || typeof run.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.id) || run.state !== 'running') throw new Error('unverified_backup_run')
        note(xpT('The backup job started at low priority. Read the list again when it finishes.'))
      }).catch(() => { reviewRequired = true; note(xpT('The outcome requires review. Nothing was retried. Read archives and review the actual home-file differences before another action.'), true) }).finally(() => { busy = false; lock() })
    })
    lock(); if (admitted()) void list()
  })
}

export const WHM_LOCAL_ARCHIVES_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};return ${bindLocalArchives.toString()};})()`
