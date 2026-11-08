/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { secKit, SEC_CLIENT_TEMPLATE_HELPERS } from './sec-security-client.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Local alias: serialized bindings must not reference imported names (test transforms rewrite them).
const kitOf = secKit
type Ask = (options: Record<string, unknown>) => Promise<unknown>
export interface DbProfileRow { name: string; host: string; port: number; user: string; description: string; validation: { state: string; reason: string | null; version: string | null; clientHost: string | null; at: string } | null }
export interface DbProfilesView { active: string; localProfile: string; profiles: DbProfileRow[] }

/** Strict reader: a row carrying any credential field is refused before it can reach the page. */
export function readDbProfilesView(value: unknown): DbProfilesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_db_profiles_view') }
  if (!object(value) || typeof value.active !== 'string' || typeof value.localProfile !== 'string' || !Array.isArray(value.profiles)) return bad()
  const profiles = value.profiles.map((item): DbProfileRow => object(item) && !('password' in item) && typeof item.name === 'string' && typeof item.host === 'string' && typeof item.port === 'number' && typeof item.user === 'string' && typeof item.description === 'string' && (item.validation === null || object(item.validation)) ? item as unknown as DbProfileRow : bad())
  return { active: value.active, localProfile: value.localProfile, profiles }
}

function bindDbProfiles(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-db-profiles-workspace]').forEach(root => {
    if (root.dataset.dbProfilesBound === 'true') return
    root.dataset.dbProfilesBound = 'true'
    const k = kitOf(root, askDialog, displayDateTime), t = k.t
    const refresh = k.q<HTMLButtonElement>('[data-sec-action="profiles-refresh"]')
    if (!k.admitted()) { if (refresh) refresh.disabled = true; k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    if (!k.prepareTemplates()) return
    const editors = k.all<HTMLInputElement>('[data-sec-input]'), save = k.q<HTMLButtonElement>('[data-sec-action="profile-save"]')
    let view: DbProfilesView | null = null
    k.controls.push(() => {
      const open = k.manageable() && !k.isBusy() && !!view
      for (const control of editors) control.disabled = !open
      if (save) save.disabled = !open
      if (refresh) refresh.disabled = k.isBusy()
    })
    const reasons: Record<string, string> = { unreachable: t('The server could not be reached'), access_denied: t('The server refused the user or password'), tls_failed: t('The TLS connection failed'), tls_not_negotiated: t('The server did not use TLS'), not_mariadb: t('The server is not MariaDB'), insufficient_privileges: t('The user lacks all privileges with grant option'), failed: t('The check failed') }
    const checkText = (row: DbProfileRow): string => !row.validation ? t('Not validated') : row.validation.state === 'passed' ? t('Passed: {version}', { version: row.validation.version ?? '-' }) : reasons[row.validation.reason ?? 'failed'] ?? t('The check failed')
    const paint = (next: DbProfilesView): void => {
      view = next
      const active = next.active === next.localProfile ? t('This server') : next.active
      k.field('profile-active', active, 'good')
      const local = [k.technical(next.localProfile), k.technical(t('This server')), '-', next.active === next.localProfile ? t('Active') : t('Saved'), '-', k.group(k.actionButton(t('Activate'), t('Activate {name}', { name: next.localProfile }), () => void activate(next.localProfile), !k.manageable() || next.active === next.localProfile))]
      k.rows('profiles', [local, ...next.profiles.map(row => [k.technical(row.name), k.technical(row.host + ':' + row.port), k.technical(row.user), next.active === row.name ? t('Active') : t('Saved'), checkText(row),
        k.group(
          k.actionButton(t('Validate'), t('Validate {name}', { name: row.name }), () => void act(row.name, 'validate'), !k.manageable()),
          k.actionButton(t('Activate'), t('Activate {name}', { name: row.name }), () => void activate(row.name), !k.manageable() || next.active === row.name),
          k.actionButton(t('Edit'), t('Edit {name}', { name: row.name }), () => edit(row), !k.manageable() || next.active === row.name),
          k.actionButton(t('Delete'), t('Delete {name}', { name: row.name }), () => void remove(row.name), !k.manageable() || next.active === row.name))])],
      t('No profiles have been read.'), 6)
      k.note('read', t('Read from this server.'))
      k.lock()
    }
    const failureText = (error: unknown): string => {
      const details = (error as { details?: { reason?: unknown; failure?: unknown } } | null)?.details
      if (details?.reason === 'IN_USE') return t('The active profile cannot be changed or deleted. Nothing was changed.')
      if (details?.reason === 'PROFILE_HAS_DATABASES') return t('Databases are saved on the active server, and switching never moves them. Remove them first. Nothing was changed.')
      if (details?.reason === 'PROFILE_INVALID') return t('The profile did not pass validation: {reason}. The previous profile stays active.', { reason: reasons[String(details.failure)] ?? t('The check failed') })
      return k.failure(k.outcome(error))
    }
    const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readDbProfilesView(await k.send('GET', '/api/server/db-profiles'))) } catch (error) { view = null; k.note('failed', failureText(error)) } })
    const act = (name: string, verb: 'validate' | 'activate', done?: string): Promise<void> => k.guarded(async () => {
      try { paint(readDbProfilesView(await k.send('POST', '/api/server/db-profiles/' + encodeURIComponent(name) + '/' + verb, {}))); if (done) k.show('read', done) }
      catch (error) { k.show(k.outcome(error), failureText(error)); void refreshQuietly() }
    })
    const refreshQuietly = async (): Promise<void> => { try { paint(readDbProfilesView(await k.send('GET', '/api/server/db-profiles'))) } catch { /* the refusal text already stands */ } }
    const activate = async (name: string): Promise<void> => {
      if (await k.confirm({ title: t('Activate {name}?', { name }), body: t('New databases are created on that server from now on. Existing data never moves.'), danger: true, confirm: t('Activate') })) await act(name, 'activate', t('The profile is active and the new server answered.'))
    }
    const remove = async (name: string): Promise<void> => {
      if (!await k.confirm({ title: t('Delete {name}?', { name }), body: t('The saved credentials are deleted. The remote server is not changed.'), danger: true, confirm: t('Delete') })) return
      await k.guarded(async () => { try { paint(readDbProfilesView(await k.send('DELETE', '/api/server/db-profiles/' + encodeURIComponent(name)))); k.show('read', t('Profile deleted.')) } catch (error) { k.show(k.outcome(error), failureText(error)) } })
    }
    const edit = (row: DbProfileRow): void => {
      const put = (key: string, value: string): void => { const input = k.input(key); if (input) input.value = value }
      put('profile-name', row.name); put('profile-host', row.host); put('profile-port', String(row.port)); put('profile-user', row.user); put('profile-password', ''); put('profile-description', row.description)
      const name = k.input('profile-name')
      put('profile-ca', '')
      if (name) name.readOnly = true
      k.show('read', t('Editing {name}. Leave the password and the certificate empty to keep them.', { name: row.name }))
    }
    save?.addEventListener('click', () => void k.guarded(async () => {
      const value = (key: string): string => k.input(key)?.value.trim() ?? '', password = k.input('profile-password'), name = k.input('profile-name'), editing = !!name?.readOnly
      const body = { name: value('profile-name'), host: value('profile-host').toLowerCase(), port: Number(value('profile-port')), user: value('profile-user'), password: password?.value || null, description: value('profile-description'), ca: value('profile-ca') || null }
      try {
        paint(readDbProfilesView(await k.send(editing ? 'PUT' : 'POST', '/api/server/db-profiles' + (editing ? '/' + encodeURIComponent(body.name) : ''), body)))
        if (name) name.readOnly = false
        for (const key of ['profile-name', 'profile-host', 'profile-user', 'profile-password', 'profile-description', 'profile-ca']) { const input = k.input(key); if (input) input.value = '' }
        k.show('read', t('Profile saved. Validate it before you activate it.'))
      } catch (error) { k.show(k.outcome(error), failureText(error)) }
      finally { if (password) password.value = '' }
    }))
    refresh?.addEventListener('click', () => void load()); void load()
  })
}
export const WHM_DB_PROFILES_CLIENT_BINDING = `(()=>{${SEC_CLIENT_TEMPLATE_HELPERS}const displayDateTime=${DISPLAY_DATETIME_BINDING};const readDbProfilesView=${readDbProfilesView.toString()};const kitOf=${secKit.toString()};return ${bindDbProfiles.toString()};})()`
