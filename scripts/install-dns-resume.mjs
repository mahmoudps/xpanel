import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readTrustedFile, requireLinuxRoot, withTrustedDirectory } from './lifecycle-ownership.mjs'

const run = promisify(execFile)
const server = 'pdns-server'
const bind = 'pdns-backend-bind'
const version = '4.8.3-4build3'
const config = '/etc/powerdns'
const data = '/var/lib/powerdns'
const unit = '/usr/lib/systemd/system/pdns.service'
const marker = 'xpanel-pdns-vendor-pristine-v1'
// Ubuntu Noble amd64. A dpkg database entry alone cannot authorize a changed file.
const vendor = {
  [config+'/pdns.conf']: [server, 0o640, 'pdns', 20289, '3d41154e93c96acee3cf10d5eb9b28f15de5a0a76e4a7273e7632bedfee74bb3'],
  [config+'/named.conf']: [bind, 0o644, 'root', 293, '54c2d275121cded0f62f8e583c4c51f7d6c756deb8eb3114613fa5ab6aea5a2a'],
  [config+'/pdns.d/bind.conf']: [bind, 0o644, 'root', 1382, 'c71d82e082d3e9db8b0ccdaaf5ed329245cfe2c4248ed9286a2956638c0e9277'],
  [unit]: [server, 0o644, 'root', 1565, 'cd60d18e3ed5a68c516612e3c9ae33a632eb6b35cd357f83693d363659338486'],
}
const directories = {
  [config]: ['named.conf','pdns.conf','pdns.d'],
  [config+'/pdns.d']: ['bind.conf'],
  [data]: ['supermaster.conf','zones.slave.d'],
  [data+'/zones.slave.d']: [],
}
const daemonPath = '/usr/sbin/pdns_server'
const daemonSize = 5700392
const daemonSha256 = '05a344f658bde6680735f2bc55f8919d7540051d32d81eb51e424296b6cc5476'
const foreignRoots = ['/etc/bind','/etc/pdns','/var/named','/var/lib/bind','/var/cache/bind','/var/lib/pdns','/var/spool/powerdns','/run/pdns']
const serviceKeys = ['Id','Names','LoadState','ActiveState','SubState','MainPID','ControlPID','ControlGroup','DropInPaths','FragmentPath','NeedDaemonReload',
  'UnitFileState','Type','User','Group','Restart','RestartUSec','Result','NRestarts','ExecMainPID','ExecMainCode','ExecMainStatus',
  'ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','Job']
const refusalMessage = 'INSTALL_RESUME_DNS_MIGRATION_REQUIRED'
const refusalCodes = new Set(['CGROUP_READ','CGROUP_EVENTS','CGROUP_NO_PID','CGROUP_MEMBER','CGROUP_DESCENDANTS','SERVICE_STATE',
  'SERVICE_ATTEMPT','SERVICE_PRIOR_PID','SERVICE_HISTORY','SERVICE_DEADLINE','SERVICE_JOB','TASK_CENSUS','TASK_CREDENTIALS',
  'SOURCE_CAPTURE','SOURCE_BINDING','POST_STOP'])
