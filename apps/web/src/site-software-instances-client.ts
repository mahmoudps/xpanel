/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
import { ISOLATE_LTR_BINDING, isolateLtr as canonicalIsolateLtr } from './display-format.ts'
// Module-local alias: the binding source declares it again from ISOLATE_LTR_BINDING.
const isolateLtr = canonicalIsolateLtr

const formatDisplayDateTime = sharedFormatDisplayDateTime
const frameAccess = canonicalFrameAccess
type Ask = (options: Record<string, unknown>) => Promise<unknown>
const CHUNK_BYTES = 512 * 1024

/** WHM Site Software: the releases stored on this server and every installed copy, with root update and uninstall as host jobs. */
function bindSiteInstances(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-site-instances]').forEach(root => {
    if (root.dataset.siteInstancesBound === 'true') return
    root.dataset.siteInstancesBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-site-instances-status]'), rows = root.querySelector<HTMLElement>('[data-site-instances-rows]'), releases = root.querySelector<HTMLElement>('[data-site-instances-releases]')
    const select = root.querySelector<HTMLSelectElement>('[data-site-instances-select]'), release = root.querySelector<HTMLSelectElement>('[data-site-instances-release-select]'), file = root.querySelector<HTMLInputElement>('[data-site-instances-file]')
    const actions = { refresh: root.querySelector<HTMLButtonElement>('[data-site-instances-action="refresh"]'), update: root.querySelector<HTMLButtonElement>('[data-site-instances-action="update"]'), remove: root.querySelector<HTMLButtonElement>('[data-site-instances-action="remove"]'), upload: root.querySelector<HTMLButtonElement>('[data-site-instances-action="upload"]') }
    if (!status || !rows || !releases || !select || !release || !file) return
    type Instance = { username: string; domainId: string; domain: string; path: string; appId: string; version: string; database: string | null; updatedAt: string; revision: string; accountStatus: string }
    type App = { id: string; name: string; versions: string[]; stored: string[] }
    let instances: Instance[] = [], apps: App[] = [], busy = false, read = false
    // Reads run in a read-only frame too; jobs and uploads need the manage flag outside one.
    const access = frameAccess(root, 'data-site-instances-can-read', 'data-site-instances-can-manage'), transport = access.request, readable = access.readable, admitted = access.writable
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const chosen = (): Instance | null => instances.find(item => item.revision === select.value) ?? null
    const newer = (a: string, b: string): boolean => { const left = a.split('.').map(Number), right = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!; return false }
    const latest = (item: Instance): string | null => { const top = apps.find(app => app.id === item.appId)?.versions[0] ?? null; return top !== null && newer(top, item.version) ? top : null }
    const lock = (): void => {
      const ready = read && admitted() && !busy, item = chosen()
      select.disabled = release.disabled = file.disabled = !ready
      if (actions.refresh) actions.refresh.disabled = busy || !admitted()
      if (actions.update) actions.update.disabled = !ready || !item || !latest(item) || item.accountStatus !== 'active'
      if (actions.remove) actions.remove.disabled = !ready || !item || item.accountStatus !== 'active'
      if (actions.upload) actions.upload.disabled = !ready || !release.value || !file.files?.length
    }
    const fill = (body: HTMLElement, data: string[][], empty: string, columns: number): void => {
      body.textContent = ''
      for (const cells of data) { const row = document.createElement('tr'); for (const content of cells) { const cell = document.createElement('td'); cell.textContent = content; row.append(cell) } body.append(row) }
      if (!data.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = empty; row.append(cell); body.append(row) }
    }
    const options = (control: HTMLSelectElement, placeholder: string, items: [string, string][]): void => {
      const keep = control.value
      control.textContent = ''
      for (const [value, label] of [['', placeholder] as [string, string], ...items]) { const option = document.createElement('option'); option.value = value; option.textContent = label; control.append(option) }
      control.value = items.some(([value]) => value === keep) ? keep : ''
    }
    const nameOf = (id: string): string => apps.find(app => app.id === id)?.name ?? id
    const place = (item: Instance): string => item.path ? item.domain + '/' + item.path : item.domain
    const paint = (): void => {
      fill(rows, instances.map(item => [item.username, place(item), nameOf(item.appId), item.version, item.database ?? t('None'), isolateLtr(formatDisplayDateTime(item.updatedAt))]), t('No application is installed on this server.'), 6)
      const pairs = apps.flatMap(app => app.versions.map(version => [app, version] as const))
      fill(releases, pairs.map(([app, version]) => [app.name, version, app.stored.includes(version) ? t('Stored') : t('Not stored')]), t('The verified catalog lists no applications.'), 3)
      options(select, t('Select an installation'), instances.map(item => [item.revision, item.username + ' · ' + place(item) + ' · ' + nameOf(item.appId)]))
      options(release, t('Select a release'), pairs.map(([app, version]) => [app.id + '|' + version, app.name + ' ' + version]))
    }
    const load = async (): Promise<void> => {
      if (busy || !readable()) return
      busy = true; lock(); note('reading', t('Reading…'))
      try {
        const [listed, catalog] = await Promise.all([transport!('GET', '/api/server/site-software/instances'), transport!('GET', '/api/server/site-software')]) as [{ instances: Instance[] }, { host: { catalog: { state: string; applications: App[] } } | null }]
        instances = listed.instances; apps = catalog.host?.catalog.state === 'read' ? catalog.host.catalog.applications : []
        read = true; paint(); note('read', t('Read from each account on this server.'))
      } catch { read = false; note('failed', t('Installed applications could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const refusal = (error: unknown): boolean => { const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null; return !!detail && detail.stateChanged === false }
    const change = async (action: 'update' | 'remove'): Promise<void> => {
      const item = chosen()
      if (!item || busy || !admitted() || typeof askDialog !== 'function') return
      const version = action === 'update' ? latest(item) : null
      busy = true; lock()
      let approved = false
      try { approved = await askDialog({ title: action === 'update' ? t('Update {app} to {version}?', { app: nameOf(item.appId), version: version ?? '' }) : t('Remove {app}?', { app: nameOf(item.appId) }), body: action === 'update' ? t('A recovery copy of the managed files is saved first. The job reports success only after the account files match the signed release.') : t('The application files and its generated config are removed, its database moves to the trash, and files the site owner added stay.'), danger: true, confirm: t('Submit job') }) === true } catch { approved = false }
      if (!approved) { busy = false; lock(); return }
      note('reading', t('Submitting the application job…'))
      try {
        const body = { username: item.username, domainId: item.domainId, path: item.path, action, expectedRecord: item.revision, ...(version ? { version } : {}) }
        const result = await transport!('POST', '/api/server/site-software/instances/jobs', body) as { job?: { id?: unknown } }
        if (typeof result?.job?.id !== 'string') throw { details: {} }
        read = false; note('submitted', t('Job {id} submitted. Read the list again after the job has verified the files.', { id: result.job.id }))
      } catch (error) { if (refusal(error)) note('failed', t('The change was refused. Nothing was changed.')); else { read = false; note('uncertain', t('The job outcome is unknown. Read again before retrying; changes stay locked until then.')) } }
      finally { busy = false; lock() }
    }
    const base64 = (bytes: Uint8Array): string => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text) }
    const upload = async (): Promise<void> => {
      const source = file.files?.[0], [appId, version] = release.value.split('|')
      if (!source || !appId || !version || busy || !admitted()) return
      busy = true; lock()
      try {
        for (let offset = 0; offset < source.size;) {
          const chunk = new Uint8Array(await source.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
          await transport!('POST', '/api/server/site-software/artifacts', { appId, version, offset, contentBase64: base64(chunk) })
          offset += chunk.length
          note('reading', t('Uploading release, {done} of {total} MiB…', { done: String(Math.ceil(offset / 1048576)), total: String(Math.ceil(source.size / 1048576)) }))
        }
        file.value = ''; busy = false; await load()
        note('read', t('The release matched its signed digest and is stored.'))
      } catch (error) { note('failed', refusal(error) ? t('The file does not match the signed release. Nothing was stored.') : t('The upload stopped. Upload the file again.')) }
      finally { busy = false; lock() }
    }
    if (!readable()) { note('unavailable', t('Installed applications are unavailable here. Nothing was read or changed.')); lock(); return }
    actions.refresh?.addEventListener('click', () => { void load() })
    actions.update?.addEventListener('click', () => { void change('update') })
    actions.remove?.addEventListener('click', () => { void change('remove') })
    actions.upload?.addEventListener('click', () => { void upload() })
    select.addEventListener('change', lock); release.addEventListener('change', lock); file.addEventListener('change', lock)
    void load()
  })
}
export const SITE_INSTANCES_CLIENT_BINDING = withFrameRequest(`(()=>{${ISOLATE_LTR_BINDING};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const CHUNK_BYTES=${CHUNK_BYTES};return ${bindSiteInstances.toString()};})()`)
