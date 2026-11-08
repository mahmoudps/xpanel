import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Binary routes must be admitted before the query check, or the JSON path takes them.
describe('agent binary download admission', () => {
  const source = readFileSync(new URL('./agent-client.ts', import.meta.url), 'utf8')
  it('admits the raw FTP log with its query and the share link without one', () => {
    const ftp = source.indexOf("url.pathname === '/host/ftp/log/raw'"), query = source.indexOf('if (url.search) return null'), share = source.indexOf('SHARE_LINK_CONTENT.test(url.pathname)')
    expect(ftp).toBeGreaterThan(0); expect(ftp).toBeLessThan(query); expect(share).toBeGreaterThan(query)
  })
})
