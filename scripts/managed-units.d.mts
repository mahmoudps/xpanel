export type ManagedUnitName = 'xpanel.slice' | 'xpanel-agent.service' | 'xpanel-api.service' | 'xpanel-management-tls.service' | 'xpanel-management-tls.timer'
export interface ManagedUnitOptions {
  readonly nodePath: string
  readonly programRoot: string
  readonly lifecycleParticipants: boolean
}
export const MANAGED_UNIT_NAMES: readonly ManagedUnitName[]
export function renderManagedUnits(options: ManagedUnitOptions): Readonly<Record<ManagedUnitName, string>>
export function renderManagedUnitPlan(options: ManagedUnitOptions): Readonly<Record<ManagedUnitName, string>>
export function runManagedUnitCli(args: readonly string[], io?: { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): number
