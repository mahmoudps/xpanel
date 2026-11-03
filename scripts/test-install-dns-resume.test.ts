import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureDnsInventory, coherentDnsService, dnsRefusalMessage, dnsServicePorts, observeDnsServiceJobs, readDnsDecisionBoundary, readDnsCgroupWindow, readDnsIdleBoundary, minimalDnsAcl, readPinnedDnsAcl, assertDnsHostProcesses, assertDnsResumeEntry, assertVendorPowerDnsShape, readAtMost, verifyVendorDnsPhase } from './install-dns-resume.mjs'

const server = 'pdns-server'
const bind = 'pdns-backend-bind'
const version = '4.8.3-4build3'
const root = '/etc/powerdns'
const data = '/var/lib/powerdns'
const unit = '/usr/lib/systemd/system/pdns.service'
const uid = 105, gid = 109
const file = (owner: string, mode: number, gid: number, size: number, sha256: string, md5: string) =>
  ({owner,uid:0,gid,mode,size,sha256,md5,vendorMd5:md5,identity:sha256})
const dir = (names: string[],uid = 0,gid = 0) => ({names,uid,gid,mode:0o755,identity:names.join(',') || 'empty-directory'})

function fixture() {
  return {
    principal:{uid,gid},
    packages:{[server]:'ii |'+server+'|amd64|'+version,[bind]:'ii |'+bind+'|amd64|'+version},
    files:{
      [root+'/pdns.conf']:file(server,0o640,gid,20289,'3d41154e93c96acee3cf10d5eb9b28f15de5a0a76e4a7273e7632bedfee74bb3','1143e56f8921c7bd5135569c90600e19'),
      [root+'/named.conf']:file(bind,0o644,0,293,'54c2d275121cded0f62f8e583c4c51f7d6c756deb8eb3114613fa5ab6aea5a2a','63c70a6c3867414ec79d6bb6f59e327e'),
      [root+'/pdns.d/bind.conf']:file(bind,0o644,0,1382,'c71d82e082d3e9db8b0ccdaaf5ed329245cfe2c4248ed9286a2956638c0e9277','ba8e97aad1c40d8a06dbda42e7fbb547'),
      [unit]:file(server,0o644,0,1565,'cd60d18e3ed5a68c516612e3c9ae33a632eb6b35cd357f83693d363659338486','a040d529f03c8091e2c8187505380361'),
    },
    dirs:{[root]:dir(['named.conf','pdns.conf','pdns.d']),[root+'/pdns.d']:dir(['bind.conf']),
      [data]:dir(['supermaster.conf','zones.slave.d']),[data+'/zones.slave.d']:dir([],uid,gid)},
    supermaster:{uid,gid,mode:0o644,size:0,identity:'generated-empty-file'},
    ancestry:{'/var/lib':{identity:'root-owned-parent',acl:'user::rwx\ngroup::r-x\nother::r-x'}},
    foreign:{} as Record<string,{identity:string;acl:string}>,
    daemon:file(server,0o755,0,5700392,'05a344f658bde6680735f2bc55f8919d7540051d32d81eb51e424296b6cc5476','bda458e86b5eeccd2c8a6b5aa601e0b2'),boot:'00000000-0000-4000-8000-000000000001',jobs:[] as string[],
    service:{Id:'pdns.service',Names:'pdns.service',LoadState:'loaded',ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlPID:'0',ControlGroup:'',
      DropInPaths:'',FragmentPath:unit,NeedDaemonReload:'no',UnitFileState:'enabled',Type:'notify',User:'pdns',Group:'pdns',
      Restart:'on-failure',RestartUSec:'1s',Result:'success',NRestarts:'0',ExecMainPID:'0',ExecMainCode:'0',ExecMainStatus:'0',
      ExecMainStartTimestampMonotonic:'0',ExecMainExitTimestampMonotonic:'0',Job:'0'},
    fragment:unit,noOtherInstance:true,noForeignData:true,noDaemon:true,emptyCgroup:true,
  }
}

