/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
export interface AccountAdminRowView {
  id: string; username: string; primaryDomain: string; status: string; home: string; shell: 'none' | 'jailed'
  planShell: 'none' | 'jailed' | null; shellSource: 'package' | 'override'; forcedPassword: boolean | null; homeMove: string | null
}
export interface HomeRootView { path: string; availableKb: number | null; filesystem: string | null }
export interface AccountAdminView { accounts: AccountAdminRowView[]; homeRoots: HomeRootView[] | null }

/** Strict reader for GET /api/accounts/admin. */
export function readAccountAdminView(value: unknown): AccountAdminView {
  const bad = (): never => { throw new Error('invalid_account_admin') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !Array.isArray(value.accounts) || value.accounts.length > 100000) return bad()
  const accounts = value.accounts.map((row: unknown): AccountAdminRowView => {
    if (!object(row) || typeof row.id !== 'string' || typeof row.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(row.username) || typeof row.primaryDomain !== 'string' || typeof row.status !== 'string' || typeof row.home !== 'string'
      || (row.shell !== 'none' && row.shell !== 'jailed') || ![null, 'none', 'jailed'].includes(row.planShell as string) || (row.shellSource !== 'package' && row.shellSource !== 'override') || ![null, true, false].includes(row.forcedPassword as boolean)) return bad()
    return row as unknown as AccountAdminRowView
  })
  const roots = value.homeRoots
  if (roots !== undefined && roots !== null && !Array.isArray(roots)) return bad()
  const homeRoots = Array.isArray(roots) ? roots.map((root: unknown): HomeRootView => object(root) && typeof root.path === 'string' && /^\/home[1-9]?[0-9]?$/.test(root.path) && (root.availableKb === null || typeof root.availableKb === 'number') && (root.filesystem === null || typeof root.filesystem === 'string')
    ? root as unknown as HomeRootView : bad()) : null
  return { accounts, homeRoots }
}

