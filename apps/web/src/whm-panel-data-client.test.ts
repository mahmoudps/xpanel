/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmRoute } from '../../../tests/fixtures/workspace-route-render.ts'
import { allRouteClientChunkSources } from './route-client-chunks.ts'
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
  document.body.innerHTML = renderWhmRoute('/whm/panel/data', { locale: 'en', generationId: 9, principal: { kind: 'root', id: 'fixture-root', username: 'operator' } })
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_PANEL_DATA_CLIENT_BINDING)()(ask)
}
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('configuration history binding', () => {
  it('is registered, reads the real history and enables admitted rollback targets and search index rebuild', async () => {
    expect(allRouteClientChunkSources()).toContain(WHM_PANEL_DATA_CLIENT_BINDING)
    boot(vi.fn<Send>(async () => before)); await tick()
    expect(document.querySelectorAll('[data-generation-row]')).toHaveLength(2)
    expect(rollbackButton(7).disabled).toBe(false)
    expect(rollbackButton(9).disabled).toBe(true)
    expect($('[data-generations-status]').dataset.state).toBe('read')
    const rebuild = $<HTMLButtonElement>('[data-action="rebuild-index"]')
    expect(rebuild.disabled).toBe(false)
    expect(document.getElementById(rebuild.getAttribute('aria-describedby')!)!.textContent).toContain('derived FTS and SQLite search index')
  })
  it('rebuilds the search index after confirmation and announces live status', async () => {
    const send = vi.fn<Send>(async (method, path) => method === 'POST' && path === '/api/server/search-index/rebuild'
      ? { ok: true, rebuilt: true, counts: { resellers: 1, plans: 2, accounts: 3, domains: 4, serviceUsers: 5, databases: 1, ftsEntries: 16 } }
      : before)
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    $<HTMLButtonElement>('[data-action="rebuild-index"]').click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rebuild search index' }))
    expect(send).toHaveBeenCalledWith('POST', '/api/server/search-index/rebuild', { confirm: true })
    expect($('[data-generations-status]').dataset.state).toBe('rebuilt')
    expect($('[data-generations-status]').textContent).toContain('16')
    expect($('[data-generations-status]').getAttribute('role')).toBe('status')
  })
  it('does not send rebuild when confirmation is declined and announces failure on error', async () => {
    const send = vi.fn<Send>(async (method) => {
      if (method === 'POST') throw { status: 500 }
      return before
    })
    boot(send, async () => false); await tick()
    $<HTMLButtonElement>('[data-action="rebuild-index"]').click(); await tick()
    expect(send.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(0)

    document.body.replaceChildren()
    boot(send, async () => true); await tick()
    $<HTMLButtonElement>('[data-action="rebuild-index"]').click(); await tick()
    expect($('[data-generations-status]').dataset.state).toBe('failed')
    expect($('[data-generations-status]').getAttribute('role')).toBe('alert')
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
