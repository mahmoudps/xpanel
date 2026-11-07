import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { handleFtpRawLogRoute } from './ftp-raw-log.ts'
import type { FtpRawLogContext, FtpRawLogState } from './ftp-raw-log.ts'

const entry = (message: string, us: number): string => JSON.stringify({ MESSAGE: message, SYSLOG_IDENTIFIER: 'pure-ftpd', _EXE: '/usr/sbin/pure-ftpd', _SYSTEMD_UNIT: 'pure-ftpd.service', __REALTIME_TIMESTAMP: String(1794045600000000 + us) })
const JOURNAL = [
  entry('(?@198.51.100.2) [INFO] New connection from 198.51.100.2', 1),
  entry('(bob@example.com@198.51.100.2) [INFO] bob@example.com is now logged in', 2),
  entry('(bob@example.com@198.51.100.2) [NOTICE] /home/alice/public_html/a.txt uploaded  (12 bytes, 1.00KB/sec)', 3),
  entry('(eve@other.test@198.51.100.3) [INFO] eve@other.test is now logged in', 4),
].join('\n') + '\n'
const state = (enabled = true): FtpRawLogState => ({
  accounts: [{ id: 'a', username: 'alice', home: '/home/alice' }], serviceUsers: [{ login: 'bob@example.com', accountId: 'a', services: { ftp: true } }],
  domains: [{ name: 'example.com', accountId: 'a' }], server: { settings: { ftp: { enabled } } },
})
const query = '?domain=example.com&since=2026-11-07T00:00:00Z&until=2026-11-07T23:00:00Z'
const call = (path: string, over: Partial<FtpRawLogContext> = {}, method = 'GET') => {
  const url = new URL('http://agent/host/ftp/log/raw' + path)
  return handleFtpRawLogRoute(new Request(url, { method }), url, method, { assertRoot: async () => undefined, readState: async () => state(), run: async () => ({ ok: true, stdout: JOURNAL, stderr: '' }), now: () => new Date('2026-11-07T23:00:00Z'), ...over })
}

describe('raw FTP log download', () => {
  it('returns a gzip holding only the sessions of the chosen domain', async () => {
    const response = await call(query)
    expect(response!.headers.get('content-type')).toBe('application/gzip')
    expect(response!.headers.get('content-disposition')).toContain('example.com.ftp.log.gz')
    const text = gunzipSync(Buffer.from(await response!.arrayBuffer())).toString()
    expect(text.trim().split('\n')).toHaveLength(2)
    expect(text).toContain('bob@example.com upload 12'); expect(text).not.toContain('eve@'); expect(text).not.toContain('connect')
  })
  it('refuses with SERVICE_DISABLED when the FTP service is off', async () => {
    const run = vi.fn()
    await expect(call(query, { readState: async () => state(false), run })).rejects.toMatchObject({ code: 'SERVICE_DISABLED' })
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses unknown domains, odd selectors and an unread journal', async () => {
    await expect(call(query.replace('example.com', 'other.test'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(query + '&path=/etc/passwd')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('?domain=example.com&since=2026-10-01T00:00:00Z&until=2026-11-07T00:00:00Z')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(query, { run: null })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect((await call(query, {}, 'POST'))!.status).toBe(405)
  })
})
