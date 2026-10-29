import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { collectProductionSbom } from './package-release.mjs'

interface PackageManifest {
  name: string
  version?: string
  license?: string
  packageManager?: string
  dependencies?: Record<string, string>
}

const sourceRoot = resolve(import.meta.dirname, '..')
const readManifest = (path: string): PackageManifest => JSON.parse(readFileSync(path, 'utf8'))

it('includes every direct external production dependency at its pinned version and installed license', () => {
  const manifestPaths = [join(sourceRoot, 'package.json')]
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(sourceRoot, group), { withFileTypes: true })) {
      const path = join(sourceRoot, group, entry.name, 'package.json')
      if (entry.isDirectory() && existsSync(path)) manifestPaths.push(path)
    }
  }
  const manifests = manifestPaths.map(path => ({ path, manifest: readManifest(path) }))
  const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name))
  const sbom = collectProductionSbom(
    sourceRoot,
    '0.1.0',
    readFileSync(join(sourceRoot, '.node-version'), 'utf8').trim(),
    manifests[0]!.manifest.packageManager!,
    createHash('sha256').update(readFileSync(join(sourceRoot, 'pnpm-lock.yaml'))).digest('hex'),
  )

  let externalDependencies = 0
  for (const { path, manifest } of manifests) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (workspaceNames.has(name)) continue
      externalDependencies++
      const installed = readManifest(join(dirname(path), 'node_modules', name, 'package.json'))
      expect(installed.version, `${manifest.name} must pin ${name} exactly`).toBe(version)
      expect(sbom.productionDependencies, `${manifest.name} dependency ${name} is missing or stale`).toEqual(
        expect.arrayContaining([expect.objectContaining({ name, version, license: installed.license })]),
      )
    }
  }
  expect(externalDependencies).toBeGreaterThan(0)
})
