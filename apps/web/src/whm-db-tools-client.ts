/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { generateMailboxPassword } from './password-generate-client.ts'

export type DbToolsRequest = (method: string, path: string, body?: unknown) => Promise<unknown>
export const splitDbNames = (value: string): string[] => [...new Set(value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean))]
/** A one-host-per-line list keeps the comment saved for a host that stays. */
export function readAccessHostLines(value: string, saved: readonly { host: string; comment: string }[]): { host: string; comment: string }[] {
  return [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))].map(host => ({ host, comment: saved.find(row => row.host === host)?.comment ?? '' }))
}
/** Step 1 of both wizards: letters, digits and underscore after the fixed account prefix, within the engine's name limit. */
export function dbWizardNameError(suffix: string, username: string, engine: string): string | null {
  if (!/^[a-z0-9_]+$/.test(suffix)) return 'invalid'
  return username.length + 1 + suffix.length > (engine === 'postgresql' ? 63 : 64) ? 'long' : null
}

function bindDbTools(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: DbToolsRequest }).xpanelSessionRequest
  const record = (value: unknown): Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const blocked = (root: HTMLElement): boolean => !transport || !!root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')
  const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
  const changed = (error: unknown): boolean => record(record(error).details).stateChanged !== false
  const refusal = (error: unknown): string => { const reason = record(record(error).details).reason; return reason === 'already_owned' ? t('This object already belongs to an account. Objects never move between accounts.') : reason === 'database_not_observed' ? t('This database is not on the server.') : reason === 'database_user_not_observed' ? t('This database user is not on the server.') : reason === 'database_user_auth_unsupported' ? t('This database user signs in with a method xPanel does not save.') : reason === 'database_user_grants_outside_account' || reason === 'database_user_grants_unsupported' ? t('This database user has grants that the account could not keep.') : changed(error) ? t('The outcome is unknown. Read the page again before you retry.') : t('Nothing was changed.') }
  const once = (roots: NodeListOf<HTMLElement>, bind: (root: HTMLElement) => void): void => roots.forEach(root => { if (root.dataset.dbToolBound !== 'true') { root.dataset.dbToolBound = 'true'; bind(root) } })
  const confirmed = async (title: string, body: string, confirm: string): Promise<boolean> => { try { return await askDialog?.({ title, body, danger: true, confirm }) === true } catch { return false } }

  once(document.querySelectorAll<HTMLElement>('[data-db-map-tool]'), root => {
    const account = root.querySelector<HTMLInputElement>('[data-db-map-account]'), databases = root.querySelector<HTMLInputElement>('[data-db-map-databases]'), users = root.querySelector<HTMLInputElement>('[data-db-map-users]'), submit = root.querySelector<HTMLButtonElement>('[data-db-map-submit]'), status = root.querySelector<HTMLElement>('[data-db-map-status]')
    if (!account || !databases || !users || !submit || !status) return
    const open = root.dataset.canManage === 'true' && !blocked(root)
    account.disabled = databases.disabled = users.disabled = submit.disabled = !open
    say(status, 'idle', open ? t('Name objects that no account owns. Each name must start with the account name and an underscore.') : t('Assigning objects is unavailable until this tool is verified on this release.'))
    submit.addEventListener('click', () => { void (async () => {
      if (submit.disabled) return
      submit.disabled = true; say(status, 'reading', t('Checking the server and saving the map…'))
      try {
        const reply = record(await transport!('POST', '/api/server/databases/ownership', { account: account.value.trim(), databases: splitDbNames(databases.value), users: splitDbNames(users.value) }))
        databases.value = users.value = ''
        say(status, record(reply.application).status === 'failed' ? 'uncertain' : 'read', record(reply.application).status === 'failed' ? t('The map was saved, but the host did not apply it. Check configuration health.') : t('The objects now belong to {account}.', { account: String(reply.account) }))
      } catch (error) { say(status, changed(error) ? 'uncertain' : 'failed', refusal(error)) } finally { submit.disabled = false }
    })() })
  })

  once(document.querySelectorAll<HTMLElement>('[data-db-hosts-tool]'), root => {
    const list = root.querySelector<HTMLTextAreaElement>('[data-db-hosts-list]'), save = root.querySelector<HTMLButtonElement>('[data-db-hosts-save]'), push = root.querySelector<HTMLButtonElement>('[data-db-hosts-push]'), status = root.querySelector<HTMLElement>('[data-db-hosts-status]')
    if (!list || !save || !push || !status) return
    const manage = root.dataset.canManage === 'true'
    let revision = '', saved: { host: string; comment: string }[] = []
    const lock = (on: boolean): void => { list.disabled = save.disabled = on || !manage; push.disabled = on || !manage || saved.length === 0 }
    const fill = (view: Record<string, unknown>): void => { revision = String(view.revision); saved = Array.isArray(view.hosts) ? view.hosts.map(record).map(row => ({ host: String(row.host), comment: String(row.comment) })) : []; list.value = saved.map(row => row.host).join('\n') }
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('Access hosts are unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/server/databases/access-hosts').then(view => { fill(record(view)); lock(false); say(status, 'read', manage ? t('Save the list, then push it to every account.') : t('The list is read-only until this tool is verified on this release.')) }).catch(() => say(status, 'failed', t('Access hosts could not be read.')))
    save.addEventListener('click', () => { void (async () => {
      lock(true); say(status, 'reading', t('Saving the access hosts…'))
      try { fill(record(await transport!('PUT', '/api/server/databases/access-hosts', { hosts: readAccessHostLines(list.value, saved), expectedRevision: revision }))); say(status, 'read', t('The list is saved. Accounts change only when you push it.')) }
      catch (error) { say(status, 'failed', changed(error) ? t('The outcome is unknown. Read the page again before you retry.') : t('Use exact IP addresses or an IPv4 network. Names and any-host entries are refused.')) } finally { lock(false) }
    })() })
    push.addEventListener('click', () => { void (async () => {
      if (!await confirmed(t('Push access hosts to every account?'), t('Every database user of every active account gains a grant for these hosts, and the firewall opens port 3306 to them.'), t('Push hosts'))) return
      lock(true); say(status, 'reading', t('Pushing to accounts. This can take minutes…'))
      try {
        const report = record(await transport!('POST', '/api/server/databases/access-hosts/push')), rows = Array.isArray(report.accounts) ? report.accounts.map(record) : [], pending = Array.isArray(report.pending) ? report.pending.length : 0
        const count = (state: string): string => String(rows.filter(row => row.state === state).length), failed = rows.some(row => row.state === 'failed')
        say(status, failed || pending ? 'uncertain' : 'read', t('Applied: {applied}. Already present: {unchanged}. Failed: {failed}. Not reached: {pending}.', { applied: count('applied'), unchanged: count('unchanged'), failed: count('failed'), pending: String(pending) }))
      } catch { say(status, 'uncertain', t('The outcome is unknown. Read the page again before you retry.')) } finally { lock(false) }
    })() })
  })

  once(document.querySelectorAll<HTMLElement>('[data-db-settings-tool]'), root => {
    const limits = root.querySelector<HTMLInputElement>('[data-db-setting-limits]'), pool = root.querySelector<HTMLInputElement>('[data-db-setting-pool]'), save = root.querySelector<HTMLButtonElement>('[data-db-settings-save]'), status = root.querySelector<HTMLElement>('[data-db-settings-status]')
    if (!limits || !pool || !save || !status) return
    const manage = root.dataset.canManage === 'true'
    let revision = ''
    const lock = (on: boolean): void => { limits.disabled = pool.disabled = save.disabled = on || !manage }
    const fill = (view: Record<string, unknown>): void => { revision = String(view.revision); limits.checked = view.autotuneLimits === true; pool.checked = view.innodbBufferPoolByRam === true }
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('Database settings are unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/server/databases/settings').then(view => { fill(record(view)); lock(false); say(status, 'read', record(view).state === 'read' ? t('Saving restarts MariaDB only when its configuration changed.') : t('The saved Tweak Settings file needs review before it can change.')) }).catch(() => say(status, 'failed', t('Database settings could not be read.')))
    save.addEventListener('click', () => { void (async () => {
      if (!await confirmed(t('Apply database settings?'), t('MariaDB restarts when the configuration changes, and open connections end.'), t('Apply'))) return
      lock(true); say(status, 'reading', t('Saving and applying…'))
      try {
        const view = record(await transport!('PUT', '/api/server/databases/settings', { autotuneLimits: limits.checked, innodbBufferPoolByRam: pool.checked, expectedRevision: revision }))
        fill(view); say(status, record(view.application).status === 'failed' ? 'uncertain' : 'read', record(view.application).status === 'failed' ? t('The settings were saved, but the host did not apply them. Check configuration health.') : t('The database settings are saved and applied.'))
      } catch (error) { say(status, 'failed', changed(error) ? t('The outcome is unknown. Read the page again before you retry.') : t('Nothing was changed.')) } finally { lock(false) }
    })() })
  })

  once(document.querySelectorAll<HTMLElement>('[data-db-pg-tool]'), root => {
    const fact = (key: string) => [...root.querySelectorAll<HTMLElement>('[data-db-pg-fact]')].find(node => node.dataset.dbPgFact === key), roles = root.querySelector<HTMLButtonElement>('[data-db-pg-roles]'), password = root.querySelector<HTMLInputElement>('[data-db-pg-new]'), confirmation = root.querySelector<HTMLInputElement>('[data-db-pg-confirm]'), generate = root.querySelector<HTMLButtonElement>('[data-db-pg-generate]'), submit = root.querySelector<HTMLButtonElement>('[data-db-pg-submit]'), status = root.querySelector<HTMLElement>('[data-db-pg-status]')
    if (!roles || !password || !confirmation || !generate || !submit || !status) return
    const manage = root.dataset.canManage === 'true'
    let running = false, missing = 0, busy = false
    const lock = (): void => {
      const open = manage && running && !busy
      password.disabled = confirmation.disabled = generate.disabled = !open
      roles.disabled = !open || missing === 0
      submit.disabled = !open || password.value.length < 8 || password.value !== confirmation.value
    }
    const load = async (): Promise<void> => {
      try {
        const view = record(await transport!('GET', '/api/server/databases/postgresql')), without = Array.isArray(view.accountsWithoutRole) ? view.accountsWithoutRole : []
        running = view.running === true; missing = without.length
        const state = fact('state'), count = fact('missing'), version = fact('version')
        if (state) state.textContent = view.installed === true ? (running ? t('Running') : t('Stopped')) : view.installed === false ? t('Not installed') : t('Not read')
        if (count) count.textContent = String(missing)
        if (version) version.textContent = typeof view.version === 'string' ? view.version : t('Not read')
        say(status, running ? 'read' : 'unavailable', running ? t('PostgreSQL is ready.') : t('PostgreSQL is not running on this server. Nothing can be changed.'))
      } catch { running = false; say(status, 'failed', t('PostgreSQL could not be read.')) } finally { lock() }
    }
    password.addEventListener('input', lock); confirmation.addEventListener('input', lock)
    generate.addEventListener('click', () => { try { const value = generateMailboxPassword(); password.value = confirmation.value = value; password.type = 'text'; say(status, 'idle', t('Password generated locally. Copy it before you save; it is not shown again.')) } catch { say(status, 'failed', t('Secure generation is unavailable. Enter a password yourself.')) } lock() })
    roles.addEventListener('click', () => { void (async () => {
      busy = true; lock(); say(status, 'reading', t('Creating roles…'))
      try {
        const reply = record(await transport!('POST', '/api/server/databases/postgresql/roles')), created = Array.isArray(reply.created) ? reply.created.length : 0, failed = Array.isArray(reply.failed) ? reply.failed.length : 0
        say(status, failed ? 'uncertain' : 'read', t('Roles created: {created}. Failed: {failed}.', { created: String(created), failed: String(failed) }))
      } catch { say(status, 'failed', t('The roles were not created.')) } finally { busy = false; await load() }
    })() })
    submit.addEventListener('click', () => { void (async () => {
      if (submit.disabled || !await confirmed(t('Change the PostgreSQL superuser password?'), t('Clients that sign in as postgres with the old password stop working. The server root account keeps signing in through the local socket.'), t('Change password'))) return
      const body = { password: password.value }
      busy = true; lock(); say(status, 'reading', t('Changing the password and verifying it on the server…'))
      try {
        const reply = record(await transport!('POST', '/api/server/databases/postgresql/superuser-password', body))
        password.value = confirmation.value = ''; password.type = 'password'
        say(status, reply.verificationRequired === true ? 'uncertain' : 'read', reply.verificationRequired === true ? t('The server uses the new password, but /root/.pgpass could not be written. Update it before using the postgres client.') : t('The new password is verified on the server and saved in /root/.pgpass.'))
      } catch (error) { say(status, changed(error) ? 'uncertain' : 'failed', changed(error) ? t('The outcome is unknown. Sign in with the new password to check before you retry.') : t('The password was not changed.')) } finally { busy = false; lock() }
    })() })
    lock()
    if (blocked(root)) { say(status, 'unavailable', t('PostgreSQL setup is unavailable here. Nothing was read or changed.')); return }
    void load()
  })

  once(document.querySelectorAll<HTMLElement>('[data-db-wizard]'), root => {
    const engine = root.dataset.engine ?? 'mariadb', username = root.dataset.username ?? '', manage = root.dataset.canManage === 'true' && !blocked(root)
    const steps = [...root.querySelectorAll<HTMLElement>('[data-db-wizard-step]')], name = root.querySelector<HTMLInputElement>('[data-db-wizard-name]'), user = root.querySelector<HTMLInputElement>('[data-db-wizard-user]'), password = root.querySelector<HTMLInputElement>('[data-db-wizard-password]')
    const all = root.querySelector<HTMLInputElement>('[data-db-wizard-all]'), rights = [...root.querySelectorAll<HTMLInputElement>('[data-db-wizard-privilege]')], next = root.querySelector<HTMLButtonElement>('[data-db-wizard-next]'), back = root.querySelector<HTMLButtonElement>('[data-db-wizard-back]'), generate = root.querySelector<HTMLButtonElement>('[data-db-wizard-generate]')
    const status = root.querySelector<HTMLElement>('[data-db-wizard-status]'), again = root.querySelector<HTMLButtonElement>('[data-db-wizard-again]'), anotherUser = root.querySelector<HTMLButtonElement>('[data-db-wizard-another-user]'), summary = root.querySelector<HTMLElement>('[data-db-wizard-summary]')
    if (!name || !user || !password || !next || !back || !generate || !status || !again || !anotherUser || !summary) return
    let step = 1, databaseId: string | null = null, databaseName = '', busy = false
    const show = (): void => {
      for (const pane of steps) pane.hidden = pane.dataset.dbWizardStep !== String(step)
      next.hidden = back.hidden = step === 4; back.disabled = step === 1 || busy; next.disabled = !manage || busy
      next.textContent = step === 3 ? t('Finish') : t('Next'); name.disabled = user.disabled = password.disabled = generate.disabled = !manage || busy || databaseId !== null && step === 1
      if (all) all.disabled = !manage || busy
      for (const right of rights) right.disabled = !manage || busy || all?.checked === true
    }
    const fullName = (value: string): string => username + '_' + value
    const reset = (toStep: number): void => { step = toStep; user.value = password.value = ''; password.type = 'password'; if (toStep === 1) { name.value = ''; databaseId = null; databaseName = '' } say(status, 'idle', ''); show() }
    const finish = async (): Promise<void> => {
      const role = fullName(user.value.trim()), secret = password.value, target = databaseName || fullName(name.value.trim())
      busy = true; show(); say(status, 'reading', t('Creating…'))
      try {
        if (engine === 'postgresql') {
          await transport!('POST', '/api/account/database-engines/postgresql/users', { name: role, password: secret })
          if (databaseName === '') await transport!('POST', '/api/account/database-engines/postgresql/databases', { name: target, owner: role })
        } else {
          if (databaseId === null) databaseId = String(record(record(await transport!('POST', '/api/databases', { name: target })).database).id)
          databaseName = target
          await transport!('POST', '/api/databases/users', { name: role, password: secret, databaseId, privileges: all?.checked === true ? rights.map(right => right.value) : rights.filter(right => right.checked).map(right => right.value) })
        }
        databaseName = target; password.value = ''; password.type = 'password'
        summary.textContent = t('Database {database} and user {user} are ready.', { database: target, user: role }); step = 4
        say(status, 'read', t('The grant is applied.'))
      } catch (error) { say(status, changed(error) ? 'uncertain' : 'failed', databaseName || databaseId ? t('The database exists, but the user was not finished. Check the databases page before you retry.') : t('Nothing was created. Check the names and the password.')) } finally { busy = false; show() }
    }
    next.addEventListener('click', () => {
      if (next.disabled) return
      if (step === 1) {
        const error = databaseName ? null : dbWizardNameError(name.value.trim(), username, engine)
        if (error) { say(status, 'failed', error === 'long' ? t('The name with its prefix is too long.') : t('Use lowercase letters, digits and underscores only.')); return }
      }
      if (step === 2 && (dbWizardNameError(user.value.trim(), username, engine) || password.value.length < 8)) { say(status, 'failed', t('Enter a valid user name and a password of at least 8 characters.')); return }
      if (step === 3) { if (engine !== 'postgresql' && all?.checked !== true && !rights.some(right => right.checked)) { say(status, 'failed', t('Choose at least one privilege.')); return } void finish(); return }
      step++; say(status, 'idle', ''); show()
    })
    back.addEventListener('click', () => { if (step > 1) { step--; say(status, 'idle', ''); show() } })
    generate.addEventListener('click', () => { try { password.value = generateMailboxPassword(); password.type = 'text' } catch { say(status, 'failed', t('Secure generation is unavailable. Enter a password yourself.')) } })
    all?.addEventListener('change', show)
    again.addEventListener('click', () => reset(1))
    anotherUser.addEventListener('click', () => reset(2))
    if (!manage) say(status, 'unavailable', t('The wizard is unavailable until this tool is verified on this release.'))
    show()
  })
}

export const WHM_DB_TOOLS_CLIENT_BINDING = `(()=>{const generateMailboxPassword=${generateMailboxPassword.toString()};const splitDbNames=${splitDbNames.toString()};const readAccessHostLines=${readAccessHostLines.toString()};const dbWizardNameError=${dbWizardNameError.toString()};return ${bindDbTools.toString()};})()`
