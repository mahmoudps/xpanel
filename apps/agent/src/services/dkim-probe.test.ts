import { describe, expect, it } from 'vitest'
import { dkimOutcomeFromMailLog, dkimProbeFromExit } from './dkim-probe.ts'

describe('OpenDKIM postfix probe', () => {
  it('treats a missing uid as unknown and a refused socket as refused', () => {
    expect(dkimProbeFromExit(null, false)).toBe('unknown')
    expect(dkimProbeFromExit(null, true)).toBe('unknown')
    expect(dkimProbeFromExit(0, true)).toBe('signing')
    expect(dkimProbeFromExit(1, true)).toBe('refused')
  })

  it('reports the last mail-log outcome and the selector that was signed', () => {
    const refused = 'warning: milter-reject: connect to Milter service local:opendkim/opendkim.sock: Permission denied'
    const signed = 'opendkim[412]: DKIM-Signature field added (s=xp202610, d=demo.example.test)'
    expect(dkimOutcomeFromMailLog(`${refused}\n${signed}`)).toEqual({ status: 'signing', selector: 'xp202610' })
    expect(dkimOutcomeFromMailLog(`${signed}\n${refused}`)?.status).toBe('refused')
    expect(dkimOutcomeFromMailLog('status=sent')).toBeNull()
  })
})
