import { defineConfig } from 'vitest/config'
import TestLaneReporter from '../../test-lane-reporter.mjs'

const fixture = process.env.XPANEL_LANE_INTEGRATION_FIXTURE
if (fixture !== 'selection' && fixture !== 'focused') throw new Error('Unknown lane integration fixture')

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: [`${fixture}.case.ts`],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    allowOnly: false,
    tags: [
      { name: 'slow', description: 'Synthetic selector fixture, not measured service cost.' },
      { name: 'visual', description: 'Synthetic selection fixture, never browser evidence.' },
    ],
    strictTags: true,
    reporters: ['default', new TestLaneReporter()],
    testTimeout: 1000,
  },
})
