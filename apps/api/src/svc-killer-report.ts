import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { DeliveryChannels, EmailSender } from './alert-delivery.ts'

interface ReportRun { at: string; trigger: string; state: string; killed: { pid: number; user: string; comm: string; outcome: string }[]; trustedSkipped: number; mailed: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Report text of one nightly run; each line is agent data, so a process name can never add mail headers. */
export const killerReportText = (run: ReportRun): string => [
  `Background Process Killer ran at ${run.at}.`,
  run.state === 'completed' ? `Processes stopped: ${run.killed.length}. Trusted users skipped: ${run.trustedSkipped}.` : 'The process list could not be read, so nothing was stopped.',
  ...run.killed.map(item => `${item.user} ${item.comm} pid ${item.pid}: ${item.outcome}`),
  '',
].join('\n')

/** Emails unmailed nightly reports that found something to the notification recipients, then marks them. Without recipients they stay on the page. */
export async function deliverProcessKillerReports(input: { db: Db; agentApp: AgentApp; agentToken: string; readChannels: () => Promise<DeliveryChannels | null>; email: EmailSender }): Promise<void> {
  const channels = await input.readChannels()
  if (!channels?.recipients.length) return
  const principal = await findPrincipalByUsername(input.db, 'root')
  if (!principal || principal.disabled || principal.kind !== 'root') return
  const headers = agentCallerHeaders({ principalId: principal.id, token: input.agentToken })
  const response = await input.agentApp.fetch(new Request('http://agent.local/host/svc/process-killer', { headers }))
  if (!response.ok) return
  const body: unknown = await response.json()
  const runs = object(body) && Array.isArray(body.runs) ? body.runs as ReportRun[] : []
  for (const run of runs) {
    if (run.mailed || run.trigger !== 'nightly' || run.state === 'completed' && run.killed.length === 0) continue
    await input.email({ to: channels.recipients, subject: 'Background Process Killer report', text: killerReportText(run) })
    await input.agentApp.fetch(new Request('http://agent.local/host/svc/process-killer/reports/mailed', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ at: run.at }) }))
  }
}
