import { describe, expect, it } from 'vitest'
import { aptOwnsFrontendLock, configuredKernelPreDepends, otherKernelStatusSha256, validateKernelAudit, validateKernelClosure, validateKernelHook, validateKernelProviders, validateKernelSimulation } from './install-kernel-package.mjs'

// Captured protocol grammar, with synthetic tuples. No apt/dpkg, host reads or package changes.
const target = 'linux-modules-extra-6.8.0-90-generic'
const v = '6.8.0-90.91'
const dep = 'wireless-regdb'
const dv = '2024.07.04-0ubuntu1~24.04.1'
const root = '/var/lib/xpanel-kernel-inputs/snapshot.Example1'
const rows = (resume = true) => [
  {name:target,version:v,arch:'amd64',previous:resume ? v : null,previousMultiArch:resume ? 'none' : null,
    multiArch:'none',depends:'linux-image-6.8.0-90-generic | linux-image-unsigned-6.8.0-90-generic, wireless-regdb',preDepends:''},
  {name:dep,version:dv,arch:'all',previous:null,previousMultiArch:null,multiArch:'foreign',depends:'',preDepends:''},
]
function simulation(resume = true) {
  return [
    'Inst ' + dep + ' (' + dv + ' local-deb [all])' + (resume ? ' [' + target + ':amd64 ]' : ''),
    ...(resume ? [] : ['Inst ' + target + ' (' + v + ' local-deb [amd64])']),
    'Conf ' + dep + ' (' + dv + ' local-deb [all])',
    'Conf ' + target + ' (' + v + ' local-deb [amd64])',
  ].join('\n') + '\n'
}
function wire(resume = true) {
  const old = resume ? v + ' amd64 none =' : '- - none <'
  const dependency = dep + ' - - none < ' + dv + ' all foreign '
  const kernel = target + ' ' + old + ' ' + v + ' amd64 none '
  return ['VERSION 3','APT::Architecture=amd64','',dependency + root + '/dependency-' + dep + '.deb',
    ...(resume ? [] : [kernel + root + '/authenticated.deb']), dependency + '**CONFIGURE**', kernel + '**CONFIGURE**', ''].join('\n')
}
const audit = 'The following packages have been unpacked but not yet configured.\n'
  + 'They must be configured using dpkg --configure or the configure\n'
  + 'menu option in dselect for them to work:\n ' + target + ' Linux kernel extra modules\n\n'

