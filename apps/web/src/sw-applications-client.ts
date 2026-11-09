/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { readSwApplicationsView } from '../../../packages/os/src/sw-applications-command.ts'
import type { SwApplicationsClientView } from '../../../packages/os/src/sw-applications-command.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
export { readSwApplicationsView }
const formatDisplayDateTime = sharedFormatDisplayDateTime
const frameAccess = canonicalFrameAccess

type Ask = (options: Record<string, unknown>) => Promise<unknown>
function bindSwApplications(askDialog: Ask | undefined, parse: typeof readSwApplicationsView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-sw-apps]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const q = <T extends HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-sw-apps-status]'), refresh = q<HTMLButtonElement>('[data-sw-apps-refresh]'), domain = q<HTMLSelectElement>('[data-sw-apps-domain-select]'), place = q<HTMLInputElement>('[data-sw-apps-path-input]'), rows = q<HTMLElement>('[data-sw-apps-instances]'), manage = q<HTMLSelectElement>('[data-sw-apps-instance-select]'), app = q<HTMLSelectElement>('[data-sw-apps-app-select]'), version = q<HTMLSelectElement>('[data-sw-apps-version-select]'), capability = q<HTMLElement>('[data-sw-apps-capability]')
    if (!status || !refresh || !domain || !place || !rows || !manage || !app || !version || !capability) return
    const REFUSED: Record<string, string> = { application_target_not_empty: t('This directory already has files. Choose an empty directory.'), application_files_modified: t('Files of this application were changed, so it cannot be updated. Remove it or restore the files.'),
      application_artifact_missing: t('This release is not stored on this server yet. Ask your provider to upload it.'), application_recovery_required: t('A previous change needs recovery first. Use Recover.'), application_path_conflict: t('A link or file blocks this directory. Nothing was changed.'),
      application_path_invalid: t('Choose a directory under the document root.'), application_database_unavailable: t('This application needs a database and none can be created here.'), application_root_unsupported: t('This domain’s document root cannot host an application.') }
    // Reads run in a read-only frame too; jobs need the manage flag outside one.
    const access = frameAccess(root, 'data-sw-apps-can-read', 'data-sw-can-manage'), transport = access.request, readable = access.readable, admitted = access.writable
    let busy = false, locked = false, view: SwApplicationsClientView | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const fact = (key: string, text: string, human: boolean): void => { const node = q<HTMLElement>('[data-sw-apps-' + key + ']'); if (node) { node.textContent = text; node.toggleAttribute('data-human', human) } }
    const options = (select: HTMLSelectElement, placeholder: string, items: [string, string][], keep: string): void => { select.textContent = ''; const first = document.createElement('option'); first.value = ''; first.textContent = placeholder; select.append(first); for (const [value, label] of items) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option) } select.value = items.some(([value]) => value === keep) ? keep : '' }
    const allowed = (action: string): boolean => {
      const s = view?.selected, chosen = view?.catalog.applications.find(item => item.id === app.value), installed = s?.installation ?? null
      if (!admitted() || busy || locked || !s || s.state !== 'read' || (view?.catalog.state !== 'read' && !(view?.catalog.reason === 'expired' && action === 'remove')) || typeof askDialog !== 'function') return false
      if (action === 'recover') return s.recoveryRequired === true
      if (!s.writesAvailable || s.recoveryRequired) return false
      if (action === 'install') return !installed && !!chosen && chosen.versions.includes(version.value)
      if (action === 'update') return !s.modified && !!installed && chosen?.id === installed.appId && chosen.versions.includes(version.value) && version.value !== installed.version
      if (action === 'rollback') return !s.modified && !!installed?.previousVersion
      return !!installed
    }
    const lock = (): void => {
      refresh.disabled = busy || !admitted(); domain.disabled = place.disabled = busy || !admitted() || !view?.domains.length; manage.disabled = busy || !admitted() || !view?.instances.length; app.disabled = version.disabled = busy || !admitted() || view?.catalog.state !== 'read' || !view?.selected
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-sw-apps-action]')) button.disabled = !allowed(button.dataset.swAppsAction!)
    }
    const paintVersions = (): void => { const chosen = view?.catalog.applications.find(item => item.id === app.value); options(version, t('Choose a version'), (chosen?.versions ?? []).map(item => [item, item]), version.value); lock() }
    const paint = (): void => {
      const c = view?.catalog, s = view?.selected ?? null
      fact('catalog', !c ? t('Not read') : c.state === 'read' ? t('Verified signed catalog') : c.reason === 'not-configured' ? t('Not configured') : c.reason === 'expired' ? t('Expired. Installed applications can only be removed.') : t('Could not be verified'), true)
      fact('sequence', c?.sequence !== null && c?.sequence !== undefined ? String(c.sequence) : t('Not read'), !c || c.sequence === null)
      fact('expires', c?.expiresAt ? formatDisplayDateTime(c.expiresAt) : t('Not read'), !c?.expiresAt)
      rows.textContent = ''
      const nameOf = (id: string): string => c?.applications.find(item => item.id === id)?.name ?? id, where = (item: { domain: string; path: string }): string => item.path ? item.domain + '/' + item.path : item.domain
      for (const item of view?.instances ?? []) { const row = document.createElement('tr'); for (const text of [nameOf(item.appId), where(item), item.version, item.database ?? t('None'), formatDisplayDateTime(item.updatedAt)]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell) } rows.append(row) }
      if (!view?.instances.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = view ? t('No application is installed on this account.') : t('Not read'); row.append(cell); rows.append(row) }
      options(manage, t('Choose an installation'), (view?.instances ?? []).map(item => [item.domainId + '|' + item.path, nameOf(item.appId) + ' · ' + where(item)]), '')
      options(domain, view?.domains.length ? t('Choose a domain') : view ? t('No active sites') : t('Read applications first'), (view?.domains ?? []).map(item => [item.id, item.name]), s?.domainId ?? domain.value)
      options(app, t('Choose an application'), (c?.applications ?? []).map(item => [item.id, item.name]), s?.installation?.appId ?? app.value)
      const installed = s?.installation ?? null
      const name = installed ? c?.applications.find(item => item.id === installed.appId)?.name ?? installed.appId : null
      fact('installed', !s ? t('Not read') : s.state !== 'read' ? t('Unavailable') : name ?? t('None'), !s || s.state !== 'read' || !installed)
      fact('version', installed?.version ?? (s?.state === 'read' ? t('None') : t('Not read')), !installed)
      fact('previous', installed?.previousVersion ?? (s?.state === 'read' ? t('None') : t('Not read')), !installed?.previousVersion)
      fact('recovery', s?.recoveryRequired === null || !s ? t('Not read') : s.recoveryRequired ? t('Review required') : s.modified ? t('Files changed outside this tool') : t('Clean'), true)
      capability.textContent = s?.writesAvailable ? t('Changes run as verified host jobs. A failed job restores the saved recovery copy before it reports.') : s?.state === 'unavailable' && s.reason && Object.hasOwn(REFUSED, s.reason) ? REFUSED[s.reason]! : s?.reason === 'application_catalog_unavailable' || c?.state !== 'read' ? t('No verified signed catalog is available, so nothing can be installed.') : t('Writes need an admitted descriptor-confined artifact provider for account files. Until one is connected, nothing can be installed and nothing is reported as installed.')
      paintVersions()
    }
    const load = async (): Promise<void> => {
      if (busy || !readable()) return
      const selected = domain.value, directory = selected ? place.value.trim().replace(/^\/+|\/+$/g, '') : ''
      busy = true; lock(); note('reading', t('Reading applications…'))
      try {
        const next = parse(await transport!('GET', '/api/account/applications' + (selected ? '?domainId=' + encodeURIComponent(selected) + (directory ? '&path=' + encodeURIComponent(directory) : '') : '')))
        if ((next.selected?.domainId ?? '') !== selected || (next.selected?.path ?? '') !== directory) throw new Error('wrong_domain')
        if (!readable()) return
        view = next; locked = false
        const s = next.selected
        note(next.catalog.state !== 'read' ? 'unavailable' : 'read', next.catalog.state !== 'read' ? (next.catalog.reason === 'not-configured' ? t('No signed application catalog is configured on this server. Nothing can be installed.') : t('The signed application catalog could not be verified. Nothing can be installed.'))
          : !s ? t('Catalog verified. Choose a domain to see its application.') : s.state !== 'read' ? (s.reason && Object.hasOwn(REFUSED, s.reason) ? REFUSED[s.reason]! : t('This domain’s application files cannot be read: the confined artifact provider is not connected. No installation is assumed.')) : s.recoveryRequired ? t('A previous change on this domain needs recovery review. Changes are locked.') : t('Domain application state read from verified account files.'))
      } catch { if (readable()) note('failed', t('Applications could not be verified. Read again; nothing was changed.')) }
      finally { busy = false; paint() }
    }
    const submit = async (action: string): Promise<void> => {
      if (!allowed(action) || !view?.selected?.revision || !view.catalog.revision) return
      const s = view.selected
      if (action === 'recover') {
        busy = true; lock()
        let confirmed = false
        try { confirmed = await askDialog!({ title: t('Recover this application?'), body: t('The change that stopped is finished or undone from its saved recovery copy.'), confirm: t('Recover') }) === true } catch { confirmed = false }
        if (!confirmed) { busy = false; lock(); return }
        note('reading', t('Recovering…'))
        try { await transport!('POST', '/api/account/applications/recover', { domainId: s.domainId, path: s.path }); busy = false; await load(); note('read', t('Recovery finished. Check the application state.')) }
        catch { note('uncertain', t('Recovery could not be verified. Files that changed during the transaction need review.')) }
        finally { busy = false; lock() }
        return
      }
      const appId = action === 'install' || action === 'update' ? app.value : s.installation!.appId, label = view.catalog.applications.find(item => item.id === appId)?.name ?? appId
      const body: Record<string, string> = { domainId: s.domainId, path: s.path, action, appId, expectedRevision: s.revision!, expectedCatalogRevision: view.catalog.revision }
      if (action === 'install' || action === 'update') body.version = version.value
      busy = true; lock()
      let approved = false
      const title = action === 'install' ? t('Install {app} {version}?', { app: label, version: version.value }) : action === 'update' ? t('Update {app} to {version}?', { app: label, version: version.value }) : action === 'rollback' ? t('Roll back {app} to {version}?', { app: label, version: s.installation!.previousVersion ?? '' }) : t('Remove {app}?', { app: label })
      const review = action === 'remove' ? t('The application files and its generated config are removed, its database moves to the trash, and files you added stay.') : t('A recovery copy of the managed files is saved first. The job reports success only after the account files match the signed release.')
      try { approved = await askDialog!({ title, body: review, danger: action !== 'install', confirm: t('Submit job') }) === true } catch { approved = false }
      if (!approved || view?.selected !== s) { busy = false; lock(); return }
      note('reading', t('Submitting the application job…'))
      try {
        const result = await transport!('POST', '/api/account/applications/jobs', body) as { job?: { id?: unknown; kind?: unknown } }
        if (!result || typeof result.job?.id !== 'string' || result.job.kind !== 'application.' + action) throw { details: {} }
        locked = true
        note('submitted', t('Job {id} submitted. The application is shown as changed only after you read again once the job has verified the files.', { id: result.job.id }))
      } catch (error) {
        const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
        const code = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
        if (detail && detail.stateChanged === false && typeof detail.reason === 'string' && Object.hasOwn(REFUSED, detail.reason)) note('failed', REFUSED[detail.reason]!)
        else if (detail && detail.stateChanged === false) note('failed', code === 409 ? t('The domain files or the catalog changed. Read again before changing the application.') : code === 412 ? t('This change is unavailable on this server right now. Nothing was changed.') : t('The change was refused. Nothing was changed.'))
        else { locked = true; note('uncertain', t('The job outcome is unknown. Read again before retrying; changes stay locked until then.')) }
      } finally { busy = false; lock() }
    }
    if (!readable()) { refresh.disabled = true; note('unavailable', t('Applications are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() }); domain.addEventListener('change', () => { void load() }); place.addEventListener('change', () => { void load() })
    manage.addEventListener('change', () => { const split = manage.value.indexOf('|'); if (split < 0) return; domain.value = manage.value.slice(0, split); place.value = manage.value.slice(split + 1); void load() })
    app.addEventListener('change', paintVersions); version.addEventListener('change', lock)
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-sw-apps-action]')) button.addEventListener('click', () => { void submit(button.dataset.swAppsAction!) })
    void load()
  })
}
export const SW_APPLICATIONS_CLIENT_BINDING = withFrameRequest(`(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parse=${readSwApplicationsView.toString()};const bind=${bindSwApplications.toString()};return (ask)=>bind(ask,parse);})()`)
