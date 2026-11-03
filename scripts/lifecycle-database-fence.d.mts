export function parseDatabaseFenceFdFlags(text:string):number
export function parseDatabaseFenceProcess(text:string):Readonly<{pid:number;start:string}>
export function withClosedDatabasePins<T>(origin:unknown,assertAuthority:()=>Promise<void>,callback:(pins:Readonly<{assertCurrent():Promise<void>}>)=>Promise<T>):Promise<T>
