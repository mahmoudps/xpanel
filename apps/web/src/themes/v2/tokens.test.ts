import { describe, expect, it } from 'vitest'
import { V2_TOKENS_CSS } from './tokens.ts'

describe('v2 font tokens', () => {
  it('includes self-hosted IBM Plex Sans Arabic in sans, mono fallback and Arabic locale rules', () => {
    const sans = /--font-sans:([^;]+);/.exec(V2_TOKENS_CSS)![1]!.split(',')
    expect(sans.slice(0, 2)).toEqual(["'IBM Plex Sans'", "'IBM Plex Sans Arabic'"])
    const mono = /--font-mono:([^;]+);/.exec(V2_TOKENS_CSS)![1]!.split(',')
    expect(mono[0]).toBe("'IBM Plex Mono'")
    expect(mono[1]).toBe("'IBM Plex Sans Arabic'")
    expect(mono.at(-1)).toBe('sans-serif')
    expect(mono).not.toContain('monospace')
    expect(V2_TOKENS_CSS).toContain("[data-ui-theme=\"v2\"]:lang(ar){--font-sans:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif}")
    expect(V2_TOKENS_CSS).toContain("[data-ui-theme=\"v2\"] [lang=\"ar\"]{font-family:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif}")
  })
})
