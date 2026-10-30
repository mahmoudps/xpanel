import { VIEW_RECORD_HELPERS, cloneViewRecord as canonicalCloneViewRecord } from './workspace-view-templates.ts'
import { clientTemplate as canonicalClientTemplate, cloneClientTemplate as canonicalCloneClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot } from './client-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const clientTemplate = canonicalClientTemplate
const cloneClientTemplate = canonicalCloneClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export type AccountTeamRole = 'administrator' | 'database' | 'email' | 'web'
export type AccountTeamMember = {
  id: string; username: string; roles: AccountTeamRole[]; contactEmail: string; notes: string; expiresAt: string | null; expiryReason: string | null
  status: 'active' | 'suspended'; suspendReason: string | null; phase: 'active' | 'suspended' | 'expired'; toolCount: number
  signIn: { password: 'set' | 'not-set'; linkExpiresAt: string | null; lastLoginAt: string | null }
}
export type AccountTeamView = {
  state: 'default' | 'saved' | 'invalid'; revision: string; account: { username: string; primaryDomain: string }
  limits: { roleHolders: number; members: number; roleHoldersUsed: number }; members: AccountTeamMember[]; signIn: { available: boolean }; changed: string | null
  passwordLink: { path: string; expiresAt: string } | null
}

/** Strict reader for /api/account/team (apps/api/src/acct-team-workspace.ts view). */
export function readAccountTeamView(value: unknown): AccountTeamView {
  const bad = (): never => { throw new Error('invalid_team') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const stamp = (item: unknown): boolean => item === null || typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && [...item].length <= max
  const count = (item: unknown, max: number): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= max
  if (!object(value) || !['default', 'saved', 'invalid'].includes(value.state as string) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !object(value.account) || typeof value.account.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.account.username) || typeof value.account.primaryDomain !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(value.account.primaryDomain)
    || !object(value.limits) || !count(value.limits.roleHolders, 100) || !count(value.limits.members, 1000) || !count(value.limits.roleHoldersUsed, value.limits.roleHolders as number)
    || !object(value.signIn) || Object.keys(value.signIn).join() !== 'available' || typeof value.signIn.available !== 'boolean' || !Array.isArray(value.members) || value.members.length > (value.limits.members as number)
    || (value.state !== 'saved' && value.members.length > 0) || !(value.changed === undefined || uuid(value.changed))
    || !(value.passwordLink === undefined || value.changed !== undefined && value.signIn.available === true && object(value.passwordLink) && typeof value.passwordLink.path === 'string'
      && /^\/login\?target=xpanel#team-password=[A-Za-z0-9_-]{43}$/.test(value.passwordLink.path) && typeof value.passwordLink.expiresAt === 'string' && stamp(value.passwordLink.expiresAt))) return bad()
  const available = value.signIn.available === true
  const members = value.members.map((item): AccountTeamMember => {
    if (!object(item) || !uuid(item.id) || typeof item.username !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9_-])?$/.test(item.username) || !Array.isArray(item.roles)
      || item.roles.some(role => !['administrator', 'database', 'email', 'web'].includes(role as string)) || new Set(item.roles).size !== item.roles.length
      || typeof item.contactEmail !== 'string' || !/^[^\s@]{1,64}@[a-z0-9.-]{1,253}$/.test(item.contactEmail) || !text(item.notes, 100) || !stamp(item.expiresAt)
      || !(item.expiryReason === null || text(item.expiryReason, 100)) || (item.status !== 'active' && item.status !== 'suspended') || !(item.suspendReason === null || text(item.suspendReason, 100))
      || (item.status === 'suspended') !== (item.suspendReason !== null) || !['active', 'suspended', 'expired'].includes(item.phase as string) || (item.status === 'suspended') !== (item.phase === 'suspended') || !count(item.toolCount, 1000)) return bad()
    const signIn = item.signIn
    // Without team sign-in no credential exists, so nothing may claim a password, a link or a sign-in.
    if (!object(signIn) || (signIn.password !== 'set' && signIn.password !== 'not-set') || !stamp(signIn.linkExpiresAt) || !stamp(signIn.lastLoginAt)
      || !available && (signIn.password !== 'not-set' || signIn.linkExpiresAt !== null || signIn.lastLoginAt !== null)) return bad()
    return { id: item.id, username: item.username, roles: [...item.roles] as AccountTeamRole[], contactEmail: item.contactEmail, notes: item.notes, expiresAt: item.expiresAt as string | null, expiryReason: item.expiryReason as string | null,
      status: item.status, suspendReason: item.suspendReason as string | null, phase: item.phase as AccountTeamMember['phase'], toolCount: item.toolCount,
      signIn: { password: signIn.password, linkExpiresAt: signIn.linkExpiresAt as string | null, lastLoginAt: signIn.lastLoginAt as string | null } }
  })
  if (new Set(members.map(item => item.id)).size !== members.length || members.filter(item => item.roles.length).length !== value.limits.roleHoldersUsed) return bad()
  const link = value.passwordLink as { path: string; expiresAt: string } | undefined
  return { state: value.state as AccountTeamView['state'], revision: value.revision, account: { username: value.account.username, primaryDomain: value.account.primaryDomain }, limits: { roleHolders: value.limits.roleHolders, members: value.limits.members, roleHoldersUsed: value.limits.roleHoldersUsed }, members, signIn: { available },
    changed: value.changed === undefined ? null : value.changed as string, passwordLink: link ? { path: link.path, expiresAt: link.expiresAt } : null }
}

