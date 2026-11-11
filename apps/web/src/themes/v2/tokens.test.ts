import { describe, expect, it } from 'vitest'
import { V2_TOKENS_CSS } from './tokens.ts'

describe('v2 font tokens', () => {
  it('lets Arabic inside a mono run fall back to the sans family, not the generic monospace', () => {
    const mono = /--font-mono:([^;]+);/.exec(V2_TOKENS_CSS)![1]!.split(',')
    expect(mono[0]).toBe("'IBM Plex Mono'")
    expect(mono.at(-1)).toBe('sans-serif')
    expect(mono).not.toContain('monospace')
  })
})
