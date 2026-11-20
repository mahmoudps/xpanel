import vm from 'node:vm'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ROUTE_CLIENT_CHUNKS } from './route-client-chunks.ts'
import { WORKSPACE_RUNTIME_SCRIPT } from './workspace-runtime-client.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

describe('client runtime and route chunk budgets and syntax', () => {
  it('keeps initial runtime JS and every route-scoped client chunk within gzip budgets', () => {
    const initialGzip = gzipSync(BROWSER_REALTIME_SCRIPT).byteLength + gzipSync(WORKSPACE_RUNTIME_SCRIPT).byteLength
    expect(initialGzip).toBeLessThanOrEqual(200 * 1024)

    for (const chunk of ROUTE_CLIENT_CHUNKS) {
      const bytes = gzipSync(chunk.script.body).byteLength
      expect(bytes, `route chunk ${chunk.id} exceeds 60 KiB gzip`).toBeLessThanOrEqual(60 * 1024)
    }
  })

  it('compiles initial runtime JS and every route-scoped client chunk without syntax errors', () => {
    expect(() => new vm.Script(BROWSER_REALTIME_SCRIPT, { filename: 'ws-client.js' })).not.toThrow()
    expect(() => new vm.Script(WORKSPACE_RUNTIME_SCRIPT, { filename: 'workspace-runtime.js' })).not.toThrow()
    for (const chunk of ROUTE_CLIENT_CHUNKS) {
      expect(() => new vm.Script(chunk.script.body, { filename: `${chunk.id}.js` }), `syntax error in ${chunk.id}`).not.toThrow()
    }
  })
})
