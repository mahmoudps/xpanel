/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Reply = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
interface Spec { columns: string[]; actions: string[]; fixed: Record<string, boolean>; single: boolean; once: boolean; editOnly: boolean; labels: Record<string, Record<string, string>> }

/** The host tool cards of both themes: every card is data, so one binding reads, lists, edits and runs them. A success shown here comes from the API reply. */
function bindWhmHostTools(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  const refusals = (): Record<string, string> => ({
    task_cycle_invalid: t('This cycle does not fit the task. A backup cannot run every N seconds, and each number has a range. Nothing was saved.'),
    task_command_invalid: t('A command is an absolute program path, then one argument per line. Nothing was saved.'),
    task_target_invalid: t('The target does not fit this task type. Nothing was saved.'),
    task_script_unknown: t('Choose a script from the library. Nothing was saved.'),
    task_name_invalid: t('A name is required. Nothing was saved.'),
    task_keep_invalid: t('Copies to keep is a number from 1 to 365. Nothing was saved.'),
    trigger_task_unknown: t('Choose existing tasks, and remove a task from its triggers before deleting it. Nothing was changed.'),
    trigger_loop: t('These triggers would start each other forever. Nothing was saved.'),
    script_content_invalid: t('The script is empty or too long. Nothing was saved.'),
    daemon_name_taken: t('Another daemon has this name. Nothing was saved.'),
    daemon_user_unknown: t('A saved daemon runs as an account that no longer exists. Fix it before saving.'),
    hosts_entry_invalid: t('An entry is an IP address and one to sixteen host names. Nothing was saved.'),
    timezone_invalid: t('This server does not know that time zone. Nothing was changed.'),
    swap_size_invalid: t('The swap size is a number of megabytes up to 65536. Nothing was changed.'),
    ram_disk_invalid: t('A RAM disk needs a unique lowercase name and a size. Nothing was changed.'),
    ram_disk_failed: t('The host refused the mount. Nothing was changed.'),
    system_user_invalid: t('A system user and a one-line password are required. Nothing was changed.'),
    system_user_refused: t('Only a regular system user outside the hosting accounts can be changed here. Nothing was changed.'),
    frp_not_installed: t('Install frp on this server first. Nothing was saved.'),
    frp_arch_unsupported: t('No reviewed frp build exists for this processor. Nothing was installed.'),
    frp_digest_mismatch: t('The downloaded frp release does not match its reviewed digest, so it was refused. Nothing was installed.'),
    frp_download_failed: t('The frp release could not be downloaded. Nothing was installed.'),
    frp_token_invalid: t('The token is too short or holds characters frp does not take. Nothing was saved.'),
    frp_port_invalid: t('Ports run from 1024 to 65535, and the tunnel range leaves out the service port. Nothing was saved.'),
    ddns_secret_invalid: t('This provider needs its credentials. Nothing was saved.'),
    ddns_hostname_invalid: t('Enter a host name that is not listed yet. Nothing was saved.'),
    log_category_invalid: t('Choose at least one log category. Nothing was deleted.'),
    host_agent_unavailable: t('No host agent is connected, so this cannot run. Nothing was changed.'),
    host_executor_unavailable: t('This server has no native host executor, so this cannot run. Nothing was changed.'),
    host_tool_limit: t('The list is full. Nothing was saved.'),
    config_test_refused: t('The configuration test refused this change. The previous setting stays saved and running.'),
  })
  const object = (value: unknown): Reply => value && typeof value === 'object' && !Array.isArray(value) ? value as Reply : {}
  const uncertain = (): string => t('The outcome is uncertain. Reload the page and review the current state before retrying; no automatic retry was sent.')
  const refusal = (error: unknown): string => {
    const value = object(error), details = object(value.details)
    if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return uncertain()
    const known = refusals()[typeof details.reason === 'string' ? details.reason : '']
    return known ?? (details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 ? t('The server refused the request. Nothing was changed; check the values and try again.') : uncertain())
  }
  const confirm = async (title: string, body: string, label: string, danger = false): Promise<boolean> => typeof askDialog === 'function' && await askDialog({ title, body, confirm: label, danger }) === true
  const stamp = (iso: unknown): string => typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '-'
  const size = (bytes: unknown): string => { const value = Number(bytes) || 0; return value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB' }
  const yes = (value: boolean): string => value ? t('Yes') : t('No')
  const results: Record<string, string> = { ok: t('Succeeded'), failed: t('Failed'), TYPE_MISMATCH: 'TYPE_MISMATCH' }
  const labels: Record<string, string> = { run: t('Run now'), edit: t('Edit'), log: t('Log'), 'clear-log': t('Clear log'), delete: t('Delete'), send: t('Send'), start: t('Start'), stop: t('Stop'), restart: t('Restart'), rotate: t('New key'), mount: t('Mount') }

  document.querySelectorAll<HTMLElement>('[data-host-tool]').forEach(root => {
    if (root.dataset.hostToolBound === 'true') return
    root.dataset.hostToolBound = 'true'
    const spec = JSON.parse(root.dataset.hostToolSpec ?? '{}') as Spec, api = root.dataset.hostToolApi ?? ''
    const status = root.querySelector<HTMLElement>('[data-host-tool-status]'), submit = root.querySelector<HTMLButtonElement>('[data-host-tool-submit]'), cancel = root.querySelector<HTMLButtonElement>('[data-host-tool-cancel]')
    const rows = root.querySelector<HTMLTableSectionElement>('[data-host-tool-rows]'), logPane = root.querySelector<HTMLElement>('[data-host-tool-log]'), reveal = root.querySelector<HTMLElement>('[data-host-tool-reveal]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-host-tool-job]')
    const controls = (): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] => Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea'))
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.setAttribute('role', state === 'failed' ? 'alert' : 'status'); status.textContent = message }
    const admitted = (): boolean => root.isConnected && typeof request === 'function' && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    const manageable = (): boolean => admitted() && root.dataset.hostToolCanManage === 'true'
    let revision: string | null = null, busy = false, editing: Reply | null = null, latest: Reply = {}
    const showWhen = (): void => {
      root.querySelectorAll<HTMLElement>('[data-host-tool-when]').forEach(wrapper => {
        const [field, values] = (wrapper.dataset.hostToolWhen ?? '').split(':'), control = controls().find(item => item.name === field)
        wrapper.hidden = !(values ?? '').split(',').includes(control?.value ?? '')
      })
    }
    const sync = (): void => {
      const open = manageable() && !busy
      for (const control of controls()) control.disabled = !open
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !open })
      if (submit) submit.hidden = spec.editOnly && !editing
      if (cancel) cancel.hidden = !editing
      root.querySelectorAll<HTMLElement>('[data-host-tool-fields]').forEach(fields => { fields.hidden = spec.editOnly && !editing })
    }
    const fieldValue = (name: string, value: unknown): void => {
      const control = controls().find(item => item.name === name)
      if (!control) return
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = value === true
      else control.value = value === null || value === undefined ? '' : String(value)
    }
    const resetForm = (): void => { editing = null; for (const control of controls()) { if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = false; else if (control instanceof HTMLSelectElement) control.selectedIndex = 0; else control.value = '' }; showWhen() }
    const body = (): Reply => {
      const out: Reply = { ...spec.fixed }
      for (const control of controls()) {
        if (control.closest('[data-host-tool-when]')?.hasAttribute('hidden')) continue
        out[control.name] = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value
      }
      return out
    }
    const pick = (list: unknown, id: unknown): string => (Array.isArray(list) ? list.find(item => object(item).id === id)?.name : null) ?? '-'
    const cell = (key: string, row: Reply): string => {
      if (key === '@last') { const run = object(object(latest.runs)[row.id]); return run.at ? `${results[String(run.result)] ?? (run.fired ? t('Fired') : t('No match'))} ${stamp(run.at)}` : t('Never') }
      if (key === '@unit') return String(object(object(latest.units)[row.id]).ActiveState ?? t('Not read'))
      if (key === '@ddns') { const item = object(object(object(latest.status).records)[row.id]); return item.ip ? `${item.ip} ${stamp(item.at)}` : item.error ? String(item.error) : t('Never') }
      if (key.startsWith('task:')) return pick(latest.tasks, row[key.slice(5)])
      if (key.startsWith('script:')) return pick(latest.scripts, row[key.slice(7)])
      if (key.startsWith('bytes:')) return size(row[key.slice(6)])
      const value = row[key]
      return typeof value === 'boolean' ? yes(value) : spec.labels[key]?.[String(value)] ?? String(value ?? '-')
    }
    const showLog = (reply: Reply): void => {
      if (!logPane) return
      const runs: Reply[] = Array.isArray(reply.runs) ? reply.runs : []
      const lines = runs.map(run => `${stamp(run.at)} ${String(run.result ?? run.outcome ?? (run.fired ? 'fired' : 'no match'))}${run.ip ? ' ' + String(run.ip) : ''}`)
      logPane.textContent = [...lines, typeof reply.log === 'string' ? reply.log : ''].filter(Boolean).join('\n') || t('The log is empty.')
      logPane.hidden = false
    }
    const act = async (work: () => Promise<[string, string] | null>): Promise<void> => {
      if (busy) return
      busy = true; sync(); note('loading', t('Saving…'))
      try { const done = await work(); if (done) note(done[0], done[1]); else note('cancelled', t('Nothing was sent.')) }
      catch (error) { note('failed', refusal(error)) } finally { busy = false; sync() }
    }
    const outcome = (reply: Reply): string => {
      if (typeof reply.job === 'object' && reply.job) return t('The change runs as a background job.')
      if (reply.resolved === false) return t('Saved, but the name does not resolve yet. Review the latest generation.')
      if (reply.applied === false) return t('Saved, but the host did not confirm it. Review the host before retrying.')
      const state = object(reply.reconcile).status
      return reply.reconcile === null || reply.reconcile === undefined ? t('Saved.') : state === 'applied' || state === 'noop' ? t('Applied on this server.') : t('Saved, but the apply was not confirmed; review the latest generation.')
    }
    const after = async (reply: Reply): Promise<[string, string]> => {
      if (jobLink && typeof object(reply.job).id === 'string') { jobLink.href = '/whm/jobs?job=' + encodeURIComponent(String(reply.job.id)); jobLink.hidden = false }
      if (reveal && typeof reply.reveal === 'string') { reveal.textContent = reply.reveal; reveal.hidden = false }
      const message = typeof reply.reveal === 'string' ? t('Copy this command now. The key is shown only once.') : outcome(reply)
      await read(true)
      return ['saved', message]
    }
    const rowAction = (action: string, row: Reply): void => {
      const id = encodeURIComponent(String(row.id)), name = String(row.name ?? row.ip ?? row.hostname ?? row.id)
      const works: Record<string, () => Promise<[string, string] | null>> = {
        run: async () => { await request!('POST', `${api}/${id}/run`, {}); await read(true); return ['saved', t('Started. Its output goes to the log.')] },
        toggle: () => after0('PUT', `${api}/${id}`, { ...row, enabled: !row.enabled, expectedRevision: revision }),
        log: async () => { showLog(object(await request!('GET', `${api}/${id}/log`))); return ['read', t('The log is shown below.')] },
        'clear-log': async () => { if (!await confirm(t('Clear this log?'), t('The output and run records of {name} are deleted.', { name }), t('Clear log'), true)) return null; await request!('DELETE', `${api}/${id}/log`, {}); if (logPane) logPane.hidden = true; return ['saved', t('The log is cleared.')] },
        delete: async () => { if (!await confirm(t('Delete this item?'), t('{name} is removed from this server. Backup copies stay on disk.', { name }), t('Delete'), true)) return null; return after0('DELETE', `${api}/${id}`, { expectedRevision: revision }) },
        send: async () => {
          const detail = { text: String(row.content), sent: false }
          root.dispatchEvent(new CustomEvent('xpanel:terminal-input', { bubbles: true, detail }))
          return detail.sent ? ['saved', t('Sent to the open session.')] : ['failed', t('Open a terminal session first. Nothing was sent.')]
        },
        rotate: async () => { if (!await confirm(t('Issue a new key?'), t('The current URL of {name} stops working at once.', { name }), t('New key'), true)) return null; return after0('POST', `${api}/${id}/rotate`, { expectedRevision: revision }) },
        mount: () => after0('POST', `${api}/${id}`, { expectedRevision: revision }),
      }
      if (action === 'edit') { resetForm(); editing = row; for (const key of Object.keys(row)) fieldValue(key, row[key]); showWhen(); sync(); root.querySelector<HTMLElement>('input,select,textarea')?.focus(); note('ready', t('Editing {name}. Save or cancel below.', { name })); return }
      void act(works[action] ?? (async () => { await request!('POST', `${api}/${id}/${action}`, {}); await read(true); return ['saved', t('Done.')] }))
    }
    const after0 = async (method: string, path: string, payload: Reply): Promise<[string, string]> => { const reply = object(await request!(method, path, payload)); resetForm(); return after(reply) }
    const button = (label: string, action: string, row: Reply, danger: boolean): HTMLButtonElement => {
      const item = document.createElement('button')
      item.type = 'button'; item.className = (root.closest('.v2-host-tools') ? 'v2-btn' : 'xp-btn') + (danger ? (root.closest('.v2-host-tools') ? ' v2-btn--danger' : ' xp-btn--danger') : ''); item.textContent = label; item.disabled = !manageable()
      item.addEventListener('click', () => rowAction(action, row))
      return item
    }
    const fill = (): void => {
      root.querySelectorAll<HTMLSelectElement>('select[data-host-tool-from]').forEach(select => {
        const list: Reply[] = Array.isArray(latest[select.dataset.hostToolFrom ?? '']) ? latest[select.dataset.hostToolFrom ?? ''] : [], chosen = select.value
        select.replaceChildren(...list.map(item => { const option = document.createElement('option'); option.value = String(item.id); option.textContent = String(item.name); return option }))
        select.value = chosen
      })
      root.querySelectorAll<HTMLElement>('[data-host-tool-fact]').forEach(fact => { const value = latest[fact.dataset.hostToolFact ?? '']; fact.textContent = typeof value === 'boolean' ? yes(value) : value === null || value === undefined ? t('Not read') : String(value) })
      if (rows) {
        const list: Reply[] = (Array.isArray(latest.rows) ? latest.rows as Reply[] : []).filter(row => Object.entries(spec.fixed).every(([key, value]) => row[key] === value))
        rows.replaceChildren(...list.map(row => {
          const tr = document.createElement('tr')
          for (const key of spec.columns) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.textContent = cell(key, row); td.append(bdi); tr.append(td) }
          if (spec.actions.length) {
            const td = document.createElement('td'), group = document.createElement('div')
            group.setAttribute('data-host-tool-row-actions', '')
            for (const action of spec.actions) group.append(button(action === 'toggle' ? (row.enabled ? t('Disable') : t('Enable')) : labels[action] ?? action, action, row, action === 'delete'))
            td.append(group); tr.append(td)
          }
          return tr
        }))
        if (!list.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = spec.columns.length + (spec.actions.length ? 1 : 0); td.textContent = t('Nothing is saved here yet.'); tr.append(td); rows.replaceChildren(tr) }
      }
      if (typeof latest.log === 'string' && logPane && !spec.actions.includes('log')) { logPane.textContent = latest.log || t('No events have been recorded.'); logPane.hidden = false }
    }
    const read = async (quiet = false): Promise<void> => {
      if (!api) { note('read', t('Ready.')); return }
      if (!admitted()) { note('unavailable', t('This tool requires root authorization and a connected session. Nothing was read or changed.')); return }
      if (spec.once && !rows) { note('ready', t('Ready.')); sync(); return }
      if (!quiet) { busy = true; sync(); note('loading', t('Reading…')) }
      try {
        latest = object(await request!('GET', api))
        if (typeof latest.revision === 'string') revision = latest.revision
        fill()
        if (spec.single) for (const control of controls()) fieldValue(control.name, control instanceof HTMLInputElement && control.type === 'password' ? '' : latest[control.name])
        showWhen()
        if (!quiet) note('read', t('Saved values are shown.'))
      } catch (error) { note('failed', refusal(error)) } finally { if (!quiet) { busy = false; sync() } }
    }
    const save = (): Promise<[string, string] | null> => {
      const payload = body()
      if (spec.once) return (async (): Promise<[string, string] | null> => {
        if (!await confirm(t('Run this now?'), t('This acts on the server at once.'), t('Continue'), true)) return null
        const reply = object(await request!('POST', api, payload))
        resetForm(); await read(true)
        return typeof reply.freedBytes === 'number' ? [reply.failed ? 'uncertain' : 'saved', t('{size} freed, {count} files handled, {failed} failed.', { size: size(reply.freedBytes), count: Number(reply.removed ?? 0), failed: Number(reply.failed ?? 0) })] : ['saved', t('Done.')]
      })()
      return after0(spec.single || editing ? 'PUT' : 'POST', editing ? `${api}/${encodeURIComponent(String(editing.id))}` : api, { ...payload, expectedRevision: revision })
    }
    submit?.addEventListener('click', () => { void act(save) })
    cancel?.addEventListener('click', () => { resetForm(); sync(); note('read', t('Nothing was sent.')) })
    root.querySelectorAll<HTMLButtonElement>('[data-host-tool-tool]').forEach(tool => tool.addEventListener('click', () => { void act(async () => {
      const reply = object(await request!('POST', new URL(tool.dataset.hostToolTool ?? '', `https://x${api}/`).pathname.replace(/\/$/, ''), {}))
      await read(true)
      return ['saved', reply.status === null ? t('No records are saved.') : t('Done.')]
    }) }))
    root.addEventListener('change', event => { if ((event.target as Element).matches('select')) showWhen() })
    resetForm()
    void read()
  })
}

export const WHM_HOST_TOOLS_CLIENT_BINDING = bindWhmHostTools.toString()
