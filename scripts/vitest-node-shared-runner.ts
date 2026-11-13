import { TestRunner, vi, type RunnerTestFile, type TestRunnerConfig } from 'vitest'
import { msgctxt as coreMsgctxt, msgid as coreMsgid } from '../packages/core/src/index.ts'

function resetNodeGlobals(): void {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  const g = globalThis as unknown as Record<string, unknown>
  delete g.xpI18n
  delete g.xpT
  g.msgid = coreMsgid
  g.msgctxt = coreMsgctxt
}

export default class NodeSharedRunner extends TestRunner {
  constructor(config: TestRunnerConfig) {
    super(config)
  }

  override async importFile(filepath: string, source: 'collect' | 'setup'): Promise<unknown> {
    if (source === 'collect') {
      resetNodeGlobals()
    }
    return super.importFile(filepath, source)
  }

  override async onAfterRunFiles(files: RunnerTestFile[]): Promise<void> {
    try {
      await super.onAfterRunFiles(files)
    } finally {
      resetNodeGlobals()
    }
  }
}
