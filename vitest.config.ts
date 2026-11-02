import { defineConfig } from 'vitest/config'
import { testLayerConfig } from './scripts/test-layers.mjs'
import TestLaneReporter from './scripts/test-lane-reporter.mjs'

export default defineConfig({
  test: {
    ...testLayerConfig(process.env.XPANEL_TEST_LAYER),
    environment: 'node',
    tags: [
      { name: 'slow', description: 'Explicit expensive case, excluded only from the fast lane.' },
      { name: 'visual', description: 'Real computed browser geometry.' },
      { name: 'unit', description: 'Pure logic, no database or framework boot, under 100 ms.' },
      { name: 'feature', description: 'One application behavior with isolated state, under 1 s.' },
      { name: 'journey', description: 'One slow end-to-end business flow.' },
    ],
    strictTags: true,
    allowOnly: process.env.XPANEL_TEST_LANE ? false : undefined,
    reporters: process.env.XPANEL_TEST_LANE ? ['default', new TestLaneReporter()] : ['default'],
    setupFiles: ['./scripts/vitest-i18n-setup.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
  },
})