describe('prepared PowerDNS package inspection', () => {
  it('recognizes the inert Noble archive and its maintainer-created defaults', () => {
    const state = fixture()
    expect(assertVendorPowerDnsShape(state)).toBe('xpanel-pdns-vendor-pristine-v1')
    state.service.ActiveState = state.service.SubState = 'failed'
    state.supermaster.mode = 0o600
    expect(assertVendorPowerDnsShape(state)).toBe('xpanel-pdns-vendor-pristine-v1')
  })

  it('requires all four original file digests even when a modified file matches local package metadata', () => {
    for (const path of Object.keys(fixture().files)) {
      const state = fixture()
      const changed = state.files[path]
      changed.md5 = changed.vendorMd5 = '1'.repeat(32)
      changed.sha256 = '0'.repeat(64)
      expect(() => assertVendorPowerDnsShape(state)).toThrow()
    }
  })

  const refusals: [string,(s: ReturnType<typeof fixture>) => void][] = [
    ['other package version',s => {s.packages[server] = 'ii |pdns-server|amd64|4.8.4'}],
    ['wrong dpkg owner',s => {s.files[unit].owner = bind}],
    ['modified local package record',s => {s.files[unit].vendorMd5 = '0'.repeat(32)}],
    ['config readable beyond package policy',s => {s.files[root+'/pdns.conf'].mode = 0o644}],
    ['wrong config group',s => {s.files[root+'/pdns.conf'].gid = 0}],
    ['secondary directory wrong owner',s => {s.dirs[data+'/zones.slave.d'].uid = 0}],
    ['nonempty generated file',s => {s.supermaster.size = 1}],
    ['extra include',s => {s.dirs[root+'/pdns.d'].names.push('local.conf')}],
    ['secondary zone present',s => {s.dirs[data+'/zones.slave.d'].names.push('example.test')}],
    ['unknown data path',s => {s.dirs[data].names.push('zones.sqlite3')}],
    ['active service despite exact files',s => {s.service.ActiveState = 'active'; s.service.SubState = 'running'}],
    ['pending service restart',s => {s.service.ActiveState = 'activating'; s.service.SubState = 'auto-restart'}],
    ['remaining control process',s => {s.service.ControlPID = '123'}],
    ['foreign fragment',s => {s.fragment = '/etc/systemd/system/pdns.service'}],
    ['unit drop-in',s => {s.service.DropInPaths = '/run/systemd/system/pdns.service.d/runtime.conf'}],
    ['stale manager configuration',s => {s.service.NeedDaemonReload = 'yes'}],
    ['populated unit cgroup',s => {s.emptyCgroup = false}],
    ['second instance',s => {s.noOtherInstance = false}],
    ['foreign data inventory',s => {s.noForeignData = false}],
    ['unmanaged daemon',s => {s.noDaemon = false}],
  ]
  it.each(refusals)('holds %s', (_name,mutate) => {
    const state = fixture()
    mutate(state)
    expect(() => assertVendorPowerDnsShape(state)).toThrow()
  })

  it('refuses a symlink alias and caller-selected flags at the real entrypoint', () => {
    const path = '/root/authenticated/scripts/install-dns-resume.mjs'
    expect(() => assertDnsResumeEntry(['/usr/bin/node',path,'inspect'],path,path)).not.toThrow()
    expect(() => assertDnsResumeEntry(['/usr/bin/node',path,'quiesce','f'.repeat(64)],path,path)).not.toThrow()
    expect(() => assertDnsResumeEntry(['/usr/bin/node',path],path,path)).toThrow()
    expect(() => assertDnsResumeEntry(['/usr/bin/node',path,'quiesce'],path,path)).toThrow()
    expect(() => assertDnsResumeEntry(['/usr/bin/node','/tmp/alias','inspect'],path,path)).toThrow()
    expect(() => assertDnsResumeEntry(['/usr/bin/node',path,'--trust'],path,path)).toThrow()
  })

  it('reads at most the limit plus one byte when an expected empty file acquired data', async () => {
    const directory = await mkdtemp(join(tmpdir(),'pdns-bounds-'))
    const path = join(directory,'generated')
    try {
      await writeFile(path,'')
      const fd = await open(path,'r')
      try {
        expect((await readAtMost(fd,0)).length).toBe(0)
        await writeFile(path,'changed')
        await expect(readAtMost(fd,0)).rejects.toThrow()
        expect((await readAtMost(fd,7)).toString()).toBe('changed')
      } finally { await fd.close() }
    } finally { await rm(directory,{recursive:true,force:true}) }
  })
})

function retry(epoch = 4) {
  const state = fixture()
  Object.assign(state.service,{ActiveState:'activating',SubState:'auto-restart',Result:'exit-code',
    NRestarts:String(epoch),ExecMainPID:String(300+epoch),ExecMainCode:'1',ExecMainStatus:'1',
    ExecMainStartTimestampMonotonic:String(epoch*1000),ExecMainExitTimestampMonotonic:String(epoch*1000+1)})
  return state
}

function stopped(state: ReturnType<typeof retry>) {
  const inactive = structuredClone(state)
  Object.assign(inactive.service,{ActiveState:'inactive',SubState:'dead',NRestarts:'0',Result:'success'})
  return inactive
}

