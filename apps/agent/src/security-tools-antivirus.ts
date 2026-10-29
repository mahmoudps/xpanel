import { posix } from 'node:path'
import { fail, msgid } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { HostJobRunner } from './host-jobs.ts'
import type { BinaryPresent, SecurityToolsRun } from './security-tools-intrusion.ts'
import { CLAMSCAN, CLAMSCAN_VERSION_ARGV, FRESHCLAM, FRESHCLAM_UPDATE_ARGV, clamscanHomeArgv, isAccountUsername, isAntivirusJobCommand, isScanTarget } from '../../../packages/os/src/security-tools-command.ts'

export type AntivirusJobs = Pick<HostJobRunner, 'list' | 'readLog'>
export interface ClamavVersion { version: string; signatureVersion: number | null; signatureDate: string | null }
export interface AntivirusEngine { state: 'read' | 'not_installed' | 'unavailable'; version: string | null; signatureVersion: number | null; signatureDate: string | null }
export interface ScanSummary { knownViruses: number | null; engineVersion: string | null; scannedDirectories: number | null; scannedFiles: number | null; infectedFiles: number; dataScanned: string | null; time: string | null }
export interface ScanFinding { path: string; signature: string }
export type ScanResult = 'pending' | 'clean' | 'infected' | 'error' | 'cancelled' | 'unknown'
export type UpdateResult = 'pending' | 'updated' | 'up_to_date' | 'error' | 'cancelled' | 'unknown'
export interface AntivirusScanView {
  jobId: string; referenceCode: string | null; account: string | null; target: string | null; status: HostJobView['status']; result: ScanResult; exitCode: number | null
  createdAt: string; finishedAt: string | null; summary: ScanSummary | null; infected: ScanFinding[]; listComplete: boolean
}
export interface AntivirusUpdateView { jobId: string; referenceCode: string | null; status: HostJobView['status']; result: UpdateResult; exitCode: number | null; createdAt: string; finishedAt: string | null; signatureVersion: number | null }
export interface AntivirusRead {
  observedAt: string
  engine: AntivirusEngine
  updater: { present: boolean | null }
  jobsAvailable: boolean
  accounts: { username: string; status: string }[]
  scans: AntivirusScanView[]
  updates: AntivirusUpdateView[]
}

export const SCAN_JOB_KIND = 'security.antivirus.scan'
export const SIGNATURE_JOB_KIND = 'security.antivirus.signatures'
export const SCAN_FINDINGS_LIMIT = 50
const SCAN_LIST_LIMIT = 10
const UPDATE_LIST_LIMIT = 5
const LOG_WINDOW = 262_144
const SUMMARY = '----------- SCAN SUMMARY -----------'
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const COUNT = /^(?:0|[1-9][0-9]{0,15})$/
const count = (value: string | undefined): number | null => value !== undefined && COUNT.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const display = (value: string | undefined): string | null => value !== undefined && value.length >= 1 && value.length <= 64 && !UNSAFE.test(value) ? value : null

/** clamscan(1) --version: "ClamAV <engine>" or "ClamAV <engine>/<daily signature version>/<signature date>". */
export function parseClamscanVersion(stdout: string): ClamavVersion | null {
  const match = typeof stdout === 'string' ? /^ClamAV ([0-9][0-9A-Za-z.+~_-]{0,63})(?:\/([0-9]{1,10})\/([^/\n]{1,64}))?$/.exec(stdout.trim()) : null
  if (!match || match[3] !== undefined && UNSAFE.test(match[3])) return null
  return { version: match[1]!, signatureVersion: match[2] === undefined ? null : Number(match[2]), signatureDate: match[3]?.trim() ?? null }
}

/**
 * Reads a scan job log: the runner records "$ <argv>", then clamscan stdout ("<path>: <signature> FOUND" per
 * infected file with --infected, then the SCAN SUMMARY block). Only lines under the logged target count, the
 * last summary wins (a crafted file name cannot follow it) and the listed total is checked against it.
 */
