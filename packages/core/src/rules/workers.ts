// Worker sizing for the shared Nginx edge, the single Apache (itk/prefork) and default
// per-domain PHP-FPM pools. Numbers follow the upstream nginx, Apache MPM and PHP-FPM docs.
import type { PhpSettings, ServerSettings } from '../types.ts'
import { invalid, isInt, isRecord, throwIfErrors } from './check.ts'

export type NginxWorkers = ServerSettings['nginx']
export type ApacheWorkers = ServerSettings['apache']
export type FpmSettings = PhpSettings['fpm']

/** Product cap; Apache's compiled hard limit for prefork-based MPMs is far above this. */
export const APACHE_SERVER_LIMIT_MAX = 20000
/** Linux default fs.nr_open, the ceiling for a per-process RLIMIT_NOFILE. */
export const NOFILE_MAX = 1_048_576
export const NGINX_WORKER_PROCESSES_MAX = 1024

export interface HardwareProfile {
  cores: number
  memoryMb: number
}

export interface SuggestOptions {
  /** resident size of one Apache child (itk/prefork without mod_php) */
  apacheChildMb?: number
  /** resident size of one PHP-FPM worker */
  phpWorkerMb?: number
}

export interface SuggestedServerSettings {
  nginx: NginxWorkers
  apache: ApacheWorkers
  /** server-wide default pool (2-10 children); fit it to the domain's plan with fitFpmToCap */
  fpm: FpmSettings
  budgetMb: { osReserve: number; dbReserve: number; apache: number; php: number }
  notes: string[]
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const nginxConnections = (memoryMb: number): number =>
  memoryMb < 1024 ? 1024 : memoryMb < 4096 ? 2048 : memoryMb < 16384 ? 4096 : 8192

/**
 * First-run wizard suggestion. Memory is split: OS reserve, MariaDB reserve, then the
 * rest between Apache children (35%) and PHP-FPM pools living in account slices (65%).
 */
export const suggestServerSettings = (hw: HardwareProfile, opts: SuggestOptions = {}): SuggestedServerSettings => {
  if (!isRecord(hw) || !isRecord(opts as unknown)) return invalid('hardware profile and options must be objects')
  const errors: string[] = []
  if (!isInt(hw.cores, 1, 4096)) errors.push('cores must be an integer between 1 and 4096')
  if (!isInt(hw.memoryMb, 256, 64 * 1024 * 1024)) errors.push('memoryMb must be an integer of at least 256')
  const childMb = opts.apacheChildMb ?? 24
  const phpMb = opts.phpWorkerMb ?? 64
  if (!isInt(childMb, 4, 4096)) errors.push('apacheChildMb must be an integer between 4 and 4096')
  if (!isInt(phpMb, 8, 8192)) errors.push('phpWorkerMb must be an integer between 8 and 8192')
  throwIfErrors('hardware profile', errors)

  const { cores, memoryMb } = hw
  const notes: string[] = []
  const workerConnections = nginxConnections(memoryMb)
  const nginx: NginxWorkers = {
    workerProcesses: Math.min(cores, NGINX_WORKER_PROCESSES_MAX),
    workerConnections,
    // each proxied request holds a client and an upstream descriptor, plus cache/log files
    workerRlimitNofile: workerConnections * 4,
    multiAccept: true,
    keepaliveTimeoutSec: memoryMb < 2048 ? 15 : 30,
  }

  const osReserve = Math.max(384, Math.round(memoryMb * 0.1))
  const dbReserve = Math.max(128, Math.round(memoryMb * 0.25))
  const rest = Math.max(0, memoryMb - osReserve - dbReserve)
  const apacheBudget = Math.floor(rest * 0.35)
  const phpBudget = rest - apacheBudget

  const fromMemory = Math.floor(apacheBudget / childMb)
  const maxRequestWorkers = clamp(fromMemory, 16, 2000)
  if (fromMemory < 16) notes.push('memory is below what the suggested Apache minimum needs; expect swapping under load')
  const minSpareServers = Math.max(2, Math.round(maxRequestWorkers * 0.05))
  const maxSpareServers = Math.min(maxRequestWorkers, Math.max(minSpareServers * 2, Math.round(maxRequestWorkers * 0.15)))
  const apache: ApacheWorkers = {
    startServers: clamp(Math.round(maxRequestWorkers * 0.1), minSpareServers, maxSpareServers),
    minSpareServers,
    maxSpareServers,
    maxRequestWorkers,
    // itk forks per connection anyway; this bounds leaks for prefork
    maxConnectionsPerChild: 1000,
    serverLimit: maxRequestWorkers,
  }

  const serverPhpWorkers = Math.floor(phpBudget / phpMb)
  const maxChildren = clamp(Math.min(cores * 2, Math.floor(serverPhpWorkers / 4)), 2, 10)
  const fpm: FpmSettings = {
    mode: 'ondemand',
    maxChildren,
    startServers: 1,
    minSpareServers: 1,
    maxSpareServers: Math.min(2, maxChildren),
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  }
  if (cores === 1) notes.push('single core: one nginx worker; consider ondemand pools everywhere')

  return {
    nginx,
    apache,
    fpm,
    budgetMb: { osReserve, dbReserve, apache: apacheBudget, php: phpBudget },
    notes,
  }
}

const unknownKeys = (value: Record<string, unknown>, known: readonly string[]): string[] =>
  Object.keys(value).filter((k) => !known.includes(k)).map((k) => `${k} is not a known field`)

const APACHE_KEYS = ['startServers', 'minSpareServers', 'maxSpareServers', 'maxRequestWorkers', 'maxConnectionsPerChild', 'serverLimit'] as const

export const apacheWorkerErrors = (apache: unknown): string[] => {
  if (!isRecord(apache)) return ['apache workers must be an object']
  const errors = unknownKeys(apache, APACHE_KEYS)
  for (const k of APACHE_KEYS) {
    // MaxConnectionsPerChild 0 is Apache's documented "never recycle"
    const min = k === 'maxConnectionsPerChild' ? 0 : 1
    const max = k === 'maxConnectionsPerChild' ? 100_000_000 : APACHE_SERVER_LIMIT_MAX
    if (!isInt(apache[k], min, max)) errors.push(`${k} must be an integer between ${min} and ${max}`)
  }
  if (errors.length > 0) return errors
  const a = apache as unknown as ApacheWorkers
  // prefork/itk silently raise MaxSpareServers to MinSpareServers + 1 otherwise; what we save must be what runs
  if (a.minSpareServers >= a.maxSpareServers) errors.push('minSpareServers must be below maxSpareServers')
  if (a.startServers < a.minSpareServers || a.startServers > a.maxSpareServers) {
    errors.push('startServers must be between minSpareServers and maxSpareServers')
  }
  if (a.maxSpareServers > a.maxRequestWorkers) errors.push('maxSpareServers must not exceed maxRequestWorkers')
  if (a.startServers > a.maxRequestWorkers) errors.push('startServers must not exceed maxRequestWorkers')
  if (a.serverLimit < a.maxRequestWorkers) errors.push('serverLimit must be at least maxRequestWorkers')
  return errors
}

export const validateApacheWorkers = (apache: unknown): ApacheWorkers => {
  throwIfErrors('Apache workers', apacheWorkerErrors(apache))
  const a = apache as ApacheWorkers
  return {
    startServers: a.startServers,
    minSpareServers: a.minSpareServers,
    maxSpareServers: a.maxSpareServers,
    maxRequestWorkers: a.maxRequestWorkers,
    maxConnectionsPerChild: a.maxConnectionsPerChild,
    serverLimit: a.serverLimit,
  }
}

const NGINX_KEYS = ['workerProcesses', 'workerConnections', 'workerRlimitNofile', 'multiAccept', 'keepaliveTimeoutSec'] as const

export const nginxWorkerErrors = (nginx: unknown): string[] => {
  if (!isRecord(nginx)) return ['nginx workers must be an object']
  const errors = unknownKeys(nginx, NGINX_KEYS)
  if (nginx.workerProcesses !== 'auto' && !isInt(nginx.workerProcesses, 1, NGINX_WORKER_PROCESSES_MAX)) {
    errors.push(`workerProcesses must be "auto" or an integer between 1 and ${NGINX_WORKER_PROCESSES_MAX}`)
  }
  if (!isInt(nginx.workerConnections, 64, NOFILE_MAX)) errors.push(`workerConnections must be an integer between 64 and ${NOFILE_MAX}`)
  if (!isInt(nginx.workerRlimitNofile, 1, NOFILE_MAX)) errors.push(`workerRlimitNofile must be an integer between 1 and ${NOFILE_MAX}`)
  else if (isInt(nginx.workerConnections) && nginx.workerRlimitNofile < nginx.workerConnections * 2) {
    errors.push('workerRlimitNofile must be at least twice workerConnections (client + upstream descriptor per request)')
  }
  if (typeof nginx.multiAccept !== 'boolean') errors.push('multiAccept must be a boolean')
  // 0 disables keep-alive, which nginx documents as valid
  if (!isInt(nginx.keepaliveTimeoutSec, 0, 3600)) errors.push('keepaliveTimeoutSec must be an integer between 0 and 3600')
  return errors
}

export const validateNginxWorkers = (nginx: unknown): NginxWorkers => {
  throwIfErrors('nginx workers', nginxWorkerErrors(nginx))
  const n = nginx as NginxWorkers
  return {
    workerProcesses: n.workerProcesses,
    workerConnections: n.workerConnections,
    workerRlimitNofile: n.workerRlimitNofile,
    multiAccept: n.multiAccept,
    keepaliveTimeoutSec: n.keepaliveTimeoutSec,
  }
}
