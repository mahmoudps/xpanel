/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { readSwContainerEngineView, readSwContainersView } from '../../../packages/os/src/sw-container-command.ts'
import type { SwContainerEngineView, SwContainersView } from '../../../packages/os/src/sw-container-command.ts'
export { readSwContainerEngineView, readSwContainersView }
const formatDisplayDateTime = sharedFormatDisplayDateTime

type Ask = (options: Record<string, unknown>) => Promise<unknown>
function bindSwContainers(askDialog: Ask | undefined, parseList: typeof readSwContainersView, parseEngine: typeof readSwContainerEngineView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, technical = false): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (text !== undefined) { if (technical) { const value = document.createElement('bdi'); value.dir = 'ltr'; value.textContent = text; node.append(value) } else node.textContent = text } return node }
  const engineName = (engine: string): string => engine === 'podman' ? 'Podman' : 'Docker'
  const stateLabel = (state: string): string => ({ running: t('Running'), exited: t('Exited'), created: t('Created'), paused: t('Paused'), restarting: t('Restarting'), stopped: t('Stopped'), dead: t('Dead') } as Record<string, string>)[state] ?? state
  const engineLabel = (item: { state: string; reason: string | null; version: string | null }): [string, boolean] => item.state === 'read' && item.version ? [item.version, false] : item.reason === 'engine-absent' ? [t('Not installed'), true] : item.reason === 'invalid-engine-output' ? [t('Output could not be verified'), true] : [t('Unreachable'), true]
  const empty = (body: HTMLElement, columns: number, message: string): void => { body.textContent = ''; const row = el('tr'), cell = el('td', message); cell.colSpan = columns; row.append(cell); body.append(row) }
  const unavailableText = (reason: string | null): string => reason === 'unsupported-host' ? t('Container engines cannot be read on this host. Nothing was read or changed.') : reason === 'no-engine' ? t('No Podman or Docker engine is installed. Install Podman from the software center to run containers.') : t('The container engines could not be read or their output could not be verified. No container is shown.')
  const setup = (root: HTMLElement): { status: HTMLElement; refresh: HTMLButtonElement; admitted(): boolean; note(state: string, message: string): void; facts(view: { observedAt: string; engines: { engine: string; state: string; reason: string | null; version: string | null }[] } | null): void } | null => {
    const status = root.querySelector<HTMLElement>('[data-sw-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-sw-refresh]')
    if (!status || !refresh) return null
    const admitted = (): boolean => root.isConnected && root.dataset.swCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const facts = (view: { observedAt: string; engines: { engine: string; state: string; reason: string | null; version: string | null }[] } | null): void => {
      for (const node of root.querySelectorAll<HTMLElement>('[data-sw-engine-state]')) {
        const item = view?.engines.find(engine => engine.engine === node.dataset.swEngineState)
        const [text, human] = item ? engineLabel(item) : [t('Not read'), true]
        node.textContent = text; node.toggleAttribute('data-human', human)
      }
      const observed = root.querySelector<HTMLElement>('[data-sw-observed]')
      if (observed) { observed.textContent = view ? formatDisplayDateTime(view.observedAt) : t('Not read'); observed.toggleAttribute('data-human', !view) }
    }
    return { status, refresh, admitted, note, facts }
  }

  document.querySelectorAll<HTMLElement>('[data-sw-containers]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const base = setup(root), body = root.querySelector<HTMLElement>('tbody[data-sw-containers]'), filterEngine = root.querySelector<HTMLSelectElement>('[data-sw-filter-engine]'), filterSearch = root.querySelector<HTMLInputElement>('[data-sw-filter-search]')
    const job = root.querySelector<HTMLElement>('[data-sw-job]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-sw-job-link]')
    if (!base || !body || !filterEngine || !filterSearch || !job || !jobLink) return
    const { refresh, admitted, note, facts } = base
    let busy = false, review = false, view: SwContainersView | null = null
    const manageable = (): boolean => admitted() && root.dataset.swCanManage === 'true' && view?.state === 'read' && view.actions.lifecycle && typeof askDialog === 'function' && !review
    const lock = (): void => { refresh.disabled = busy || !admitted(); filterEngine.disabled = filterSearch.disabled = !view || view.state !== 'read'; for (const button of body.querySelectorAll<HTMLButtonElement>('button[data-sw-action]')) button.disabled = busy || !manageable() || button.dataset.swAllowed !== 'true' }
    const paint = (): void => {
      facts(view)
      const rows = (view?.engines ?? []).flatMap(engine => engine.containers.map(row => ({ engine: engine.engine, revision: engine.revision!, row })))
      const wanted = filterEngine.value, term = filterSearch.value.trim().toLowerCase()
      const visible = rows.filter(item => (!wanted || item.engine === wanted) && (!term || item.row.name.toLowerCase().includes(term) || item.row.image.toLowerCase().includes(term)))
      body.textContent = ''
      for (const item of visible) {
        const tr = el('tr'), actions = el('td'), box = el('div'); box.className = 'xp-whm-detail-actions'
        tr.append(el('td', item.row.name, true), el('td', engineName(item.engine)), el('td', item.row.image, true), el('td', stateLabel(item.row.state)), el('td', item.row.status, true), el('td', item.row.ports.join(', ') || t('None'), item.row.ports.length > 0))
        for (const action of ['start', 'stop', 'restart'] as const) {
          const button = el('button', action === 'start' ? t('Start') : action === 'stop' ? t('Stop') : t('Restart')); button.type = 'button'; button.className = 'xp-btn'; button.dataset.swAction = action
          button.dataset.swAllowed = String(action === 'start' ? item.row.state !== 'running' : item.row.state === 'running')
          button.setAttribute('aria-label', (action === 'start' ? t('Start container {name}', { name: item.row.name }) : action === 'stop' ? t('Stop container {name}', { name: item.row.name }) : t('Restart container {name}', { name: item.row.name })))
          button.addEventListener('click', () => { void change(item.engine, item.revision, item.row, action) })
          box.append(button)
        }
        actions.append(box); tr.append(actions); body.append(tr)
      }
      if (!visible.length) empty(body, 7, view?.state !== 'read' ? t('No containers have been read.') : rows.length ? t('No containers match the filters.') : t('The engines report no containers.'))
      lock()
    }
    const failure = (error: unknown, change: boolean): void => {
      const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
      const code = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
      if (change && !(detail && detail.stateChanged === false)) { review = true; note('uncertain', t('The submission outcome is unknown. Check the jobs page before trying again; actions stay locked until you read containers again.')); return }
      note('failed', code === 409 ? t('Containers changed since they were read. Read them again before changing a container.') : code === 412 ? t('The change is unavailable on this host right now. Nothing was changed.') : t('The request failed. Nothing was changed.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading container engines…'))
      try {
        const next = parseList(await transport!('GET', '/api/server/software/containers'))
        if (!admitted()) return
        view = next; review = false
        note(view.state === 'read' ? 'read' : 'unavailable', view.state === 'read' ? t('Containers read from the engines. Changes run as host jobs that re-read the engine before they succeed.') + (view.actions.lifecycle ? '' : ' ' + t('Changes are unavailable: the host job runner is not connected.')) : unavailableText(view.reason))
      } catch (error) { if (admitted()) { view = null; failure(error, false) } }
      finally { busy = false; paint() }
    }
    const change = async (engine: string, revision: string, row: SwContainersView['engines'][number]['containers'][number], action: 'start' | 'stop' | 'restart'): Promise<void> => {
      if (busy || !manageable()) return
      busy = true; lock()
      let approved = false
      const copy = action === 'start' ? [t('Start container {name}?', { name: row.name }), t('The engine starts container {name} with its saved configuration.', { name: row.name })]
        : action === 'stop' ? [t('Stop container {name}?', { name: row.name }), t('The engine stops container {name}. Its processes get 30 seconds to exit before they are killed.', { name: row.name })]
          : [t('Restart container {name}?', { name: row.name }), t('The engine stops container {name}, waiting up to 30 seconds, and starts it again.', { name: row.name })]
      try { approved = await askDialog!({ title: copy[0], body: copy[1], danger: action !== 'start', confirm: t('Submit host job') }) === true } catch { approved = false }
      if (!approved || !manageable()) { busy = false; lock(); return }
      note('reading', t('Submitting the host job…'))
      try {
        const result = await transport!('POST', '/api/server/software/containers/action', { engine, containerId: row.id, action, expectedRevision: revision }) as { job?: { id?: unknown; kind?: unknown } }
        if (!result || typeof result.job?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'software.container.' + action) throw { details: {} }
        review = true; jobLink.href = '/whm/jobs?job=' + encodeURIComponent(result.job.id); job.hidden = false
        note('submitted', t('Host job submitted. The container list is unchanged here until you read it again after the job finishes.'))
      } catch (error) { failure(error, true) }
      finally { busy = false; lock() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Container reads are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    filterEngine.addEventListener('change', paint); filterSearch.addEventListener('input', paint)
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-sw-container-engine]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const base = setup(root)
    const bodies = Object.fromEntries(['facts', 'images', 'registries', 'networks', 'volumes'].map(key => [key, root.querySelector<HTMLElement>('tbody[data-sw-' + key + ']')]))
    if (!base || Object.values(bodies).some(node => !node)) return
    const { refresh, admitted, note, facts } = base
    let busy = false
    const fill = (key: string, columns: number, rows: { text: string; technical: boolean }[][], message: string): void => {
      const body = bodies[key]!; body.textContent = ''
      for (const cells of rows) { const tr = el('tr'); for (const cell of cells) tr.append(el('td', cell.text, cell.technical)); body.append(tr) }
      if (!rows.length) empty(body, columns, message)
    }
    const paint = (view: SwContainerEngineView | null): void => {
      facts(view)
      const read = (view?.engines ?? []).filter(engine => engine.state === 'read')
      const yes = (value: boolean | null): string => value === null ? t('Not read') : value ? t('Yes') : t('No')
      const tech = (text: string | null): { text: string; technical: boolean } => text === null ? { text: t('Not read'), technical: false } : { text, technical: true }
      fill('facts', 5, read.map(engine => [{ text: engineName(engine.engine), technical: false }, tech(engine.facts!.runtime), tech(engine.facts!.storageDriver), tech(engine.facts!.cgroupVersion), { text: yes(engine.facts!.rootless), technical: false }]), view ? t('No engine facts were returned.') : t('No engine facts have been read.'))
      fill('images', 4, read.flatMap(engine => engine.images.map(image => [tech(image.id.slice(0, 12)), image.tags.length ? tech(image.tags.join(', ')) : { text: t('Untagged'), technical: false }, tech(image.size), { text: engineName(engine.engine), technical: false }])), view ? t('The engines report no images.') : t('No images have been read.'))
      fill('registries', 2, read.flatMap(engine => engine.facts!.registries.map(registry => [tech(registry), { text: engineName(engine.engine), technical: false }])), view ? t('The engines report no configured registries.') : t('No registries have been read.'))
      fill('networks', 4, read.flatMap(engine => engine.networks.map(network => [tech(network.name), tech(network.driver), tech(network.id.slice(0, 12)), { text: engineName(engine.engine), technical: false }])), view ? t('The engines report no networks.') : t('No networks have been read.'))
      fill('volumes', 3, read.flatMap(engine => engine.volumes.map(volume => [tech(volume.name), tech(volume.driver), { text: engineName(engine.engine), technical: false }])), view ? t('The engines report no volumes.') : t('No volumes have been read.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; note('reading', t('Reading the container engine…'))
      try {
        const view = parseEngine(await transport!('GET', '/api/server/software/containers/engine'))
        if (!admitted()) return
        paint(view)
        note(view.state === 'read' ? 'read' : 'unavailable', view.state === 'read' ? t('Engine facts, images, registries, networks and volumes read. All engine changes are unavailable here.') : unavailableText(view.reason))
      } catch { if (admitted()) { paint(null); note('failed', t('The container engine could not be verified. Read again; nothing was changed.')) } }
      finally { busy = false; refresh.disabled = !admitted() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Container reads are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}

export const SW_CONTAINERS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parseList=${readSwContainersView.toString()};const parseEngine=${readSwContainerEngineView.toString()};const bind=${bindSwContainers.toString()};return (ask)=>bind(ask,parseList,parseEngine);})()`