export function parseClamscanReport(text: string): { target: string | null; summary: ScanSummary | null; infected: ScanFinding[]; matched: number } {
  const lines = typeof text === 'string' ? text.split('\n') : []
  const prefix = '$ ' + clamscanHomeArgv('/home/xpanel').slice(0, -1).join(' ') + ' '
  const command = lines.find(line => line.startsWith(prefix))
  const candidate = command?.slice(prefix.length)
  const target = isScanTarget(candidate) && command === '$ ' + clamscanHomeArgv(candidate).join(' ') ? candidate : null
  let summaryAt = -1
  for (let index = lines.length - 1; index >= 0; index--) if (lines[index] === SUMMARY) { summaryAt = index; break }
  let summary: ScanSummary | null = null
  if (summaryAt >= 0) {
    const values = new Map<string, string>()
    for (const line of lines.slice(summaryAt + 1, summaryAt + 16)) {
      const split = line.indexOf(': ')
      if (split > 0 && !values.has(line.slice(0, split))) values.set(line.slice(0, split), line.slice(split + 2).trim())
    }
    const infectedFiles = count(values.get('Infected files'))
    if (infectedFiles !== null) summary = { knownViruses: count(values.get('Known viruses')), engineVersion: display(values.get('Engine version')), scannedDirectories: count(values.get('Scanned directories')),
      scannedFiles: count(values.get('Scanned files')), infectedFiles, dataScanned: display(values.get('Data scanned')), time: display(values.get('Time')) }
  }
  const infected: ScanFinding[] = []
  let matched = 0
  if (target) for (const line of lines.slice(0, summaryAt >= 0 ? summaryAt : lines.length)) {
    if (!line.endsWith(' FOUND')) continue
    const body = line.slice(0, -' FOUND'.length), split = body.lastIndexOf(': ')
    const path = body.slice(0, split), signature = body.slice(split + 2)
    if (split < 1 || !(path === target || path.startsWith(target + '/')) || !/^[A-Za-z0-9._:{}+-]{1,160}$/.test(signature) || path.length > 1024 || UNSAFE.test(path)) continue
    matched++
    if (infected.length < SCAN_FINDINGS_LIMIT) infected.push({ path, signature })
  }
  return { target, summary, infected, matched }
}

export function buildAntivirusScanPlan(input: { accountId: string; username: string; target: string }): HostJobPlan {
  const { accountId, username, target } = input
  if (!isAccountUsername(username) || !isScanTarget(target) || posix.basename(target) !== username) return fail('VALIDATION', 'a scan targets exactly one account home', { stateChanged: false })
  return {
    kind: SCAN_JOB_KIND, summary: 'Antivirus scan of account ' + username, accountId, fingerprint: { username, target }, detail: { username, target },
    // clamscan(1) RETURN CODES: 0 no virus found, 1 virus(es) found, 2 error. Exit 1 is a completed scan with findings.
    steps: [{ id: 'scan', successExitCodes: [1], title: msgid('Scan the account home with ClamAV'), argv: clamscanHomeArgv(target), timeoutMs: 3_600_000, mutates: false }],
    policy: isAntivirusJobCommand,
  }
}

export function buildSignatureUpdatePlan(): HostJobPlan {
  return {
    kind: SIGNATURE_JOB_KIND, summary: 'Update ClamAV signatures', accountId: null, fingerprint: { update: 'freshclam' }, detail: {},
    // freshclam replaces each database only after it downloads and verifies it, so a failed run keeps the previous signatures.
    steps: [{ id: 'update', successExitCodes: [1], title: msgid('Download ClamAV signature updates'), argv: [...FRESHCLAM_UPDATE_ARGV], timeoutMs: 900_000, mutates: false }],
    policy: isAntivirusJobCommand,
    verify: async run => {
      const result = await run([...CLAMSCAN_VERSION_ARGV], { timeoutMs: 60_000 }).catch(() => null)
      const version = result?.ok ? parseClamscanVersion(result.stdout) : null
      return { ok: version?.signatureVersion != null, detail: version ? { ...version } : { error: 'the ClamAV version could not be read after the update' } }
    },
  }
}

const scanResult = (job: HostJobView): ScanResult => {
  const code = job.steps[0]?.exitCode ?? null
  if (job.status === 'queued' || job.status === 'running') return 'pending'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.failureClass === 'unknown_outcome') return 'unknown'
  return job.status === 'succeeded' && code === 0 ? 'clean' : job.status === 'succeeded' && code === 1 ? 'infected' : 'error'
}
const updateResult = (job: HostJobView): UpdateResult => {
  const code = job.steps[0]?.exitCode ?? null
  if (job.status === 'queued' || job.status === 'running') return 'pending'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.failureClass === 'unknown_outcome') return 'unknown'
  // freshclam(1) RETURN CODES: 0 database successfully updated, 1 database is up-to-date.
  return job.status === 'succeeded' && code === 0 ? 'updated' : job.status === 'succeeded' && code === 1 ? 'up_to_date' : 'error'
}

