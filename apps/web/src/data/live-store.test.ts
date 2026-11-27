import { describe, expect, it } from 'vitest'
import { LIVE_DATA_STORE_SCRIPT } from './live-store.ts'

describe('live data store script', () => {
  it('exposes toast, confirmation dialog, drawer, and executable command runner helpers', () => {
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelToast = showActionToast')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelConfirmAction = openConfirmDialog')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelOpenActionDrawer = openActionDrawer')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelExecuteCommandAction = executeCommandAction')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('LIVE_CACHEABLE')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('configuration-health')
  })
})
