export function parseIssuedLifecycleAuditJournal(value:unknown,expectedJobId:string):Record<string,unknown>
export function writeIssuedLifecycleAuditJournal(capability:unknown,plan:unknown):Promise<Readonly<{path:string;sha256:string}>>
export function assertIssuedLifecycleAuditJournalCurrent(capability:unknown):Promise<void>
export function issuedLifecycleAuditJournalInfo(capability:unknown):Readonly<{path:string;sha256:string;journal:Record<string,unknown>}>
export function withIssuedLifecycleAuditJournal<T>(jobId:string,callback:(capability:object)=>Promise<T>):Promise<T>
export function withSelectedIssuedLifecycleAuditJournal<T>(headSha256:string,helperArchiveSha256:string,callback:(capability:object|null)=>Promise<T>):Promise<T>
/** Completes only the issued audit append; never signals lifecycle success or readiness. */
export function writeIssuedLifecycleAuditCompletion(capability:unknown):Promise<void>
export function assertNoUnretiredIssuedLifecycleAudit():Promise<void>
