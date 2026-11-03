import { describe, expect, it } from 'vitest'
import { parseDatabaseFenceFdFlags, parseDatabaseFenceProcess, withClosedDatabasePins } from './lifecycle-database-fence.mjs'

describe('database fence diagnostic grammar, not native admission', () => {
  it('retains the actual descriptor access mode and refuses malformed flags', () => {
    expect(parseDatabaseFenceFdFlags('pos:\t0\nflags:\t02100000\n')).toBe(0)
    expect(parseDatabaseFenceFdFlags('flags:\t02100002\n')).toBe(2)
    for (const text of ['', 'flags:\t8\n', 'flags:\t0\nflags:\t0\n']) expect(() => parseDatabaseFenceFdFlags(text)).toThrow()
  })
  it('uses the process start token after the final comm delimiter', () => {
    const fields = ['S', ...Array(18).fill('0'), '777', '0']
    expect(parseDatabaseFenceProcess('42 (worker (a)) ' + fields.join(' '))).toEqual({ pid: 42, start: '777' })
    expect(() => parseDatabaseFenceProcess('42 (broken) S')).toThrow()
  })
  it('does not treat an input origin as admission for a caller-selected file', async () => {
    let reached = false
    await expect(withClosedDatabasePins({ file: '/tmp/control.db' }, async () => {}, async () => { reached = true })).rejects.toThrow()
    expect(reached).toBe(false)
  })
})
