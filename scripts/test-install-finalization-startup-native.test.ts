import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parseInstallParticipantStartContract, parsePreparedInstallUnitFile, assertPreparedInstallEnvironmentFile, startPreparedInstallParticipant, awaitPreparedInstallServiceChildren } from './lifecycle-services.mjs'
import { assertInstallFinalizationStartupScope, assertInstallFinalizationStartupRetirement } from './install-finalization-native.mjs'
describe('fixed native install startup boundary, no native commands',()=>{
 it('accepts only Type=simple without post-start or condition commands',()=>{expect(parseInstallParticipantStartContract('Type=simple\nExecStartPost=\nExecCondition=\n')).toEqual({type:'simple'})})
 it('refuses notify/oneshot readiness contracts instead of holding a host guard across them',()=>{for(const type of ['notify','oneshot','forking','exec'])expect(()=>parseInstallParticipantStartContract('Type='+type+'\nExecStartPost=\nExecCondition=\n')).toThrow('INSTALL_START_UNIT_CONTRACT_INVALID')})
 it('refuses post-start and condition hooks before effects',()=>{for(const row of ['ExecStartPost=/usr/bin/curl health','ExecCondition=/usr/bin/check']){const text=row.startsWith('ExecStartPost')?'Type=simple\n'+row+'\nExecCondition=\n':'Type=simple\nExecStartPost=\n'+row+'\n';expect(()=>parseInstallParticipantStartContract(text)).toThrow('INSTALL_START_UNIT_CONTRACT_INVALID')}})
 it('refuses duplicate/missing or injected unit contract fields',()=>{for(const text of ['Type=simple\nType=simple\nExecStartPost=\nExecCondition=\n','Type=simple\nExecStartPost=\n','Type=simple\nExecStartPost=\nExecCondition=\nUser=root\n'])expect(()=>parseInstallParticipantStartContract(text)).toThrow('INSTALL_START_UNIT_CONTRACT_INVALID')})
 it('refuses every unit outside the exact API/Agent pair before authority lookup',async()=>{for(const unit of ['nginx.service','xpanel-management-tls.timer','xpanel-upgrade.service','xpanel-api.service;id'])await expect(startPreparedInstallParticipant({},unit)).rejects.toThrow('INSTALL_START_UNIT_FORBIDDEN')})
 it('refuses structural startup capabilities before service IO',async()=>{for(const cap of [null,{},Object.freeze({startup:true})]){await expect(assertInstallFinalizationStartupScope(cap,'xpanel-api.service')).rejects.toThrow('INSTALL_STARTUP_SCOPE_REQUIRED');await expect(startPreparedInstallParticipant(cap,'xpanel-agent.service')).rejects.toThrow('INSTALL_STARTUP_SCOPE_REQUIRED');expect(()=>assertInstallFinalizationStartupRetirement(cap)).toThrow('INSTALL_STARTUP_SCOPE_REQUIRED')}})
 it('does not permit a forged retirement scope to drain or authorize service activity',async()=>{await expect(awaitPreparedInstallServiceChildren({})).rejects.toThrow('INSTALL_STARTUP_SCOPE_REQUIRED')})
 it('wires startup admission before the separate unchanged protocol entry and resets it before readiness',async()=>{
   const source=await readFile(new URL('./install-finalization-native.mjs',import.meta.url),'utf8')
   expect(source.indexOf("await startPreparedInstallScope(scope)")).toBeLessThan(source.lastIndexOf('return runPreparedInstallFinalization(ports(scope))'))
   expect(source).toContain("scope.phase = 'new'; scope.startupActive = false; scope.guard = null; scope.startupDeadline = null")
   expect(source).toContain('settlePreparedInstallReadiness')
   const startup=source.slice(source.indexOf('async function startPreparedInstallScope('),source.indexOf('async function allocateInstallJob('))
   expect(startup).not.toContain('captureInstallFinalizationReadiness')
 })
})

