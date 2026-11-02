import type { InstallFinalizationPorts } from './install-finalization.mjs'
export type InstallParticipant = 'xpanel-api.service'|'xpanel-agent.service'
export interface InstallStartupPorts {
 observe():Promise<readonly Readonly<Record<string,string>>[]>
 withStartAuthority(run:()=>Promise<void>):Promise<void>
 current():Promise<void>
 recordIntent(unit:InstallParticipant):Promise<void>
 start(unit:InstallParticipant):Promise<void>
 recordObserved(unit:InstallParticipant,state:Readonly<Record<string,string>>):Promise<void>
}
export interface InstallReadinessSettlingPorts<T> {clock:InstallFinalizationPorts['clock'];current():Promise<void>;ready():Promise<T>;delay(ms:number):Promise<void>}
export const INSTALL_PARTICIPANTS:readonly InstallParticipant[]
export function ensurePreparedInstallParticipants(ports:InstallStartupPorts):Promise<Readonly<{started:readonly InstallParticipant[];preserved:readonly InstallParticipant[];requiresSettling:boolean}>>
export function settlePreparedInstallReadiness<T>(ports:InstallReadinessSettlingPorts<T>):Promise<T>

export const REQUIRED_INSTALL_STARTUP_SOURCES:readonly string[]
export function verifyPreparedInstallStartupSources(report:unknown,readInstalled:(path:string,sha256:string)=>Promise<void>):Promise<void>
