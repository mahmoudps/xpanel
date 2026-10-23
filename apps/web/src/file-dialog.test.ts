/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'

const plan = { ...defaultPlan({ id: 'file-plan', name: 'Synthetic plan', featureListId: 'file-features' }), shell: 'jailed' as const }
const account: Account = {
  id: 'file-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.21', shell: 'jailed', createdAt: '2026-10-22T14:05:00Z',
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('file manager confirmation dialog', () => {
  afterEach(() => {
    document.body.replaceChildren()
    delete (window as unknown as { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })

  it('formats size and time, refuses an empty name, and deletes only after confirmation', async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
      this.returnValue = value ?? ''
      this.open = false
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('should-not-run')
    const request = vi.fn(async (_method: string, _path: string, body: { op?: string }) => {
      if (body?.op === 'list') {
        return { entries: [{ name: 'note.txt', path: 'note.txt', kind: 'file', sizeBytes: 2048, mode: 0o640, mtime: '2026-10-22T14:05:09.000Z' }] }
      }
      return { entries: [] }
    })
    ;(window as unknown as { xpanelSessionRequest: typeof request }).xpanelSessionRequest = request
    document.documentElement.lang = 'en'
    document.documentElement.dataset.realtimeEnabled = 'false'
    document.body.innerHTML = renderPanelSurface({ account, plan, activeRoute: '/files/manager', files: [], locale: 'en' })
    new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
    await tick()
    expect(document.body.textContent).toContain('2.00 KB')
    expect(document.body.textContent).toContain('2026-10-22 14:05:09 UTC')
    expect(prompt).not.toHaveBeenCalled()

    const trashCalls = () => request.mock.calls.filter(call => (call[2] as { op?: string }).op === 'trash')
    const writeCalls = () => request.mock.calls.filter(call => (call[2] as { op?: string }).op === 'write')
    document.querySelector<HTMLButtonElement>('[data-file-manager-table] tbody .xp-btn:last-child')?.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-xp-prompt]')
    expect(dialog?.hasAttribute('open')).toBe(true)
    dialog?.querySelector<HTMLButtonElement>('[data-xp-prompt-cancel]')?.click()
    expect(trashCalls()).toHaveLength(0)

    document.querySelector<HTMLButtonElement>('[data-file-manager-table] tbody .xp-btn:last-child')?.click()
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(trashCalls()).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('[data-action="new-file"]')?.click()
    const input = document.querySelector<HTMLInputElement>('[data-xp-prompt-input]')
    expect(input).not.toBeNull()
    input!.value = '   '
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(writeCalls()).toHaveLength(0)
    input!.value = 'notes.txt'
    dialog?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(writeCalls()[0]?.[2]).toMatchObject({ op: 'write', path: 'notes.txt', content: '' })
    expect(prompt).not.toHaveBeenCalled()
  })
})
