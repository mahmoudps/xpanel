export type ManagedUnitName = 'xpanel.slice' | 'xpanel-agent.service' | 'xpanel-api.service' | 'xpanel-management-tls.service' | 'xpanel-management-tls.timer'
export interface ManagedUnitOptions {
  readonly nodePath: string
  readonly programRoot: string
  readonly lifecycleParticipants: boolean
}
export const MANAGED_UNIT_NAMES: readonly ManagedUnitName[]
export const API_HEAP_ARGUMENTS: readonly (readonly string[])[]
export function renderInstalledManagedUnitImages(options: ManagedUnitOptions): readonly Readonly<Record<ManagedUnitName, string>>[]
export function managedWriterArguments(role: 'api' | 'agent', nodePath: string, entry: string): string[][]
export function renderManagedUnits(options: ManagedUnitOptions): Readonly<Record<ManagedUnitName, string>>
export function renderManagedUnitPlan(options: ManagedUnitOptions): Readonly<Record<ManagedUnitName, string>>
export function runManagedUnitCli(args: readonly string[], io?: { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): number
