/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

export interface ServiceUserRow { id: string; login: string; services: { email: boolean; ftp: boolean; webdisk: boolean }; mailboxQuotaMb: number | 'unlimited'; ftpDir: string; webdiskReadOnly?: boolean }
export function readServiceUsers(raw: unknown): ServiceUserRow[] {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const list = object(raw) ? raw.serviceUsers : null
  if (!Array.isArray(list) || list.some(user => !object(user) || typeof user.id !== 'string' || typeof user.login !== 'string' || !object(user.services) || typeof user.ftpDir !== 'string')) throw new Error('invalid_service_users')
  return list as ServiceUserRow[]
}
/** Letters, digits, dot, dash and underscore; the server applies the same rule to the login. */
export const SERVICE_USER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/

function bindServiceUsers(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-service-users]').forEach(root => {
    if (root.dataset.serviceUsersBound === 'true') return
    root.dataset.serviceUsersBound = 'true'
    const part = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-service-user-' + key + ']')
    const rows = root.querySelector<HTMLElement>('[data-service-users-rows]'), status = root.querySelector<HTMLElement>('[data-service-users-status]')
    const local = part<HTMLInputElement>('local'), domain = part<HTMLSelectElement>('domain'), password = part<HTMLInputElement>('password'), generate = part<HTMLButtonElement>('generate'), email = part<HTMLInputElement>('email'), quota = part<HTMLInputElement>('quota')
    const ftp = part<HTMLInputElement>('ftp'), dir = part<HTMLInputElement>('dir'), webdisk = part<HTMLInputElement>('webdisk'), readonly = part<HTMLInputElement>('readonly'), save = part<HTMLButtonElement>('save'), cancel = part<HTMLButtonElement>('cancel')
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    const manage = root.dataset.serviceUsersCanManage === 'true'
    if (!send || !rows || !local || !domain || !password || !generate || !email || !quota || !ftp || !dir || !webdisk || !readonly || !save || !cancel || !manage || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      if (!manage) say('unavailable', t('Service users can only be changed by the account owner.'))
      return
    }
    for (const control of controls) control.disabled = false
    let editing: ServiceUserRow | null = null, users: ServiceUserRow[] = []
    const failure = (error: unknown): string => {
      const code = (error as { code?: unknown } | null)?.code, message = (error as { message?: unknown } | null)?.message
      if (code === 'CONFLICT') return t('A service user with that name already exists. Edit it instead.')
      if (code === 'LIMIT_EXCEEDED') return t('The plan does not allow this. Check its mailbox and quota limits.')
      return code === 'VALIDATION' && typeof message === 'string' ? message : t('The change was not saved. Nothing else was changed.')
    }
    const reset = (): void => {
      editing = null; local.value = ''; local.disabled = false; domain.disabled = false; password.value = ''; password.type = 'password'; email.checked = true; ftp.checked = false; webdisk.checked = false; readonly.checked = false; quota.value = '1024'; dir.value = 'public_html'; cancel.hidden = true
      save.textContent = t('Create user')
    }
    const cell = (value: string, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) } else td.textContent = value; return td }
    const button = (label: string, run: () => void): HTMLElement => { const node = cloneClientTemplate(clientTemplate(root, 'service-user-action'), 'button', ['label']); clientTemplateSlot(node, 'label').textContent = label; node.addEventListener('click', run); return node }
    const yes = (value: boolean): string => value ? t('Yes') : t('No')
    const paint = (): void => {
      rows.replaceChildren()
      const owner = document.createElement('tr'), note = cell(t('Account owner. Change it on the Contact and Password pages.'))
      owner.append(cell(root.dataset.serviceUsersOwner ?? '', true), cell('-'), cell('-'), cell('-'), note); rows.append(owner)
      for (const user of users) {
        const row = document.createElement('tr'), actions = document.createElement('td')
        actions.append(button(t('Edit'), () => { edit(user) }), button(t('Delete'), () => { void remove(user) }))
        row.append(cell(user.login, true), cell(yes(user.services.email)), cell(yes(user.services.ftp)), cell(yes(user.services.webdisk)), actions); rows.append(row)
      }
    }
    const load = async (): Promise<void> => {
      say('reading', t('Reading service users…'))
      try {
        users = readServiceUsers(await send('GET', '/api/service-users')); paint()
        say('read', users.length ? t('Service users read.') : t('No service users yet. Create the first one.'))
      } catch { say('failed', t('Service users could not be read. Nothing was changed.')) }
    }
    const edit = (user: ServiceUserRow): void => {
      editing = user; const at = user.login.lastIndexOf('@')
      local.value = user.login.slice(0, at); local.disabled = true; domain.disabled = true
      if (![...domain.options].some(option => option.textContent === user.login.slice(at + 1))) domain.append(new Option(user.login.slice(at + 1), ''))
      domain.value = [...domain.options].find(option => option.textContent === user.login.slice(at + 1))?.value ?? ''
      password.value = ''; email.checked = user.services.email; ftp.checked = user.services.ftp; webdisk.checked = user.services.webdisk; readonly.checked = user.webdiskReadOnly === true
      quota.value = String(user.mailboxQuotaMb); dir.value = user.ftpDir; cancel.hidden = false; save.textContent = t('Save changes'); local.scrollIntoView?.({ block: 'center' })
    }
    const remove = async (user: ServiceUserRow): Promise<void> => {
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Delete {login}?', { login: user.login }), body: t('The login stops working for every service. Its mailbox and all its messages are deleted. This cannot be undone.'), confirm: t('Delete user'), danger: true }) !== true) return
      try { await send('DELETE', '/api/service-users/' + user.id); if (editing?.id === user.id) reset(); await load() }
      catch (error) { say('failed', failure(error)) }
    }
    const submit = async (): Promise<void> => {
      const services = { email: email.checked, ftp: ftp.checked, webdisk: webdisk.checked }, megabytes = Number(quota.value)
      if (!services.email && !services.ftp && !services.webdisk) { say('failed', t('Turn on at least one service.')); return }
      if (services.email && !(Number.isSafeInteger(megabytes) && megabytes >= 1)) { say('failed', t('Enter the mailbox quota in whole MB.')); return }
      const common = { services, ...(services.email ? { mailboxQuotaMb: megabytes } : {}), ftpDir: dir.value.trim(), webdiskReadOnly: services.webdisk && readonly.checked }
      if (!editing) {
        if (!SERVICE_USER_NAME.test(local.value.trim())) { say('failed', t('Use letters, digits, dots, dashes and underscores in the username.')); return }
        if (!domain.value) { say('failed', t('Choose a domain.')); return }
        if (!password.value) { say('failed', t('Enter a password or generate one.')); return }
      }
      save.disabled = true; say('saving', t('Saving…'))
      try {
        if (editing) await send('PATCH', '/api/service-users/' + editing.id, { ...common, ...(password.value ? { password: password.value } : {}) })
        else await send('POST', '/api/service-users', { ...common, localPart: local.value.trim().toLowerCase(), domainId: domain.value, password: password.value })
        reset(); await load(); say('saved', t('Saved and applied to the services.'))
      } catch (error) { say('failed', failure(error)) }
      finally { save.disabled = false }
    }
    generate.addEventListener('click', () => { const bytes = crypto.getRandomValues(new Uint8Array(18)); password.value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_'); password.type = 'text' })
    save.addEventListener('click', () => { void submit() }); cancel.addEventListener('click', reset)
    reset()
    void (async () => {
      await load()
      try {
        const raw = await send('GET', '/api/domains') as { domains?: { id?: unknown; name?: unknown }[] }
        for (const item of Array.isArray(raw?.domains) ? raw.domains : []) if (typeof item.id === 'string' && typeof item.name === 'string') domain.append(new Option(item.name, item.id))
      } catch { say('failed', t('The domain list could not be read.')) }
    })()
  })
}

export const SERVICE_USERS_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const SERVICE_USER_NAME=${SERVICE_USER_NAME.toString()};const readServiceUsers=${readServiceUsers.toString()};return ${bindServiceUsers.toString()}})()`
