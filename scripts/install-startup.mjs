export const INSTALL_PARTICIPANTS = Object.freeze(['xpanel-agent.service', 'xpanel-api.service'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const none = value => value === '' || value === '0'
function states(value) {
  check(Array.isArray(value) && value.length === 2, 'INSTALL_STARTUP_OBSERVATION_INVALID')
  const result = new Map()
  for (const row of value) {
    check(row && INSTALL_PARTICIPANTS.includes(row.Id) && !result.has(row.Id)
      && row.LoadState === 'loaded' && row.FragmentPath === '/etc/systemd/system/' + row.Id
      && row.DropInPaths === '' && row.NeedDaemonReload === 'no' && none(row.Job)
      && row.ControlPID === '0', 'INSTALL_STARTUP_UNIT_UNOWNED')
    if (row.ActiveState === 'active') {
      check(row.SubState === 'running' && /^[1-9][0-9]*$/.test(row.MainPID)
        && row.ControlGroup === '/system.slice/' + row.Id && /^[a-f0-9]{32}$/.test(row.InvocationID), 'INSTALL_STARTUP_PROCESS_UNVERIFIED')
    } else {
      check(['inactive', 'failed'].includes(row.ActiveState) && row.MainPID === '0'
        && (row.ControlGroup === '' || row.ControlGroup === '/system.slice/' + row.Id), 'INSTALL_STARTUP_TRANSITION_PENDING')
    }
    result.set(row.Id, row)
  }
  return result
}
/** Internal algorithm only. The live factory supplies sealed authority and fixed service ports. */
export async function ensurePreparedInstallParticipants(ports) {
  const before = states(await ports.observe())
  const preserved = INSTALL_PARTICIPANTS.filter(unit => before.get(unit).ActiveState === 'active')
  const missing = INSTALL_PARTICIPANTS.filter(unit => before.get(unit).ActiveState !== 'active')
  const started = []
  if (missing.length) {
    await ports.withStartAuthority(async () => {
      await ports.current()
      let current = states(await ports.observe())
      for (const unit of INSTALL_PARTICIPANTS) {
        if (current.get(unit).ActiveState === 'active') continue
        await ports.current()
        await ports.recordIntent(unit)
        await ports.current()
        await ports.start(unit)
        await ports.current()
        current = states(await ports.observe())
        check(current.get(unit).ActiveState === 'active', 'INSTALL_STARTUP_NOT_RUNNING')
        started.push(unit)
        await ports.recordObserved(unit, current.get(unit))
      }
    })
  }
  return Object.freeze({ started: Object.freeze(started), preserved: Object.freeze(preserved), requiresSettling: missing.length > 0 })
}

/** Runs only in the subsequent normal fresh SH, after startup admission and children retire. */
export async function settlePreparedInstallReadiness(ports) {
  const deadline = ports.clock.now().getTime() + 30_000
  while (true) {
    await ports.current()
    check(ports.clock.now().getTime() < deadline, 'INSTALL_STARTUP_READINESS_UNVERIFIED')
    try {
      const observation = await ports.ready()
      await ports.current()
      check(ports.clock.now().getTime() < deadline, 'INSTALL_STARTUP_DEADLINE')
      return observation
    } catch (error) {
      if (ports.clock.now().getTime() >= deadline) fail('INSTALL_STARTUP_READINESS_UNVERIFIED')
      await ports.current()
      check(ports.clock.now().getTime() < deadline, 'INSTALL_STARTUP_READINESS_UNVERIFIED')
      await ports.delay(Math.min(100, deadline - ports.clock.now().getTime()))
    }
  }
}

export const REQUIRED_INSTALL_STARTUP_SOURCES = Object.freeze([
  'scripts/install-finalization.mjs','scripts/install-finalization-native.mjs',
  'scripts/install-finalization-readiness.mjs','scripts/install-startup.mjs','scripts/lifecycle-services.mjs',
])
/** Uses the authenticated report and the factory's existing trusted-file reader. */
export async function verifyPreparedInstallStartupSources(report, readInstalled) {
  const files = report?.manifest?.files
  check(Array.isArray(files) && typeof readInstalled === 'function', 'INSTALL_STARTUP_RELEASE_CONTROLS_REQUIRED')
  const required = REQUIRED_INSTALL_STARTUP_SOURCES.map(path => {
    const entries = files.filter(entry => entry?.path === path)
    check(entries.length === 1 && /^[a-f0-9]{64}$/.test(entries[0].sha256 ?? ''), 'INSTALL_STARTUP_RELEASE_CONTROLS_REQUIRED')
    return entries[0]
  })
  for (const entry of required) await readInstalled(entry.path, entry.sha256)
}