describe('listed DNS jobs at the installed capture and stop boundaries', () => {
  const dead = retry(4).service, next = retry(5).service
  const start = {...next,SubState:'start',MainPID:next.ExecMainPID,ControlGroup:'/system.slice/pdns.service',Job:'832',Result:'success',ExecMainCode:'0',ExecMainStatus:'0'}
  const listed = '832 pdns.service start running\n'
  const provisioner = '73 provisioner.service start running\n'
  const hit = {populated:true,pid:next.ExecMainPID}, empty = {populated:false}
  type Service = typeof dead
  type Window = {populated:boolean;pid?:string}
  function sample(services: Service[],lists: string[],groups: Window[]) {
    function take<T>(values: T[]) {
      const value = values.shift()
      if (value === undefined) throw Error('unexpected fixture read')
      return value
    }
    return dnsServicePorts(async (tool:string,args:string[]) => {
      expect(tool).toBe('systemctl')
      if (args[0] === 'list-jobs') {
        expect(args).toEqual(['list-jobs','--full','--no-legend','--no-pager'])
        return provisioner+take(lists)
      }
      expect(args.slice(0,3)).toEqual(['show','pdns.service','--all'])
      const value = take(services)
      expect(args[3]?.slice('--property='.length).split(',').sort()).toEqual(Object.keys(value).sort())
      return Object.entries(value).map(([key,v]) => key+'='+v).join('\n')+'\n'
    },async () => take(groups),async () => {})
  }
  const clean = (service:Service) => sample([service],[''],[empty])
  const boundary = (service:Service) => sample([service,service],['',''],[empty])
  const transition = () => sample([dead,start,start,next],[listed,listed,'',''],[empty,hit,empty,empty])

  it('discards the witnessed list-job sample, recaptures the complete inventory and checks a job-free write boundary',async () => {
    const inputs = await inspect(retry(3)), current = retry(5), idle = stopped(current)
    const inventories:boolean[] = []
    let stops = 0, boundaries = 0
    const proof = await verifyVendorDnsPhase('quiesce',inputs,{
      capture:(allowRetry = true) => captureDnsInventory(Infinity,allowRetry,async (deadline:number,allowed:boolean) => {
        inventories.push(allowed)
        const data = stops ? idle : current
        const ports = inventories.length === 1 ? transition() : clean(data.service)
        const cut = await observeDnsServiceJobs(deadline,unit,allowed,ports)
        return cut.drained ? null : {...data,service:cut.service}
      }),
      service:async () => {
        boundaries++
        return readDnsIdleBoundary(Infinity,unit,boundary(stops ? idle.service : current.service))
      },
      stop:async () => { expect(inventories).toEqual([true,false,true]); expect(boundaries).toBe(1); stops++ },
    })
    expect(proof).toBe('xpanel-pdns-vendor-pristine-v1')
    expect(inventories).toEqual([true,false,true,false,false])
    expect([stops,boundaries]).toEqual([1,2])
  })

  it('recognizes the running provisioner and requires a new complete cycle after first observing mid-start',async () => {
    const successor = retry(6).service
    const live = {...successor,SubState:'start',MainPID:successor.ExecMainPID,ControlGroup:start.ControlGroup,Job:'833',Result:'success',ExecMainCode:'0',ExecMainStatus:'0'}
    const another = '833 pdns.service start running\n'
    const result = await observeDnsServiceJobs(Infinity,unit,true,sample(
      [start,next,next,live,successor],
      [listed,'','',another,''],
      [hit,empty,empty,{populated:true,pid:live.MainPID},empty],
    ))
    expect(result).toEqual({service:successor,drained:true})
  })

  it('ignores an unlisted mixed start frame and still requires the next fully listed cycle',async () => {
    const successor = retry(6).service
    const live = {...successor,SubState:'start',MainPID:successor.ExecMainPID,ControlGroup:start.ControlGroup,Job:'833',Result:'success',ExecMainCode:'0',ExecMainStatus:'0'}
    const result = await observeDnsServiceJobs(Infinity,unit,true,sample(
      [start,next,live,live,successor],
      [listed,'','','833 pdns.service start running\n',''],
      [hit,empty,{populated:true,pid:live.MainPID},{populated:true,pid:live.MainPID},empty],
    ))
    expect(result).toEqual({service:successor,drained:true})
  })

  it('never stops for a persistent mixed start or foreign mixed identity',async () => {
    const successor = retry(6).service
    const live = {...successor,SubState:'start',MainPID:successor.ExecMainPID,ControlGroup:start.ControlGroup,Job:'833',Result:'success',ExecMainCode:'0',ExecMainStatus:'0'}
    const wrong = [
      {...live,User:'other'}, {...live,FragmentPath:'/tmp/foreign.service'},
      {...live,NRestarts:'9'}, {...live,NRestarts:'6e0'}, {...live,MainPID:'777'}, {...live,Job:'foreign'},
    ]
    const cases = [
      sample([start,next,...Array<Service>(201).fill(live)], [listed,'',...Array<string>(201).fill('')],
        [hit,empty,...Array<Window>(201).fill({populated:true,pid:live.MainPID})]),
      ...wrong.map(item => sample([start,next,item],[listed,'',''],[hit,empty,{populated:true,pid:live.MainPID}])),
      sample([start,next,live],[listed,'',''],[hit,empty,{populated:true,pid:'777'}]),
    ]
    const inputs = await inspect(retry(5))
    for (const p of cases) {
      let stops = 0
      await expect(verifyVendorDnsPhase('quiesce',inputs,{
        capture:async () => { await observeDnsServiceJobs(Infinity,unit,true,p); return retry(5) },
        service:async () => retry(5).service,
        stop:async () => { stops++ },
      })).rejects.toThrow()
      expect(stops).toBe(0)
    }
  })

  it('requires the same listed job, cgroup PID and completed attempt; missed or reused transitions remain held',async () => {
    const cases = [
      sample([start,next,retry(6).service],[listed,'',''],[hit,empty,empty]), // Uncredited partial cycle, next cycle skipped.
      sample([start,next,next],[listed,'',listed],[hit,empty,empty]), // Reused job ID.
      sample([dead,next],[listed,''],[empty,empty]), // PID never witnessed running.
      sample([dead,{...start,Job:'831'}],[listed,listed],[empty,hit]),
      sample([dead,start],[listed,'831 pdns.service start running\n'],[empty,hit]),
      sample([dead,start],[listed,''],[empty,hit]), // List ID never joined the actual start.
      sample([dead,start,next],[listed,listed,''],[empty,empty,empty]),
      sample([dead,start,next],[listed,listed,''],[hit,empty,empty]), // Never one joined live frame.
      sample([dead,start],[listed,listed],[empty,{populated:true,pid:dead.ExecMainPID}]),
      sample([dead,{...start,NRestarts:'6'}],[listed,listed],[empty,hit]),
      sample([dead,{...start,ExecMainStartTimestampMonotonic:dead.ExecMainExitTimestampMonotonic}],[listed,listed],[empty,hit]),
      sample([dead,start,{...next,ExecMainPID:'777'}],[listed,listed,''],[empty,hit,empty]),
      sample([dead,start,{...next,ExecMainStartTimestampMonotonic:'4999'}],[listed,listed,''],[empty,hit,empty]),
      sample([dead,start,{...next,ExecMainStatus:'9'}],[listed,listed,''],[empty,hit,empty]),
      sample([dead,start,next],[listed,listed,listed],[empty,hit,empty]),
      sample([dead,start,next],[listed,listed,''],[empty,hit,hit]),
      sample([dead,{...start,Names:'pdns.service dns-alias.service'}],[listed,listed],[empty,hit]),
      sample([start],['832 alias.service start running\n'],[hit]),
      sample([dead,...Array<Service>(40).fill(start)],[listed,...Array<string>(40).fill(listed)],[empty,...Array<Window>(40).fill(hit)]),
    ]
    for (const ports of cases) await expect(observeDnsServiceJobs(Infinity,unit,true,ports)).rejects.toThrow('MIGRATION_REQUIRED')
    await expect(observeDnsServiceJobs(0,unit,true,transition())).rejects.toMatchObject({code:'SERVICE_DEADLINE'})
    await expect(observeDnsServiceJobs(Infinity,unit,false,transition())).rejects.toMatchObject({code:'SERVICE_JOB'})
  })

  it.each([
    '832 pdns.service stop running','832 pdns.service restart running','832 pdns.service reload running',
    '832 pdns.service start waiting','832 pdns@fixture.service start running','832 pdns@.service start running',
    '832 pdns.service start running\n833 pdns.service start running',
    '832 other.service start running\n832 pdns.service start running','73 unrelated.service reload running',
    '832 pdns.service start running trailing','832 pdns.service start','0 pdns.service start running',
    '4294967296 pdns.service start running','832 unrelated pdns.service running',
  ])('refuses unsupported or ambiguous native list-jobs output %s',async row => {
    await expect(observeDnsServiceJobs(Infinity,unit,true,sample([dead],[row],[empty]))).rejects.toMatchObject({code:'SERVICE_JOB'})
  })

  it('issues no stop if a new job, changed process or populated cgroup races the final read',async () => {
    const state = retry(4), inputs = await inspect(state)
    const cases = [
      sample([],[listed],[]),
      sample([dead,dead],['',listed],[empty]),
      sample([{...dead,Job:'832'}],[''],[]),
      sample([dead,next],['',''],[empty]),
      sample([dead],[''],[hit]),
    ]
    for (const ports of cases) {
      let stops = 0
      await expect(verifyVendorDnsPhase('quiesce',inputs,{
        capture:async () => state, service:() => readDnsIdleBoundary(Infinity,unit,ports),stop:async () => { stops++ },
      })).rejects.toThrow('MIGRATION_REQUIRED')
      expect(stops).toBe(0)
    }
  })

  it('recaptures both inventories after a witnessed boundary transition before stopping',async () => {
    const state = retry(5), inputs = await inspect(state), idle = stopped(state)
    let reads = 0, stops = 0, boundaries = 0
    const ports = sample([dead,start,start,next], [listed,listed,listed,'',''], [empty,hit,empty,empty])
    const result = await verifyVendorDnsPhase('quiesce',inputs,{
      capture:async () => { reads++; return stops ? idle : state },
      service:async (allowTransition = false) => {
        boundaries++
        if (boundaries === 1) {
          expect(allowTransition).toBe(true)
          return readDnsDecisionBoundary(Infinity,unit,ports)
        }
        return readDnsIdleBoundary(Infinity,unit,boundary(stops ? idle.service : state.service))
      },
      stop:async () => { expect(reads).toBe(4); expect(boundaries).toBe(2); stops++ },
    })
    expect(result).toBe('xpanel-pdns-vendor-pristine-v1')
    expect(stops).toBe(1)
  })

  it('does not stop on a foreign job, changed job ID, failed transition or drift after a deferred boundary',async () => {
    const state = retry(5), inputs = await inspect(state)
    const bad = [
      sample([],['832 pdns.service stop running'],[]),
      sample([dead],[listed,'833 pdns.service start running'],[empty]),
      sample([dead,start,next],[listed,listed,listed,''],[empty,empty,empty]),
    ]
    for (const ports of bad) {
      let stops = 0
      await expect(verifyVendorDnsPhase('quiesce',inputs,{
        capture:async () => state,
        service:() => readDnsDecisionBoundary(Infinity,unit,ports),
        stop:async () => { stops++ },
      })).rejects.toThrow()
      expect(stops).toBe(0)
    }
    let reads = 0, stops = 0
    const drift = structuredClone(state); drift.boot = '00000000-0000-4000-8000-000000000002'
    await expect(verifyVendorDnsPhase('quiesce',inputs,{
      capture:async () => ++reads > 2 ? drift : state,
      service:async () => null,
      stop:async () => { stops++ },
    })).rejects.toThrow()
    expect(stops).toBe(0)
  })

  it('waits for all concurrent observations and never stops when one fails',async () => {
    const state = retry(4), inputs = await inspect(state)
    for (const failed of ['service','jobs','cgroup'] as const) {
      const completed:string[] = []
      let stops = 0
      const finish = async (name:string) => { await new Promise(resolve => setTimeout(resolve,2)); completed.push(name) }
      const ports = {
        service:async () => { if (failed === 'service') { completed.push('service'); throw Error('unavailable') }; await finish('service'); return dead },
        jobs:async () => { if (failed === 'jobs') { completed.push('jobs'); throw Error('unavailable') }; await finish('jobs'); return '' },
        cgroup:async () => { if (failed === 'cgroup') { completed.push('cgroup'); throw Error('unavailable') }; await finish('cgroup'); return empty },
        pause:async () => {},
      }
      await expect(verifyVendorDnsPhase('quiesce',inputs,{
        capture:async () => { await observeDnsServiceJobs(Infinity,unit,true,ports); return state },
        service:async () => dead,stop:async () => { stops++ },
      })).rejects.toThrow()
      expect(completed.sort()).toEqual(['cgroup','jobs','service'])
      expect(stops).toBe(0)
    }
  })
})

