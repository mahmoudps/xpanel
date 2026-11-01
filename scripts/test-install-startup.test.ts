import { describe, expect, it } from 'vitest'
import { ensurePreparedInstallParticipants as startParticipants, settlePreparedInstallReadiness, REQUIRED_INSTALL_STARTUP_SOURCES, verifyPreparedInstallStartupSources } from './install-startup.mjs'
import type { InstallParticipant, InstallStartupPorts, InstallReadinessSettlingPorts } from './install-startup.mjs'
async function ensurePreparedInstallParticipants(ports:InstallStartupPorts & InstallReadinessSettlingPorts<{ready:true}>) {
 const started=await startParticipants(ports)
 const observation=started.requiresSettling?await settlePreparedInstallReadiness(ports):await ports.ready()
 return {...started,observation}
}
function fixture(initial:readonly InstallParticipant[] = []) {
  let now=0, held=false, current=true, readyFailures=0, delayCount=0
  const events:string[]=[], starts:InstallParticipant[]=[], intents:InstallParticipant[]=[], rows=new Map<InstallParticipant,Record<string,string>>()
  for(const unit of ['xpanel-agent.service','xpanel-api.service'] as const) rows.set(unit,{Id:unit,LoadState:'loaded',FragmentPath:'/etc/systemd/system/'+unit,DropInPaths:'',NeedDaemonReload:'no',Job:'',ControlPID:'0',MainPID:initial.includes(unit)?'100':'0',ActiveState:initial.includes(unit)?'active':'inactive',SubState:initial.includes(unit)?'running':'dead',ControlGroup:initial.includes(unit)?'/system.slice/'+unit:'',InvocationID:initial.includes(unit)?'a'.repeat(32):''})
  const hooks:{start?:(unit:InstallParticipant)=>Promise<void>;intent?:()=>void;lock?:()=>void;ready?:()=>void}={}
  const ports:InstallStartupPorts & InstallReadinessSettlingPorts<{ready:true}>={clock:{now:()=>new Date(now)},
    observe:async()=>{events.push('observe');return [...rows.values()].map(row=>({...row}))},
    withStartAuthority:async run=>{held=true;events.push('guard.enter');hooks.lock?.();try{await run()}finally{held=false;events.push('guard.exit')}},
    current:async()=>{if(!current)throw Object.assign(new Error('revoked'),{code:'REVOKED'});events.push('current')},
    recordIntent:async unit=>{expect(held).toBe(true);hooks.intent?.();intents.push(unit);events.push('intent:'+unit)},
    start:async unit=>{expect(held).toBe(true);events.push('start:'+unit);starts.push(unit);if(hooks.start)await hooks.start(unit);const row=rows.get(unit);if(!row)throw new Error('missing');Object.assign(row,{ActiveState:'active',SubState:'running',MainPID:'100',ControlGroup:'/system.slice/'+unit,InvocationID:'a'.repeat(32)})},
    recordObserved:async unit=>{expect(held).toBe(true);events.push('observed:'+unit)},
    ready:async()=>{expect(held).toBe(false);hooks.ready?.();events.push('ready');if(readyFailures-- >0)throw new Error('not ready');return {ready:true}},
    delay:async ms=>{expect(held).toBe(false);delayCount++;now+=ms},
  }
  return {ports,rows,hooks,events,starts,intents,revoke:()=>{current=false},failReady:(n:number)=>{readyFailures=n},advance:(ms:number)=>{now+=ms},delayCount:()=>delayCount}
}
describe('prepared install participant startup with isolated existing ports',()=>{
  it('starts only fixed Agent then API and releases the guard before readiness',async()=>{const f=fixture();const r=await ensurePreparedInstallParticipants(f.ports);expect(r.started).toEqual(['xpanel-agent.service','xpanel-api.service']);expect(f.events.indexOf('guard.exit')).toBeLessThan(f.events.indexOf('ready'));expect(f.intents).toEqual(f.starts)})
  it('preserves both preexisting running participants without service commands',async()=>{const f=fixture(['xpanel-agent.service','xpanel-api.service']);const r=await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual([]);expect(f.events).not.toContain('guard.enter');expect(r.preserved).toHaveLength(2)})
  it('starts only a missing Agent and preserves the API',async()=>{const f=fixture(['xpanel-api.service']);await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual(['xpanel-agent.service'])})
  it('starts only a missing API and preserves the Agent',async()=>{const f=fixture(['xpanel-agent.service']);await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual(['xpanel-api.service'])})
  it('reobserves after admission and does not replay a unit another actor started',async()=>{const f=fixture();f.hooks.lock=()=>{for(const row of f.rows.values())Object.assign(row,{ActiveState:'active',SubState:'running',MainPID:'200',ControlGroup:'/system.slice/'+row.Id,InvocationID:'b'.repeat(32)})};await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual([])})
  it('is idempotent after a completed startup',async()=>{const f=fixture();await ensurePreparedInstallParticipants(f.ports);await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual(['xpanel-agent.service','xpanel-api.service'])})
  it('refuses a foreign fragment before any dispatch',async()=>{const f=fixture();const row=f.rows.get('xpanel-api.service');if(!row)throw new Error();row.FragmentPath='/foreign/api.service';await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('INSTALL_STARTUP_UNIT_UNOWNED');expect(f.starts).toEqual([])})
  it('refuses drop-ins or reload drift before dispatch',async()=>{for(const field of ['DropInPaths','NeedDaemonReload']){const f=fixture();const row=f.rows.get('xpanel-api.service');if(!row)throw new Error();row[field]=field==='DropInPaths'?'/foreign.conf':'yes';await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('INSTALL_STARTUP_UNIT_UNOWNED');expect(f.starts).toEqual([])}})
  it('refuses pending systemd jobs before dispatch',async()=>{const f=fixture();const row=f.rows.get('xpanel-agent.service');if(!row)throw new Error();row.Job='123 start';await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('INSTALL_STARTUP_UNIT_UNOWNED');expect(f.starts).toEqual([])})
  it('refuses a residual process in an inactive unit',async()=>{const f=fixture();const row=f.rows.get('xpanel-agent.service');if(!row)throw new Error();row.MainPID='42';await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('INSTALL_STARTUP_TRANSITION_PENDING');expect(f.starts).toEqual([])})
  it('records intent before dispatch and stops when authority changes',async()=>{const f=fixture();f.hooks.intent=f.revoke;await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('revoked');expect(f.starts).toEqual([])})
  it('retains a preexisting participant and does not roll it back after a failed start',async()=>{const f=fixture(['xpanel-api.service']);f.hooks.start=async()=>{throw new Error('start failed')};await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('start failed');expect(f.rows.get('xpanel-api.service')?.ActiveState).toBe('active');expect(f.starts).toEqual(['xpanel-agent.service']);expect(f.events).toContain('guard.exit')})
  it('reports a lost reply without dispatching the remaining unit',async()=>{const f=fixture();f.hooks.start=async unit=>{const row=f.rows.get(unit);if(!row)throw new Error();Object.assign(row,{ActiveState:'active',SubState:'running',MainPID:'100',ControlGroup:'/system.slice/'+unit,InvocationID:'a'.repeat(32)});throw new Error('reply lost')};await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('reply lost');expect(f.starts).toEqual(['xpanel-agent.service'])})
  it('reobserves a lost-reply retry and starts only the still-missing participant',async()=>{const f=fixture();f.hooks.start=async unit=>{const row=f.rows.get(unit);if(!row)throw new Error();Object.assign(row,{ActiveState:'active',SubState:'running',MainPID:'100',ControlGroup:'/system.slice/'+unit,InvocationID:'a'.repeat(32)});throw new Error('reply lost')};await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow();delete f.hooks.start;await ensurePreparedInstallParticipants(f.ports);expect(f.starts).toEqual(['xpanel-agent.service','xpanel-api.service'])})
  it('settles real readiness only after startup guard retirement without repeating starts',async()=>{const f=fixture();f.failReady(2);const r=await ensurePreparedInstallParticipants(f.ports);expect(r.observation.ready).toBe(true);expect(f.delayCount()).toBe(2);expect(f.starts).toHaveLength(2)})
  it('keeps a failed readonly readiness result on preexisting units immediate',async()=>{const f=fixture(['xpanel-agent.service','xpanel-api.service']);f.failReady(1);await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('not ready');expect(f.delayCount()).toBe(0);expect(f.starts).toEqual([])})
  it('ends a bounded readiness wait without invented success or another start',async()=>{const f=fixture();f.failReady(1000);await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('INSTALL_STARTUP_READINESS_UNVERIFIED');expect(f.starts).toHaveLength(2);expect(f.delayCount()).toBe(300)})
  it('rechecks original authority between readiness attempts',async()=>{const f=fixture();f.failReady(2);f.hooks.ready=f.revoke;await expect(ensurePreparedInstallParticipants(f.ports)).rejects.toThrow('revoked');expect(f.delayCount()).toBe(0);expect(f.starts).toHaveLength(2)})
})

