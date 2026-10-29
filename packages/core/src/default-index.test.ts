import { describe, expect, it } from 'vitest'
import { DEFAULT_INDEX_FILES, validateDomainIndexFiles } from './default-index.ts'

describe('authoritative directory-index basename grammar', () => {
  it('preserves explicit search order without altering caller arrays', () => {
    const names = ['home.html', 'index.php']; const result = validateDomainIndexFiles(names)
    expect(result).toEqual(names); expect(result).not.toBe(names)
    expect(DEFAULT_INDEX_FILES).toEqual(['index.php', 'index.html', 'index.htm'])
  })
  it.each([null, {}, '', [], Array(17).fill('index.html'), ['index.html', 'index.html'], ['../index.html'], ['/index.html'], ['dir/index.html'], ['dir\\index.html'], ['https://example.test/'], ['index.html\nRequire all granted'], ['index%2ehtml'], ['index?.html'], ['${host}'], ['disabled'], ['DISABLED'], ['.htaccess'], ['..'], ['a..b'], ['é.html'], ['a'.repeat(65)], ['a b.html']])('rejects unsafe or ambiguous input %j', raw => {
    expect(() => validateDomainIndexFiles(raw)).toThrow()
  })
  it('permits bounded ASCII filename punctuation and exact maximum sizes', () => {
    expect(validateDomainIndexFiles(['A-1_2.html', 'x'.repeat(64)])).toHaveLength(2)
    expect(validateDomainIndexFiles(Array.from({ length: 16 }, (_, index) => 'page' + index + '.html'))).toHaveLength(16)
  })
})