describe('prepared DNS refusal reporting', () => {
  const base = 'INSTALL_RESUME_DNS_MIGRATION_REQUIRED'
  async function denial(work: Promise<unknown>,code: string) {
    await expect(work).rejects.toMatchObject({message:base,code})
    await expect(work.catch(dnsRefusalMessage)).resolves.toBe(base+' '+code)
  }
  it('distinguishes empty attribution, foreign members and a previous invocation without exposing their values',async () => {
    const files = (procs:string) => async (name:string) => name === 'cgroup.procs' ? procs : name === 'cgroup.events' ? 'populated 1\n' : 'nr_descendants 0\n'
    await denial(readDnsCgroupWindow(files('')),'CGROUP_NO_PID')
    await denial(readDnsCgroupWindow(files('904\n905\n')),'CGROUP_MEMBER')
    const s = retry().service
    await denial(coherentDnsService(Infinity,unit,true,{
      service:async () => s, cgroup:async () => ({populated:true,pid:s.ExecMainPID}),
    }),'SERVICE_PRIOR_PID')
  })
  it('keeps native errors, spoofed codes, private command text and paths out of stderr',async () => {
    const raw = Object.assign(new Error('private command and stderr at /private/path'),{code:'CGROUP_MEMBER'})
    expect(dnsRefusalMessage(raw)).toBe(base)
    expect(dnsRefusalMessage({code:'SERVICE_JOB\nforged'})).toBe(base)
    await denial(coherentDnsService(Infinity,unit,true,{service:async () => retry().service,cgroup:async () => { throw raw }}),'CGROUP_READ')
  })
  it('keeps a mismatch at the write boundary and an unrelated host task independently identifiable',async () => {
    const state = retry(), phase = feed([state,state])
    await denial(verifyVendorDnsPhase('quiesce','0'.repeat(64),phase.ports),'SOURCE_BINDING')
    expect(phase.counts().stops).toBe(0)
    const host = procFixture()
    host.secondaryUid = '700 700 700 '+uid
    await denial(assertDnsHostProcesses(uid,Infinity,host.port),'TASK_CREDENTIALS')
  })
})

