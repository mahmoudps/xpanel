/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface SwRuntimeRow { id: 'golang' | 'openjdk-17' | 'openjdk-21'; state: 'installed' | 'partial' | 'absent' | 'unavailable'; versions: string[] }
/** Reads only the Go and Java rows of the existing software center runtime view. Self-contained for serialization. */
export function readSwProjectRuntimes(value: unknown): { state: 'read' | 'unavailable'; runtimes: SwRuntimeRow[] } {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_runtime_view') }
  if (!object(value) || value.page !== 'runtime' || !['read', 'unavailable'].includes(value.state) || !Array.isArray(value.components) || value.components.length > 512) return bad()
  const runtimes: SwRuntimeRow[] = []
  for (const id of ['golang', 'openjdk-17', 'openjdk-21'] as const) {
    const item = value.components.find((row: unknown) => object(row) && row.id === id)
    if (!item) continue
    if (!['installed', 'partial', 'absent', 'unavailable'].includes(item.state) || !Array.isArray(item.installed) || item.installed.length > 16) return bad()
    const versions = item.installed.flatMap((pkg: unknown) => object(pkg) && Array.isArray(pkg.versions) && pkg.versions.length <= 8 && pkg.versions.every((v: unknown) => typeof v === 'string' && /^[A-Za-z0-9.+~:_-]{1,256}$/.test(v)) ? pkg.versions : bad())
    runtimes.push({ id, state: item.state, versions: [...new Set<string>(versions)] })
  }
  return { state: value.state, runtimes: value.state === 'read' ? runtimes : [] }
}

function bindSwProjects(parse: typeof readSwProjectRuntimes): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-sw-projects]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-sw-projects-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-sw-projects-refresh]'), body = root.querySelector<HTMLElement>('[data-sw-projects-runtimes]')
    if (!status || !refresh || !body) return
    const admitted = (): boolean => root.isConnected && root.dataset.swCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const name = (id: string): string => id === 'golang' ? 'Go' : id === 'openjdk-17' ? 'OpenJDK 17' : 'OpenJDK 21'
    const empty = (message: string): void => { body.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 3; cell.textContent = message; row.append(cell); body.append(row) }
    let busy = false
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; note('reading', t('Reading installed runtimes…'))
      try {
        const view = parse(await transport!('GET', '/api/server/software-center?page=runtime'))
        if (!admitted()) return
        body.textContent = ''
        for (const runtime of view.runtimes) {
          const row = document.createElement('tr'), label = document.createElement('td'), state = document.createElement('td'), version = document.createElement('td')
          label.textContent = name(runtime.id); state.textContent = runtime.state === 'installed' ? t('Installed') : runtime.state === 'partial' ? t('Partially installed') : runtime.state === 'absent' ? t('Not installed') : t('Unavailable on this system')
          if (runtime.versions.length) { const value = document.createElement('bdi'); value.dir = 'ltr'; value.textContent = runtime.versions.join(', '); version.append(value) } else version.textContent = t('None')
          row.append(label, state, version); body.append(row)
        }
        if (!body.childElementCount) empty(view.state === 'read' ? t('No Go or Java runtime is offered for this system.') : t('The package database could not be read. Nothing is shown as installed.'))
        note(view.state === 'read' ? 'read' : 'unavailable', view.state === 'read' ? t('Runtimes read from the package database. Projects remain unavailable until a confined service runner is connected.') : t('The package database could not be read. Nothing is shown as installed.'))
      } catch { if (admitted()) { empty(t('No runtimes have been read.')); note('failed', t('Runtimes could not be verified. Read again; nothing was changed.')) } }
      finally { busy = false; refresh.disabled = !admitted() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Runtime reads are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}
export const SW_APP_PROJECTS_CLIENT_BINDING = `(()=>{const parse=${readSwProjectRuntimes.toString()};const bind=${bindSwProjects.toString()};return ()=>bind(parse);})()`