describe('signed kernel package transaction admission', () => {
  it.each([false,true])('admits exactly the simulated and locked required installs, resume=%s', resume => {
    const set = rows(resume)
    validateKernelAudit(resume ? audit : '',set[0],resume ? 'resume' : 'fresh')
    validateKernelSimulation(simulation(resume),set)
    expect(validateKernelHook(wire(resume),set)).toEqual([
      {name:dep,path:root + '/dependency-' + dep + '.deb'},
      ...(resume ? [] : [{name:target,path:root + '/authenticated.deb'}]),
    ])
  })
  it('admits a target-only install and another mandatory dependency name without fixture-specific policy', () => {
    const [kernel] = rows(false)
    validateKernelClosure([kernel])
    const renamed = rows()
    renamed[0].depends = 'signed-data (>= 2)'
    renamed[1].name = 'signed-data'
    expect(validateKernelClosure(renamed)).toEqual([[dv,'>=','2']])
  })
  it('cannot use an alternative, recommendation, self-contained orphan or replacement kernel as new package authority', () => {
    for (const relation of [dep + ' | virtual-regdb', 'another-package', dep + ':i386']) {
      const set = rows(); set[0].depends = relation; set[1].depends = dep
      expect(() => validateKernelClosure(set)).toThrow('KERNEL_PLAN_UNRELATED_ARCHIVE')
    }
    const set = rows(); set[1].name = 'linux-image-generic'; set[0].depends = set[1].name
    expect(() => validateKernelClosure(set)).toThrow()
    expect(() => validateKernelClosure([...rows(),...rows()])).toThrow()
  })
  it('refuses to install a redundant provider even when it appears as an explicit mandatory relation', () => {
    expect(() => validateKernelProviders(rows(),'ii \tregdb, wireless-regdb (= 2)\n')).toThrow('KERNEL_PLAN_EXISTING_PROVIDER')
    expect(() => validateKernelProviders(rows(),'hi \twireless-regdb\n')).toThrow('KERNEL_PLAN_EXISTING_PROVIDER')
    validateKernelProviders(rows(),'ii \tregdb, another-package\n')
  })
  it('rejects fresh target audit on resume-only state, mixed/stale audits and empty reports for iU', () => {
    for (const output of ['',audit + ' foreign-pkg second package\n',audit.replace(target,dep),audit.replace('unpacked','half configured')]) {
      expect(() => validateKernelAudit(output,rows()[0],'resume')).toThrow()
    }
    expect(() => validateKernelAudit(audit,rows()[0],'fresh')).toThrow()
    expect(() => validateKernelAudit(audit,rows(false)[0],'resume')).toThrow()
  })
  it('admits only target configure in the APT iU plan and refuses extra actions or version changes', () => {
    const input = simulation()
    for (const bad of [input.replace(/^Conf linux-modules[^\n]*\n/m,''),input + 'Remv other [1]\n',input + 'Purg other [1]\n',
      input + 'Conf other (1 local-deb [amd64])\n',input.replace('('+v+' local-deb','(0.1 local-deb'),input.replace('[all]','[i386]'),
      input.replace(':'+ 'amd64 ]',':amd64 foreign:amd64 ]'),input.replace('Conf '+dep,'Conf '+target),
      input.replace('Conf '+dep,'Unknown '+dep),input.replace('local-deb [all]','wrong-origin-without-architecture')]) {
      expect(() => validateKernelSimulation(bad,rows())).toThrow()
    }
  })
  it('does not reinterpret a dropped fresh unpack or a partial reinstall as the requested APT action', () => {
    expect(() => validateKernelSimulation(simulation(true),rows(false))).toThrow()
    expect(() => validateKernelHook(wire(true),rows(false))).toThrow()
    expect(() => validateKernelSimulation('Inst '+target+' ['+v+'] ('+v+' local-deb [amd64])\n'+simulation(),rows())).toThrow()
    const bad=wire().replace('\n\n','\n\n'+target+' '+v+' amd64 none = '+v+' amd64 none '+root+'/authenticated.deb\n')
    expect(() => validateKernelHook(bad,rows())).toThrow()
    for (const override of ['Dir=/some/other/root','DPkg::Options::=--root=/elsewhere','Dir::State::status=/scratch/status']) {
      expect(() => validateKernelHook(wire().replace('APT::Architecture=amd64','APT::Architecture=amd64\n'+override),rows())).toThrow()
    }
    const only=[rows()[0]]
    validateKernelSimulation('Conf '+target+' ('+v+' local-deb [amd64])\n',only)
    expect(validateKernelHook('VERSION 3\nAPT::Architecture=amd64\n\n'+target+' '+v+' amd64 none = '+v+' amd64 none **CONFIGURE**\n',only)).toEqual([])
  })
  it('requires a previously configured positive direct Pre-Depends before a separate target unpack', () => {
    const present=(n:string)=>['ii ',n,'3','all','no']
    const compare=(a:string,op:string,b:string)=>a==='3'&&op==='>='&&b==='2'
    configuredKernelPreDepends('kernel-helper (>= 2)',present,compare)
    for (const clause of ['kernel-helper | second','kernel-helper:arm64','kernel-helper (>= 4)']) {
      expect(() => configuredKernelPreDepends(clause,present,compare)).toThrow()
    }
    expect(() => configuredKernelPreDepends('kernel-helper',()=>null,compare)).toThrow()
    expect(() => configuredKernelPreDepends('kernel-helper',()=>['iU ','kernel-helper','3','all','no'],compare)).toThrow()
  })
  it('binds every non-target status field, tolerates paragraph ordering and refuses trigger/configuration backlog', () => {
    const kernel='Package: '+target+'\nStatus: install ok unpacked\nArchitecture: amd64\nVersion: '+v
    const other='Package: existing\nStatus: hold ok installed\nArchitecture: all\nVersion: 1\nDescription: example\n more'
    const before=otherKernelStatusSha256(kernel+'\n\n'+other+'\n',target,true)
    expect(otherKernelStatusSha256(other+'\n\n'+kernel+'\n',target,true)).toBe(before)
    expect(otherKernelStatusSha256(other,target,false)).toBe(before)
    for (const change of ['Version: 2','Version: 1\nProvides: added']) {
      expect(otherKernelStatusSha256(kernel+'\n\n'+other.replace('Version: 1',change),target,true)).not.toBe(before)
    }
    for (const invalid of [other+'\nTriggers-Pending: initramfs',other.replace('ok installed','ok unpacked'),
      other.replace('ok installed','reinstreq installed'),other.replace('ok installed','ok triggers-awaited')]) {
      expect(()=>otherKernelStatusSha256(kernel+'\n\n'+invalid,target,true)).toThrow()
      expect(()=>otherKernelStatusSha256(invalid,target,false)).toThrow()
    }
    expect(()=>otherKernelStatusSha256(other,target,true)).toThrow()
  })
  it('requires the actual frontend inode and a full-file write lock owned by the APT ancestor', () => {
    const line = '9: POSIX  ADVISORY  WRITE 426 08:02:2001 0 EOF'
    const file = {dev:0x802n,ino:2001n}
    expect(aptOwnsFrontendLock([line],file,426)).toBe(true)
    for (const [from,to] of [['WRITE','READ'],['426','999'],['08:02','08:01'],['2001','2002'],['0 EOF','1 EOF'],['POSIX','FLOCK']]) {
      expect(aptOwnsFrontendLock([line.replace(from,to)],file,426)).toBe(false)
    }
  })
  it('checks actual hooked operations separately from an admitted simulation', () => {
    validateKernelSimulation(simulation(), rows())
    const input = wire()
    for (const bad of [input.replace('VERSION 3','VERSION 2'),input.replace('= ' + v,'> '+v),
      input.replace(' all foreign ', ' i386 foreign '),input.replace('none <','none >'),
      input.replace('**CONFIGURE**','**REMOVE**'),input.replace(root+'/dependency-'+dep+'.deb','relative.deb'),
      input.replace('**CONFIGURE**','**ERROR**'),input.replace(/^[^\n]+dependency-wireless-regdb\.deb\n/m,''),
      input + dep + ' - - none < '+dv+' all foreign **CONFIGURE**\n',input.replace(' amd64 none =',' amd64 foreign =')]) {
      expect(() => validateKernelHook(bad,rows())).toThrow()
    }
  })
})
