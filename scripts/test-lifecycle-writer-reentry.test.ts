import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('shared writer admission re-entry', () => {
  const source = readFileSync(new URL('./lifecycle-admission.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function bindLifecycleWriter(state) {')
  const end = source.indexOf('\n/** Tracks full admission retirement', start)
  if (start < 0 || end <= start) throw new Error('writer re-entry source missing')
  const body = source.slice(start, end).replace('export function', 'function').replace('export async function', 'async function')

  function load() {
    const writerScope = new AsyncLocalStorage<{ active: boolean }>()
    const exclusiveScope = new AsyncLocalStorage<object>()
    const agentPrivateExclusiveScope = new AsyncLocalStorage<object>()
    const installExclusiveScope = new AsyncLocalStorage<object>()
    const fail = (code: string) => { throw new Error(code) }
    const api = new Function('writerScope', 'writerStates', 'writerCapabilities', 'exclusiveScope', 'agentPrivateExclusiveScope', 'installExclusiveScope', 'fail',
      body + '\nreturn { currentLifecycleWriterAdmission, withVisibleLifecycleWriterAdmission }')(
      writerScope, new WeakMap(), new WeakMap(), exclusiveScope, agentPrivateExclusiveScope, installExclusiveScope, fail,
    ) as {
      currentLifecycleWriterAdmission: () => object
      withVisibleLifecycleWriterAdmission: (capability: unknown, callback: () => unknown) => Promise<unknown>
    }
    return { ...api, writerScope, exclusiveScope }
  }

  it('re-enters the same live admission after the store is dropped and refuses a retired or foreign admission', async () => {
    const { currentLifecycleWriterAdmission, withVisibleLifecycleWriterAdmission, writerScope, exclusiveScope } = load()
    const state = { active: true }
    let admission: object | undefined
    await writerScope.run(state, async () => { admission = currentLifecycleWriterAdmission() })
    expect(writerScope.getStore()).toBeUndefined()
    let seen: unknown
    await withVisibleLifecycleWriterAdmission(admission, async () => { seen = writerScope.getStore() })
    expect(seen).toBe(state)
    await writerScope.run({ active: true }, async () => {
      await expect(withVisibleLifecycleWriterAdmission(admission, () => undefined)).rejects.toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
    })
    await exclusiveScope.run({}, async () => {
      await expect(withVisibleLifecycleWriterAdmission(admission, () => undefined)).rejects.toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
    })
    state.active = false
    await expect(withVisibleLifecycleWriterAdmission(admission, () => undefined)).rejects.toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
    await expect(withVisibleLifecycleWriterAdmission({}, () => undefined)).rejects.toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
    expect(() => currentLifecycleWriterAdmission()).toThrow('LIFECYCLE_SHARED_ADMISSION_REQUIRED')
  })
})