async function readScanLog(jobs: AntivirusJobs, id: string): Promise<{ text: string; complete: boolean } | null> {
  const head = await jobs.readLog(id, 0, LOG_WINDOW)
  if (!head.available) return null
  if (head.nextOffset >= head.total && !head.truncated) return { text: head.text, complete: true }
  const tail = await jobs.readLog(id, Math.max(head.nextOffset, head.total - LOG_WINDOW), LOG_WINDOW)
  return { text: head.text + '\n' + tail.text, complete: false }
}

async function scanView(jobs: AntivirusJobs, job: HostJobView): Promise<AntivirusScanView> {
  const result = scanResult(job)
  const log = result === 'clean' || result === 'infected' || result === 'error' ? await readScanLog(jobs, job.id).catch(() => null) : null
  const report = log ? parseClamscanReport(log.text) : null
  const summary = report?.summary ?? null
  // The exit code is authoritative; a summary that contradicts it is not shown as a result.
  const consistent = !!summary && (result === 'clean' ? summary.infectedFiles === 0 : result !== 'infected' || summary.infectedFiles > 0)
  return { jobId: job.id, referenceCode: job.referenceCode, account: report?.target ? posix.basename(report.target) : null, target: report?.target ?? null, status: job.status, result, exitCode: job.steps[0]?.exitCode ?? null,
    createdAt: job.createdAt, finishedAt: job.finishedAt, summary: consistent ? summary : null, infected: report?.infected ?? [],
    listComplete: !!log?.complete && consistent && report!.matched === summary!.infectedFiles && report!.matched <= SCAN_FINDINGS_LIMIT }
}

export async function readAntivirus(input: { run: SecurityToolsRun; present: BinaryPresent; accounts: readonly { username: string; status: string }[]; jobs: AntivirusJobs | null; now?: () => Date }): Promise<AntivirusRead> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const empty = { version: null, signatureVersion: null, signatureDate: null }
  let engine: AntivirusEngine
  if (await input.present(CLAMSCAN).catch(() => null) === false) engine = { state: 'not_installed', ...empty }
  else {
    const result = await input.run([...CLAMSCAN_VERSION_ARGV]).catch(() => null)
    const version = result?.ok && result.code === 0 ? parseClamscanVersion(result.stdout) : null
    engine = version ? { state: 'read', ...version } : { state: 'unavailable', ...empty }
  }
  const updater = { present: await input.present(FRESHCLAM).catch(() => null) }
  const accounts = input.accounts.filter(account => isAccountUsername(account.username) && account.status !== 'terminating').map(({ username, status }) => ({ username, status })).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 5000)
  const jobs = input.jobs
  if (!jobs) return { observedAt, engine, updater, jobsAvailable: false, accounts, scans: [], updates: [] }
  const [scanJobs, updateJobs] = await Promise.all([jobs.list({ kindPrefix: SCAN_JOB_KIND, limit: SCAN_LIST_LIMIT }), jobs.list({ kindPrefix: SIGNATURE_JOB_KIND, limit: UPDATE_LIST_LIMIT })])
  const scans: AntivirusScanView[] = []
  for (const job of scanJobs) if (job.kind === SCAN_JOB_KIND) scans.push(await scanView(jobs, job))
  const updates = updateJobs.filter(job => job.kind === SIGNATURE_JOB_KIND).map((job): AntivirusUpdateView => {
    const signatureVersion = job.verification?.ok && Number.isSafeInteger(job.verification.detail.signatureVersion) ? job.verification.detail.signatureVersion as number : null
    return { jobId: job.id, referenceCode: job.referenceCode, status: job.status, result: updateResult(job), exitCode: job.steps[0]?.exitCode ?? null, createdAt: job.createdAt, finishedAt: job.finishedAt, signatureVersion }
  })
  return { observedAt, engine, updater, jobsAvailable: true, accounts, scans, updates }
}