describe('read-only service sampling at the vendor restart boundary', () => {
  const dead = retry(4).service, next = retry(5).service
  const start = {...next,SubState:'start',MainPID:next.ExecMainPID,ControlGroup:'/system.slice/pdns.service',Job:'832',Result:'success',ExecMainCode:'0',ExecMainStatus:'0'}
  const hit = {populated:true,pid:next.ExecMainPID}, empty = {populated:false}
  function inputs(services: typeof dead[],windows: (typeof hit | typeof empty)[]) {
    let pauses = 0, reads = 0
    return {counts:() => ({pauses,reads}),ports:{
      service:async () => { reads++; const s = services.shift(); if (!s) throw Error('unexpected service'); return s },
      cgroup:async () => { const w = windows.shift(); if (!w) throw Error('unexpected cgroup'); return w },
      pause:async () => { pauses++ },
    }}
  }

  it('requires a corroborated completed failure, followed by a fresh empty cgroup',async () => {
    for (const first of [start,dead]) {
      const sample = inputs([first,start,next],[hit,empty])
      await expect(coherentDnsService(Infinity,unit,true,sample.ports)).resolves.toEqual(next)
      expect(sample.counts()).toEqual({reads:3,pauses:1})
    }
    const exited = inputs([start,next],[empty,empty])
    await expect(coherentDnsService(Infinity,unit,true,exited.ports)).resolves.toEqual(next)
    expect(exited.counts()).toEqual({reads:2,pauses:0})
  })

  it('never waits on an active daemon, unknown PID, changed policy, intervening failure or different invocation',async () => {
    const changes = [{MainPID:hit.pid,ActiveState:'active',SubState:'running'},{ExecMainPID:'444'},{NRestarts:'6'},
      {ExecMainStatus:'9'},{ExecMainStartTimestampMonotonic:'4000'},{DropInPaths:'/etc/override.conf'},{Restart:'always'},
      {FragmentPath:'/lib/systemd/system/pdns.service'},{Job:'999'},{ControlPID:'321'}]
    for (const change of changes) {
      const sample = inputs([dead,{...next,...change}],[hit])
      await expect(coherentDnsService(Infinity,unit,true,sample.ports)).rejects.toThrow('MIGRATION_REQUIRED')
      expect(sample.counts()).toEqual({reads:2,pauses:0})
    }
    const unchanged = inputs([dead,dead],[hit])
    await expect(coherentDnsService(Infinity,unit,true,unchanged.ports)).rejects.toThrow('MIGRATION_REQUIRED')
    const wrongStart = inputs([{...start,MainPID:'999'}],[hit])
    await expect(coherentDnsService(Infinity,unit,true,wrongStart.ports)).rejects.toThrow('MIGRATION_REQUIRED')
  })

  it('keeps the monotonic deadline, bounds both observation loops and never retries after stop',async () => {
    const expired = inputs([dead],[hit])
    await expect(coherentDnsService(0,unit,true,expired.ports)).rejects.toThrow('MIGRATION_REQUIRED')
    const postStop = inputs([dead],[hit])
    await expect(coherentDnsService(Infinity,unit,false,postStop.ports)).rejects.toThrow('MIGRATION_REQUIRED')
    expect(postStop.counts()).toEqual({reads:1,pauses:0})
    const stuck = inputs([dead,...Array(9).fill(start)],[hit])
    await expect(coherentDnsService(Infinity,unit,true,stuck.ports)).rejects.toThrow('MIGRATION_REQUIRED')
    expect(stuck.counts().pauses).toBe(8)
    const epochs = [4,5,6,7,8].map(epoch => retry(epoch).service)
    const repeat = inputs([...epochs],epochs.slice(1).map(s => ({populated:true,pid:s.ExecMainPID})))
    await expect(coherentDnsService(Infinity,unit,true,repeat.ports)).rejects.toThrow('MIGRATION_REQUIRED')
    expect(repeat.counts().reads).toBe(4)
  })

  it('accepts only an identified single member, rejects malformed cgroup data, subgroups and unreadable inputs',async () => {
    function files(before:string,events:string,after:string,children:string) {
      const values: Record<string,string[]> = {'cgroup.procs':[before,after],'cgroup.events':[events],'cgroup.stat':[children]}
      return async (path:string) => { const value = values[path]?.shift(); if (value === undefined) throw Error('unavailable'); return value }
    }
    const zero = 'nr_descendants 0\n', live = 'populated 1\nfrozen 0\n'
    await expect(readDnsCgroupWindow(files('','populated 0\n','',''))).resolves.toEqual(empty)
    await expect(readDnsCgroupWindow(files('',live,hit.pid+'\n',zero))).resolves.toEqual(hit)
    await expect(readDnsCgroupWindow(files(hit.pid+'\n','populated 0\n','',zero))).resolves.toEqual(hit)
    for (const read of [files('',live,'',zero),files('99\n',live,hit.pid+'\n',zero),
      files('99\n',live,'99\n','nr_descendants 1\n'),files('','populated 0\npopulated 1\n','',''),
      files('','unknown\n','',''),async () => { throw Error('denied') }]) {
      await expect(readDnsCgroupWindow(read)).rejects.toThrow()
    }
  })
})

