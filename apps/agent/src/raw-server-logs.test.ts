import { describe, expect, it } from 'vitest'
import { handleRawServerLogsRoute, openRawServerLog } from './raw-server-logs.ts'

const route = async (path: string, ctx: { root?: boolean; available?: boolean } = {}, method = 'GET') => {
  const url = new URL('http://agent.local' + path)
  return handleRawServerLogsRoute(new Request(url, { method }), url, method, { assertRoot: async () => { if (ctx.root === false) throw Object.assign(new Error('root only'), { code: 'FORBIDDEN' }) }, available: ctx.available ?? true })
}

describe('raw web server log route', { tags: ['unit'] }, () => {
  it('admits only the fixed servers and log names, for root, without selectors', async () => {
    expect(await route('/host/logs/raw/mysql')).toBeNull()
    expect(await route('/host/logs/raw/nginx/a/b')).toBeNull()
    await expect(route('/host/logs/raw/nginx', { root: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(route('/host/logs/raw/nginx?path=/etc')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(route('/host/logs/raw/nginx', { available: false })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await route('/host/logs/raw/apache', {}, 'POST'))!.status).toBe(405)
    for (const name of ['shadow', '..', 'access.log.100', 'access.log;rm']) await expect(openRawServerLog('nginx', name)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
