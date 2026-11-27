import { describe, expect, it } from 'vitest'
import { projectTelemetry } from './telemetry.ts'

const identity = (m: string) => m

describe('unified telemetry projection', () => {
  it('formats metrics using unified IEC units, ASCII digits, durations, and ISO date conversion', () => {
    const projected = projectTelemetry({
      status: 'ready',
      observedAt: '2026-11-27T07:00:00Z',
      osLabel: 'Ubuntu 24.04',
      uptimeSeconds: 1206000,
      cpuLoad1m: 1.25,
      cpuCores: 4,
      memoryUsedBytes: 2 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      diskUsedBytes: 15 * 1024 * 1024 * 1024,
      diskTotalBytes: 100 * 1024 * 1024 * 1024,
      inodeUsed: 99311,
      inodeTotal: 1000000,
      bandwidthRateBps: 512 * 1024,
    }, 'ar', identity, { timeZone: 'UTC' })

    expect(projected.status).toBe('ready')
    expect(projected.summary.memoryText).toBe('2.00 GiB / 8.00 GiB')
    expect(projected.summary.diskText).toBe('15.00 GiB / 100.00 GiB')
    expect(projected.summary.inodeText).toBe('99,311 / 1,000,000')
    expect(projected.summary.bandwidthText).toBe('512.00 KiB/s')
    expect(projected.summary.uptimeText).not.toContain('seconds')
    expect(projected.metrics).toHaveLength(4)
  })

  it('never emits unassisted Not read / Not observed strings in loading or disabled states', () => {
    const loading = projectTelemetry({ status: 'loading' }, 'en', identity)
    expect(loading.summary.memoryText).toBe('Loading...')
    expect(JSON.stringify(loading)).not.toMatch(/Not read|Not observed/)

    const disabled = projectTelemetry({ status: 'disabled' }, 'en', identity)
    expect(disabled.summary.memoryText).toBe('Enable service')
    expect(JSON.stringify(disabled)).not.toMatch(/Not read|Not observed/)
  })
})