function feed(samples: ReturnType<typeof fixture>[], serviceSamples = samples.map(s => s.service), stopFails = false) {
  let reads = 0, serviceReads = 0, stops = 0
  return {
    ports:{
      capture:async () => { if (reads >= samples.length) throw Error('unexpected capture'); return samples[reads++]! },
      service:async () => { if (serviceReads >= serviceSamples.length) throw Error('unexpected service'); return serviceSamples[serviceReads++]! },
      stop:async () => { stops++; if (stopFails) throw Error('stop outcome unknown') },
    },
    counts:() => ({reads,serviceReads,stops}),
  }
}

async function inspect(state: ReturnType<typeof fixture>) {
  const phase = feed([state,state])
  const proof = await verifyVendorDnsPhase('inspect',undefined,phase.ports)
  expect(proof).toMatch(/^xpanel-pdns-vendor-inspected-v2 [a-f0-9]{64}$/)
  expect(phase.counts().stops).toBe(0)
  return proof.split(' ')[1]!
}

describe('prepared vendor DNS retry admission', () => {
  it('inspects different completed retries without stopping and stops once only at the final write boundary', async () => {
    const binding = await inspect(retry(4))
    const last = retry(9), after = stopped(last)
    const final = feed([retry(7),retry(8),after,after],[last.service,after.service])
    await expect(verifyVendorDnsPhase('quiesce',binding,final.ports)).resolves.toBe('xpanel-pdns-vendor-pristine-v1')
    expect(final.counts()).toEqual({reads:4,serviceReads:2,stops:1})
  })

  it('rechecks inert vendor state without issuing any systemd operation', async () => {
    const state = fixture(), binding = await inspect(state), final = feed([state,state])
    await expect(verifyVendorDnsPhase('quiesce',binding,final.ports)).resolves.toBe('xpanel-pdns-vendor-pristine-v1')
    expect(final.counts().stops).toBe(0)
  })

  const invalid: [string,(s: ReturnType<typeof retry>) => void][] = [
    ['queued or unprojected auto restart',s => {s.service.SubState = 'auto-restart-queued'}],
    ['unknown result',s => {s.service.Result = 'resources'}],
    ['signal exit',s => {s.service.ExecMainCode = '2'}],
    ['success exit',s => {s.service.ExecMainStatus = '0'}],
    ['arbitrary exit code',s => {s.service.ExecMainStatus = '7'}],
    ['no previous PID',s => {s.service.ExecMainPID = '0'}],
    ['no repeat yet',s => {s.service.NRestarts = '0'}],
    ['invalid exit times',s => {s.service.ExecMainExitTimestampMonotonic = '1'}],
    ['unexpected daemon user',s => {s.service.User = 'root'}],
    ['unsupported restart policy',s => {s.service.Restart = 'always'}],
    ['different restart delay',s => {s.service.RestartUSec = '200ms'}],
    ['unexpected enablement',s => {s.service.UnitFileState = 'disabled'}],
    ['current start job',s => {s.service.Job = '888'}],
    ['pending instance job',s => {s.jobs.push('123 pdns@secondary.service start waiting')}],
    ['replaced daemon matching forged local metadata',s => {s.daemon.sha256 = '1'.repeat(64); s.daemon.md5 = s.daemon.vendorMd5 = '2'.repeat(32)}],
    ['daemon binary writable by service',s => {s.daemon.mode = 0o775}],
    ['active child',s => {s.service.MainPID = '302'}],
    ['new DNS record',s => {s.supermaster.size = 1}],
  ]
  it.each(invalid)('refuses %s before any stop',async (_name,change) => {
    const state = retry(), binding = await inspect(state)
    change(state)
    for (const phase of ['inspect','quiesce']) {
      const simulated = feed([state,state])
      await expect(verifyVendorDnsPhase(phase,phase === 'inspect' ? undefined : binding,simulated.ports)).rejects.toThrow()
      expect(simulated.counts().stops).toBe(0)
    }
  })

  it('holds source, inode, policy or boot changes across the two phases',async () => {
    const binding = await inspect(retry())
    const changes: ((s: ReturnType<typeof retry>) => void)[] = [
      s => {s.supermaster.identity = 'new empty file'},
      s => {s.files[unit].identity = 'replacement even if bytes match'},
      s => {s.daemon.identity = 'replacement executable'},
      s => {s.ancestry['/var/lib'].identity = 'different trusted parent'},
      s => {s.foreign['/etc/bind'] = {identity:'new empty directory',acl:'user::rwx\ngroup::r-x\nother::r-x'}},
      s => {s.boot = '00000000-0000-4000-8000-000000000002'},
      s => {Object.assign(s.service,{ActiveState:'inactive',SubState:'dead'})},
    ]
    for (const change of changes) {
      const next = retry()
      change(next)
      const simulated = feed([next,next])
      await expect(verifyVendorDnsPhase('quiesce',binding,simulated.ports)).rejects.toThrow()
      expect(simulated.counts().stops).toBe(0)
    }
  })

  it('holds a start racing the final unit lookup, without asking systemd to stop',async () => {
    const state = retry(), binding = await inspect(state)
    const current = {...state.service,ActiveState:'active',SubState:'running',MainPID:'905'}
    const simulated = feed([state,state],[current])
    await expect(verifyVendorDnsPhase('quiesce',binding,simulated.ports)).rejects.toThrow()
    expect(simulated.counts().stops).toBe(0)
  })

  it('requires original file identities, the same completed attempt and a stable idle census after stop',async () => {
    const state = retry(), binding = await inspect(state)
    const changes: ((s: ReturnType<typeof retry>) => void)[] = [
      s => {s.files[root+'/pdns.conf'].identity = 'same bytes at a changed inode'},
      s => {s.dirs[data+'/zones.slave.d'].names.push('unexpected-zone')},
      s => {s.noDaemon = false},
      s => {s.service.ExecMainPID = '888'},
      s => {Object.assign(s.service,{ActiveState:'activating',SubState:'auto-restart'})},
    ]
    for (const change of changes) {
      const after = stopped(state), changed = structuredClone(after)
      change(changed)
      const simulated = feed([state,state,after,changed],[state.service,after.service])
      await expect(verifyVendorDnsPhase('quiesce',binding,simulated.ports)).rejects.toThrow()
      expect(simulated.counts().stops).toBe(1)
    }
    const uncertain = feed([state,state],[state.service],true)
    await expect(verifyVendorDnsPhase('quiesce',binding,uncertain.ports)).rejects.toThrow('stop outcome unknown')
    expect(uncertain.counts()).toEqual({reads:2,serviceReads:1,stops:1})
  })
})

