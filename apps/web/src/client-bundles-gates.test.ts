import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ROUTE_CLIENT_CHUNKS, routeClientChunksFor } from './route-client-chunks.ts'
import { WORKSPACE_RUNTIME_SCRIPT } from './workspace-runtime-client.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

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

  it('selects every route chunk for all root workspace hooks bound by its imported client modules', () => {
    const chunkSource = readFileSync(join(SRC_DIR, 'route-client-chunks.ts'), 'utf8')
    const imports = new Map<string, string>()
    for (const match of chunkSource.matchAll(/import\s+\{\s*([A-Z0-9_]+)\s*\}\s+from\s+'\.\/([^']+)'/g)) {
      imports.set(match[1]!, match[2]!)
    }

    const helperSelectors = new Set(['data-surface', 'data-whm-detail-route'])
    for (const entry of ROUTE_CLIENT_CHUNKS) {
      if (entry.alwaysForSurface) continue
      const blockMatch = new RegExp(`chunk\\('${entry.id}'[\\s\\S]*?(?=\\n\\s*chunk\\(|\\n\\]\\))`).exec(chunkSource)
      expect(blockMatch, `chunk definition missing for ${entry.id}`).not.toBeNull()
      const symbols = new Set(Array.from(blockMatch![0].matchAll(/\$\{([A-Z0-9_]+)\}/g), m => m[1]!))
      for (const symbol of symbols) {
        const file = imports.get(symbol)
        if (!file) continue
        const bindingSource = readFileSync(join(SRC_DIR, file), 'utf8')
        for (const qm of bindingSource.matchAll(/document\.querySelector(?:All)?(?:<[^>]+>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
          for (const attr of qm[1]!.matchAll(/data-[a-z0-9-]+/g)) {
            const hook = attr[0]
            if (helperSelectors.has(hook)) continue
            const matched = entry.hooks.some(candidate => hook.includes(candidate))
            expect(matched, `chunk ${entry.id} (${file}) must include selector hook ${hook}`).toBe(true)
          }
        }
      }
    }

    // Spot-check cross-surface and multi-workspace chunk dispatch explicitly.
    for (const hook of ['data-whm-web-templates', 'data-whm-skeleton', 'data-whm-email-users', 'data-whm-locale-copy']) {
      expect(routeClientChunksFor('xwhm', `<section ${hook}></section>`).some(item => item.id === 'whm-accounts-2'), hook).toBe(true)
    }
    expect(routeClientChunksFor('xpanel', '<section data-account-plugins></section>').some(item => item.id === 'whm-panel-2')).toBe(true)
  })
})
