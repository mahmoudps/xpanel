import './i18n.ts'

const statsObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)

/** "alice analog awstats", one user per line; null when a line is not a saved-account name with known engines. */
export function parseAllowedDraft(text: string): Record<string, string[]> | null {
  const allowed: Record<string, string[]> = {}
  for (const line of text.split('\n').map(row => row.trim()).filter(Boolean)) {
    const [name, ...engines] = line.split(/\s+/)
    if (!/^[a-z][a-z0-9]{0,15}$/.test(name!) || Object.hasOwn(allowed, name!) || new Set(engines).size !== engines.length || !engines.every(engine => engine === 'analog' || engine === 'awstats' || engine === 'webalizer')) return null
    allowed[name!] = engines
  }
  return allowed
}
/** Comma-separated UTC hours; null when one is not a distinct hour or none is left free. */
export function parseHoursDraft(text: string): number[] | null {
  const hours = text.split(',').map(part => part.trim()).filter(Boolean).map(Number)
  return hours.length <= 23 && new Set(hours).size === hours.length && hours.every(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23) ? hours : null
}

function bindWebStatsMetrics(): void {
  const t = (message: string) => xpT(message)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-web-stats-metrics]').forEach(root => {
    if (root.dataset.webStatsBound === 'true') return
    root.dataset.webStatsBound = 'true'
    const save = root.querySelector<HTMLButtonElement>('[data-web-stats-metrics-save]'), status = root.querySelector<HTMLElement>('[data-web-stats-metrics-status]')
    if (!save || !status) return
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[data-web-stats-choice]')]
    const admitted = () => root.isConnected && root.dataset.webStatsEnabled === 'true' && !!request
    let revision = root.dataset.webStatsRevision ?? '', busy = false
    const draft = () => {
      const sites: Record<string, string[]> = {}
      for (const box of boxes) { const site = sites[box.dataset.site!] ??= []; if (box.checked) site.push(box.dataset.engine!) }
      return sites
    }
    let saved = JSON.stringify(draft())
    const controls = () => {
      const disabled = !admitted() || busy
      for (const box of boxes) box.disabled = disabled || box.dataset.locked === 'true'
      save.disabled = disabled || JSON.stringify(draft()) === saved
    }
    const message = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    boxes.forEach(box => box.addEventListener('change', controls))
    save.addEventListener('click', () => {
      if (!admitted() || busy) return
      const sites = draft()
      busy = true; controls(); message('loading', t('Saving the statistics engines…'))
      void request!('PUT', '/api/account/web-stats', { revision, sites }).then(reply => {
        if (!statsObject(reply) || typeof reply.revision !== 'string') throw new Error('invalid_reply')
        revision = reply.revision; saved = JSON.stringify(sites)
        message('saved', t('Saved. The next statistics run applies this choice.'))
      }).catch((error: unknown) => {
        const details = statsObject(error) && statsObject(error.details) ? error.details : {}
        message('failed', details.stateChanged === false ? t('The change was refused and nothing was saved. Reload the page before retrying.') : t('The outcome is uncertain. Reload the page and check the saved choice.'))
      }).finally(() => { busy = false; controls() })
    })
    controls()
  })
}

