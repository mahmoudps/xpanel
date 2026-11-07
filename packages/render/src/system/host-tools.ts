import { HOST_SCRIPT_LANGUAGES, hostCommandArgv, isBackupTask } from '@xpanel/core'
import type { FrpState, HostAction, HostDaemons, HostScheduler, HostScript, HostTask, HostTaskCycle, RenderedFile } from '@xpanel/core'
import { SYSTEMD_UNIT_DIR, accountSliceName } from './slice.ts'
import { header, quoteExecArg, unitFile } from './units.ts'

export const HOST_TASK_DIR = '/etc/xpanel/tasks'
export const HOST_TASK_LOG_DIR = '/var/log/xpanel-tasks'
export const HOST_TASK_PROGRAM = '/usr/local/sbin/xpanel-host-task'
export const HOST_TASK_BACKUP_DIR = '/var/lib/xpanel/task-backups'
export const hostTaskUnit = (id: string): string => `xpanel-task-${id}.service`
export const hostTaskTimer = (id: string): string => `xpanel-task-${id}.timer`
export const hostDaemonUnit = (name: string): string => `xpanel-daemon-${name}.service`
export const FRP_BIN_DIR = '/usr/local/bin'
export const FRP_DIR = '/etc/xpanel/frp'
export const FRP_UNITS = { server: 'xpanel-frps.service', client: 'xpanel-frpc.service' } as const

