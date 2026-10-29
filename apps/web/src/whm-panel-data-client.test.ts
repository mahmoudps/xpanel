/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { WHM_PANEL_DATA_CLIENT_BINDING } from './whm-panel-data-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const at = '2026-10-28T12:00:00.000Z'
const active = { id: 9, createdAt: at, status: 'active', checksum: 'a'.repeat(64) }, target = { id: 7, createdAt: at, status: 'superseded', checksum: 'b'.repeat(64) }
const restored = { id: 10, createdAt: at, status: 'active', checksum: 'b'.repeat(64) }
const before = { generations: [active, target], currentGeneration: active, desiredState: { revision: 20, checksum: 'c'.repeat(64), pending: false }, canRollback: true, rollbackEligibleGenerationIds: [7] }
const after = { generations: [restored, { ...active, status: 'superseded' }, target], currentGeneration: restored, desiredState: { revision: 21, checksum: 'd'.repeat(64), pending: false }, canRollback: true, rollbackEligibleGenerationIds: [9, 7] }
const ack = { status: 'applied', rollbackTargetGenerationId: 7, rollbackTargetChecksum: target.checksum, generation: restored }
const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const rollbackButton = (id: number) => $<HTMLButtonElement>(`[data-action="rollback-generation"][data-generation-id="${id}"]`)
const boot = (send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => '7') => {
  document.body.innerHTML = renderWhmSurface({ locale: 'en', activeRoute: '/whm/panel/data', generationId: 9, principal: { kind: 'root', id: 'fixture-root', username: 'operator' } })
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_PANEL_DATA_CLIENT_BINDING)()(ask)
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('configuration history binding', () => {
  it('is registered, reads the real history and enables only admitted rollback targets; rebuild stays disabled with a reason', async () => {
    expect(BROWSER_REALTIME_SCRIPT).toContain(WHM_PANEL_DATA_CLIENT_BINDING)
    boot(vi.fn<Send>(async () => before)); await tick()
    expect(document.querySelectorAll('[data-generation-row]')).toHaveLength(2)
    expect(rollbackButton(7).disabled).toBe(false)
    expect(rollbackButton(9).disabled).toBe(true)
    expect($('[data-generations-status]').dataset.state).toBe('read')
    const rebuild = $<HTMLButtonElement>('[data-action="rebuild-index"]')
    expect(rebuild.disabled).toBe(true)
    expect(document.getElementById(rebuild.getAttribute('aria-describedby')!)!.textContent).toContain('cannot rebuild the index')
  })
  it('restores after a typed danger confirmation, a fresh check and a read-back of the new active generation', async () => {
    let restoredState = false
    const send = vi.fn<Send>(async (method) => { if (method === 'POST') { restoredState = true; return ack } return restoredState ? after : before })
    const ask = vi.fn(async () => '7')
    boot(send, ask); await tick()
    rollbackButton(7).click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true, input: true }))
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/generations'], ['GET', '/api/generations'], ['POST', '/api/generations/7/rollback'], ['GET', '/api/generations']])
    expect(send.mock.calls[2]![2]).toEqual({ expectedCurrentGenerationId: 9, expectedCurrentStateRevision: 20, expectedTargetChecksum: target.checksum, confirmation: '7' })
    expect($('[data-generations-status]').dataset.state).toBe('restored')
    expect(document.querySelector('[data-generation-row="10"]')).not.toBeNull()
    expect($('[data-generations-current]').textContent).toContain('Generation 10')
  })
  it('locks every rollback after an unknown outcome and never resends', async () => {
    const send = vi.fn<Send>(async (method) => { if (method === 'POST') throw { status: 503, details: { verificationRequired: true } }; return before })
    boot(send); await tick()
    rollbackButton(7).click(); await tick()
    expect($('[data-generations-status]').dataset.state).toBe('uncertain')
    expect(rollbackButton(7).disabled).toBe(true)
    rollbackButton(7).click(); await tick()
    expect(send.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1)
  })
  it('shows a failed read instead of a reading state and keeps rollback disabled', async () => {
    boot(vi.fn<Send>(async () => { throw { status: 503 } })); await tick()
    expect($('[data-generations-status]').dataset.state).toBe('failed')
    expect($('[data-generations-status]').textContent).not.toContain('Reading')
    expect(document.querySelectorAll('[data-action="rollback-generation"]:not([disabled])')).toHaveLength(0)
  })
})
