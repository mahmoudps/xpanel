import { defineConfig } from 'vitest/config'
import { testLayerConfig } from './scripts/test-layers.mjs'

export default defineConfig({
  test: {
    ...testLayerConfig(process.env.XPANEL_TEST_LAYER),
    environment: 'node',
    setupFiles: ['./scripts/vitest-i18n-setup.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
  },
})