class DnsRefusal extends Error {
  constructor(code) { super(refusalMessage); this.code = code }
}
const requireFact = (condition,code) => { if (!condition) throw new DnsRefusal(code) }
function atRefusal(code,error) {
  if (error instanceof DnsRefusal && refusalCodes.has(error.code)) throw error
  throw new DnsRefusal(code)
}
export function dnsRefusalMessage(error) {
  return error instanceof DnsRefusal && refusalCodes.has(error.code) ? refusalMessage+' '+error.code : refusalMessage
}
const exactNames = (values, expected) => values.length === expected.length && expected.every(name => values.includes(name))
const identity = info => ['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].map(k => String(info[k])).join(':')
const hash = (algorithm,bytes) => createHash(algorithm).update(bytes).digest('hex')
const modes = info => Number(info.mode & 0o7777n)

function assertVendorFiles(facts) {
  const { uid,gid } = facts.principal
  requireFact([uid,gid].every(id => Number.isSafeInteger(id) && id > 0 && id < 65534))
  requireFact(exactNames(Object.keys(facts.packages),[server,bind]))
  for (const name of [server,bind]) requireFact(facts.packages[name] === 'ii |'+name+'|amd64|'+version)
  requireFact(exactNames(Object.keys(facts.files),Object.keys(vendor)))
  for (const [path,[owner,mode,group,size,sha256]] of Object.entries(vendor)) {
    const file = facts.files[path]
    requireFact(file.owner === owner && file.uid === 0 && file.gid === (group === 'pdns' ? gid : 0)
      && file.mode === mode && file.size === size && file.sha256 === sha256 && file.md5 === file.vendorMd5 && /^[a-f0-9]{32}$/.test(file.md5))
  }
  for (const [path,expected] of Object.entries(directories)) {
    const zone = path.endsWith('/zones.slave.d'), dir = facts.dirs[path]
    requireFact(dir.uid === (zone ? uid : 0) && dir.gid === (zone ? gid : 0) && dir.mode === 0o755 && exactNames(dir.names,expected))
  }
  const empty = facts.supermaster
  // postinst creates this with touch, inheriting the administrator's umask, then chowns it to pdns:pdns.
  requireFact(empty.uid === uid && empty.gid === gid && [0o600,0o640,0o644].includes(empty.mode) && empty.size === 0)
  const daemon = facts.daemon
  requireFact(daemon.owner === server && daemon.uid === 0 && daemon.gid === 0 && daemon.mode === 0o755 && daemon.size === daemonSize
    && daemon.sha256 === daemonSha256 && daemon.md5 === daemon.vendorMd5 && /^[0-9a-f]{32}$/.test(daemon.md5))
}

function assertVendorUnit(s,fragment) {
  requireFact(exactNames(Object.keys(s),serviceKeys) && s.Id === 'pdns.service' && s.Names === 'pdns.service' && s.LoadState === 'loaded'
    && s.ControlPID === '0' && ['', '/system.slice/pdns.service'].includes(s.ControlGroup)
    && s.DropInPaths === '' && s.NeedDaemonReload === 'no' && [unit,'/lib/systemd/system/pdns.service'].includes(s.FragmentPath) && fragment === unit,'SERVICE_STATE')
}

function assertRestartPolicy(s) {
  requireFact(s.UnitFileState === 'enabled' && s.User === 'pdns' && s.Group === 'pdns' && s.Type === 'notify'
    && s.Restart === 'on-failure' && s.RestartUSec === '1s','SERVICE_STATE')
}

function assertDeadRetry(s) {
  assertRestartPolicy(s)
  requireFact(s.ActiveState === 'activating' && s.SubState === 'auto-restart' && s.MainPID === '0' && noServiceJob(s.Job)
    && s.Result === 'exit-code' && s.ExecMainCode === '1' && s.ExecMainStatus === '1'
    && positive(s.ExecMainPID) && Number(s.ExecMainPID) > 1 && positive(s.NRestarts)
    && positive(s.ExecMainStartTimestampMonotonic) && positive(s.ExecMainExitTimestampMonotonic)
    && Number(s.ExecMainExitTimestampMonotonic) >= Number(s.ExecMainStartTimestampMonotonic),'SERVICE_STATE')
}

function vendorState(facts) {
  assertVendorFiles(facts)
  const s = facts.service
  assertVendorUnit(s,facts.fragment)
  requireFact(s.MainPID === '0','SERVICE_STATE')
  requireFact(facts.noOtherInstance === true && facts.noForeignData === true && facts.noDaemon === true && facts.emptyCgroup === true)
  requireFact(noServiceJob(s.Job) && Array.isArray(facts.jobs) && facts.jobs.length === 0,'SERVICE_JOB')
  if (s.ActiveState === 'inactive' && s.SubState === 'dead') return 'idle'
  if (s.ActiveState === 'failed' && s.SubState === 'failed') return 'failed'
  assertDeadRetry(s)
  return 'retry'
}

const positive = text => typeof text === 'string' && /^[1-9][0-9]{0,15}$/.test(text) && Number.isSafeInteger(Number(text))
const noServiceJob = job => job === '' || job === '0'

export function assertVendorPowerDnsShape(facts) {
  requireFact(vendorState(facts) !== 'retry')
  return marker
}

async function command(tool,args,maxBuffer = 512*1024) {
  const { stdout,stderr } = await run('/usr/bin/'+tool,args,{ cwd:'/', encoding:'utf8', timeout:5000,maxBuffer,
    env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',SYSTEMD_PAGER:'cat',SYSTEMD_COLORS:'0'} })
  requireFact(stderr.trim() === '')
  return stdout
}

async function list(path,maximum) {
  const found = [], dir = await opendir(path)
  try {
    for (;;) {
      const entry = await dir.read()
      if (entry === null) return found.sort()
      requireFact(found.length < maximum)
      found.push(entry.name)
    }
  } finally { await dir.close() }
}

export async function readAtMost(fd,limit) {
  const bytes = Buffer.alloc(limit+1)
  let offset = 0
  while (offset <= limit) {
    const { bytesRead } = await fd.read(bytes,offset,bytes.length-offset,offset)
    if (bytesRead === 0) return bytes.subarray(0,offset)
    offset += bytesRead
  }
  requireFact(false)
}

// POSIX mode reflects the ACL mask rather than the owning group's access on an extended ACL.
export function minimalDnsAcl(text,mode) {
  requireFact(typeof text === 'string' && text.length <= 4096 && Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777)
  const rwx = bits => ((bits & 4) ? 'r' : '-')+((bits & 2) ? 'w' : '-')+((bits & 1) ? 'x' : '-')
  const expected = ['user::'+rwx(mode >> 6),'group::'+rwx(mode >> 3),'other::'+rwx(mode)].join('\n')
  requireFact(text === expected+'\n' || text === expected+'\n\n')
  return expected
}

export async function readPinnedDnsAcl(fd,mode,read = command) {
  requireFact(Number.isSafeInteger(fd) && fd >= 0)
  const output = await read('getfacl',['--omit-header','--absolute-names','--numeric','--no-effective',
    '/proc/'+process.pid+'/fd/'+fd],4096)
  return minimalDnsAcl(output,mode)
}

async function captureAncestorAcls() {
  const names = new Set()
  for (const leaf of [...Object.keys(vendor),...Object.keys(directories),data+'/supermaster.conf',daemonPath,...foreignRoots]) {
    for (let path = dirname(leaf); ; path = dirname(path)) {
      names.add(path)
      if (path === '/') break
    }
  }
  const result = {}
  for (const path of [...names].sort()) {
    result[path] = await withTrustedDirectory(dirname(path),async () => {
      const handle = await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
      try {
        const before = await handle.stat({bigint:true}), mode = modes(before)
        requireFact(before.isDirectory() && before.uid === 0n && !(mode & 0o022))
        const acl = await readPinnedDnsAcl(handle.fd,mode)
        // Parent inventory may legitimately change across apt. Only its security identity is bound.
        const key = info => ['dev','ino','uid','gid','mode'].map(k => String(info[k])).join(':')
        requireFact(key(await lstat(path,{bigint:true})) === key(before) && key(await handle.stat({bigint:true})) === key(before))
        return {identity:key(before),acl}
      } finally { await handle.close() }
    })
  }
  return result
}

async function observePath(path,expectedEntries) {
  return withTrustedDirectory(dirname(path), async () => {
    const directory = Array.isArray(expectedEntries), max = directory ? expectedEntries.length : expectedEntries
    const handle = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory ? constants.O_DIRECTORY : 0))
    try {
      const before = await handle.stat({bigint:true})
      requireFact(directory ? before.isDirectory() : before.isFile() && before.nlink === 1n && before.size <= BigInt(max))
      const base = {identity:identity(before),uid:Number(before.uid),gid:Number(before.gid),mode:modes(before),acl:await readPinnedDnsAcl(handle.fd,modes(before))}
      if (directory) base.names = await list('/proc/self/fd/'+handle.fd,max)
      else {
        const bytes = await readAtMost(handle,max)
        requireFact(bytes.length === Number(before.size))
        Object.assign(base,{size:bytes.length,sha256:hash('sha256',bytes),md5:hash('md5',bytes)})
      }
      requireFact(await readPinnedDnsAcl(handle.fd,base.mode) === base.acl && identity(await handle.stat({bigint:true})) === base.identity
        && identity(await lstat(path,{bigint:true})) === base.identity)
      return base
    } finally { await handle.close() }
  })
}

function parseProperties(text) {
  const out = {}
  for (const line of text.trimEnd().split('\n')) {
    const i = line.indexOf('='), k = line.slice(0,i)
    requireFact(i > 0 && serviceKeys.includes(k) && !Object.hasOwn(out,k))
    out[k] = line.slice(i+1)
  }
  requireFact(exactNames(Object.keys(out),serviceKeys))
  return out
}

async function optional(path,read) {
  try { await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  await read()
}

async function procText(path,limit) {
  const fd = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try { return (await readAtMost(fd,limit)).toString('utf8') } finally { await fd.close() }
}

const procView = {
  list, text:procText, link:path => readlink(path),
  directory:async path => {
    const held = await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    return {fd:held.fd,close:() => held.close()}
  },
}

async function assertDnsHostView(view) {
  requireFact((await view.text('/proc/1/comm',64)).trim() === 'systemd')
  for (const ns of ['pid','mnt','user','net']) {
    const mine = await view.link('/proc/self/ns/'+ns), init = await view.link('/proc/1/ns/'+ns)
    requireFact(mine === init && new RegExp('^'+ns+':\\[[1-9][0-9]*\\]$').test(mine))
  }
}

function taskStart(stat,tid) {
  const last = stat.lastIndexOf(') ')
  requireFact(stat.startsWith(tid+' (') && last > 0)
  const birth = stat.slice(last+2).trim().split(/\s+/)[19]
  requireFact(/^[1-9][0-9]*$/.test(birth ?? ''))
  return birth
}

async function allowExited(error,held,view) {
  const gone = e => e?.code === 'ENOENT' || e?.code === 'ESRCH'
  if (!gone(error)) throw error
  if (!held) return
  try { await view.text('/proc/self/fd/'+held.fd+'/stat',4096) }
  catch (current) { if (gone(current)) return; throw current }
  // A missing child view of a still-observable task/process is not evidence it exited.
  requireFact(false)
}

export async function assertDnsHostProcesses(uid,deadline,view = procView) {
  await assertDnsHostView(view)
  const numeric = /^[1-9][0-9]*$/
  const pids = (await view.list('/proc',32768)).filter(name => numeric.test(name))
  requireFact(pids.length <= 16384)
  let count = 0
  for (const pid of pids) {
    requireFact(performance.now() < deadline)
    let processPin
    try {
      processPin = await view.directory('/proc/'+pid)
      const tasks = '/proc/self/fd/'+processPin.fd+'/task'
      const tids = await view.list(tasks,4096)
      requireFact(tids.length > 0 && tids.length <= 4096 && tids.every(name => numeric.test(name)))
      for (const tid of tids) {
        requireFact(++count <= 65536 && performance.now() < deadline)
        let taskPin
        try {
          taskPin = await view.directory(tasks+'/'+tid)
          const base = '/proc/self/fd/'+taskPin.fd+'/'
          const birth = taskStart(await view.text(base+'stat',4096),tid)
          const status = await view.text(base+'status',65536)
          const ids = /^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/m.exec(status)
          const name = /^Name:[ \t]+([^\n]+)$/m.exec(status)
          requireFact(ids && name,'TASK_CENSUS')
          requireFact(ids.slice(1).every(id => Number(id) !== uid) && !['pdns_server','named'].includes(name[1]),'TASK_CREDENTIALS')
          requireFact(taskStart(await view.text(base+'stat',4096),tid) === birth)
        } catch (error) { await allowExited(error,taskPin,view) }
        finally { if (taskPin) await taskPin.close() }
      }
    } catch (error) { await allowExited(error,processPin,view) }
    finally { if (processPin) await processPin.close() }
  }
  await assertDnsHostView(view)
  requireFact(performance.now() < deadline)
}

const unitCgroup = '/sys/fs/cgroup/system.slice/pdns.service'

export async function readDnsCgroupWindow(read) {
  const before = await read('cgroup.procs')
  const events = (await read('cgroup.events')).split('\n').filter(row => row.startsWith('populated '))
  requireFact(events.length === 1 && ['populated 0','populated 1'].includes(events[0]),'CGROUP_EVENTS')
  if (events[0] === 'populated 0' && before.trim() === '') return {populated:false}
  const after = await read('cgroup.procs')
  const members = [...new Set([before,after].flatMap(text => text.trim().split(/\s+/).filter(Boolean)))]
  const children = (await read('cgroup.stat')).split('\n').filter(row => row.startsWith('nr_descendants '))
  requireFact(members.length > 0,'CGROUP_NO_PID')
  requireFact(members.length === 1 && positive(members[0]) && Number(members[0]) > 1,'CGROUP_MEMBER')
  requireFact(children.length === 1 && children[0] === 'nr_descendants 0','CGROUP_DESCENDANTS')
  return {populated:true,pid:members[0]}
}

async function cgroupWindow() {
  requireFact((await lstat('/sys/fs/cgroup/cgroup.controllers')).isFile())
  let result = {populated:false}
  await optional(unitCgroup,async () => { result = await readDnsCgroupWindow(name => procText(unitCgroup+'/'+name,4096)) })
  return result
}

// A populated cgroup can never authorize admission. Correlate its only PID to one
// completed vendor attempt before taking a new observation, under the original deadline.
export async function coherentDnsService(deadline,fragment,allowRetry,ports) {
  const bounded = () => requireFact(performance.now() < deadline,'SERVICE_DEADLINE')
  let service = await ports.service()
  for (let attempt = 0; ; attempt++) {
    bounded()
    assertVendorUnit(service,fragment)
    const window = await ports.cgroup().catch(error => atRefusal('CGROUP_READ',error))
    bounded()
    const starting = service.ActiveState === 'activating' && service.SubState === 'start'
    if (!window.populated && !starting) return service
    // A sampled MainPID may have exited just before cgroup.events reported empty.
    const pid = window.populated ? window.pid : service.MainPID
    requireFact(allowRetry && attempt < 3 && positive(pid) && Number(pid) > 1,'SERVICE_ATTEMPT')
    assertRestartPolicy(service)
    const previous = service
    if (starting) {
      requireFact(previous.ActiveState === 'activating' && previous.ControlGroup === '/system.slice/pdns.service'
        && previous.MainPID === pid && previous.ExecMainPID === pid
        && positive(previous.ExecMainStartTimestampMonotonic) && positive(previous.NRestarts),'SERVICE_ATTEMPT')
    } else {
      assertDeadRetry(previous)
      requireFact(previous.ExecMainPID !== pid,'SERVICE_PRIOR_PID')
    }
    for (let sample = 0; ; sample++) {
      bounded()
      service = await ports.service()
      bounded()
      assertVendorUnit(service,fragment)
      assertRestartPolicy(service)
      requireFact(service.FragmentPath === previous.FragmentPath && service.ExecMainPID === pid
        && Number(service.NRestarts) === Number(previous.NRestarts)+(starting ? 0 : 1)
        && positive(service.ExecMainStartTimestampMonotonic)
        && (starting ? service.ExecMainStartTimestampMonotonic === previous.ExecMainStartTimestampMonotonic
          : Number(service.ExecMainStartTimestampMonotonic) > Number(previous.ExecMainExitTimestampMonotonic)),'SERVICE_HISTORY')
      if (service.SubState !== 'start') {
        assertDeadRetry(service)
        break
      }
      requireFact(service.ActiveState === 'activating' && service.MainPID === pid
        && service.ControlGroup === '/system.slice/pdns.service' && sample < 8,'SERVICE_ATTEMPT')
      await ports.pause()
    }
  }
}

async function inspectDnsEnvironment(uid) {
  const instances = await command('systemctl',['list-units','--all','--no-legend','--plain','--no-pager','pdns@*.service'])
  requireFact(!instances.trim())
  // Only the vendor template may be present. An enabled concrete alias can start after this check.
  const units = await command('systemctl',['list-unit-files','--no-legend','--no-pager','pdns@*.service'])
  requireFact(units.trim().split('\n').filter(Boolean).every(row => row.trim().split(/\s+/)[0] === 'pdns@.service'))
  const foreign = {}
  for (const path of foreignRoots) {
    await optional(path,async () => {
      const dir = await observePath(path,[])
      requireFact((dir.uid === 0 || (['/var/spool/powerdns','/run/pdns'].includes(path) && dir.uid === uid)) && !(dir.mode & 0o022))
      foreign[path] = dir
    })
  }
  requireFact(!(await list('/etc',4096)).some(name => /^named(?:$|\.)/.test(name)))
  return foreign
}

function listedDnsJob(text) {
  requireFact(typeof text === 'string' && text.length <= 512*1024,'SERVICE_JOB')
  let id = null
  const seen = new Set()
  const lines = text.trim().split('\n')
  requireFact(lines.length <= 4096,'SERVICE_JOB')
  for (const line of lines) {
    if (!line) continue
    const columns = line.trim().split(/\s+/)
    requireFact(columns.length === 4 && positive(columns[0]) && Number(columns[0]) < 2**32,'SERVICE_JOB')
    const [number,name,type,state] = columns
    requireFact(!seen.has(number),'SERVICE_JOB')
    seen.add(number)
    requireFact(/^\S+\.(?:automount|device|mount|path|scope|service|slice|socket|swap|target|timer)$/.test(name)
      && /^[a-z]+(?:-[a-z]+)*$/.test(type) && (state === 'running' || state === 'waiting'),'SERVICE_JOB')
    if (!/^pdns(?:@[^\s]*)?\.service$/.test(name)) continue
    requireFact(id === null && name === 'pdns.service' && type === 'start' && state === 'running','SERVICE_JOB')
    id = number
  }
  return id
}

export function dnsServicePorts(read = command,cgroup = cgroupWindow,pause = (delay = 25) => new Promise(resolve => setTimeout(resolve,delay))) {
  return {
    service:async () => parseProperties(await read('systemctl',['show','pdns.service','--all','--property='+serviceKeys.join(',')])),
    jobs:() => read('systemctl',['list-jobs','--full','--no-legend','--no-pager']),
    cgroup,pause,
  }
}
const livePorts = dnsServicePorts()
const jobAt = async ports => listedDnsJob(await ports.jobs().catch(error => atRefusal('SERVICE_JOB',error)))
const groupAt = async ports => ports.cgroup().catch(error => atRefusal('CGROUP_READ',error))
const timeLeft = deadline => requireFact(performance.now() < deadline,'SERVICE_DEADLINE')

// Read the three independent views together: a short-lived process may be gone by
// the time a second systemctl command exits. An inconsistent frame never admits a stop.
async function dnsFrame(deadline,fragment,ports) {
  timeLeft(deadline)
  const results = await Promise.allSettled([ports.service(),jobAt(ports),groupAt(ports)])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  const [service,id,group] = results.map(result => result.value)
  timeLeft(deadline)
  assertVendorUnit(service,fragment)
  return {service,id,group}
}
function sameFailedAttempt(a,b) {
  return a.NRestarts === b.NRestarts && a.ExecMainPID === b.ExecMainPID
    && a.ExecMainStartTimestampMonotonic === b.ExecMainStartTimestampMonotonic
    && a.ExecMainExitTimestampMonotonic === b.ExecMainExitTimestampMonotonic
}

// This identifies a systemd-managed attempt and its cgroup member. Neither the
// submitter nor the member's current executable is inferred from these observations.
async function finishListedAttempt(first,prior,read,ports,deadline) {
  const id = first.id
  requireFact(id !== null,'SERVICE_JOB')
  if (prior) assertDeadRetry(prior)
  const until = Math.min(deadline,performance.now()+1000)
  let frame = first, start, member, witnessed = false
  for (let i = 0; i < 40; i++) {
    timeLeft(until)
    const {service:s,group} = frame
    requireFact(frame.id === null || frame.id === id,'SERVICE_JOB')
    if (group.populated) {
      requireFact(positive(group.pid) && Number(group.pid) > 1 && (!member || member === group.pid)
        && (!prior || group.pid !== prior.ExecMainPID),'SERVICE_ATTEMPT')
      member = group.pid
    }
    if (s.SubState === 'start') {
      assertRestartPolicy(s)
      requireFact(s.ActiveState === 'activating' && s.Job === id && s.ControlGroup === '/system.slice/pdns.service'
        && positive(s.NRestarts) && positive(s.MainPID) && Number(s.MainPID) > 1 && s.ExecMainPID === s.MainPID
        && positive(s.ExecMainStartTimestampMonotonic) && (!member || member === s.MainPID),'SERVICE_ATTEMPT')
      if (prior) requireFact(s.FragmentPath === prior.FragmentPath && Number(s.NRestarts) === Number(prior.NRestarts)+1
        && s.MainPID !== prior.ExecMainPID && Number(s.ExecMainStartTimestampMonotonic) > Number(prior.ExecMainExitTimestampMonotonic),'SERVICE_HISTORY')
      if (!start) {
        requireFact(frame.id === id,'SERVICE_JOB')
        start = s
      } else requireFact(s.FragmentPath === start.FragmentPath && s.MainPID === start.MainPID && s.NRestarts === start.NRestarts
        && s.ExecMainStartTimestampMonotonic === start.ExecMainStartTimestampMonotonic,'SERVICE_HISTORY')
      if (frame.id === id && group.populated && group.pid === s.MainPID) witnessed = true
    } else {
      assertDeadRetry(s)
      if (start) {
        requireFact(witnessed && frame.id === null && !group.populated && member === start.MainPID && s.ExecMainPID === start.MainPID
          && s.FragmentPath === start.FragmentPath && s.NRestarts === start.NRestarts
          && s.ExecMainStartTimestampMonotonic === start.ExecMainStartTimestampMonotonic,'SERVICE_HISTORY')
        return frame
      }
      requireFact(prior && sameFailedAttempt(prior,s) && frame.id === id,'SERVICE_HISTORY')
    }
    if (i > 0 || start) await ports.pause(8)
    frame = await read()
  }
  requireFact(false,'SERVICE_ATTEMPT')
}

// A first observation can already be mid-start. Its completion supplies a predecessor,
// not credit. Demand an independently listed NEW full cycle after the exact one-second
// vendor restart policy; skipped counters, ambiguous PIDs or a persistent job refuse.
async function followingStart(completed,spentId,read,ports,deadline) {
  const until = Math.min(deadline,performance.now()+2500)
  for (let i = 0; i < 200; i++) {
    timeLeft(until)
    const frame = await read()
    timeLeft(until)
    if (frame.id !== null) {
      requireFact(frame.id !== spentId,'SERVICE_JOB')
      return finishListedAttempt(frame,completed.service,read,ports,deadline)
    }
    if (frame.service.SubState === 'start') {
      // The independent list-jobs sample can lag the show sample. This frame is
      // never credited as a witnessed attempt; a new listed full cycle is still required.
      const s = frame.service, prior = completed.service
      assertRestartPolicy(s)
      requireFact(s.ActiveState === 'activating' && s.ControlGroup === '/system.slice/pdns.service'
        && (noServiceJob(s.Job) || (positive(s.Job) && Number(s.Job) < 2**32)) && positive(s.MainPID) && Number(s.MainPID) > 1
        && s.ExecMainPID === s.MainPID && positive(s.ExecMainStartTimestampMonotonic)
        && s.FragmentPath === prior.FragmentPath && positive(s.NRestarts) && Number(s.NRestarts) === Number(prior.NRestarts)+1
        && s.MainPID !== prior.ExecMainPID
        && Number(s.ExecMainStartTimestampMonotonic) > Number(prior.ExecMainExitTimestampMonotonic)
        && (!frame.group.populated || frame.group.pid === s.MainPID),'SERVICE_HISTORY')
    } else {
      assertDeadRetry(frame.service)
      requireFact(sameFailedAttempt(completed.service,frame.service) && !frame.group.populated,'SERVICE_HISTORY')
    }
    await ports.pause(8)
  }
  requireFact(false,'SERVICE_ATTEMPT')
}

export async function observeDnsServiceJobs(deadline,fragment,allowRetry,ports,expectedFirstJob = null) {
  let latest, drained = false
  const read = () => dnsFrame(deadline,fragment,ports)
  const service = async () => {
    const prior = latest?.service
    latest = await read()
    const {id,service:s} = latest
    if (!prior && expectedFirstJob !== null) requireFact(id === expectedFirstJob,'SERVICE_JOB')
    if (id === null && noServiceJob(s.Job)) return s
    requireFact(allowRetry && !drained && id !== null && (noServiceJob(s.Job) || s.Job === id),'SERVICE_JOB')
    const predecessor = s.SubState === 'start' ? prior : s
    latest = await finishListedAttempt(latest,predecessor,read,ports,deadline)
    if (!predecessor) latest = await followingStart(latest,id,read,ports,deadline)
    drained = true
    return latest.service
  }
  const result = await coherentDnsService(deadline,fragment,allowRetry,{service,cgroup:async () => latest.group,pause:ports.pause})
  return {service:result,drained}
}

// A read-only transition can run out of time. The effect boundary never waits on any job.
export async function readDnsIdleBoundary(deadline,fragment,ports) {
  timeLeft(deadline)
  requireFact(await jobAt(ports) === null,'SERVICE_JOB')
  const first = await ports.service()
  assertVendorUnit(first,fragment)
  requireFact(noServiceJob(first.Job),'SERVICE_JOB')
  requireFact(first.MainPID === '0' && !(await groupAt(ports)).populated,'SERVICE_ATTEMPT')
  const last = await ports.service()
  assertVendorUnit(last,fragment)
  requireFact(noServiceJob(last.Job) && await jobAt(ports) === null,'SERVICE_JOB')
  requireFact(serviceKeys.every(k => first[k] === last[k]),'SERVICE_HISTORY')
  timeLeft(deadline)
  return last
}

// Only a listed, fully witnessed vendor retry can defer the decision. No stop
// occurs in this path, and the caller must restart the complete inventory.
export async function readDnsDecisionBoundary(deadline,fragment,ports) {
  timeLeft(deadline)
  const id = await jobAt(ports)
  if (id === null) return readDnsIdleBoundary(deadline,fragment,ports)
  const observed = await observeDnsServiceJobs(deadline,fragment,true,ports,id)
  requireFact(observed.drained,'SERVICE_JOB')
  return null
}

async function captureOnce(deadline,allowRetry) {
  const ancestry = await captureAncestorAcls()
  const principal = (await command('getent',['passwd','pdns'])).trimEnd().split(':')
  const group = (await command('getent',['group','pdns'])).trimEnd().split(':')
  requireFact(principal.length === 7 && principal[0] === 'pdns' && principal[5] === '/var/spool/powerdns' && principal[6] === '/bin/false'
    && group.length === 4 && group[0] === 'pdns' && group[2] === principal[3] && /^[1-9]\d*$/.test(principal[2]) && /^[1-9]\d*$/.test(group[2]))
  const uid = Number(principal[2]), gid = Number(group[2])
  const packages = {}, files = {}, dirs = {}, packageSums = {}
  const query = await command('dpkg-query',['-W','-f=${db:Status-Abbrev}|${Package}|${Architecture}|${Version}\\n',server,'pdns-backend-*'])
  for (const row of query.trimEnd().split('\n')) {
    const [status,name] = row.split('|')
    // Residual third-party backend configuration requires operator inspection too.
    requireFact([server,bind].includes(name) && status === 'ii ' && !Object.hasOwn(packages,name))
    packages[name] = row
  }
  for (const pkg of [server,bind]) {
    const conffiles = await command('dpkg-query',['-W','-f=${Conffiles}\\n',pkg])
    packageSums[pkg] = conffiles.split('\n').map(line => /^ (\/\S+) ([a-f0-9]{32})$/.exec(line)).filter(Boolean).map(m => [m[1],m[2]])
  }
  const sums = await command('dpkg-query',['--control-show',server,'md5sums'])
  for (const line of sums.split('\n')) {
    const record = /^([a-f0-9]{32})\s+(\S+)$/.exec(line)
    if (record) packageSums[server].push(['/'+record[2],record[1]])
  }
  for (const [path,[owner,,,size]] of Object.entries(vendor)) {
    const dpkgOwner = (await command('dpkg-query',['-S','--',path])).trimEnd()
    const digests = packageSums[owner].filter(([named]) => named === path)
    requireFact(dpkgOwner === owner+': '+path && digests.length === 1)
    files[path] = {...await observePath(path,size),owner,vendorMd5:digests[0][1]}
  }
  for (const [path,names] of Object.entries(directories)) dirs[path] = await observePath(path,names)
  const supermaster = await observePath(data+'/supermaster.conf',0)
  const daemonOwner = (await command('dpkg-query',['-S','--',daemonPath])).trimEnd()
  const daemon = await observePath(daemonPath,daemonSize)
  const daemonSums = packageSums[server].filter(([name]) => name === daemonPath)
  requireFact(daemonOwner === server+': '+daemonPath && daemonSums.length === 1)
  Object.assign(daemon,{owner:server,vendorMd5:daemonSums[0][1]})
  const boot = (await procText('/proc/sys/kernel/random/boot_id',64)).trim()
  requireFact(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot))
  const staticFacts = {principal:{uid,gid},packages,files,dirs,supermaster,daemon}
  assertVendorFiles(staticFacts)
  const fragment = await realpath(unit)
  const foreign = await inspectDnsEnvironment(uid)
  const {service,drained} = await observeDnsServiceJobs(deadline,fragment,allowRetry,livePorts)
  if (drained) return null
  requireFact(await realpath(service.FragmentPath) === fragment)
  await assertDnsHostProcesses(uid,deadline).catch(error => atRefusal('TASK_CENSUS',error))
  requireFact(JSON.stringify(await captureAncestorAcls()) === JSON.stringify(ancestry),'SOURCE_BINDING')
  return {principal:{uid,gid},packages,files,dirs,supermaster,daemon,boot,service,fragment,jobs:[],ancestry,foreign,
    noOtherInstance:true,noForeignData:true,noDaemon:true,emptyCgroup:true}
}

export async function captureDnsInventory(deadline,allowRetry,read = captureOnce) {
  const facts = await read(deadline,allowRetry)
  if (facts !== null) return facts
  timeLeft(deadline)
  // No repeated waiting: an independently acquired clean inventory is mandatory.
  const fresh = await read(deadline,false)
  requireFact(fresh !== null,'SERVICE_JOB')
  return fresh
}

function binding(facts) {
  const {principal,packages,files,dirs,supermaster,daemon,fragment,boot,ancestry,foreign} = facts
  for (const item of [...Object.values(files),...Object.values(dirs),supermaster,daemon]) requireFact(typeof item.identity === 'string' && item.identity.length > 0)
  // The package files and their original inode/owner/ctime identities must survive both phases.
  const {Id,LoadState,FragmentPath,UnitFileState,Type,User,Group,Restart,RestartUSec,DropInPaths,NeedDaemonReload} = facts.service
  const definition = {Id,LoadState,FragmentPath,UnitFileState,Type,User,Group,Restart,RestartUSec,DropInPaths,NeedDaemonReload}
  return hash('sha256',JSON.stringify({principal,packages,files,dirs,supermaster,daemon,fragment,boot,definition,ancestry,foreign}))
}

export async function verifyVendorDnsPhase(phase,expected,ports) {
  requireFact((phase === 'inspect' && expected === undefined) || (phase === 'quiesce' && /^[a-f0-9]{64}$/.test(expected)))
  let inspected, digest, state, last, latest, priorInspected
  for (let attempt = 0; ; attempt++) {
    const first = await ports.capture(), firstState = vendorState(first)
    digest = binding(first)
    inspected = hash('sha256',firstState+':'+digest)
    requireFact((expected === undefined || expected === inspected)
      && (priorInspected === undefined || priorInspected === inspected),'SOURCE_BINDING')
    last = await ports.capture()
    state = vendorState(last)
    requireFact(firstState === state && binding(last) === digest,'SOURCE_BINDING')
    // A fully witnessed in-flight retry invalidates both inventories: recapture.
    latest = await ports.service(true)
    if (latest !== null) break
    requireFact(attempt < 2,'SERVICE_ATTEMPT')
    priorInspected = inspected
  }
  const decision = {...last,service:latest}
  requireFact(vendorState(decision) === state && binding(decision) === digest,'SOURCE_BINDING')
  if (phase === 'inspect') return 'xpanel-pdns-vendor-inspected-v2 '+inspected
  if (state !== 'retry') return marker

  // Do not replace or cancel an already queued job. The only effect is a single synchronous stop.
  await ports.stop()
  for (let i = 0; i < 2; i++) {
    const after = await ports.capture(false)
    requireFact(binding(after) === digest && vendorState(after) === 'idle','POST_STOP')
    // A raced start/exit since our decision is not proof of the intended stop.
    requireFact(after.service.ExecMainPID === latest.ExecMainPID
      && after.service.ExecMainStartTimestampMonotonic === latest.ExecMainStartTimestampMonotonic
      && after.service.ExecMainExitTimestampMonotonic === latest.ExecMainExitTimestampMonotonic,'POST_STOP')
  }
  const final = {...last,service:await ports.service()}
  requireFact(vendorState(final) === 'idle' && binding(final) === digest
    && final.service.ExecMainPID === latest.ExecMainPID && final.service.ExecMainExitTimestampMonotonic === latest.ExecMainExitTimestampMonotonic,'POST_STOP')
  return marker
}

export function assertDnsResumeEntry(argv,modulePath,realEntry) {
  requireFact(((argv.length === 3 && argv[2] === 'inspect') || (argv.length === 4 && argv[2] === 'quiesce' && /^[a-f0-9]{64}$/.test(argv[3]))) && argv[1] === realEntry && modulePath === realEntry && basename(realEntry) === 'install-dns-resume.mjs' && basename(dirname(realEntry)) === 'scripts')
}

async function runNative() {
  requireLinuxRoot()
  const path = fileURLToPath(import.meta.url)
  assertDnsResumeEntry(process.argv,path,await realpath(process.argv[1]))
  requireFact(!process.execArgv.length && !['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH'].some(k => process.env[k]))
  await readTrustedFile(path,{maxBytes:128*1024})
  const os = (await readTrustedFile('/usr/lib/os-release',{maxBytes:65536})).bytes.toString()
  requireFact(await realpath('/etc/os-release') === '/usr/lib/os-release' && /^ID=ubuntu$/m.test(os) && /^VERSION_ID="24\.04"$/m.test(os) && /^VERSION_CODENAME=noble$/m.test(os))
  const deadline = performance.now()+30000
  const bounded = () => requireFact(performance.now() < deadline,'SERVICE_DEADLINE')
  const result = await verifyVendorDnsPhase(process.argv[2],process.argv[3],{
    capture: async (allowRetry = true) => { bounded(); const observation = await captureDnsInventory(deadline,allowRetry).catch(error => atRefusal('SOURCE_CAPTURE',error)); bounded(); return observation },
    service: (allowTransition = false) => (allowTransition ? readDnsDecisionBoundary(deadline,unit,livePorts) : readDnsIdleBoundary(deadline,unit,livePorts)).catch(error => atRefusal('SERVICE_STATE',error)),
    stop: async () => { bounded(); await command('systemctl',['--job-mode=fail','stop','pdns.service']); bounded() },
  })
  bounded()
  return result
}

if (import.meta.main) {
  try { process.stdout.write(await runNative()+'\n') }
  catch (error) { process.stderr.write(dnsRefusalMessage(error)+'\n'); process.exitCode = 1 }
}
