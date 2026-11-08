import { describe, expect, it } from 'vitest'
import { siteCompressionLines } from './nginx.ts'

describe('account compression lines', () => {
  it('keeps the server default without a choice', () => {
    expect(siteCompressionLines(undefined)).toEqual([])
  })

  it('renders each mode and leaves text/html to the gzip default', () => {
    expect(siteCompressionLines({ mode: 'disabled', types: [] })).toEqual(['gzip off;'])
    expect(siteCompressionLines({ mode: 'all', types: [] })).toEqual(['gzip on;', 'gzip_types *;'])
    expect(siteCompressionLines({ mode: 'types', types: ['text/html', 'text/css'] })).toEqual(['gzip on;', 'gzip_types text/css;'])
    expect(siteCompressionLines({ mode: 'types', types: ['text/html'] })).toEqual(['gzip on;'])
  })
})
