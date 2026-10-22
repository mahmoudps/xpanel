import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { MAX_OS_RELEASE_CHARS, parseOsRelease } from './osRelease.ts'
import { ALMA_9, CENTOS_STREAM_9, FEDORA_40, MINT_21, ROCKY_10, UBUNTU_2404 } from './fixtures.ts'

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof XpanelError ? e.code : 'NOT_XPANEL'
  }
  return undefined
}

describe('parseOsRelease', () => {
  it('reads unquoted Ubuntu values', () => {
    const r = parseOsRelease(UBUNTU_2404)
    expect(r.id).toBe('ubuntu')
    expect(r.versionId).toBe('24.04')
    expect(r.versionCodename).toBe('noble')
    expect(r.idLike).toEqual(['debian'])
    expect(r.prettyName).toBe('Ubuntu 24.04.1 LTS')
    expect(r.fields.UBUNTU_CODENAME).toBe('noble')
  })

  it('reads quoted EL values and the ID_LIKE list', () => {
    const r = parseOsRelease(CENTOS_STREAM_9)
    expect(r.id).toBe('centos')
    expect(r.versionId).toBe('9')
    expect(r.name).toBe('CentOS Stream')
    expect(r.platformId).toBe('platform:el9')
    expect(r.idLike).toEqual(['rhel', 'fedora'])
    expect(parseOsRelease(ALMA_9).idLike).toEqual(['rhel', 'centos', 'fedora'])
    expect(parseOsRelease(ROCKY_10).versionId).toBe('10.0')
    expect(parseOsRelease(MINT_21).idLike).toEqual(['ubuntu', 'debian'])
  })

  it('keeps an explicitly empty value empty', () => {
    expect(parseOsRelease(FEDORA_40).versionCodename).toBe('')
    expect(parseOsRelease(FEDORA_40).versionId).toBe('40')
  })

  it('handles single quotes, escapes and mixed quoting', () => {
    const r = parseOsRelease([
      `A='single "quoted" $x'`,
      'B="dq \\"esc\\" \\\\ \\$HOME \\`tick\\`"',
      'C="keep \\n backslash"',
      'D=un\\ quoted',
      `E="con"'cat'enated`,
    ].join('\n'))
    expect(r.fields.A).toBe('single "quoted" $x')
    expect(r.fields.B).toBe('dq "esc" \\ $HOME `tick`')
    expect(r.fields.C).toBe('keep \\n backslash')
    expect(r.fields.D).toBe('un quoted')
    expect(r.fields.E).toBe('concatenated')
  })

  it('skips comments, blank lines and CRLF endings', () => {
    const r = parseOsRelease('# comment\r\n\r\n   # indented comment\r\nID=ubuntu\r\nVERSION_ID="22.04"\r\n')
    expect(r.id).toBe('ubuntu')
    expect(r.versionId).toBe('22.04')
  })

  it('accepts a trailing comment after a value', () => {
    expect(parseOsRelease('ID=ubuntu # the distro').id).toBe('ubuntu')
    expect(parseOsRelease('ID="rocky"   # el').id).toBe('rocky')
  })

  it('skips malformed lines instead of guessing', () => {
    const r = parseOsRelease([
      'ID ubuntu',
      '=nokey',
      '1BAD=x',
      'BAD-KEY=x',
      'KEY WITH SPACE=x',
      'OPEN="unterminated',
      `OPEN2='unterminated`,
      'TRAIL=a b',
      'BS=end\\',
      'ID=rocky',
    ].join('\n'))
    expect(r.id).toBe('rocky')
    expect(Object.keys(r.fields)).toEqual(['ID'])
  })

  it('lets the last assignment win', () => {
    expect(parseOsRelease('ID=debian\nID=ubuntu').id).toBe('ubuntu')
  })

  it('defaults a missing or empty ID to linux', () => {
    expect(parseOsRelease('').id).toBe('linux')
    expect(parseOsRelease('NAME=x').id).toBe('linux')
    expect(parseOsRelease('ID=').id).toBe('linux')
  })

  it('normalises ID_LIKE whitespace', () => {
    expect(parseOsRelease('ID_LIKE="  rhel\tcentos   fedora "').idLike).toEqual(['rhel', 'centos', 'fedora'])
    expect(parseOsRelease('ID=x').idLike).toEqual([])
  })

  it('cannot be used to pollute prototypes', () => {
    const r = parseOsRelease('__proto__=polluted\nconstructor=x\nID=ubuntu')
    expect(Object.getPrototypeOf(r.fields)).toBeNull()
    expect(r.fields.__proto__).toBe('polluted')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(r.id).toBe('ubuntu')
  })

  it('returns a frozen result', () => {
    const r = parseOsRelease(UBUNTU_2404)
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen(r.fields)).toBe(true)
    expect(Object.isFrozen(r.idLike)).toBe(true)
  })

  it('rejects oversized or non-text input', () => {
    expect(code(() => parseOsRelease('A=b\n'.repeat(MAX_OS_RELEASE_CHARS)))).toBe('VALIDATION')
    expect(code(() => parseOsRelease(42 as unknown as string))).toBe('VALIDATION')
    expect(code(() => parseOsRelease(null as unknown as string))).toBe('VALIDATION')
  })
})
