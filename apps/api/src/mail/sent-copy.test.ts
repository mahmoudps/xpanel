import { describe, expect, it } from 'vitest'
import { mimeForSent } from './inbox.ts'

describe('Sent copy', () => {
  it('keeps a submitted message only when it carries DKIM-Signature', () => {
    const submitted = 'From: a@demo.example.test\r\n\r\nHello\r\n'
    const signed = `DKIM-Signature: v=1; a=rsa-sha256; b=abc\r\n${submitted}`
    expect(mimeForSent(submitted, signed)).toBe(signed)
    expect(mimeForSent(submitted, submitted)).toBeNull()
    expect(mimeForSent(submitted, null)).toBeNull()
  })
})
