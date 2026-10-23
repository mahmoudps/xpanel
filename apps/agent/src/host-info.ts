export interface HostLoad {
  load1: number
  load5: number
  load15: number
}

export interface HostMemory {
  totalBytes: number
  availableBytes: number
}

export interface HostDisk {
  filesystem: string
  mount: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
}

const finite = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export const parseLoadavg = (text: string): HostLoad => {
  const [one, five, fifteen] = text.trim().split(/\s+/)
  const load1 = finite(one)
  const load5 = finite(five)
  const load15 = finite(fifteen)
  if (load1 === null || load5 === null || load15 === null) {
    throw new Error('load average is unreadable')
  }
  return { load1, load5, load15 }
}

export const parseMeminfo = (text: string): HostMemory => {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
    const kib = match ? finite(match[1]) : null
    return kib === null ? null : kib * 1024
  }
  const totalBytes = read('MemTotal')
  const availableBytes = read('MemAvailable')
  if (totalBytes === null || availableBytes === null) throw new Error('memory figures are unreadable')
  return { totalBytes, availableBytes }
}

export interface HostInodes {
  filesystem: string
  mount: string
  total: number
  used: number
}

/** Parses `df -B1 -P` output for one filesystem. */
export const parseDf = (text: string): HostDisk => {
  const line = text.trim().split('\n').find(row => row.length > 0 && !row.startsWith('Filesystem'))
  const parts = line?.trim().split(/\s+/) ?? []
  const filesystem = parts[0]
  const totalBytes = finite(parts[1])
  const usedBytes = finite(parts[2])
  const availableBytes = finite(parts[3])
  const mount = parts[5]
  if (!filesystem || !mount || totalBytes === null || usedBytes === null || availableBytes === null) {
    throw new Error('disk figures are unreadable')
  }
  return { filesystem, mount, totalBytes, usedBytes, availableBytes }
}

/** Parses `df -P -i` output for one filesystem. The percent is computed by the caller. */
export const parseDfInodes = (text: string): HostInodes => {
  const line = text.trim().split('\n').find(row => row.length > 0 && !row.startsWith('Filesystem'))
  const parts = line?.trim().split(/\s+/) ?? []
  const filesystem = parts[0]
  const total = finite(parts[1])
  const used = finite(parts[2])
  const mount = parts[5]
  if (!filesystem || !mount || !mount.startsWith('/') || total === null || used === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(used) || used > total) {
    throw new Error('inode figures are unreadable')
  }
  return { filesystem, mount, total, used }
}

export interface HostCpu {
  cores: number
  model: string | null
}

/** Processor count and the first model name from `/proc/cpuinfo`. */
export const parseCpuinfo = (text: string): HostCpu | null => {
  const cores = text.split('\n').filter(line => /^processor\s*:/.test(line)).length
  if (!Number.isInteger(cores) || cores < 1 || cores > 4096) return null
  const modelLine = text.split('\n').find(line => /^model name\s*:/.test(line))
  const modelRaw = modelLine ? modelLine.slice(modelLine.indexOf(':') + 1).trim() : ''
  return { cores, model: modelRaw ? displayText(modelRaw, 160) : null }
}

/** One hostname from `hostname -f`. */
export const parseHostname = (text: string): string | null => {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (line.length === 0 || line.length > 253 || line.includes('..')) return null
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(line) ? line : null
}

const quoted = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const displayText = (value: string, max: number): string | null => {
  if (value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || value.includes('\\')) return null
  return value
}

/** `PRETTY_NAME` from `/etc/os-release`, or `NAME` plus `VERSION` when the pretty name is absent. */
export const parseOsRelease = (text: string): string | null => {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq), quoted(line.slice(eq + 1)))
  }
  const pretty = values.get('PRETTY_NAME')
  if (pretty) return displayText(pretty, 160)
  const name = values.get('NAME')
  const version = values.get('VERSION')
  if (!name) return null
  return displayText(version ? `${name} ${version}` : name, 160)
}

/** Whole seconds from the first field of `/proc/uptime`. */
export const parseProcUptime = (text: string): number | null => {
  const seconds = Number(text.trim().split(/\s+/)[0])
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 100 * 366 * 24 * 60 * 60) return null
  return Math.floor(seconds)
}

/** `uname -r` as one kernel token. */
export const parseKernelRelease = (text: string): string | null => {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return /^[A-Za-z0-9._+-]+$/.test(line) && line.length <= 128 ? line : null
}

export const parseNginxVersion = (text: string): string | null => {
  const match = /nginx\/(\d+\.\d+\.\d+)/.exec(text)
  return match ? match[1]! : null
}

export const parseApacheVersion = (text: string): string | null => {
  const match = /Apache\/(\d+\.\d+\.\d+)/.exec(text)
  return match ? match[1]! : null
}

const VERSION_TOKEN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/

/** One version line from `/opt/xpanel/VERSION`. */
export const parseVersionFile = (text: string): string | null => {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return VERSION_TOKEN.test(line) ? line : null
}

/** Package manifest `version`, only when it is a plain semver token. */
export const parsePackageVersion = (text: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'string' && VERSION_TOKEN.test(version) ? version : null
}
