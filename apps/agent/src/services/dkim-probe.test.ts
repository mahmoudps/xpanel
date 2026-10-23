import { describe, expect, it } from 'vitest'
import { dkimProbeFromExit } from './dkim-probe.ts'

describe('OpenDKIM postfix probe', () => {
  it('treats a missing uid as unknown and a refused socket as refused', () => {
    expect(dkimProbeFromExit(null, false)).toBe('unknown')
    expect(dkimProbeFromExit(null, true)).toBe('unknown')
    expect(dkimProbeFromExit(0, true)).toBe('signing')
    expect(dkimProbeFromExit(1, true)).toBe('refused')
  })
})
