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
