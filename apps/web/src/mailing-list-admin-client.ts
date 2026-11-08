import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />

/**
 * Mailing list administrator password controllers: the owner's change form (xPanel), list member administration
 * with the list password (xMail) and the root reset and restart (xWHM). Passwords stay in their inputs only.
 */
export function listAdminObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function listAdminEmail(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(text)) throw new Error('invalid_list_address')
  return text
}
/** The members reply of one list. */
export function listAdminMembers(value: unknown, address: string): string[] {
  if (!listAdminObject(value) || value.address !== address || !Array.isArray(value.members) || value.members.length > 1000 || value.members.some(item => typeof item !== 'string' || item.length > 254)) throw new Error('invalid_list_members')
  return value.members as string[]
}
/** Root list inventory rows. */
export function listAdminRows(value: unknown): { id: string; address: string; account: string | null; passwordSet: boolean }[] {
  if (!listAdminObject(value) || !Array.isArray(value.lists) || value.lists.length > 10_000) throw new Error('invalid_lists')
  return value.lists.map(item => {
    if (!listAdminObject(item) || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.address !== 'string' || !(item.account === null || typeof item.account === 'string') || typeof item.passwordSet !== 'boolean') throw new Error('invalid_lists')
    return { id: item.id, address: item.address, account: item.account as string | null, passwordSet: item.passwordSet }
  })
}

