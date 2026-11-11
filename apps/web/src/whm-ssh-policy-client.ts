/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'

/** SSH sign-in, daemon and alarm controls, the firewall switch and ping block, and the shell jail. The host answers decide what is shown. */
function bindWhmSshPolicy(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (typeof transport !== 'function') return
  const request = transport
  const reason = (error: unknown): string => {
    const detail = object(error) && object(error.details) ? error.details : object(error) && object(error.detail) ? error.detail : {}
    const texts: Record<string, string> = {
      root_has_no_key: t('Root has no authorized key. Add a key first, or root would be locked out.'),
      root_has_no_password: t('Root has no usable password. Set one first, or root would be locked out.'),
      no_other_administrator: t('No other administrator can sign in. Keep root sign-in on, or add a sudo user first.'),
      port_in_use: t('Another service listens on that port.'), port_unread: t('The listening ports could not be read, so the port was not changed.'),
      port_not_answering: t('sshd did not answer on the new port. The previous port stays in use.'), old_port_open: t('The old port could not be closed. Both ports stay open until the change is retried.'),
      selinux_port_refused: t('SELinux refused the new SSH port.'), no_notification_channel: t('Add a notification recipient or webhook first.'),
    }
    const known = typeof detail.reason === 'string' ? texts[detail.reason] : undefined
    return known ?? (object(error) && typeof error.message === 'string' ? error.message : t('The request failed.'))
  }
  const say = (node: HTMLElement | null, state: string, text: string): void => { if (node) { node.dataset.state = state; node.textContent = text; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') } }
  const ask = async (title: string, body: string, danger: boolean): Promise<boolean> => { if (!askDialog) return false; try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } }

  document.querySelectorAll<HTMLElement>('[data-whm-ssh-policy]').forEach(panel => {
    if (panel.dataset.bound === 'true') return
    panel.dataset.bound = 'true'
    const scope = panel.closest<HTMLElement>('[data-whm-detail-route]') ?? document.body
    const port = panel.querySelector<HTMLInputElement>('[data-whm-ssh-port]'), auth = panel.querySelector<HTMLSelectElement>('[data-whm-ssh-auth]'), rootLogin = panel.querySelector<HTMLSelectElement>('[data-whm-ssh-root]')
    const apply = panel.querySelector<HTMLButtonElement>('[data-whm-ssh-apply]'), status = panel.querySelector<HTMLElement>('[data-whm-ssh-policy-status]')
    const start = scope.querySelector<HTMLButtonElement>('[data-whm-ssh-start]'), stop = scope.querySelector<HTMLButtonElement>('[data-whm-ssh-stop]'), serviceStatus = scope.querySelector<HTMLElement>('[data-whm-ssh-service-status]')
    const alarm = scope.querySelector<HTMLInputElement>('[data-whm-ssh-alarm]'), alarmStatus = scope.querySelector<HTMLElement>('[data-whm-ssh-alarm-status]')
    if (!port || !auth || !rootLogin || !apply || !start || !stop || !alarm) return
    const manage = panel.dataset.whmSshCanManage === 'true'
    let revision: string | null = null, channels: string[] = [], busy = false, active: string | null = null
    const fact = (key: string, value: string): void => { scope.querySelectorAll<HTMLElement>('[data-whm-ssh-fact]').forEach(cell => {
      if (cell.dataset.whmSshFact !== key) return
      cell.textContent = value
      // A v2 tile styles a count as a number and a word as text, as it does when rendered.
      const tile = cell.parentElement; if (tile?.classList.contains('v2-kpi__value')) tile.classList.toggle('v2-kpi__value--text', !/\d/.test(value))
    }) }
    const counted = (value: unknown): string => object(value) && typeof value.accepted === 'number' ? String(value.accepted) : t('Not read')
    const failed = (value: unknown): string => object(value) && typeof value.failed === 'number' ? String(value.failed) : t('Not read')
    const partial = (value: unknown): string => object(value) && value.complete === false ? ' +' : ''
    const lock = (): void => {
      const open = manage && !busy && revision !== null
      for (const control of [port, auth, rootLogin, apply, alarm]) control.disabled = !open
      start.disabled = !open || active === 'active'; stop.disabled = !open || active !== 'active'
    }
    const paint = (value: unknown): void => {
      if (!object(value) || !object(value.settings) || typeof value.settings.revision !== 'string' || !Number.isSafeInteger(value.settings.port)) throw new Error('invalid_ssh_view')
      const saved = value.settings
      revision = saved.revision as string
      port.value = String(saved.port)
      auth.value = saved.passwordAuth === true ? saved.pubkeyAuth === true ? 'both' : 'password' : 'keys'
      rootLogin.value = String(saved.rootLogin)
      alarm.checked = saved.loginAlarm === true
      channels = Array.isArray(value.alarmChannels) ? value.alarmChannels.filter(item => typeof item === 'string') : []
      say(alarmStatus, 'read', saved.loginAlarm === true ? t('Alerts go to the notification channels: {channels}', { channels: channels.join(', ') || t('none') }) : channels.length ? t('The alarm is off.') : t('Add a notification recipient or webhook first.'))
      const host = object(value.host) ? value.host : null, service = host && object(host.service) ? host.service : null
      const openSessions = host && object(host.openSessions) ? host.openSessions : null
      active = service && typeof service.active === 'string' ? service.active : null
      fact('active', active ?? t('Not read'))
      fact('enabled', service && typeof service.enabled === 'string' ? service.enabled : t('Not read'))
      fact('open-sessions', openSessions?.state === 'read' && typeof openSessions.count === 'number' ? String(openSessions.count) : openSessions?.state === 'unavailable' ? t('Unavailable') : t('Not read'))
      fact('today-accepted', counted(host?.today) + partial(host?.today)); fact('today-failed', failed(host?.today) + partial(host?.today))
      fact('total-accepted', counted(host?.total) + partial(host?.total)); fact('total-failed', failed(host?.total) + partial(host?.total))
      say(status, 'read', typeof saved.previousPort === 'number' ? t('The previous port {port} is still open. Apply again to finish the change.', { port: String(saved.previousPort) }) : t('Sign-in settings read.'))
    }
    const reload = async (): Promise<void> => { paint(await request('GET', '/api/server/ssh')); lock() }
    const run = async (note: HTMLElement | null, work: () => Promise<string>): Promise<void> => {
      if (busy) return
      busy = true; lock(); say(note, 'reading', t('Working…'))
      try { const done = await work(); await reload(); say(note, 'stored', done) }
      catch (error) { try { await reload() } catch { /* the last read stays on screen */ } say(note, 'failed', reason(error)) }
      finally { busy = false; lock() }
    }
    apply.addEventListener('click', () => {
      const body = { port: Number(port.value), passwordAuth: auth.value !== 'keys', pubkeyAuth: auth.value !== 'password', rootLogin: rootLogin.value, expectedRevision: revision }
      void (async () => {
        if (auth.value !== 'keys' && !await ask(t('Allow password sign-in?'), t('Every user may then sign in with a password. Keep the auto-ban rule on.'), true)) return
        await run(status, async () => { const result = await request('PUT', '/api/server/ssh', body); return object(result) && object(result.application) && result.application.changed === false ? t('Nothing to change.') : t('sshd was tested and reloaded. Open sessions stay connected.') })
      })()
    })
    const service = (action: 'start' | 'stop'): void => { void (async () => {
      if (action === 'stop' && !await ask(t('Stop the SSH service?'), t('New SSH connections are refused until you start it here or the server boots. Open sessions and this panel stay up.'), true)) return
      await run(serviceStatus, async () => { const result = await request('POST', '/api/server/ssh/service', { action }); return object(result) && result.verified === true ? action === 'stop' ? t('SSH is stopped: the port refuses connections.') : t('SSH is running: the port answers.') : t('The service command ran, but the port did not behave as expected. Check the service.') })
    })() }
    start.addEventListener('click', () => service('start')); stop.addEventListener('click', () => service('stop'))
    alarm.addEventListener('change', () => { void run(alarmStatus, async () => { await request('PUT', '/api/server/ssh/login-alarm', { enabled: alarm.checked }); return alarm.checked ? t('The alarm is on.') : t('The alarm is off.') }) })
    void reload().catch(error => { say(status, 'failed', reason(error)); lock() })
  })

  document.querySelectorAll<HTMLElement>('[data-whm-firewall-policy]').forEach(panel => {
    if (panel.dataset.bound === 'true') return
    panel.dataset.bound = 'true'
    const enabled = panel.querySelector<HTMLInputElement>('[data-whm-firewall-enabled]'), ping = document.querySelector<HTMLInputElement>('[data-whm-firewall-ping]'), status = panel.querySelector<HTMLElement>('[data-whm-firewall-policy-status]')
    if (!enabled || !ping) return
    const manage = panel.dataset.whmFirewallCanManage === 'true'
    let revision: string | null = null, busy = false
    const lock = (): void => { enabled.disabled = ping.disabled = !manage || busy || revision === null }
    const paint = (value: unknown): void => {
      if (!object(value) || typeof value.revision !== 'string' || typeof value.enabled !== 'boolean' || typeof value.blockPing !== 'boolean') throw new Error('invalid_firewall_view')
      revision = value.revision; enabled.checked = value.enabled; ping.checked = !value.blockPing
      say(status, 'read', value.enabled ? t('The firewall is on. Traffic that no rule allows is dropped.') : t('The firewall is off. Every port with a listening service is open, except the loopback-only backends and the database port.'))
    }
    const change = (): void => { void (async () => {
      const turningOff = !enabled.checked
      if (turningOff && !await ask(t('Turn the firewall off?'), t('Every port with a listening service becomes reachable from the internet.'), true)) { enabled.checked = true; return }
      busy = true; lock()
      try {
        const reply = await request('PUT', '/api/firewall/policy', { enabled: enabled.checked, blockPing: !ping.checked, expectedRevision: revision })
        // A second request over the new rules proves this session survived them; without it the change reverts.
        await request('GET', '/api/firewall')
        const id = object(reply) && object(reply.confirmation) ? reply.confirmation.id : null
        paint(typeof id === 'string' ? await request('POST', '/api/firewall/confirm', { id }) : reply)
      } catch (error) {
        say(status, 'failed', reason(error))
        try { paint(await request('GET', '/api/firewall')) } catch { /* the last read stays on screen */ }
      } finally { busy = false; lock() }
    })() }
    enabled.addEventListener('change', change); ping.addEventListener('change', change)
    void request('GET', '/api/firewall').then(value => { paint(value); lock() }).catch(error => say(status, 'failed', reason(error)))
  })

  document.querySelectorAll<HTMLElement>('[data-whm-isolation-policy]').forEach(panel => {
    if (panel.dataset.bound === 'true') return
    panel.dataset.bound = 'true'
    const scope = panel.closest<HTMLElement>('[data-whm-security-tools-workspace]') ?? document.body
    const switches = [...panel.querySelectorAll<HTMLInputElement>('[data-whm-isolation-switch]')], exceptions = panel.querySelector<HTMLTextAreaElement>('[data-whm-isolation-exceptions]')
    const save = panel.querySelector<HTMLButtonElement>('[data-whm-isolation-save]'), verify = panel.querySelector<HTMLButtonElement>('[data-whm-isolation-verify]'), status = panel.querySelector<HTMLElement>('[data-whm-isolation-status]'), rows = panel.querySelector<HTMLElement>('[data-whm-isolation-proof]')
    const account = scope.querySelector<HTMLSelectElement>('[data-whm-security-tools-account]')
    if (!switches.length || !exceptions || !save || !verify || !rows) return
    const manage = panel.dataset.whmIsolationCanManage === 'true'
    let revision: string | null = null, busy = false
    const lock = (): void => {
      for (const control of [...switches, exceptions, save]) control.disabled = !manage || busy || revision === null
      verify.disabled = !manage || busy || !account?.value
    }
    const paint = (value: unknown): void => {
      if (!object(value) || !object(value.policy) || typeof value.revision !== 'string' || !Array.isArray(value.policy.exceptions)) throw new Error('invalid_isolation_policy')
      const policy = value.policy
      revision = value.revision
      for (const control of switches) control.checked = policy[control.dataset.whmIsolationSwitch ?? ''] === true
      exceptions.value = (value.policy.exceptions as { username: string; reason: string }[]).map(entry => entry.username + ': ' + entry.reason).join('\n')
    }
    const parsed = (): { username: string; reason: string }[] => exceptions.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const split = line.indexOf(':'); return { username: line.slice(0, split).trim(), reason: line.slice(split + 1).trim() } })
    const proof = (checks: { id: string; state: string; expected: string | null; observed: string | null }[]): void => {
      const names: Record<string, string> = { 'jail-home-list': t('Other accounts in the home listing'), 'jail-other-home': t('Reading another account home'), 'jail-private-tmp': t('Private /tmp') }
      rows.textContent = ''
      for (const check of checks) {
        const row = document.createElement('tr')
        for (const text of [names[check.id] ?? check.id, check.expected ?? '', check.observed ?? t('Not read'), check.state === 'ok' ? t('Proved') : check.state === 'drift' ? t('Not isolated') : t('Not read')]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell) }
        rows.append(row)
      }
    }
    save.addEventListener('click', () => { void (async () => {
      busy = true; lock(); say(status, 'reading', t('Working…'))
      try {
        const body = { ...Object.fromEntries(switches.map(control => [control.dataset.whmIsolationSwitch, control.checked])), exceptions: parsed(), expectedRevision: revision }
        paint(await request('PUT', '/api/server/security-tools/isolation/policy', body))
        say(status, 'stored', t('Saved. New logins enter this view; open shells keep theirs.'))
      } catch (error) { say(status, 'failed', reason(error)) } finally { busy = false; lock() }
    })() })
    verify.addEventListener('click', () => { void (async () => {
      busy = true; lock(); say(status, 'reading', t('Working…'))
      try {
        const reply = await request('POST', '/api/server/security-tools/isolation/verify', { account: account?.value })
        if (!object(reply) || !Array.isArray(reply.checks)) throw new Error('invalid_isolation_proof')
        proof(reply.checks as never)
        say(status, 'read', t('Proof ran as {account} through its login shell.', { account: String(reply.username) }))
      } catch (error) { say(status, 'failed', reason(error)) } finally { busy = false; lock() }
    })() })
    account?.addEventListener('change', lock)
    void request('GET', '/api/server/security-tools/isolation/policy').then(value => { paint(value); say(status, 'read', t('Isolation policy read.')); lock() }).catch(error => say(status, 'failed', reason(error)))
  })
}

export const WHM_SSH_POLICY_CLIENT_BINDING = `(()=>{return ${bindWhmSshPolicy.toString()};})()`