const startupReceipt={source:{root:'/opt/xpanel',version:'0.1.0'},runtime:{nodePath:'/usr/bin/node'}}
function participantUnit(role:'api'|'agent') {
 const shared='[Unit]\nDescription=xPanel participant\n'+(role==='agent'?'After=network-online.target systemd-sysctl.service systemd-tmpfiles-setup.service\nWants=network-online.target\n':'After=network-online.target xpanel-agent.service\nRequires=xpanel-agent.service\n')
 const service='[Service]\nType=simple\nUser='+(role==='agent'?'root':'xpanel')+'\nGroup='+(role==='agent'?'xpanel-agent':'xpanel')+'\nSupplementaryGroups='+(role==='agent'?'xpanel':'xpanel-agent')+'\nWorkingDirectory=/opt/xpanel/current\nEnvironment=NODE_ENV=production\nEnvironmentFile=/etc/xpanel/runtime.env\n'
 const extra=role==='agent'?'RuntimeDirectory=xpanel\nRuntimeDirectoryMode=0750\nRuntimeDirectoryPreserve=no\nEnvironment=XPANEL_GENERATIONS_DIR=/var/lib/xpanel/generations\nEnvironment=XPANEL_LOG_DIR=/var/log/xpanel\nEnvironment=XPANEL_RUN_DIR=/run/xpanel\nExecStartPre=/usr/bin/test -f /var/lib/xpanel/control.db\nExecStartPre=/usr/bin/install -d -o root -g root -m 0700 /run/xpanel/lifecycle-agent\nExecStartPre=/usr/bin/install -d -o xpanel -g xpanel -m 0700 /run/xpanel/lifecycle-api\n':'EnvironmentFile=/etc/xpanel/api.env\nReadWritePaths=/var/lib/xpanel /var/log/xpanel /run/xpanel/lifecycle-api\n'
 return shared+service+extra+'ExecStart=/usr/bin/node --max-old-space-size='+(role==='agent'?'64':'96')+' /opt/xpanel/current/apps/'+role+'/src/main.ts\nRestart=always\nRestartSec=2\nUMask=0007\n[Install]\nWantedBy=multi-user.target\n'
}
describe('supported prepared participant unit source',()=>{
 it('accepts the exact intended normal API and Agent startup inputs',()=>{for(const role of ['api','agent'] as const)expect(parsePreparedInstallUnitFile('xpanel-'+role+'.service',startupReceipt,participantUnit(role)).unit).toBe('xpanel-'+role+'.service')})
 it('refuses a different executable or injected Node options before start',()=>{for(const replace of ['/bin/sh -c run','/usr/bin/node --eval code'])expect(()=>parsePreparedInstallUnitFile('xpanel-api.service',startupReceipt,participantUnit('api').replace('/usr/bin/node --max-old-space-size=96',replace))).toThrow('INSTALL_START_UNIT_SOURCE_INVALID')})
 it('refuses a privileged API user or foreign working directory',()=>{for(const text of [participantUnit('api').replace('User=xpanel','User=root'),participantUnit('api').replace('WorkingDirectory=/opt/xpanel/current','WorkingDirectory=/tmp')])expect(()=>parsePreparedInstallUnitFile('xpanel-api.service',startupReceipt,text)).toThrow('INSTALL_START_UNIT_SOURCE_INVALID')})
 it('refuses foreign environment files or NODE_OPTIONS injection',()=>{for(const text of [participantUnit('api').replace('/etc/xpanel/api.env','/tmp/evil.env'),participantUnit('api').replace('Environment=NODE_ENV=production','Environment=NODE_OPTIONS=--require=/tmp/inject')])expect(()=>parsePreparedInstallUnitFile('xpanel-api.service',startupReceipt,text)).toThrow('INSTALL_START_UNIT_SOURCE_INVALID')})
 it('refuses extra start hooks or unrelated service dependencies',()=>{for(const text of [participantUnit('api').replace('Type=simple','Type=simple\nExecStartPost=/bin/sh -c run'),participantUnit('api').replace('Requires=xpanel-agent.service','Requires=foreign.service')])expect(()=>parsePreparedInstallUnitFile('xpanel-api.service',startupReceipt,text)).toThrow('INSTALL_START_UNIT_SOURCE_INVALID')})
 it('refuses an unexpected Agent pre-start command',()=>{expect(()=>parsePreparedInstallUnitFile('xpanel-agent.service',startupReceipt,participantUnit('agent').replace('ExecStartPre=/usr/bin/test -f /var/lib/xpanel/control.db','ExecStartPre=/bin/sh -c run'))).toThrow('INSTALL_START_UNIT_SOURCE_INVALID')})
})

describe('installed startup EnvironmentFile modes',()=>{
 it('accepts supported root:xpanel api.env0600 and0640',()=>{for(const mode of [0o600n,0o640n])expect(()=>assertPreparedInstallEnvironmentFile('/etc/xpanel/api.env',1000,{uid:0n,gid:1000n,mode},'XPANEL_API_HOST=127.0.0.1\n')).not.toThrow()})
 it('keeps runtime.env0640 required and rejects0600',()=>{expect(()=>assertPreparedInstallEnvironmentFile('/etc/xpanel/runtime.env',1000,{uid:0n,gid:1000n,mode:0o640n},'XPANEL_DB_PATH=/var/lib/xpanel/control.db\n')).not.toThrow();expect(()=>assertPreparedInstallEnvironmentFile('/etc/xpanel/runtime.env',1000,{uid:0n,gid:1000n,mode:0o600n},'')).toThrow('INSTALL_START_ENVIRONMENT_UNSAFE')})
 it('rejects a different owner or group for either supported API mode',()=>{for(const info of [{uid:1000n,gid:1000n,mode:0o600n},{uid:0n,gid:2000n,mode:0o640n}])expect(()=>assertPreparedInstallEnvironmentFile('/etc/xpanel/api.env',1000,info,'')).toThrow('INSTALL_START_ENVIRONMENT_UNSAFE')})
})