function bindMailingListAdmin(): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const reasons: Record<string, string> = {
    list_password_wrong: copy('The list password is not correct.'),
    list_admin_locked: copy('List sign-in is locked for 15 minutes after repeated wrong passwords.'),
    list_password_unset: copy('This list has no administrator password yet. The account owner sets it in xPanel.'),
    no_mailing_lists: copy('No mailing list exists, so no list delivery runs to restart.'),
  }
  const failure = (error: unknown, fallback: string): string => {
    const detail = listAdminObject(error) && listAdminObject(error.details) ? error.details : {}
    if (detail.stateChanged !== false || detail.verificationRequired === true) return copy('The outcome is uncertain. Reload and inspect before retrying; nothing was retried.')
    return typeof detail.reason === 'string' && reasons[detail.reason] ? reasons[detail.reason]! : fallback
  }
  const bind = (roots: NodeListOf<HTMLElement>, setup: (root: HTMLElement, say: (message: string, kind: string) => void, disable: (off: boolean) => void) => void): void => {
    roots.forEach(root => {
      if (root.dataset.listAdminBound === 'true') return
      root.dataset.listAdminBound = 'true'
      const status = root.querySelector<HTMLElement>('[data-list-admin-status]')
      const say = (message: string, kind: string): void => { if (!status) return; status.hidden = !message; status.dataset.state = kind; status.setAttribute('role', kind === 'failed' ? 'alert' : 'status'); status.textContent = message }
      // Only this controller's controls; the theme's permanently unavailable buttons stay disabled.
      const disable = (off: boolean): void => { root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(control => { if ([...control.attributes].some(item => item.name.startsWith('data-list-'))) control.disabled = off }) }
      if (typeof transport !== 'function' || root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')) {
        disable(true); say(copy('List administration is unavailable here. Nothing was read or changed.'), 'unavailable'); return
      }
      setup(root, say, disable)
    })
  }
  const fill = (select: HTMLSelectElement, rows: { id: string; address: string }[]): void => {
    select.textContent = ''
    for (const row of rows) select.appendChild(new Option(row.address, row.id))
  }
  // xPanel: the owner sets a list password without the old one.
  bind(document.querySelectorAll<HTMLElement>('[data-list-password]'), (root, say, disable) => {
    const select = root.querySelector<HTMLSelectElement>('select[data-list-password-list]'), input = root.querySelector<HTMLInputElement>('input[data-list-password-input]')
    const save = root.querySelector<HTMLButtonElement>('button[data-list-password-save]')
    if (!select || !input || !save) return
    void (async () => {
      try {
        const value = await transport!('GET', '/api/mail/mailing-lists')
        const rows = listAdminObject(value) && Array.isArray(value.mailingLists) ? value.mailingLists.filter(listAdminObject).map(item => ({ id: String(item.id), address: String(item.address) })) : []
        fill(select, rows); disable(!rows.length); say(rows.length ? '' : copy('Create a mailing list first.'), 'read')
      } catch { disable(true); say(copy('Saved mailing lists could not be read. Nothing was changed.'), 'failed') }
    })()
    save.addEventListener('click', () => {
      if (input.value.length < 8) { say(copy('The list password needs at least 8 characters. Nothing was sent.'), 'failed'); return }
      disable(true); say(copy('Saving the list password…'), 'saving')
      transport!('PUT', '/api/mail/mailing-lists/' + encodeURIComponent(select.value) + '/password', { password: input.value })
        .then(() => { input.value = ''; say(copy('The list password was saved. The old password no longer works.'), 'saved') })
        .catch(error => say(failure(error, copy('The list password was refused. Nothing was changed.')), 'failed'))
        .finally(() => disable(false))
    })
  })
  // xMail: whoever holds the list password administers its members.
  bind(document.querySelectorAll<HTMLElement>('[data-list-admin]'), (root, say, disable) => {
    const address = root.querySelector<HTMLInputElement>('input[data-list-admin-address]'), password = root.querySelector<HTMLInputElement>('input[data-list-admin-password]')
    const member = root.querySelector<HTMLInputElement>('input[data-list-admin-member]'), rows = root.querySelector<HTMLTableSectionElement>('tbody[data-list-admin-members]')
    const open = root.querySelector<HTMLButtonElement>('button[data-list-admin-open]'), add = root.querySelector<HTMLButtonElement>('button[data-list-admin-add]')
    if (!address || !password || !member || !rows || !open || !add) return
    let list = ''
    const paint = (members: string[]): void => {
      rows.textContent = ''
      for (const item of members) {
        const row = cloneClientTemplate(clientTemplate(root, 'list-admin-member'), 'tr', ['address', 'action'])
        clientTemplateSlot(row, 'address').textContent = item
        const remove = clientTemplateSlot(row, 'action', 'button') as HTMLButtonElement
        remove.textContent = copy('Remove member'); remove.disabled = false
        remove.addEventListener('click', () => { void call('remove', item) })
        rows.appendChild(row)
      }
    }
    const call = async (op: 'read' | 'add' | 'remove', target: string | null): Promise<void> => {
      let next: string
      try { next = op === 'read' ? listAdminEmail(address.value) : list } catch { say(copy('Enter the list address. Nothing was sent.'), 'failed'); return }
      if (!password.value) { say(copy('Enter the list password. Nothing was sent.'), 'failed'); return }
      disable(true); say(copy('Checking the list password…'), 'saving')
      try {
        const reply = await transport!('POST', '/api/webmail/mailing-lists/admin', { list: next, password: password.value, op, member: target })
        list = next; paint(listAdminMembers(reply, next)); member.value = ''
        say(op === 'read' ? copy('Members read. Changes apply to list delivery when the mail routing applies.') : copy('Saved and read back.'), 'saved')
      } catch (error) { say(failure(error, copy('The list administration request was refused. Nothing was changed.')), 'failed') }
      finally { disable(false); add.disabled = !list }
    }
    disable(false); add.disabled = true
    open.addEventListener('click', () => { void call('read', null) })
    add.addEventListener('click', () => { try { void call('add', listAdminEmail(member.value)) } catch { say(copy('A member is one email address. Nothing was sent.'), 'failed') } })
  })
  // xWHM: root resets any list password and restarts list delivery.
  bind(document.querySelectorAll<HTMLElement>('[data-list-reset]'), (root, say, disable) => {
    const select = root.querySelector<HTMLSelectElement>('select[data-list-reset-list]'), input = root.querySelector<HTMLInputElement>('input[data-list-reset-password]')
    const rows = root.querySelector<HTMLTableSectionElement>('tbody[data-list-reset-rows]'), reset = root.querySelector<HTMLButtonElement>('button[data-list-reset-save]'), restart = root.querySelector<HTMLButtonElement>('button[data-list-restart]')
    if (!select || !input || !rows || !reset || !restart) return
    const read = async (): Promise<void> => {
      try {
        const lists = listAdminRows(await transport!('GET', '/api/server/mailing-lists'))
        rows.textContent = ''
        for (const item of lists) {
          const row = cloneClientTemplate(clientTemplate(root, 'list-reset-row'), 'tr', ['address', 'account', 'password'])
          clientTemplateSlot(row, 'address').textContent = item.address
          clientTemplateSlot(row, 'account').textContent = item.account ?? copy('No account')
          clientTemplateSlot(row, 'password').textContent = item.passwordSet ? copy('Set') : copy('Not set')
          rows.appendChild(row)
        }
        fill(select, lists); disable(false); reset.disabled = !lists.length; say(lists.length ? '' : copy('No mailing list exists on this server.'), 'read')
      } catch { disable(true); restart.disabled = false; say(copy('Saved mailing lists could not be read. Nothing was changed.'), 'failed') }
    }
    reset.addEventListener('click', () => {
      if (input.value.length < 8) { say(copy('The list password needs at least 8 characters. Nothing was sent.'), 'failed'); return }
      disable(true); say(copy('Saving the list password…'), 'saving')
      transport!('PUT', '/api/server/mailing-lists/' + encodeURIComponent(select.value) + '/password', { password: input.value })
        .then(async () => { input.value = ''; await read(); say(copy('The list password was saved. The old password no longer works.'), 'saved') })
        .catch(error => { disable(false); say(failure(error, copy('The list password was refused. Nothing was changed.')), 'failed') })
    })
    restart.addEventListener('click', () => {
      disable(true); say(copy('Testing the Postfix configuration and restarting list delivery…'), 'saving')
      transport!('POST', '/api/server/mailing-lists/restart', {})
        .then(() => say(copy('Postfix passed its configuration test and was restarted; lists deliver from its alias table again.'), 'saved'))
        .catch(error => say(failure(error, copy('List delivery was not restarted. Postfix kept running unchanged.')), 'failed'))
        .finally(() => disable(false))
    })
    void read()
  })
}

export const MAILING_LIST_ADMIN_CLIENT_BINDING = `(function(){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const listAdminObject=${listAdminObject.toString()};const listAdminEmail=${listAdminEmail.toString()};const listAdminMembers=${listAdminMembers.toString()};const listAdminRows=${listAdminRows.toString()};(${bindMailingListAdmin.toString()})();})`
