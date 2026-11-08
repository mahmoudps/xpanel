import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { PANEL_BINDING_DEFAULT, PANEL_GATE_DEFAULT, parseEntrancePath, parsePanelBinding, parsePanelGatePolicy } from './panel-gate-policy.ts'

const refusal = (run: () => unknown): { code: string; reason: unknown } => {
  try { run() } catch (error) { if (isXpanelError(error)) return { code: error.code, reason: error.detail.reason }; throw error }
  throw new Error('expected a refusal')
}
const binding = (ports: Partial<typeof PANEL_BINDING_DEFAULT.ports>, hosts: Partial<typeof PANEL_BINDING_DEFAULT.hosts> = {}) => ({ ports: { ...PANEL_BINDING_DEFAULT.ports, ...ports }, hosts: { ...PANEL_BINDING_DEFAULT.hosts, ...hosts } })

describe('panel gate grammar', () => {
  it('names a short entrance with the stable code', () => {
    expect(refusal(() => parseEntrancePath('abc1234'))).toEqual({ code: 'VALIDATION', reason: 'ENTRANCE_TOO_SHORT' })
    expect(refusal(() => parseEntrancePath('settings-page'))).toEqual({ code: 'VALIDATION', reason: 'ENTRANCE_INVALID' })
    expect(refusal(() => parseEntrancePath('bad/path/2024'))).toEqual({ code: 'VALIDATION', reason: 'ENTRANCE_INVALID' })
    expect(parseEntrancePath('door-2026-x')).toBe('door-2026-x')
  })

  it('accepts only exact https redirects and never stops xWHM', () => {
    const redirect = (url: unknown) => parsePanelGatePolicy({ ...PANEL_GATE_DEFAULT, response: { kind: 'redirect', url } })
    expect(redirect('https://example.com/').response.url).toBe('https://example.com/')
    for (const url of ['http://example.com/', 'https://user:pw@example.com/', 'javascript:alert(1)', null]) expect(refusal(() => redirect(url)).code).toBe('VALIDATION')
    expect(refusal(() => parsePanelGatePolicy({ ...PANEL_GATE_DEFAULT, stopped: ['xwhm'] })).reason).toBe('XWHM_NOT_STOPPABLE')
    expect(parsePanelGatePolicy({ ...PANEL_GATE_DEFAULT, stopped: ['xmail', 'xpanel'] }).stopped).toEqual(['xpanel', 'xmail'])
  })

  it('round-trips the default exactly, which is how a saved record is accepted', () => {
    expect(parsePanelGatePolicy(structuredClone(PANEL_GATE_DEFAULT))).toEqual(PANEL_GATE_DEFAULT)
  })
})

describe('panel binding grammar', () => {
  it('uses the acceptance codes for bad and busy ports', () => {
    for (const port of [0, 65536, 1.5, '2087' as unknown as number]) expect(refusal(() => parsePanelBinding(binding({ xwhm: port })))).toEqual({ code: 'VALIDATION', reason: 'INVALID_PORT' })
    for (const port of [80, 443, 2078, 12087, 22]) expect(refusal(() => parsePanelBinding(binding({ xwhm: port }), [22]))).toEqual({ code: 'CONFLICT', reason: 'PORT_IN_USE' })
    expect(refusal(() => parsePanelBinding(binding({ xwhm: 2083 })))).toEqual({ code: 'CONFLICT', reason: 'PORT_IN_USE' })
    expect(parsePanelBinding(binding({ xwhm: 18888 })).ports.xwhm).toBe(18888)
  })

  it('needs fully qualified, distinct, lowercase hosts', () => {
    expect(parsePanelBinding(binding({}, { xwhm: 'panel.example.com' })).hosts.xwhm).toBe('panel.example.com')
    for (const host of ['localhost', 'Panel.Example.com', '192.0.2.10', 'a b.example.com']) expect(refusal(() => parsePanelBinding(binding({}, { xwhm: host }))).reason).toBe('INVALID_HOST')
    expect(refusal(() => parsePanelBinding(binding({}, { xwhm: 'a.example.com', xpanel: 'a.example.com' }))).reason).toBe('INVALID_HOST')
  })
})
