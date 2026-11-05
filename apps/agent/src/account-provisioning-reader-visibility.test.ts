import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('canary source reader visibility', () => {
  it('reads the active generation inside the same live read-only reader', () => {
    const source = readFileSync(new URL('./account-provisioning-http-source.ts', import.meta.url), 'utf8')
    const uses = source.match(/withVisibleReadonlyOperationDatabase\(options\.db, \(\) => latestActive\(options\.db\)\)/g)
    expect(uses).toHaveLength(2)
    expect(source).not.toMatch(/(?<!withVisibleReadonlyOperationDatabase\(options\.db, \(\) => )latestActive\(options\.db\)/)
  })
})
