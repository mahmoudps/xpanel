import { describe, expect, it } from 'vitest'
import { classifyCoordinatorRotationImage, parseCoordinatorRotationRequest } from './coordinator-rotation.mjs'

const request = () => ({ operationId: '12345678-1234-1234-1234-123456789abc', mode: 'apply' })
describe('explicit fixed coordinator rotation; portable grammar and image model only', () => {
  it.each(['apply', 'recover', 'rollback'])('keeps %s a distinct root product operation', mode => {
    expect(parseCoordinatorRotationRequest({ ...request(), mode })).toEqual({ ...request(), mode })
  })
  it.each(['unit', 'actor', 'nodePath', 'source', 'ready', 'force', 'ignoreOwnership'])('rejects caller supplied %s', key => {
    expect(() => parseCoordinatorRotationRequest({ ...request(), [key]: true })).toThrow('COORDINATOR_ROTATION_REQUEST_INVALID')
  })
  it('rejects an accessor before reading a proposed operation mode', () => {
    let read = false
    const value = request()
    Object.defineProperty(value, 'mode', { enumerable: true, get() { read = true; return 'apply' } })
    expect(() => parseCoordinatorRotationRequest(value)).toThrow('COORDINATOR_ROTATION_REQUEST_INVALID')
    expect(read).toBe(false)
  })
  it('refuses foreign images at every lost-reply point instead of selecting a convenient direction', () => {
    const previous = 'a'.repeat(64), next = 'b'.repeat(64), foreign = 'c'.repeat(64)
    expect(classifyCoordinatorRotationImage(previous, previous, next)).toBe('previous')
    expect(classifyCoordinatorRotationImage(next, previous, next)).toBe('next')
    for (const actual of [foreign, null, Object(previous), '../unit']) expect(classifyCoordinatorRotationImage(actual, previous, next)).toBe('foreign')
  })
})
