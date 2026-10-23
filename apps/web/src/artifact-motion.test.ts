import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DESIGN_TOKENS_CSS } from './tokens.ts'

describe('artifact motion values', () => {
  it('copies the declared keyframes and does not invent a duration for them', () => {
    expect(DESIGN_TOKENS_CSS).toContain('transform: translateX(-100%)')
    expect(DESIGN_TOKENS_CSS).toContain('transform: translateX(260%)')
    expect(DESIGN_TOKENS_CSS).toContain('background-position: -480px 0')
    expect(DESIGN_TOKENS_CSS).toContain('background-position: 480px 0')
    expect(DESIGN_TOKENS_CSS).toContain('transform: rotate(360deg)')
    expect(DESIGN_TOKENS_CSS).toContain('width: 100%')
    expect(DESIGN_TOKENS_CSS).toContain('width: 0%')
    expect(DESIGN_TOKENS_CSS).not.toMatch(/animation:\s*xp-(?:indet|shimmer|spin|drain)\b/)
    expect(DESIGN_TOKENS_CSS).not.toMatch(/\b(?:140|160|220)ms\b/)
  })

  it('removes animation and transition when the reader asks for reduced motion', () => {
    expect(DESIGN_TOKENS_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(DESIGN_TOKENS_CSS).toContain('animation: none !important')
    expect(DESIGN_TOKENS_CSS).toContain('transition: none !important')
  })

  it('keeps the inbox selection and compose pressed colours from the mail artboards', () => {
    expect(DESIGN_TOKENS_CSS).toContain('background: #f3f7fe')
    expect(DESIGN_TOKENS_CSS).toContain('inset 3px 0 0 #1d5bd6')
    expect(DESIGN_TOKENS_CSS).toContain('background: #1546a8')
  })

  it('records the same keyframes in the design note', () => {
    const note = readFileSync(new URL('../../../docs/design/artifact-design-system.md', import.meta.url), 'utf8')
    expect(note).toContain('translateX(-100%)')
    expect(note).toContain('translateX(260%)')
    expect(note).toContain('background-position: -480px 0')
    expect(note).toContain('rotate(360deg)')
    expect(note).toContain('width: 100%')
    expect(note).toContain('animation: none !important; transition: none !important')
    expect(note).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(note).not.toContain('about 160ms')
  })
})
