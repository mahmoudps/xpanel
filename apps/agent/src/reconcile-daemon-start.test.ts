import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { compileDesiredGeneration } from './reconciler.ts'

let state: TestStateStoreHandle
beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })

describe('daemons a generation reloads', () => {
  it.each(['ID=ubuntu\nVERSION_ID="22.04"\n', 'ID=rocky\nVERSION_ID="9.6"\n'])('starts each one before its reload, since the installer leaves them stopped', async release => {
    const os = profileFor(release)
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const steps = compileDesiredGeneration(await state.store.readSnapshot(), { os }).postActions
      .flatMap(action => action.kind === 'systemd' ? [`${action.verb} ${action.unit}`] : [])
    for (const unit of [os.services.apache, os.services.nginx]) {
      expect(steps.indexOf(`start ${unit}`), unit).toBeGreaterThanOrEqual(0)
      expect(steps.indexOf(`start ${unit}`), unit).toBeLessThan(steps.indexOf(`reload ${unit}`))
    }
  })
})