function procFixture() {
  const closed: number[] = [], readTids: string[] = [], count = new Map<string,number>()
  const fds: Record<string,number> = {'/proc/300':10,'/proc/self/fd/10/task/300':11,'/proc/self/fd/10/task/301':12}
  const result = {
    tids:['300','301'],closed,readTids,secondaryUid:'700 700 700 700',secondaryName:'app-thread',replaceTask:false,
    foreignNamespace:'',badInit:false,denied:false,missingStatus:false,
    port:{
      directory:async (path: string): Promise<{fd:number;close:() => Promise<void>}> => {
        const fd = fds[path]
        if (!fd) throw Error('unknown fixture directory')
        return {fd,close:async () => { closed.push(fd) }}
      },
      list:async (path: string,_limit: number): Promise<string[]> => {
        if (path === '/proc') return ['self','300']
        if (path === '/proc/self/fd/10/task') return result.tids
        throw Error('unknown fixture listing')
      },
      link:async (path: string): Promise<string> => {
        const ns = path.split('/').at(-1)!
        return ns+':['+(result.foreignNamespace === ns && path.startsWith('/proc/self/') ? 2 : 1)+']'
      },
      text:async (path: string,_limit: number): Promise<string> => {
        if (path === '/proc/1/comm') return result.badInit ? 'other\n' : 'systemd\n'
        const match = /^\/proc\/self\/fd\/(10|11|12)\/(stat|status)$/.exec(path)
        if (!match) throw Error('unknown fixture file')
        const tid = match[1] === '12' ? '301' : '300'
        if (match[2] === 'status') {
          readTids.push(tid)
          if (tid === '301' && (result.denied || result.missingStatus)) throw Object.assign(Error('unreadable task'),{code:result.denied ? 'EACCES' : 'ENOENT'})
          return 'Name:\t'+(tid === '301' ? result.secondaryName : 'owner')+'\nUid:\t'+(tid === '301' ? result.secondaryUid : '700 700 700 700')+'\nGroups:\t'+gid+'\n'
        }
        const calls = count.get(path) ?? 0
        count.set(path,calls+1)
        return tid+' (thread) S '+'0 '.repeat(18)+(tid === '301' && result.replaceTask && calls ? '200' : '100')
      },
    },
  }
  return result
}

