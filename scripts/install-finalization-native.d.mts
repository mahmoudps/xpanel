export function parseNativeInstallFinalizationRequest(value:unknown):Readonly<Record<string,unknown>>
export function installFinalizationMetadataTarget(path:unknown,jobId:unknown):Readonly<{path:string;temporary:boolean;sha256:string|null}>|null
export function assertInstallFinalizationNativeScope(capability:unknown,phase:'admission'|'held'):Promise<void>
export function installFinalizationNativeInfo(capability:unknown):Readonly<{probeId:string;processes:readonly Readonly<Record<string,unknown>>[]}>
export function runNativeInstallFinalization(value:unknown):Promise<Readonly<{exitCode:number;code:string;outcome:string;details:Readonly<Record<string,unknown>>}>>

/** Internal fixed read-only pins; grants no native capability. UID/GID come from protected installed identity. */
export function withInstallFinalizationStateDirectories<T>(uid:number,gid:number,run:(pins:Readonly<{verify():Promise<void>}>)=>Promise<T>):Promise<T>

export function assertInstallFinalizationStartupScope(capability:unknown,unit:'xpanel-api.service'|'xpanel-agent.service'):Promise<Readonly<{receipt:unknown;operationId:string;serviceGid:number}>>
export function assertInstallFinalizationStartupRetirement(capability:unknown):void
