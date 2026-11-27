/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_DATA_STORE_SCRIPT } from './live-store.ts'

describe('live data store script', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    delete (window as { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    delete (window as { __xpanelSoftRefresh?: unknown }).__xpanelSoftRefresh
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('exposes toast, confirmation dialog, drawer, and executable command runner helpers', () => {
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelToast = showActionToast')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelConfirmAction = openConfirmDialog')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelOpenActionDrawer = openActionDrawer')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('window.__xpanelExecuteCommandAction = executeCommandAction')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('LIVE_CACHEABLE')
    expect(LIVE_DATA_STORE_SCRIPT).toContain('configuration-health')
  })

  it('strips path-template parameters such as username from JSON action request bodies', async () => {
    new Function(LIVE_DATA_STORE_SCRIPT)()
    const sessionSpy = vi.fn().mockResolvedValue({ outcome: 'ok', message: 'Suspended' })
    ;(window as unknown as { xpanelSessionRequest: typeof sessionSpy }).xpanelSessionRequest = sessionSpy

    const btn = document.createElement('button')
    btn.setAttribute('data-cmdk-spec', JSON.stringify({
      id: 'suspend-account',
      mode: 'drawer',
      method: 'POST',
      endpoint: '/api/accounts/{username}/suspend',
      confirm: false,
      fields: [
        { name: 'username', label: 'Account', type: 'text', value: 'alice', required: true },
        { name: 'reason', label: 'Reason', type: 'text', value: 'Overdue' },
      ],
    }))
    btn.innerHTML = '<strong>Suspend account</strong>'
    document.body.appendChild(btn)

    ;(window as unknown as { __xpanelExecuteCommandAction: (el: HTMLElement) => void }).__xpanelExecuteCommandAction(btn)
    const form = document.querySelector<HTMLFormElement>('[data-ds-action-drawer-form]')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(sessionSpy).toHaveBeenCalledWith('POST', '/api/accounts/alice/suspend', { reason: 'Overdue' })
  })

  it('defers full page refresh when an undoable command runs without soft-refresh-safe container', async () => {
    new Function(LIVE_DATA_STORE_SCRIPT)()
    const refreshSpy = vi.fn()
    const sessionSpy = vi.fn().mockResolvedValue({ outcome: 'ok', message: 'Suspended' })
    ;(window as unknown as { __xpanelSoftRefresh: typeof refreshSpy; xpanelSessionRequest: typeof sessionSpy }).__xpanelSoftRefresh = refreshSpy
    ;(window as unknown as { xpanelSessionRequest: typeof sessionSpy }).xpanelSessionRequest = sessionSpy

    const btn = document.createElement('button')
    btn.setAttribute('data-cmdk-spec', JSON.stringify({
      id: 'suspend-account',
      mode: 'drawer',
      method: 'POST',
      endpoint: '/api/accounts/{username}/suspend',
      undoEndpoint: '/api/accounts/{username}/unsuspend',
      confirm: false,
      fields: [{ name: 'username', label: 'Account', type: 'text', value: 'alice', required: true }],
    }))
    btn.innerHTML = '<strong>Suspend account</strong>'
    document.body.appendChild(btn)

    ;(window as unknown as { __xpanelExecuteCommandAction: (el: HTMLElement) => void }).__xpanelExecuteCommandAction(btn)
    const form = document.querySelector<HTMLFormElement>('[data-ds-action-drawer-form]')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(refreshSpy).not.toHaveBeenCalled()
    const undoBtn = document.querySelector<HTMLButtonElement>('[data-ds-toast-undo]')!
    expect(undoBtn).not.toBeNull()
    undoBtn.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(sessionSpy).toHaveBeenCalledWith('POST', '/api/accounts/alice/unsuspend', {})

    vi.advanceTimersByTime(1500)
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('prefixes account username on create-database submissions without double-prefixing', async () => {
    new Function(LIVE_DATA_STORE_SCRIPT)()
    const sessionSpy = vi.fn().mockResolvedValue({ outcome: 'ok', message: 'Created' })
    ;(window as unknown as { xpanelSessionRequest: typeof sessionSpy }).xpanelSessionRequest = sessionSpy

    const btn = document.createElement('button')
    btn.setAttribute('data-cmdk-spec', JSON.stringify({
      id: 'create-database',
      mode: 'drawer',
      method: 'POST',
      endpoint: '/api/databases',
      confirm: false,
      namePrefix: 'alice_',
      fields: [{ name: 'name', label: 'Database name', type: 'text', required: true }],
    }))
    btn.innerHTML = '<strong>Create database</strong>'
    document.body.appendChild(btn)

    ;(window as unknown as { __xpanelExecuteCommandAction: (el: HTMLElement) => void }).__xpanelExecuteCommandAction(btn)
    const form = document.querySelector<HTMLFormElement>('[data-ds-action-drawer-form]')!
    const input = form.querySelector<HTMLInputElement>('input[name="name"]')!
    input.value = 'app_prod'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(sessionSpy).toHaveBeenCalledWith('POST', '/api/databases', { name: 'alice_app_prod' })

    input.value = 'alice_reporting'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(sessionSpy).toHaveBeenCalledWith('POST', '/api/databases', { name: 'alice_reporting' })
  })

  it('keeps the toast open and reports an error when undo fails', async () => {
    new Function(LIVE_DATA_STORE_SCRIPT)()
    const sessionSpy = vi.fn()
      .mockResolvedValueOnce({ outcome: 'ok', message: 'Suspended' })
      .mockRejectedValueOnce(new Error('Unsuspend refused'))
      .mockResolvedValueOnce({ outcome: 'ok', message: 'Undone' })
    ;(window as unknown as { xpanelSessionRequest: typeof sessionSpy }).xpanelSessionRequest = sessionSpy

    const btn = document.createElement('button')
    btn.setAttribute('data-cmdk-spec', JSON.stringify({
      id: 'suspend-account',
      mode: 'drawer',
      method: 'POST',
      endpoint: '/api/accounts/{username}/suspend',
      undoEndpoint: '/api/accounts/{username}/unsuspend',
      confirm: false,
      fields: [{ name: 'username', label: 'Account', type: 'text', value: 'alice', required: true }],
    }))
    btn.innerHTML = '<strong>Suspend account</strong>'
    document.body.appendChild(btn)

    ;(window as unknown as { __xpanelExecuteCommandAction: (el: HTMLElement) => void }).__xpanelExecuteCommandAction(btn)
    const form = document.querySelector<HTMLFormElement>('[data-ds-action-drawer-form]')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()

    const undoBtn = document.querySelector<HTMLButtonElement>('[data-ds-toast-undo]')!
    undoBtn.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(undoBtn.isConnected).toBe(true)
    expect(undoBtn.disabled).toBe(false)
    expect(document.body.textContent).toContain('Unsuspend refused')

    undoBtn.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(undoBtn.isConnected).toBe(false)
  })
})
