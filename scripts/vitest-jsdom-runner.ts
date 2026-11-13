import { readFileSync } from 'node:fs'
import { TestRunner, vi, type RunnerTestFile, type TestRunnerConfig } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { msgctxt as coreMsgctxt, msgid as coreMsgid } from '../packages/core/src/index.ts'
import { isLocale, isolateClientValues, translator } from '../apps/web/src/i18n.ts'

const ENV_OPTIONS_RE = /@vitest-environment-options\s+(\{[^\r\n]+\})/

export default class JsdomSharedRunner extends TestRunner {
  private currentDom: EnvironmentReturn | undefined

  constructor(config: TestRunnerConfig) {
    super(config)
  }

  override async importFile(filepath: string, source: 'collect' | 'setup'): Promise<unknown> {
    if (source === 'collect') {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
      if (this.currentDom) {
        await this.currentDom.teardown(globalThis)
        this.currentDom = undefined
      }
      let jsdomOpts: Record<string, unknown> = {}
      try {
        const head = readFileSync(filepath, 'utf8').slice(0, 512)
        const match = ENV_OPTIONS_RE.exec(head)
        if (match?.[1]) jsdomOpts = JSON.parse(match[1]) as Record<string, unknown>
      } catch {
        jsdomOpts = {}
      }
      this.currentDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: jsdomOpts })
      const g = globalThis as unknown as Record<string, unknown>
      delete g.xpI18n
      g.msgid = coreMsgid
      g.msgctxt = coreMsgctxt
      g.xpT = (
        message: string,
        values?: Readonly<Record<string, string | number>>,
      ): string => {
        const lang = document.documentElement.lang
        const locale = isLocale(lang) ? lang : undefined
        return translator(locale)(message, locale ? isolateClientValues(locale, values) : values)
      }
    }
    return super.importFile(filepath, source)
  }

  override async onAfterRunFiles(files: RunnerTestFile[]): Promise<void> {
    try {
      await super.onAfterRunFiles(files)
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
      if (this.currentDom) {
        await this.currentDom.teardown(globalThis)
        this.currentDom = undefined
      }
    }
  }
}