function bindWebStatsEngines(): void {
  const t = (message: string, values?: Record<string, string | number>) => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-web-stats-engines]').forEach(root => {
    if (root.dataset.webStatsBound === 'true') return
    root.dataset.webStatsBound = 'true'
    const controls: Record<string, HTMLInputElement> = {}
    for (const control of root.querySelectorAll<HTMLInputElement>('[data-web-stats-policy]')) controls[control.dataset.webStatsPolicy!] = control
    const save = root.querySelector<HTMLButtonElement>('[data-web-stats-save]'), run = root.querySelector<HTMLButtonElement>('[data-web-stats-process]'), user = root.querySelector<HTMLInputElement>('[data-web-stats-process-user]')
    const status = root.querySelector<HTMLElement>('[data-web-stats-status]'), summary = root.querySelector<HTMLElement>('[data-web-stats-summary]'), behind = root.querySelector<HTMLElement>('[data-web-stats-behind]')
    if (!save || !run || !user || !status || !summary || !behind) return
    let revision = '', busy = false, writable = false
    const admitted = () => root.isConnected && root.dataset.webStatsEnabled === 'true' && !!request
    const message = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    const refresh = () => {
      const disabled = !admitted() || busy || !revision
      for (const control of Object.values(controls)) control.disabled = disabled || !writable
      save.disabled = disabled || !writable; user.disabled = disabled || !writable; run.disabled = disabled || !writable || !/^[a-z][a-z0-9]{0,15}$/.test(user.value)
    }
    const when = (value: unknown) => typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') + ' UTC' : t('Not yet')
    const engine = (value: unknown, on: boolean, name: string) => (controls[name + '.available']!.checked = statsObject(value) && value.available === true, controls[name + '.byDefault']!.checked = statsObject(value) && value.byDefault === true, on)
    const fill = (raw: Record<string, unknown>) => {
      const policy = raw.policy as Record<string, unknown>, engines = policy.engines as Record<string, unknown>, host = raw.host as Record<string, unknown> | null
      revision = String(raw.revision); writable = statsObject(raw.actions) && raw.actions.save === true
      engine(engines.analog, true, 'analog'); engine(engines.awstats, true, 'awstats'); engine(engines.webalizer, true, 'webalizer')
      for (const name of ['allowInclude', 'reverseDns', 'avoidBackups']) controls[name]!.checked = policy[name] === true
      controls.users!.value = String(policy.users); controls.intervalHours!.value = String(policy.intervalHours); controls.bandwidthIntervalMinutes!.value = String(policy.bandwidthIntervalMinutes); controls.blackoutHours!.value = (policy.blackoutHours as number[]).join(', ')
      controls.allowed!.value = Object.entries(policy.allowed as Record<string, string[]>).map(([name, list]) => [name, ...list].join(' ')).join('\n')
      const metered = host && statsObject(host.bandwidth) ? host.bandwidth : null
      summary.textContent = host ? t('Last run {last}. Next run {next}.', { last: when(host.lastRunAt), next: when(host.nextRunAt) }) + (metered ? ' ' + t('Bandwidth last processed {last}.', { last: when(metered.lastCollectedAt) }) : '') : t('The statistics runs could not be read from this server.')
      const rows = host ? host.behind as { username: string; minutes: number | null; pendingBytes: number }[] : []
      behind.replaceChildren(...rows.map(row => {
        const tr = document.createElement('tr')
        for (const text of [row.username, row.minutes === null ? t('Never processed') : String(row.minutes), String(row.pendingBytes)]) { const cell = document.createElement('td'); cell.textContent = text; tr.append(cell) }
        return tr
      }))
    }
    const load = async () => {
      busy = true; refresh(); message('loading', t('Reading the statistics configuration…'))
      try {
        const raw = await request!('GET', '/api/server/web-stats')
        if (!statsObject(raw) || !statsObject(raw.policy) || typeof raw.revision !== 'string') throw new Error('invalid_reply')
        fill(raw); message(writable ? 'read' : 'unavailable', writable ? t('Saved configuration read.') : t('Saved configuration read. This tool is not verified on this server, so changes stay closed.'))
      } catch { revision = ''; message('failed', t('The statistics configuration could not be read.')) }
      finally { busy = false; refresh() }
    }
    const draft = () => {
      const allowed = parseAllowedDraft(controls.allowed!.value), blackoutHours = parseHoursDraft(controls.blackoutHours!.value), intervalHours = Number(controls.intervalHours!.value)
      if (!allowed || !blackoutHours) return null
      const engines = (name: string) => ({ available: controls[name + '.available']!.checked, byDefault: controls[name + '.byDefault']!.checked })
      return { engines: { analog: engines('analog'), awstats: engines('awstats'), webalizer: engines('webalizer') }, allowInclude: controls.allowInclude!.checked, reverseDns: controls.reverseDns!.checked, users: controls.users!.value, allowed, intervalHours, bandwidthIntervalMinutes: Number(controls.bandwidthIntervalMinutes!.value), blackoutHours, avoidBackups: controls.avoidBackups!.checked }
    }
    const refused = (error: unknown) => {
      const details = statsObject(error) && statsObject(error.details) ? error.details : {}
      message('failed', details.stateChanged === false ? t('The change was refused and nothing was saved. Check the values and reload before retrying.') : t('The outcome is uncertain. Reload the page and check the saved configuration.'))
    }
    save.addEventListener('click', () => {
      const policy = draft()
      if (!admitted() || busy) return
      if (!policy) { message('failed', t('Check the allowed users and the blackout hours.')); return }
      busy = true; refresh(); message('loading', t('Saving the statistics configuration…'))
      void request!('PUT', '/api/server/web-stats', { revision, policy }).then(reply => {
        if (!statsObject(reply) || typeof reply.revision !== 'string') throw new Error('invalid_reply')
        revision = reply.revision
        message('saved', t('Saved. The next statistics run applies this configuration.'))
      }).catch(refused).finally(() => { busy = false; refresh() })
    })
    run.addEventListener('click', () => {
      if (!admitted() || busy) return
      busy = true; refresh(); message('loading', t('Starting the statistics run…'))
      void request!('POST', '/api/server/web-stats/process', { username: user.value }).then(() => { message('saved', t('Statistics run started in the background.')) }).catch(refused).finally(() => { busy = false; refresh() })
    })
    user.addEventListener('input', refresh)
    refresh(); if (admitted()) void load()
  })
}
/** A reseller's engine locks on its accounts page; every control stays closed until the saved locks were read. */
function bindWebStatsLocks(): void {
  const t = (message: string) => xpT(message)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-web-stats-locks]').forEach(root => {
    if (root.dataset.webStatsBound === 'true') return
    root.dataset.webStatsBound = 'true'
    const save = root.querySelector<HTMLButtonElement>('[data-web-stats-locks-save]'), status = root.querySelector<HTMLElement>('[data-web-stats-locks-status]')
    const controls = [...root.querySelectorAll<HTMLSelectElement>('select[data-web-stats-lock]')]
    if (!save || !status || !request || root.dataset.webStatsEnabled !== 'true') return
    let revision = '', busy = false, writable = false, offered: string[] = []
    const message = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    const refresh = () => { for (const control of controls) control.disabled = busy || !writable || !offered.includes(control.dataset.webStatsLock!); save.disabled = busy || !writable }
    const failed = (error: unknown) => {
      const details = statsObject(error) && statsObject(error.details) ? error.details : {}
      message('failed', details.stateChanged === false ? t('The change was refused and nothing was saved. Reload the page before retrying.') : t('The outcome is uncertain. Reload the page and check the saved locks.'))
    }
    save.addEventListener('click', () => {
      if (busy) return
      const locks = Object.fromEntries(controls.filter(control => control.value).map(control => [control.dataset.webStatsLock!, control.value === 'on']))
      busy = true; refresh(); message('loading', t('Saving the statistics locks…'))
      void request('PUT', '/api/resellers/web-stats', { revision, locks }).then(reply => {
        if (!statsObject(reply) || typeof reply.revision !== 'string') throw new Error('invalid_reply')
        revision = reply.revision; message('saved', t('Saved. The next statistics run applies these locks.'))
      }).catch(failed).finally(() => { busy = false; refresh() })
    })
    busy = true; refresh(); message('loading', t('Reading the statistics locks…'))
    void request('GET', '/api/resellers/web-stats').then(raw => {
      if (!statsObject(raw) || !statsObject(raw.locks) || typeof raw.revision !== 'string' || !Array.isArray(raw.available)) throw new Error('invalid_reply')
      const locks = raw.locks
      revision = raw.revision; offered = raw.available.map(String); writable = statsObject(raw.actions) && raw.actions.save === true
      for (const control of controls) control.value = typeof locks[control.dataset.webStatsLock!] === 'boolean' ? locks[control.dataset.webStatsLock!] ? 'on' : 'off' : ''
      message(writable ? 'read' : 'unavailable', writable ? t('Saved locks read.') : t('Saved locks read. This tool is not verified on this server, so changes stay closed.'))
    }).catch(() => { message('failed', t('The statistics locks could not be read.')) }).finally(() => { busy = false; refresh() })
  })
}

export const WEB_STATS_CLIENT_BINDING = `function(){const statsObject=${statsObject.toString()};const parseAllowedDraft=${parseAllowedDraft.toString()};const parseHoursDraft=${parseHoursDraft.toString()};(${bindWebStatsMetrics.toString()})();(${bindWebStatsEngines.toString()})();(${bindWebStatsLocks.toString()})();}`