/** Force Password Change, Manage Shell Access and Rearrange an Account share one read; each reply alone proves its change. */
function bindWhmAccountAdmin(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const note = (node: HTMLElement | null, state: string, message: string): void => {
    if (!node) return
    node.hidden = false; node.dataset.state = state; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status'); node.textContent = message
  }
  const uncertain = t('The outcome is uncertain. Reload the page and review the current state before retrying; no automatic retry was sent.')
  const refusal = (error: unknown): string => {
    const value = object(error), details = object(value.details)
    if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return ''
    const known: Record<string, string> = {
      invalid_home_root: t('That home directory is not one of the home roots on this server. Nothing was changed.'),
      home_exists: t('The destination already has a directory with this username. Nothing was changed.'),
      home_space: t('The destination does not have enough free space. Nothing was changed.'),
      home_unchanged: t('The account already lives in that home directory. Nothing was changed.'),
      account_busy: t('The account is being moved or terminated. Nothing was changed.'),
      home_missing: t('The home directory of the account could not be read. Nothing was changed.'),
    }
    const reason = typeof details.reason === 'string' ? details.reason : ''
    if (known[reason]) return known[reason]!
    return details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408 ? t('The server refused the request. Nothing was changed; check the values and try again.') : ''
  }
  const confirm = async (title: string, body: string, label: string, danger = false): Promise<boolean> => typeof askDialog === 'function' && await askDialog({ title, body, confirm: label, danger }) === true
  const admitted = (root: HTMLElement): boolean => root.isConnected && !root.closest(denied) && typeof request === 'function'
  const editable = (root: HTMLElement): boolean => admitted(root) && root.dataset.accountAdminEditable === 'true'
  const guard = (root: HTMLElement, status: HTMLElement | null, control: readonly (HTMLElement | null)[]) => {
    let busy = false
    return async (work: () => Promise<void>): Promise<void> => {
      if (busy || !editable(root)) return
      busy = true; root.setAttribute('aria-busy', 'true'); control.forEach(item => { if (item) (item as HTMLButtonElement).disabled = true })
      try { await work() } catch (error) { const text = refusal(error); note(status, text ? 'failed' : 'uncertain', text || uncertain) }
      finally { busy = false; root.setAttribute('aria-busy', 'false'); control.forEach(item => { if (item) (item as HTMLButtonElement).disabled = false }) }
    }
  }
  const read = async (): Promise<AccountAdminView> => readAccountAdminView(await request!('GET', '/api/accounts/admin'))

  document.querySelectorAll<HTMLElement>('[data-whm-force-password]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-force-password-status]'), rows = root.querySelector<HTMLElement>('[data-force-password-rows]'), save = root.querySelector<HTMLButtonElement>('[data-force-password-save]')
    const all = root.querySelector<HTMLButtonElement>('[data-force-password-all]'), none = root.querySelector<HTMLButtonElement>('[data-force-password-none]')
    if (!admitted(root) || !rows) { [save, all, none].forEach(item => { if (item) item.disabled = true }); note(status, 'unavailable', t('Password changes require root or a reseller with the edit-account privilege. Nothing was read or changed.')); return }
    const template = clientTemplate(root, 'force-password-row'), slots = ['username', 'domain', 'forced', 'state']
    let saved = new Map<string, boolean>()
    const boxes = (): HTMLInputElement[] => [...rows.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    const paint = (view: AccountAdminView): void => {
      saved = new Map(view.accounts.filter(row => row.forcedPassword !== null).map(row => [row.username, row.forcedPassword!]))
      rows.replaceChildren(...view.accounts.map(row => {
        const tr = cloneClientTemplate(template, 'tr', slots), box = clientTemplateSlot(tr, 'forced', 'input') as HTMLInputElement
        clientTemplateSlot(tr, 'username').textContent = row.username; clientTemplateSlot(tr, 'domain').textContent = row.primaryDomain
        box.checked = row.forcedPassword === true; box.disabled = row.forcedPassword === null || !editable(root); box.dataset.username = row.username; box.setAttribute('aria-label', t('Force a password change for {username}', { username: row.username }))
        clientTemplateSlot(tr, 'state').textContent = row.forcedPassword === null ? t('No panel sign-in') : row.forcedPassword ? t('Change required') : t('Not required')
        return tr
      }))
      note(status, 'read', view.accounts.length ? t('{count, plural, one {{count} account read.} other {{count} accounts read.}}', { count: view.accounts.length }) : t('No accounts were returned.'))
    }
    const run = guard(root, status, [save, all, none])
    all?.addEventListener('click', () => { boxes().forEach(box => { if (!box.disabled) box.checked = true }) })
    none?.addEventListener('click', () => { boxes().forEach(box => { if (!box.disabled) box.checked = false }) })
    save?.addEventListener('click', () => void run(async () => {
      const users = Object.fromEntries(boxes().filter(box => !box.disabled && box.checked !== saved.get(box.dataset.username ?? '')).map(box => [box.dataset.username, box.checked]))
      if (!Object.keys(users).length) { note(status, 'read', t('Nothing changed.')); return }
      if (!await confirm(t('Change the forced password list?'), t('A newly forced user is signed out at once and can only change the password at the next sign-in.'), t('Save'))) { note(status, 'cancelled', t('Nothing was changed.')); return }
      note(status, 'loading', t('Saving…'))
      const reply = object(await request!('PUT', '/api/accounts/admin/password-change', { users, stopOnFailure: false }))
      if (!Array.isArray(reply.updated) || !Array.isArray(reply.failed)) throw new Error('unverified')
      paint(await read())
      note(status, reply.failed.length ? 'failed' : 'saved', t('{updated} changed, {failed} not changed.', { updated: reply.updated.length, failed: reply.failed.length }))
    }))
    read().then(paint, () => note(status, 'failed', t('The accounts could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-shell-access]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-shell-status]'), rows = root.querySelector<HTMLElement>('[data-shell-rows]')
    const bulk = [...root.querySelectorAll<HTMLButtonElement>('[data-shell-all]')]
    if (!admitted(root) || !rows) { bulk.forEach(item => { item.disabled = true }); note(status, 'unavailable', t('Shell changes require root or a reseller with the edit-account privilege. Nothing was read or changed.')); return }
    const template = clientTemplate(root, 'shell-access-row'), slots = ['username', 'shell', 'source']
    let accounts: AccountAdminRowView[] = []
    const run = guard(root, status, bulk)
    const paint = (view: AccountAdminView): void => {
      accounts = view.accounts
      rows.replaceChildren(...accounts.map(row => {
        const tr = cloneClientTemplate(template, 'tr', slots), select = clientTemplateSlot(tr, 'shell', 'select') as HTMLSelectElement
        clientTemplateSlot(tr, 'username').textContent = row.username
        select.value = row.shell; select.disabled = !editable(root); select.dataset.accountId = row.id; select.setAttribute('aria-label', t('Shell access for {username}', { username: row.username }))
        clientTemplateSlot(tr, 'source').textContent = row.planShell === 'none' && row.shell === 'jailed' ? t('Override; the package still disables the shell') : row.shellSource === 'override' ? t('Override of the package') : t('From the package')
        return tr
      }))
      note(status, 'read', accounts.length ? t('{count, plural, one {{count} account read.} other {{count} accounts read.}}', { count: accounts.length }) : t('No accounts were returned.'))
    }
    // The bulk route holds 25 accounts; each change is a host reconcile, so the page sends one batch at a time.
    const change = async (ids: string[], shell: string): Promise<void> => {
      let applied = 0, other = 0
      for (let at = 0; at < ids.length; at += 25) {
        const reply = object(await request!('POST', '/api/accounts/bulk-actions/shell', { operationId: crypto.randomUUID(), accounts: ids.slice(at, at + 25).map(id => ({ id })), shell }))
        const summary = object(reply.summary)
        if (typeof summary.applied !== 'number') throw new Error('unverified')
        applied += summary.applied; other += Number(summary.refused) + Number(summary.reviewRequired) + Number(summary.notAttempted)
      }
      paint(await read())
      note(status, other ? 'failed' : 'saved', t('{applied} changed, {failed} not changed.', { applied, failed: other }))
    }
    rows.addEventListener('change', event => {
      const select = event.target instanceof HTMLSelectElement ? event.target : null
      if (select?.dataset.accountId) void run(() => change([select.dataset.accountId!], select.value))
    })
    bulk.forEach(button => button.addEventListener('click', () => void run(async () => {
      const shell = button.dataset.shellAll ?? '', ids = accounts.filter(row => row.shell !== shell).map(row => row.id)
      if (!ids.length) { note(status, 'read', t('Nothing changed.')); return }
      if (!await confirm(t('Change the shell of {count, plural, one {{count} account} other {{count} accounts}}?', { count: ids.length }), t('Each account is changed in turn with its host reconcile.'), t('Change'))) { note(status, 'cancelled', t('Nothing was changed.')); return }
      note(status, 'loading', t('Saving…'))
      await change(ids, shell)
    })))
    read().then(paint, () => note(status, 'failed', t('The accounts could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-rearrange]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-rearrange-status]'), form = root.querySelector<HTMLFormElement>('form[data-rearrange-form]')
    const account = form?.elements.namedItem('account') as HTMLSelectElement | null, target = form?.elements.namedItem('root') as HTMLSelectElement | null, submit = root.querySelector<HTMLButtonElement>('[data-rearrange-submit]')
    if (!admitted(root) || !form || !account || !target) { if (submit) submit.disabled = true; note(status, 'unavailable', t('Rearranging requires root authorization. Nothing was read or changed.')); return }
    const options = (select: HTMLSelectElement, items: [string, string][]): void => {
      const blank = select.firstElementChild?.cloneNode(true)
      select.replaceChildren(...(blank ? [blank] : []), ...items.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option }))
    }
    let view: AccountAdminView = { accounts: [], homeRoots: null }
    const paint = (next: AccountAdminView): void => {
      view = next
      options(account, view.accounts.filter(row => !row.homeMove).map(row => [row.id, `${row.username} (${row.home})`]))
      options(target, (view.homeRoots ?? []).map(item => [item.path, item.availableKb === null ? item.path : t('{path} ({gb} GB free)', { path: item.path, gb: Math.floor(item.availableKb / 1048576) })]))
      if (submit) submit.disabled = !editable(root) || !view.homeRoots?.length
      const moving = root.querySelector<HTMLButtonElement>('[data-rearrange-recover]'); if (moving) moving.hidden = !view.accounts.some(row => row.homeMove)
      note(status, view.homeRoots ? 'read' : 'unavailable', view.homeRoots ? t('{count, plural, one {{count} home root found.} other {{count} home roots found.}}', { count: view.homeRoots.length }) : t('The home roots of this server could not be read. Nothing was changed.'))
    }
    const run = guard(root, status, [submit])
    const recover = root.querySelector<HTMLButtonElement>('[data-rearrange-recover]')
    recover?.addEventListener('click', () => void run(async () => {
      const row = view.accounts.find(item => item.homeMove)
      if (!row) { note(status, 'read', t('No account is moving.')); return }
      if (!await confirm(t('Settle the move of {username}?', { username: row.username }), t('Use this only when the job has stopped. A compared copy finishes the move; anything less returns the account to its old home.'), t('Settle'), true)) { note(status, 'cancelled', t('Nothing was changed.')); return }
      const reply = object(await request!('DELETE', '/api/accounts/' + encodeURIComponent(row.id) + '/rearrange'))
      if (reply.outcome !== 'finished' && reply.outcome !== 'cancelled') throw new Error('unverified')
      paint(await read())
      note(status, 'saved', reply.outcome === 'finished' ? t('The move was finished.') : t('The account is back in its old home.'))
    }))
    form.addEventListener('submit', event => {
      event.preventDefault()
      void run(async () => {
        const row = view.accounts.find(item => item.id === account.value), acknowledged = (form.elements.namedItem('acknowledge') as HTMLInputElement | null)?.checked === true
        if (!row || !target.value || !acknowledged) { note(status, 'failed', t('Choose the account and the home root, and confirm the warning. Nothing was changed.')); return }
        if (!await confirm(t('Move {username} to {root}?', { username: row.username, root: target.value }), t('The account stops serving while its files move. Scripts with the old path written in them will break.'), t('Move account'), true)) { note(status, 'cancelled', t('Nothing was changed.')); return }
        note(status, 'loading', t('Stopping the account and starting the move…'))
        const reply = object(await request!('POST', '/api/accounts/' + encodeURIComponent(row.id) + '/rearrange', { root: target.value }))
        if (typeof reply.home !== 'string' || !object(reply.job).id) throw new Error('unverified')
        paint(await read())
        note(status, 'saved', t('The move to {home} is running as a job. The account stays suspended until the job finishes; follow it on the jobs page.', { home: reply.home }))
      })
    })
    read().then(paint, () => note(status, 'failed', t('The accounts could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-email-users]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-email-users-status]'), form = root.querySelector<HTMLFormElement>('form[data-email-users-form]'), send = root.querySelector<HTMLButtonElement>('[data-email-users-send]')
    const list = root.querySelector<HTMLElement>('[data-email-users-recipients]'), review = root.querySelector<HTMLButtonElement>('[data-email-users-review]')
    if (!editable(root) || !form) { if (review) review.disabled = true; if (send) send.disabled = true; note(status, 'unavailable', t('Email All Users requires root authorization. Nothing was sent.')); return }
    const message = (): Record<string, unknown> => {
      const data = new FormData(form)
      return { fromName: String(data.get('fromName') ?? ''), fromAddress: String(data.get('fromAddress') ?? ''), subject: String(data.get('subject') ?? ''), body: String(data.get('body') ?? ''), includeResellerCustomers: data.get('includeResellerCustomers') !== null }
    }
    let reviewed = ''
    const paintList = (rows: unknown[]): void => {
      if (!list) return
      list.replaceChildren(...rows.map(row => { const item = document.createElement('li'), name = document.createElement('bdi'); name.dir = 'ltr'; name.textContent = String(object(row).address ?? ''); item.append(name); return item }))
      list.hidden = !rows.length
    }
    form.addEventListener('input', () => { reviewed = ''; if (send) send.disabled = true })
    const run = guard(root, status, [review])
    form.addEventListener('submit', event => {
      event.preventDefault()
      void run(async () => {
        note(status, 'loading', t('Reading the recipients…'))
        const reply = object(await request!('POST', '/api/server/announcements/email', message()))
        if (typeof reply.review !== 'string' || typeof reply.recipients !== 'number' || !Array.isArray(reply.sample) || !Array.isArray(reply.skipped)) throw new Error('unverified')
        reviewed = reply.review; paintList(reply.sample); if (send) send.disabled = false
        note(status, 'read', t('{count, plural, one {{count} account would receive this message.} other {{count} accounts would receive this message.}} {skipped} without a contact address would be skipped. Nothing has been sent.', { count: reply.recipients, skipped: reply.skipped.length }))
      })
    })
    send?.addEventListener('click', () => void run(async () => {
      if (!reviewed) return
      if (!await confirm(t('Send this message?'), String(message().subject), t('Send'))) { note(status, 'cancelled', t('Nothing was sent.')); return }
      send.disabled = true; note(status, 'loading', t('Sending…'))
      const reply = object(await request!('POST', '/api/server/announcements/email', { ...message(), confirm: reviewed }))
      if (!Array.isArray(reply.sent) || !Array.isArray(reply.failed) || !Array.isArray(reply.skipped)) throw new Error('unverified')
      reviewed = ''; paintList(reply.sent)
      note(status, reply.failed.length ? 'failed' : 'saved', t('The local mail server accepted {sent, plural, one {{sent} message} other {{sent} messages}}. {failed} could not be handed over and {skipped} were skipped.', { sent: reply.sent.length, failed: reply.failed.length, skipped: reply.skipped.length }))
    }))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-account-enhancements]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-enh-assign-status]'), form = root.querySelector<HTMLFormElement>('form[data-enh-assign-form]')
    const account = form?.elements.namedItem('account') as HTMLSelectElement | null, enhancement = form?.elements.namedItem('enhancement') as HTMLSelectElement | null, amount = form?.elements.namedItem('value') as HTMLInputElement | null
    const assign = root.querySelector<HTMLButtonElement>('[data-enh-assign]'), remove = root.querySelector<HTMLButtonElement>('[data-enh-unassign]')
    if (!admitted(root) || !form || !account || !enhancement || !amount) { note(status, 'unavailable', t('Assigning enhancements requires the edit-account privilege. Nothing was read or changed.')); return }
    interface Definition { id: string; label: string; kind: string; min: number | null; max: number | null }
    let revision = '', definitions: Definition[] = []
    const fill = (select: HTMLSelectElement, items: [string, string][]): void => {
      const blank = select.firstElementChild?.cloneNode(true)
      select.replaceChildren(...(blank ? [blank] : []), ...items.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option }))
    }
    const load = async (): Promise<void> => {
      const view = object(await request!('GET', '/api/accounts/enhancements'))
      if (typeof view.revision !== 'string' || !Array.isArray(view.definitions) || !Array.isArray(view.accounts)) throw new Error('unverified')
      revision = view.revision; definitions = view.definitions as Definition[]
      fill(account, (view.accounts as { id: string; username: string }[]).map(row => [row.id, row.username]))
      fill(enhancement, definitions.map(item => [item.id, item.label]))
      note(status, 'read', definitions.length ? t('{count, plural, one {{count} enhancement can be assigned.} other {{count} enhancements can be assigned.}}', { count: definitions.length }) : t('Root has not given you any enhancement.'))
    }
    const run = guard(root, status, [assign, remove])
    const change = (value: unknown): Promise<void> => run(async () => {
      if (!account.value || !enhancement.value) { note(status, 'failed', t('Choose the account and the enhancement. Nothing was changed.')); return }
      const reply = object(await request!('PUT', '/api/accounts/' + encodeURIComponent(account.value) + '/enhancements', { enhancement: enhancement.value, value, expectedRevision: revision }))
      if (typeof reply.revision !== 'string') throw new Error('unverified')
      revision = reply.revision
      note(status, 'saved', t('The enhancement list of this account was saved.'))
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      const definition = definitions.find(item => item.id === enhancement.value)
      void change(definition?.kind === 'limit' ? Number(amount.value) : true)
    })
    remove?.addEventListener('click', () => void change(null))
    load().catch(() => note(status, 'failed', t('Enhancements could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-web-templates]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-web-template-status]'), preview = root.querySelector<HTMLIFrameElement>('[data-web-template-preview]')
    const forms = [...root.querySelectorAll<HTMLFormElement>('form[data-web-template-form]')]
    if (!editable(root)) { note(status, 'unavailable', t('Editing templates requires the edit-account privilege. Nothing was read or changed.')); return }
    interface Page { state: string; html: string; updatedAt: string | null; shipped: string }
    let revision = '', pages: Record<string, Page> = {}
    const area = (form: HTMLFormElement): HTMLTextAreaElement => form.elements.namedItem('html') as HTMLTextAreaElement
    const paint = (view: Record<string, unknown>): void => {
      if (typeof view.revision !== 'string' || !object(view.pages)) throw new Error('unverified')
      revision = view.revision; pages = view.pages as Record<string, Page>
      for (const form of forms) {
        const page = pages[form.dataset.webTemplateForm ?? ''], label = form.querySelector<HTMLElement>('[data-web-template-state]')
        if (!page) throw new Error('unverified')
        area(form).value = page.html
        if (label) label.textContent = page.state === 'custom' ? t('Custom page, saved {at} UTC.', { at: String(page.updatedAt).slice(0, 16).replace('T', ' ') }) : t('The shipped page.')
      }
    }
    const run = guard(root, status, [])
    const published = (view: Record<string, unknown>): void => note(status, view.published === true ? 'saved' : 'failed', view.published === true ? t('The page was saved and published.') : t('The page was saved, but the host has not published it. Apply the configuration from the dashboard.'))
    for (const form of forms) {
      const kind = form.dataset.webTemplateForm ?? ''
      form.addEventListener('submit', event => {
        event.preventDefault()
        void run(async () => { const view = object(await request!('PUT', '/api/accounts/web-templates/' + kind, { html: area(form).value, expectedRevision: revision })); paint(view); published(view) })
      })
      form.querySelector<HTMLInputElement>('[data-web-template-upload]')?.addEventListener('change', event => {
        const file = (event.target as HTMLInputElement).files?.[0]
        if (file) void file.text().then(text => { area(form).value = text; note(status, 'read', t('The file is in the editor. Nothing is saved yet.')) })
      })
      form.querySelectorAll<HTMLButtonElement>('[data-web-template-action]').forEach(button => button.addEventListener('click', () => {
        const action = button.dataset.webTemplateAction
        if (action === 'revert') { area(form).value = pages[kind]?.html ?? ''; note(status, 'read', t('The editor shows the last saved page.')) }
        else if (action === 'preview' && preview) { preview.srcdoc = area(form).value; preview.hidden = false }
        else if (action === 'shipped') void run(async () => {
          if (!await confirm(t('Restore the shipped page?'), t('Your saved page is removed.'), t('Restore'), true)) { note(status, 'cancelled', t('Nothing was changed.')); return }
          const view = object(await request!('DELETE', '/api/accounts/web-templates/' + kind, { expectedRevision: revision })); paint(view); published(view)
        })
      }))
    }
    request!('GET', '/api/accounts/web-templates').then(view => { paint(object(view)); note(status, 'read', t('Templates read.')) }).catch(() => note(status, 'failed', t('The templates could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-skeleton]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-skeleton-status]'), rows = root.querySelector<HTMLElement>('[data-skeleton-rows]'), form = root.querySelector<HTMLFormElement>('form[data-skeleton-form]')
    if (!editable(root) || !rows || !form) { note(status, 'unavailable', t('Editing the skeleton requires the edit-account privilege. Nothing was read or changed.')); return }
    const template = clientTemplate(root, 'skeleton-row'), slots = ['path', 'size', 'remove']
    let revision = ''
    const run = guard(root, status, [])
    const paint = (view: Record<string, unknown>): void => {
      if (typeof view.revision !== 'string' || !Array.isArray(view.files)) throw new Error('unverified')
      revision = view.revision
      rows.replaceChildren(...(view.files as { path: string; bytes: number }[]).map(file => {
        const tr = cloneClientTemplate(template, 'tr', slots)
        clientTemplateSlot(tr, 'path').textContent = file.path; clientTemplateSlot(tr, 'size').textContent = String(file.bytes)
        clientTemplateSlot(tr, 'remove', 'button').addEventListener('click', () => void run(async () => {
          if (!await confirm(t('Remove {path}?', { path: file.path }), t('New accounts no longer get this file. Existing accounts keep their copy.'), t('Remove'), true)) { note(status, 'cancelled', t('Nothing was changed.')); return }
          paint(object(await request!('DELETE', '/api/accounts/skeleton/file', { path: file.path, expectedRevision: revision }))); note(status, 'saved', t('The file was removed.'))
        }))
        return tr
      }))
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      void run(async () => {
        const data = new FormData(form), upload = data.get('file'), path = String(data.get('path') ?? '').trim()
        const bytes = upload instanceof File && upload.size ? new Uint8Array(await upload.arrayBuffer()) : new TextEncoder().encode(String(data.get('text') ?? ''))
        if (!path) { note(status, 'failed', t('Enter the file path. Nothing was changed.')); return }
        let binary = ''
        bytes.forEach(byte => { binary += String.fromCharCode(byte) })
        paint(object(await request!('PUT', '/api/accounts/skeleton/file', { path, contentBase64: btoa(binary), expectedRevision: revision })))
        form.reset(); note(status, 'saved', t('The file was saved. It is copied into accounts created from now on.'))
      })
    })
    request!('GET', '/api/accounts/skeleton').then(view => { paint(object(view)); note(status, 'read', t('The skeleton was read.')) }).catch(() => note(status, 'failed', t('The skeleton could not be read. Nothing was changed.')))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-locale-copy]').forEach(root => {
    if (root.dataset.accountAdminBound === 'true') return
    root.dataset.accountAdminBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-locale-copy-status]'), rows = root.querySelector<HTMLElement>('[data-locale-copy-rows]'), form = root.querySelector<HTMLFormElement>('form[data-locale-copy-form]')
    if (!editable(root) || !rows || !form) { note(status, 'unavailable', t('Copying a locale requires root authorization. Nothing was read or changed.')); return }
    const template = clientTemplate(root, 'locale-copy-row'), slots = ['tag', 'name', 'source', 'messages', 'state', 'remove'], source = form.elements.namedItem('source') as HTMLSelectElement
    let revision = ''
    const run = guard(root, status, [])
    const paint = (view: Record<string, unknown>): void => {
      if (typeof view.revision !== 'string' || !Array.isArray(view.copies) || !Array.isArray(view.locales)) throw new Error('unverified')
      revision = view.revision
      source.replaceChildren(...(view.locales as { tag: string; name: string }[]).map(row => { const option = document.createElement('option'); option.value = row.tag; option.textContent = `${row.tag} (${row.name})`; return option }))
      rows.replaceChildren(...(view.copies as { tag: string; name: string; source: string; messages: number; active: boolean }[]).map(copy => {
        const tr = cloneClientTemplate(template, 'tr', slots)
        clientTemplateSlot(tr, 'tag').textContent = copy.tag; clientTemplateSlot(tr, 'name').textContent = copy.name; clientTemplateSlot(tr, 'source').textContent = copy.source; clientTemplateSlot(tr, 'messages').textContent = String(copy.messages)
        clientTemplateSlot(tr, 'state').textContent = copy.active ? t('In use') : t('Waiting for the next panel start')
        clientTemplateSlot(tr, 'remove', 'button').addEventListener('click', () => void run(async () => {
          if (!await confirm(t('Delete {tag}?', { tag: copy.tag }), t('Users of this locale return to the default language at the next panel start.'), t('Delete'), true)) { note(status, 'cancelled', t('Nothing was changed.')); return }
          paint(object(await request!('DELETE', '/api/server/panel/languages/copies/' + encodeURIComponent(copy.tag), { expectedRevision: revision }))); note(status, 'saved', t('The copy was deleted.'))
        }))
        return tr
      }))
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      void run(async () => {
        const tag = (form.elements.namedItem('tag') as HTMLInputElement).value.trim()
        if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(tag)) { note(status, 'failed', t('Enter a language code such as fr or pt-BR. Nothing was changed.')); return }
        paint(object(await request!('POST', '/api/server/panel/languages/copies', { source: source.value, tag, expectedRevision: revision })))
        form.reset(); note(status, 'saved', t('The locale was copied. It joins the panels at the next panel start.'))
      })
    })
    request!('GET', '/api/server/panel/languages').then(view => { paint(object(view)); note(status, 'read', t('Locale copies read.')) }).catch(() => note(status, 'failed', t('The locale copies could not be read. Nothing was changed.')))
  })
}

export const WHM_ACCOUNT_ADMIN_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const readAccountAdminView=${readAccountAdminView.toString()};return ${bindWhmAccountAdmin.toString()};})()`