export interface HostTaskStep { argv?: readonly string[]; url?: string }
/** What one run does. The program reads only this file, so a run never depends on the panel being up. */
export interface HostTaskSpec {
  id: string; name: string; steps: HostTaskStep[]; stamped: boolean; returns: HostScript['returns']; alert: boolean
  retention: { dir: string; keep: number } | null
  triggers: { id: string; name: string; match: string; value: string; target: string }[]
  /** A saved task whose target left the server: the run fails with this reason instead of guessing a path. */
  refuse: string | null
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (value: number): string => String(value).padStart(2, '0')

/** The [Timer] lines of a cycle in UTC, so a change of the server time zone never moves a task. */
export function hostTaskSchedule(task: Pick<HostTask, 'cycle' | 'every' | 'minute' | 'hour' | 'weekday' | 'day'>): string[] {
  const clock = `${two(task.hour)}:${two(task.minute)}:00 UTC`, calendar = (value: string): string[] => [`OnCalendar=${value}`]
  const cycles: Record<HostTaskCycle, () => string[]> = {
    manual: () => [],
    seconds: () => [`OnActiveSec=${task.every}s`, `OnUnitActiveSec=${task.every}s`],
    minutes: () => calendar(`*-*-* *:00/${task.every}:00 UTC`),
    hourly: () => calendar(`*-*-* *:${two(task.minute)}:00 UTC`),
    hours: () => calendar(`*-*-* 00/${task.every}:${two(task.minute)}:00 UTC`),
    daily: () => calendar(`*-*-* ${clock}`),
    days: () => calendar(`*-*-01/${task.every} ${clock}`),
    weekly: () => calendar(`${DAYS[task.weekday]} *-*-* ${clock}`),
    monthly: () => calendar(`*-*-${two(task.day)} ${clock}`),
  }
  return cycles[task.cycle]()
}

const excludes = (task: HostTask): string[] => task.exclude.split('\n').filter(Boolean).map(item => `--exclude=${item}`)
const tarSteps = (task: HostTask, directory: string, dir: string): HostTaskStep[] => [{ argv: ['/usr/bin/tar', '--create', '--zstd', `--file=${dir}/{stamp}.tar.zst`, ...excludes(task), `--directory=${directory}`, '--', '.'] }]

function taskSteps(task: HostTask, family: string, domains: ReadonlyMap<string, string>, script: (id: string) => readonly string[]): { steps: HostTaskStep[]; refuse: string | null } {
  const dir = `${HOST_TASK_BACKUP_DIR}/${task.id}`
  switch (task.type) {
    case 'command': return { steps: [{ argv: hostCommandArgv(task.command) }], refuse: null }
    case 'script': return { steps: [{ argv: script(task.scriptId) }], refuse: null }
    case 'url': return { steps: [{ url: task.target }], refuse: null }
    case 'log-rotation': return { steps: [{ argv: ['/usr/sbin/logrotate', '--force', '/etc/logrotate.d/xpanel'] }], refuse: null }
    case 'memory-release': return { steps: [{ argv: ['/usr/bin/sync'] }, { argv: ['/usr/sbin/sysctl', '-w', 'vm.drop_caches=3'] }], refuse: null }
    case 'time-sync': return { steps: [{ argv: family === 'rhel' ? ['/usr/bin/chronyc', 'makestep'] : ['/usr/bin/systemctl', 'restart', 'systemd-timesyncd.service'] }], refuse: null }
    case 'directory-backup': return { steps: tarSteps(task, task.target, dir), refuse: null }
    case 'site-backup': {
      const root = domains.get(task.target)
      return root ? { steps: tarSteps(task, root, dir), refuse: null } : { steps: [], refuse: 'site_not_found' }
    }
    case 'database-backup': return { steps: [
      { argv: ['/usr/bin/mariadb-dump', '--single-transaction', '--quick', `--result-file=${dir}/{stamp}.sql`, '--databases', task.target] },
      { argv: ['/usr/bin/zstd', '--rm', '--quiet', `${dir}/{stamp}.sql`] },
    ], refuse: null }
  }
}

const serviceFile = (id: string): RenderedFile => unitFile(`${SYSTEMD_UNIT_DIR}/${hostTaskUnit(id)}`, [
  header(`host task ${id}`), '[Unit]', `Description=xPanel host task ${id}`, '', '[Service]', 'Type=oneshot',
  `ExecStart=${HOST_TASK_PROGRAM} ${id}`, 'StandardInput=null', 'Nice=10', 'CPUWeight=50', 'IOSchedulingClass=best-effort', 'IOSchedulingPriority=7', 'TimeoutStartSec=6h',
])
const specFile = (spec: HostTaskSpec): RenderedFile => ({ path: `${HOST_TASK_DIR}/${spec.id}.json`, content: JSON.stringify(spec) + '\n', mode: 0o600, owner: 'root', group: 'root' })

/** One oneshot per task, script and hook; a timer only for an enabled task with a cycle. Nothing runs between ticks of systemd. */
export function renderHostTasks(scheduler: HostScheduler, input: { program: string; family: string; domains: ReadonlyMap<string, string> }): { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[] } {
  const units = scheduler.tasks.length + scheduler.scripts.length + scheduler.hooks.length
  if (units === 0) return { files: [], preActions: [], postActions: [] }
  const files: RenderedFile[] = [{ path: HOST_TASK_PROGRAM, content: input.program, mode: 0o755, owner: 'root', group: 'root' }]
  const postActions: HostAction[] = [{ kind: 'systemd-daemon-reload' }]
  const scriptsById = new Map(scheduler.scripts.map(item => [item.id, item]))
  const scriptPath = (id: string): string => `${HOST_TASK_DIR}/${id}.script`
  const scriptArgv = (id: string): string[] => { const item = scriptsById.get(id)!; return [HOST_SCRIPT_LANGUAGES[item.language], scriptPath(id), ...item.args.split('\n').filter(Boolean)] }
  const blank = { stamped: false, retention: null, triggers: [], alert: false, returns: 'string' as const, refuse: null }
  for (const item of scheduler.scripts) {
    files.push({ path: scriptPath(item.id), content: item.content.endsWith('\n') ? item.content : item.content + '\n', mode: 0o700, owner: 'root', group: 'root' })
    files.push(specFile({ ...blank, id: item.id, name: item.name, steps: [{ argv: scriptArgv(item.id) }], returns: item.returns }), serviceFile(item.id))
  }
  for (const hook of scheduler.hooks) files.push(specFile({ ...blank, id: hook.id, name: hook.name, steps: [{ argv: scriptArgv(hook.scriptId) }], returns: scriptsById.get(hook.scriptId)!.returns }), serviceFile(hook.id))
  for (const task of scheduler.tasks) {
    const { steps, refuse } = taskSteps(task, input.family, input.domains, scriptArgv), backup = isBackupTask(task.type)
    const triggers = scheduler.triggers.filter(item => item.taskId === task.id).map(item => ({ id: item.id, name: item.name, match: item.match, value: item.value, target: hostTaskUnit(item.targetId) }))
    files.push(specFile({ id: task.id, name: task.name, steps, stamped: backup, returns: task.type === 'script' ? scriptsById.get(task.scriptId)!.returns : 'string', alert: task.alert, retention: backup ? { dir: `${HOST_TASK_BACKUP_DIR}/${task.id}`, keep: task.keep } : null, triggers, refuse }), serviceFile(task.id))
    if (task.cycle === 'manual') continue
    const timer = hostTaskTimer(task.id)
    files.push(unitFile(`${SYSTEMD_UNIT_DIR}/${timer}`, [header(`host task schedule ${task.id}`), '[Unit]', `Description=xPanel host task schedule ${task.id}`, '', '[Timer]', ...hostTaskSchedule(task), 'AccuracySec=1s', 'Persistent=false', `Unit=${hostTaskUnit(task.id)}`, '', '[Install]', 'WantedBy=timers.target']))
    postActions.push(...task.enabled
      ? [{ kind: 'systemd', verb: 'enable', unit: timer }, { kind: 'systemd', verb: 'start', unit: timer }] as const
      : [{ kind: 'systemd', verb: 'stop', unit: timer }, { kind: 'systemd', verb: 'disable', unit: timer }] as const)
  }
  return { files, preActions: [{ kind: 'ensure-dir', path: HOST_TASK_DIR, mode: 0o700, owner: 'root', group: 'root' }], postActions }
}

/** cPanel has no supervisor and systemd already is one: a daemon is a unit with Restart=, so a killed process returns with no extra daemon in memory. */
export function renderHostDaemons(state: HostDaemons, accounts: ReadonlyMap<string, number>): { files: RenderedFile[]; postActions: HostAction[] } {
  const files: RenderedFile[] = [], postActions: HostAction[] = state.daemons.length ? [{ kind: 'systemd-daemon-reload' }] : []
  for (const daemon of state.daemons) {
    const unit = hostDaemonUnit(daemon.name), uid = accounts.get(daemon.user)
    // A removed account must not stop every generation: its daemon loses its unit, and the page shows it as not found.
    if (daemon.user !== 'root' && uid === undefined) continue
    files.push(unitFile(`${SYSTEMD_UNIT_DIR}/${unit}`, [
      header(`daemon ${daemon.name}`), '[Unit]', `Description=xPanel daemon: ${daemon.name}`, 'After=network.target', `StartLimitIntervalSec=${state.profile.windowSec}`, `StartLimitBurst=${state.profile.burst}`, '',
      '[Service]', 'Type=simple', `User=${daemon.user}`, ...(uid === undefined ? [] : [`Slice=${accountSliceName(uid)}`]), ...(daemon.directory ? [`WorkingDirectory=${quoteExecArg(daemon.directory)}`] : []),
      `ExecStart=${hostCommandArgv(daemon.command).map(quoteExecArg).join(' ')}`, 'StandardInput=null', `Restart=${daemon.restart}`, `RestartSec=${state.profile.restartSec}`, '', '[Install]', 'WantedBy=multi-user.target',
    ]))
    postActions.push(...daemon.enabled ? [{ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'start', unit }] as const : [{ kind: 'systemd', verb: 'stop', unit }, { kind: 'systemd', verb: 'disable', unit }] as const)
  }
  return { files, postActions }
}

const toml = (value: string): string => JSON.stringify(value)
const frpUnit = (unit: string, binary: string, config: string, what: string): RenderedFile => unitFile(`${SYSTEMD_UNIT_DIR}/${unit}`, [
  header(what), '[Unit]', `Description=xPanel ${what}`, 'After=network-online.target', 'Wants=network-online.target', `ConditionFileIsExecutable=${FRP_BIN_DIR}/${binary}`, 'StartLimitIntervalSec=0', '',
  '[Service]', 'Type=simple', 'DynamicUser=yes', `ExecStart=${FRP_BIN_DIR}/${binary} -c %d/frp.toml`, 'Restart=on-failure', 'RestartSec=5', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', `LoadCredential=frp.toml:${config}`, '', '[Install]', 'WantedBy=multi-user.target',
])

/** Both sides keep their token in a root-only file; a disabled side has no file, no unit and no open port. */
export function renderFrp(state: FrpState): { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[] } {
  const files: RenderedFile[] = [], postActions: HostAction[] = []
  const add = (unit: string, binary: string, name: string, lines: string[], what: string): void => {
    const config = `${FRP_DIR}/${name}.toml`
    files.push({ path: config, content: lines.join('\n') + '\n', mode: 0o600, owner: 'root', group: 'root' }, frpUnit(unit, binary, config, what))
    postActions.push({ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'start', unit })
  }
  if (state.server.enabled) add(FRP_UNITS.server, 'frps', 'frps', [`bindPort = ${state.server.bindPort}`, 'auth.method = "token"', `auth.token = ${toml(state.server.token)}`, `allowPorts = [{ start = ${state.server.portMin}, end = ${state.server.portMax} }]`, 'log.to = "console"'], 'frp server')
  if (state.client.enabled) add(FRP_UNITS.client, 'frpc', 'frpc', [`serverAddr = ${toml(state.client.serverAddr)}`, `serverPort = ${state.client.serverPort}`, 'auth.method = "token"', `auth.token = ${toml(state.client.token)}`, 'log.to = "console"',
    ...state.client.proxies.flatMap(item => ['', '[[proxies]]', `name = ${toml(item.name)}`, 'type = "tcp"', 'localIP = "127.0.0.1"', `localPort = ${item.localPort}`, `remotePort = ${item.remotePort}`])], 'frp client')
  return { files, preActions: files.length ? [{ kind: 'ensure-dir', path: FRP_DIR, mode: 0o700, owner: 'root', group: 'root' }] : [], postActions: files.length ? [{ kind: 'systemd-daemon-reload' }, ...postActions] : [] }
}