function bindAccountTeam(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, _rtl: boolean): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-acct-team-workspace]').forEach(root => {
    if (root.dataset.teamBound === 'true') return
    root.dataset.teamBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-acct-team-status]'), loading = one<HTMLElement>('[data-acct-team-loading]'), rows = one<HTMLElement>('[data-acct-team-rows]'), empty = one<HTMLElement>('[data-acct-team-empty]')
    const usage = one<HTMLElement>('[data-acct-team-usage]'), refresh = one<HTMLButtonElement>('[data-acct-team-refresh]'), listStatus = one<HTMLElement>('[data-acct-team-list-status]'), domain = one<HTMLElement>('[data-acct-team-domain]')
    const form = one<HTMLFormElement>('[data-acct-team-form]'), heading = one<HTMLElement>('[data-acct-team-editor-heading]'), save = one<HTMLButtonElement>('[data-acct-team-save]'), cancel = one<HTMLButtonElement>('[data-acct-team-cancel]'), saveStatus = one<HTMLElement>('[data-acct-team-save-status]')
    const signInState = one<HTMLElement>('[data-acct-team-signin-state]'), signInHelp = one<HTMLElement>('[data-acct-team-signin]'), linkBox = one<HTMLElement>('[data-acct-team-link]'), linkHeading = one<HTMLElement>('[data-acct-team-link-heading]')
    const linkUrl = one<HTMLInputElement>('[data-acct-team-link-url]'), linkExpires = one<HTMLElement>('[data-acct-team-link-expires]'), linkCopy = one<HTMLButtonElement>('[data-acct-team-link-copy]'), linkDone = one<HTMLButtonElement>('[data-acct-team-link-done]'), linkStatus = one<HTMLElement>('[data-acct-team-link-status]')
    const inputs: Record<string, HTMLInputElement> = {}
    root.querySelectorAll<HTMLInputElement>('[data-acct-team-input]').forEach(control => { inputs[control.dataset.acctTeamInput!] = control })
    const roles = Array.from(root.querySelectorAll<HTMLInputElement>('[data-acct-team-role]'))
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !loading || !rows || !empty || !usage || !refresh || !listStatus || !domain || !form || !heading || !save || !cancel || !saveStatus || roles.length !== 4 || !['username', 'contactEmail', 'notes', 'expiresAt', 'expiryReason'].every(name => inputs[name])
      || !signInState || !signInHelp || !linkBox || !linkHeading || !linkUrl || !linkExpires || !linkCopy || !linkDone || !linkStatus) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.teamCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    const controls = [...Object.values(inputs), ...roles]
    let view: AccountTeamView | null = null, editing: AccountTeamMember | null = null, busy = false

    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    try {
      for (const [name, tag, slots] of [
        ['acct-team-member', 'tr', ['username', 'roles', 'email', 'phase', 'reason', 'signin', 'expires', 'actions']],
        ['acct-team-empty', 'tr', ['message']], ['acct-team-signin', 'div', ['password', 'times']],
        ['acct-team-signin-time', 'span', ['label', 'stamp']], ['acct-team-value', 'bdi', ['value']],
        ['acct-team-action', 'button', ['label']], ['acct-team-delete', 'button', ['label']],
      ] as const) cloneClientTemplate(clientTemplate(root, name), tag, slots)
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select').forEach(control => { control.disabled = true })
      note(status, 'unavailable', t('The team cannot be read from this page.')); return
    }
    const value = (content: string): HTMLElement => cloneViewRecord(root, 'acct-team-value', 'bdi', { value: content })
    const roleLabel = (role: AccountTeamRole): string => role === 'administrator' ? t('Administrator') : role === 'database' ? t('Database') : role === 'email' ? t('Email') : t('Web')
    const phaseLabel = (phase: AccountTeamMember['phase']): string => phase === 'suspended' ? t('Suspended') : phase === 'expired' ? t('Expired') : t('Active')
    const lock = (locked: boolean): void => {
      busy = locked
      for (const control of [...controls, refresh, cancel]) control.disabled = locked || !admitted()
      inputs.username!.disabled = locked || !admitted() || editing !== null
      save.disabled = locked || !admitted() || !view || view.state === 'invalid'
      root.setAttribute('aria-busy', String(locked))
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = locked || !admitted() || (button.dataset.action !== 'edit' && typeof askDialog !== 'function') || button.dataset.inactive === 'true' })
    }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Refresh the team before trying again.')
        : failed?.status === 409 ? t('The team changed since it was read. Refresh it, then try again.')
          : failed?.status === 403 ? t('Only the signed-in account owner can manage the team, and the plan must include it.')
            : failed?.status === 412 ? t('Team sign-in is not available on this server, so no password link was created.')
            : failed?.status === 404 ? t('That team member no longer exists. Refresh the team.')
              : failed?.status === 422 ? t('The server refused these values. Up to 7 members can hold a role, and expiry must be in the future.')
                : failed?.status === 400 ? t('The server refused these values. Check the username, contact email, notes and expiry.') : fallback
    }
    const resetForm = (): void => {
      editing = null
      for (const control of Object.values(inputs)) { control.value = ''; control.removeAttribute('aria-invalid') }
      for (const role of roles) role.checked = false
      heading.textContent = t('Add team member'); save.textContent = t('Add team member'); cancel.hidden = true
      lock(busy)
    }
    const edit = (member: AccountTeamMember): void => {
      editing = member
      inputs.username!.value = member.username; inputs.contactEmail!.value = member.contactEmail; inputs.notes!.value = member.notes
      inputs.expiresAt!.value = member.expiresAt ? member.expiresAt.slice(0, 16) : ''; inputs.expiryReason!.value = member.expiryReason ?? ''
      for (const role of roles) role.checked = member.roles.includes(role.value as AccountTeamRole)
      heading.textContent = t('Edit team member'); save.textContent = t('Save changes'); cancel.hidden = false; saveStatus.hidden = true
      lock(busy); inputs.contactEmail!.focus()
    }
    // The secret leaves the page when the owner is done with it; it is never stored in the browser.
    const closeLink = (): void => { linkBox.hidden = true; linkUrl.value = ''; linkStatus.hidden = true; linkHeading.textContent = '' }
    const paintSignIn = (next: AccountTeamView): void => {
      signInState.dataset.stateChip = next.signIn.available ? 'ok' : 'unavailable'
      signInState.textContent = next.signIn.available ? t('Available') : t('Unavailable on this server')
      signInHelp.textContent = next.signIn.available
        ? t('Members sign in on the xPanel sign-in page with the name shown in the Username column. Each member sets a password through a single-use password link that you create here; you never see or choose it. Suspending or deleting a member, or removing one of their roles, signs them out.')
        : t('Team members cannot sign in yet: this server has no team sign-in identity. Members and roles you save here are kept, and nobody gains access from them. No password is asked for or stored.')
    }
    const signInCell = (member: AccountTeamMember): Node[] => {
      const box = cloneViewRecord(root, 'acct-team-signin', 'div', { password: member.signIn.password === 'set' ? t('Password set') : t('No password yet'), times: '' })
      const line = (label: string, stamp: string): void => { clientTemplateSlot(box, 'times').append(cloneViewRecord(root, 'acct-team-signin-time', 'span', { label, stamp: formatDisplayDateTime(stamp) })) }
      if (member.signIn.linkExpiresAt) line(t('Link valid until'), member.signIn.linkExpiresAt)
      if (member.signIn.lastLoginAt) line(t('Last sign-in'), member.signIn.lastLoginAt)
      return [box]
    }
    const paint = (next: AccountTeamView): void => {
      view = next
      paintSignIn(next)
      domain.textContent = '@' + next.account.primaryDomain
      usage.replaceChildren(value(`${next.limits.roleHoldersUsed} / ${next.limits.roleHolders}`))
      rows.replaceChildren(...next.members.map(member => {
        const row = cloneViewRecord(root, 'acct-team-member', 'tr', {
          username: member.username + '@' + next.account.primaryDomain, roles: member.roles.length ? member.roles.map(roleLabel).join(', ') : t('No role'),
          email: member.contactEmail, phase: phaseLabel(member.phase), reason: member.suspendReason ?? '', signin: '',
          expires: member.expiresAt ? formatDisplayDateTime(member.expiresAt) : t('Never'), actions: '',
        })
        clientTemplateSlot(row, 'phase').dataset.stateChip = member.phase === 'active' ? 'ok' : 'unavailable'
        const signin = clientTemplateSlot(row, 'signin')
        if (next.signIn.available) signin.replaceChildren(...signInCell(member)); else signin.textContent = t('Unavailable')
        const actions = clientTemplateSlot(row, 'actions')
        const button = (action: string, label: string, accessible: string): HTMLButtonElement => {
          const node = cloneViewRecord(root, action === 'delete' ? 'acct-team-delete' : 'acct-team-action', 'button', { label }) as HTMLButtonElement
          node.dataset.action = action; node.setAttribute('aria-label', accessible); node.addEventListener('click', () => void act(action, member)); actions.append(node); return node
        }
        button('edit', t('Edit'), t('Edit {username}', { username: member.username }))
        if (next.signIn.available) { const link = button('link', t('Password link'), t('Create a password link for {username}', { username: member.username })); if (member.phase !== 'active') link.dataset.inactive = 'true' }
        if (member.status === 'suspended') button('reinstate', t('Reinstate'), t('Reinstate {username}', { username: member.username }))
        else button('suspend', t('Suspend'), t('Suspend {username}', { username: member.username }))
        button('delete', t('Delete'), t('Delete {username}', { username: member.username }))
        return row
      }))
      if (!next.members.length) rows.replaceChildren(cloneViewRecord(root, 'acct-team-empty', 'tr', { message: next.state === 'invalid' ? t('The saved team file cannot be read. Nothing is shown and it cannot be changed here.') : t('No team members') }))
      empty.hidden = next.state === 'invalid' || next.members.length > 0
      note(status, next.state === 'invalid' ? 'failed' : 'ready', next.state === 'invalid' ? t('The saved team file requires review by the server administrator.') : t('{count, plural, one {{count} team member read.} other {{count} team members read.}}', { count: next.members.length }))
      if (editing && !next.members.some(member => member.id === editing!.id)) resetForm()
      lock(false)
    }
    const load = async (): Promise<void> => {
      if (!request) { note(status, 'unavailable', t('The team cannot be read from this page.')); return }
      loading.hidden = false; lock(true); note(status, 'reading', t('Reading the team...'))
      try { paint(readAccountTeamView(await request('GET', '/api/account/team'))) }
      catch (error) { view = null; rows.replaceChildren(); empty.hidden = true; signInState.dataset.stateChip = 'unavailable'; signInState.textContent = t('Not read'); note(status, 'failed', failText(error, t('The team could not be read or verified. Nothing was changed.'))); lock(false) }
      finally { loading.hidden = true }
    }
    const submitChange = async (method: string, path: string, body: Record<string, unknown>, target: HTMLElement, progress: string, done: string, fallback: string, expect: (next: AccountTeamView) => boolean): Promise<boolean> => {
      if (!request || !view) return false
      lock(true); note(target, 'reading', progress)
      try {
        const next = readAccountTeamView(await request(method, path, { ...body, expectedRevision: view.revision }))
        if (!expect(next)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next); note(target, 'ok', done); return true
      } catch (error) { note(target, 'failed', failText(error, fallback)); lock(false); return false }
    }
    const act = async (action: string, member: AccountTeamMember): Promise<void> => {
      if (busy || !admitted() || !view) return
      if (action === 'edit') { edit(member); return }
      if (typeof askDialog !== 'function') return
      const path = '/api/account/team/' + member.id
      if (action === 'link') {
        let confirmed = false
        try { confirmed = await askDialog({ title: t('Create a password link for this member?'), body: t('Any earlier link for {username} stops working. Their current password keeps working until they use the new link.', { username: member.username }), confirm: t('Create link') }) === true } catch { confirmed = false }
        if (!confirmed || !request || !view) return
        closeLink(); lock(true); note(listStatus, 'reading', t('Creating the password link...'))
        try {
          const next = readAccountTeamView(await request('POST', path + '/password-link', { expectedRevision: view.revision }))
          if (next.changed !== member.id || !next.passwordLink) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
          paint(next)
          linkHeading.textContent = t('Password link for {username}', { username: member.username + '@' + next.account.primaryDomain })
          linkUrl.value = window.location.origin + next.passwordLink.path
          linkExpires.replaceChildren(value(formatDisplayDateTime(next.passwordLink.expiresAt)))
          linkBox.hidden = false; linkUrl.focus(); linkUrl.select()
          note(listStatus, 'ok', t('The password link is ready. It is shown below only once.'))
        } catch (error) { note(listStatus, 'failed', failText(error, t('No password link was created.'))); lock(false) }
        return
      }
      if (action === 'reinstate') {
        let confirmed = false
        try { confirmed = await askDialog({ title: t('Reinstate this team member?'), body: member.username, confirm: t('Reinstate') }) === true } catch { confirmed = false }
        if (confirmed) await submitChange('POST', path + '/reinstate', {}, listStatus, t('Reinstating...'), t('The team member is active again.'), t('The team member was not reinstated.'), next => next.changed === member.id && next.members.some(item => item.id === member.id && item.status === 'active'))
        return
      }
      if (action === 'suspend') {
        let reason: unknown = null
        try { reason = await askDialog({ title: t('Suspend this team member?'), body: member.username, input: true, label: t('Reason (required, up to 100 characters)'), confirm: t('Suspend'), danger: true }) } catch { reason = null }
        if (typeof reason === 'string' && reason.trim()) await submitChange('POST', path + '/suspend', { reason: reason.trim() }, listStatus, t('Suspending...'), t('The team member is suspended.'), t('The team member was not suspended.'), next => next.members.some(item => item.id === member.id && item.status === 'suspended'))
        return
      }
      let typed: unknown = null
      try { typed = await askDialog({ title: t('Delete this team member permanently?'), body: t('Type {username} to confirm. This frees a role place and cannot be undone.', { username: member.username }), input: true, label: t('Username'), confirm: t('Delete'), danger: true }) } catch { typed = null }
      if (typeof typed !== 'string' || typed !== member.username) { if (typed !== null) note(listStatus, 'failed', t('The username did not match. Nothing was deleted.')); return }
      await submitChange('DELETE', path, { confirmUsername: typed }, listStatus, t('Deleting...'), t('The team member is deleted.'), t('The team member was not deleted.'), next => !next.members.some(item => item.id === member.id))
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !admitted() || !view) return
      const expires = inputs.expiresAt!.value, match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(expires)
      if (expires && !match) { inputs.expiresAt!.setAttribute('aria-invalid', 'true'); note(saveStatus, 'failed', t('Enter the expiry as a UTC date and time.')); return }
      const original = editing?.expiresAt ?? null, expiresAt = !expires ? null : original && original.slice(0, 16) === expires ? original : match![1] + ':' + (match![2] ?? '00') + '.000Z'
      const body = { roles: roles.filter(role => role.checked).map(role => role.value), contactEmail: inputs.contactEmail!.value.trim(), notes: inputs.notes!.value.trim(), expiresAt, expiryReason: inputs.expiryReason!.value.trim() || null }
      const target = editing
      const added = view.signIn.available ? t('The team member is added. Create a password link so they can sign in.') : t('The team member is added. They cannot sign in until team sign-in is available.')
      void submitChange(target ? 'PUT' : 'POST', '/api/account/team' + (target ? '/' + target.id : ''), target ? body : { ...body, username: inputs.username!.value.trim() }, saveStatus, t('Saving the team member...'), target ? t('The team member is saved.') : added, t('The team member was not saved.'),
        next => !!next.changed && next.members.some(item => item.id === next.changed && item.contactEmail === body.contactEmail)).then(ok => { if (ok) resetForm() })
    })
    cancel.addEventListener('click', () => { if (!busy) resetForm() })
    linkDone.addEventListener('click', closeLink)
    linkCopy.addEventListener('click', () => {
      if (!linkUrl.value) return
      const copied = (): void => note(linkStatus, 'ok', t('The link is copied.'))
      const manual = (): void => { linkUrl.focus(); linkUrl.select(); note(linkStatus, 'failed', t('Copying is not available here. Select the link and copy it yourself.')) }
      try { void navigator.clipboard.writeText(linkUrl.value).then(copied, manual) } catch { manual() }
    })
    refresh.addEventListener('click', () => { if (!busy) void load() })
    lock(false)
    if (admitted()) void load()
    else note(status, 'unavailable', t('Team management is not available for this account on this server.'))
  })
}

export const ACCOUNT_TEAM_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readAccountTeamView=${readAccountTeamView.toString()};return ${bindAccountTeam.toString()};})()`