it('keeps all readiness and delay calls out of the startup-only helper',async()=>{const f=fixture();f.ports.ready=async()=>{throw new Error('health forbidden in startup')};f.ports.delay=async()=>{throw new Error('delay forbidden in startup')};await startParticipants(f.ports);expect(f.starts).toHaveLength(2);expect(f.events).not.toContain('ready')})

describe('authenticated startup source binding with isolated trusted reader',()=>{
 const files=()=>REQUIRED_INSTALL_STARTUP_SOURCES.map(path=>({path,sha256:'a'.repeat(64)}))
 it('requires and reads every actual startup/finalizer source binding',async()=>{const seen:string[]=[];await verifyPreparedInstallStartupSources({manifest:{files:files()}},async path=>{seen.push(path)});expect(seen).toEqual(REQUIRED_INSTALL_STARTUP_SOURCES)})
 it('refuses a missing startup module before any read/effect',async()=>{let reads=0;await expect(verifyPreparedInstallStartupSources({manifest:{files:files().filter(file=>file.path!=='scripts/install-startup.mjs')}},async()=>{reads++})).rejects.toThrow('INSTALL_STARTUP_RELEASE_CONTROLS_REQUIRED');expect(reads).toBe(0)})
 it('refuses duplicate or invalid startup helper digests',async()=>{for(const entries of [[...files(),files()[0]],files().map(file=>file.path==='scripts/lifecycle-services.mjs'?{...file,sha256:'invalid'}:file)])await expect(verifyPreparedInstallStartupSources({manifest:{files:entries}},async()=>undefined)).rejects.toThrow('INSTALL_STARTUP_RELEASE_CONTROLS_REQUIRED')})
 it('propagates a tampered installed-source rejection without any service dispatch',async()=>{let dispatches=0;await expect((async()=>{await verifyPreparedInstallStartupSources({manifest:{files:files()}},async path=>{if(path==='scripts/install-startup.mjs')throw new Error('installed source digest changed')});dispatches++})()).rejects.toThrow('installed source digest changed');expect(dispatches).toBe(0)})
})

it('does not probe health when the first awaited current check crosses the settling deadline',async()=>{
 const f=fixture();let probes=0
 f.ports.current=async()=>{f.advance(30_001)}
 f.ports.ready=async()=>{probes++;return {ready:true}}
 await expect(settlePreparedInstallReadiness(f.ports)).rejects.toThrow('INSTALL_STARTUP_READINESS_UNVERIFIED')
 expect(probes).toBe(0);expect(f.delayCount()).toBe(0)
})
it('does not schedule negative delay or a second probe when the retry current check expires',async()=>{
 const f=fixture();let checks=0,probes=0
 f.ports.current=async()=>{if(++checks===2)f.advance(30_001)}
 f.ports.ready=async()=>{probes++;throw new Error('not ready')}
 await expect(settlePreparedInstallReadiness(f.ports)).rejects.toThrow('INSTALL_STARTUP_READINESS_UNVERIFIED')
 expect(probes).toBe(1);expect(f.delayCount()).toBe(0)
})
