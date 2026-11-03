export interface AgentPrivateStateMigrationRequest {
  readonly mode: 'apply' | 'observe' | 'recover'
  readonly artifact: Readonly<{ artifactPath: string; expectedArchiveSha256: string }>
}
export function parseAgentPrivateStateMigrationArgs(argv: readonly string[]): AgentPrivateStateMigrationRequest
export function assertAgentPrivateStateMigrationScope(capability: unknown, phase: 'admitting' | 'held'): Promise<void>
export function runAgentPrivateStateMigration(prepared: unknown, request: AgentPrivateStateMigrationRequest): Promise<Readonly<Record<string, unknown>>>