describe('prepared DNS host task census', () => {
  it('inspects every pinned task UID including FSUID and ignores a read-only group membership alone',async () => {
    const healthy = procFixture()
    await expect(assertDnsHostProcesses(uid,Infinity,healthy.port)).resolves.toBeUndefined()
    expect(healthy.readTids).toEqual(['300','301'])
    expect(healthy.closed).toEqual([11,12,10])
    for (const replacement of [String(uid)+' 700 700 700','700 '+uid+' 700 700','700 700 '+uid+' 700','700 700 700 '+uid]) {
      const foreign = procFixture()
      foreign.secondaryUid = replacement
      await expect(assertDnsHostProcesses(uid,Infinity,foreign.port)).rejects.toThrow()
      expect(foreign.closed).toEqual([11,12,10])
    }
  })

  it('requires a host system manager and matching namespace identities',async () => {
    for (const namespace of ['pid','mnt','user','net']) {
      const source = procFixture()
      source.foreignNamespace = namespace
      await expect(assertDnsHostProcesses(uid,Infinity,source.port)).rejects.toThrow()
      expect(source.closed).toEqual([])
    }
    const source = procFixture()
    source.badInit = true
    await expect(assertDnsHostProcesses(uid,Infinity,source.port)).rejects.toThrow()
  })

  it('holds reused, unreadable, named daemon and missing-task views without losing descriptors',async () => {
    const changes: ((source: ReturnType<typeof procFixture>) => void)[] = [
      s => {s.replaceTask = true},s => {s.denied = true},s => {s.missingStatus = true},
      s => {s.secondaryUid = '700 700'},s => {s.secondaryName = 'pdns_server'},s => {s.secondaryName = 'named'},
    ]
    for (const change of changes) {
      const source = procFixture()
      change(source)
      await expect(assertDnsHostProcesses(uid,Infinity,source.port)).rejects.toThrow()
      expect(source.closed).toEqual([11,12,10])
    }
    const oversized = procFixture()
    oversized.tids = Array<string>(4097).fill('301')
    await expect(assertDnsHostProcesses(uid,Infinity,oversized.port)).rejects.toThrow()
    expect(oversized.closed).toEqual([10])
    const empty = procFixture()
    empty.tids = []
    await expect(assertDnsHostProcesses(uid,Infinity,empty.port)).rejects.toThrow()
  })
})

describe('prepared DNS file and directory access', () => {
  const basic = 'user::rwx\ngroup::r-x\nother::r-x\n'

  it('reads the held descriptor, includes default entries and bounds the ACL output',async () => {
    const calls: unknown[][] = []
    const observed = await readPinnedDnsAcl(11,0o755,async (tool: string,args: string[],cap: number) => {
      calls.push([tool,args,cap])
      return basic+'\n'
    })
    expect(observed).toBe(basic.trimEnd())
    expect(calls).toEqual([['getfacl',['--omit-header','--absolute-names','--numeric','--no-effective','/proc/'+process.pid+'/fd/11'],4096]])
    expect(minimalDnsAcl('user::rw-\ngroup::r--\nother::---\n',0o640)).toBe('user::rw-\ngroup::r--\nother::---')
    expect(minimalDnsAcl('user::rw-\ngroup::---\nother::---\n',0o600)).toBe('user::rw-\ngroup::---\nother::---')
  })

  it.each([
    ['named UID',basic.replace('group::','user:120:rw-\ngroup::')],
    ['named GID',basic.replace('other::','group:121:r-x\nother::')],
    ['access mask',basic.replace('other::','mask::r-x\nother::')],
    ['inherited default',basic+'default:user::rwx\ndefault:group::r-x\ndefault:other::r-x\n'],
    ['named default',basic+'default:user:120:rwx\n'],
    ['wrong mode',basic.replace('group::r-x','group::r--')],
    ['malformed extra line',basic+'# unknown\n'],
    ['duplicate entry',basic+'other::r-x\n'],
  ])('holds %s even with unchanged stat mode',async (_label,acl) => {
    await expect(readPinnedDnsAcl(11,0o755,async () => acl)).rejects.toThrow()
  })
})
