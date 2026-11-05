import { describe, expect, it } from 'vitest'
import { stableMachineCode } from './ops-upgrade-operator.ts'

describe('root operator review code', () => {
  it('reports the callback cause instead of the archive wrapper', () => {
    const cause = Object.assign(new Error('LIFECYCLE_DATABASE_ADMISSION_REQUIRED'), { code: 'LIFECYCLE_DATABASE_ADMISSION_REQUIRED' })
    const wrapped = Object.assign(new Error('Archive callback failed'), { code: 'ARCHIVE_USE_UNCERTAIN', cause })
    expect(stableMachineCode(wrapped)).toBe('LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
    expect(stableMachineCode(Object.assign(new Error('ARCHIVE_USE_UNCERTAIN'), { code: 'ARCHIVE_USE_UNCERTAIN' }))).toBe('ARCHIVE_USE_UNCERTAIN')
    expect(stableMachineCode(new Error('not a machine code'))).toBe('ROOT_OPERATOR_REVIEW_REQUIRED')
  })
})
