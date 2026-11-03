import { describe, expect, it } from 'vitest'
import { classifyInstallationImage, parseInstallationTransitionJournal } from './installation-transition.mjs'

describe('installation transition diagnostic image admission; no native authority', () => {
  it('distinguishes previous, selected and unrecognized byte images', () => {
    const previous = 'a'.repeat(64), selected = 'b'.repeat(64)
    expect(classifyInstallationImage(previous, previous, selected)).toBe('previous')
    expect(classifyInstallationImage(selected, previous, selected)).toBe('selected')
    expect(classifyInstallationImage('c'.repeat(64), previous, selected)).toBe('foreign')
    expect(classifyInstallationImage(Object(selected), previous, selected)).toBe('foreign')
  })
  it('rejects a boolean readiness assertion and an invented durable recovery record', () => {
    expect(() => parseInstallationTransitionJournal({ ready: true }, '12345678-1234-1234-1234-123456789abc')).toThrow()
    expect(() => parseInstallationTransitionJournal({ schemaVersion: 1, kind: 'xpanel-installation-transition', operationId: '12345678-1234-1234-1234-123456789abc', phase: 'published', selected: 'target' }, '12345678-1234-1234-1234-123456789abc')).toThrow()
  })
  it('rejects accessors before cloning or reading attacker controlled values', () => {
    let touched = false
    const value = Object.defineProperty({}, 'operationId', { enumerable: true, get() { touched = true; return '12345678-1234-1234-1234-123456789abc' } })
    expect(() => parseInstallationTransitionJournal(value, '12345678-1234-1234-1234-123456789abc')).toThrow()
    expect(touched).toBe(false)
  })
})
