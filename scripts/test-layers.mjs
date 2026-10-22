/** Test classifications describe the environment used, not feature readiness. */
export const linuxTestFiles = ['apps/agent/src/linux-isolation.test.ts', 'apps/agent/src/executor-linux.test.ts', '**/*.linux.test.ts']
export const httpTestFiles = ['apps/api/src/**/*.test.ts', 'apps/agent/src/boundary-security.test.ts']
const allTestFiles = ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/test-*.test.ts']
const sharedExcludes = ['**/node_modules/**', '**/.pnpm-store/**']

export function testLayerConfig(layer = 'portable') {
  if (layer === 'linux') return { include: linuxTestFiles, exclude: sharedExcludes }
  if (layer === 'http') return { include: httpTestFiles, exclude: sharedExcludes }
  if (layer === 'unit') return { include: allTestFiles, exclude: [...sharedExcludes, ...linuxTestFiles, ...httpTestFiles] }
  if (layer === 'portable') return { include: allTestFiles, exclude: [...sharedExcludes, ...linuxTestFiles] }
  throw new Error(`Unknown test layer: ${layer}`)
}
