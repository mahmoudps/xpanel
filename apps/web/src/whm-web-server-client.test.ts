// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmWebGenerationControls, renderWhmWebServerReadback } from './board-port/whm-web-server-workspace.ts'
import { buildWhmWebRollbackRequest, readWhmWebRollbackAck, readWhmWebGenerations, readWhmWebServices, WHM_WEB_SERVER_CLIENT_BINDING } from './whm-web-server-client.ts'
const current = { id: 9, createdAt: '2026-10-26T12:00:00Z', status: 'active', checksum: '9'.repeat(64) }
const target = { id: 7, createdAt: '2026-10-25T12:00:00Z', status: 'superseded', checksum: '7'.repeat(64) }
const desiredState = { revision: 20, checksum: 'd'.repeat(64), pending: false }
const settings = { engine: 'apache', apacheMpm: 'itk', backendPort: 8080, backendTlsPort: 8443, nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, keepaliveTimeoutSec: 45, multiAccept: false }, apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 200, serverLimit: 200, maxConnectionsPerChild: 0 } }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const render = (canRollback: boolean) => `<section data-whm-detail-route="/whm/services/web" data-capability-state="authorized"><section data-whm-detail-section="web-stack"><form data-server-settings-form><label for="engine">Engine</label><select id="engine" name="engine"><option value="apache">Apache</option><option value="openlitespeed">OpenLiteSpeed</option></select><button type="submit">Save</button></form></section><section data-whm-detail-section="web-backend">${renderWhmWebServerReadback({ locale: 'en', canRead: true, canRollback })}</section><section data-whm-detail-section="web-pending"><table><tbody></tbody></table><button type="button" disabled>Discard</button></section><section data-whm-detail-section="web-generations"><table><tbody></tbody></table>${renderWhmWebGenerationControls({ locale: 'en', canRead: true, canRollback })}</section></section>`
beforeEach(() => { document.body.innerHTML = render(false); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const model = () => {
  let active = current, resultMode = 'normal'
  let sourceState: typeof desiredState | null | undefined = { ...desiredState }, canRollback: boolean | undefined = true
  let eligibleTargets: number[] | undefined = [target.id]
  const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
    if (method === 'GET' && path === '/api/server/settings') return { settings }
    if (method === 'GET' && path === '/api/server/services') return { services: [{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' }] }
    if (method === 'GET' && path === '/api/generations') return { generations: [active, target], currentGeneration: active, ...(eligibleTargets === undefined ? {} : { rollbackEligibleGenerationIds: [...eligibleTargets] }), ...(sourceState === undefined ? {} : { desiredState: sourceState && { ...sourceState } }), ...(canRollback === undefined ? {} : { canRollback }) }
    if (method === 'POST') {
      if (resultMode === 'uncertain') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
      active = { ...current, id: 10, checksum: 'a'.repeat(64) }
      sourceState = { ...desiredState, revision: 21, checksum: 'e'.repeat(64), pending: resultMode === 'pending-readback' }
      return { status: 'applied', stateChanged: true, generation: active, rollbackTargetGenerationId: resultMode === 'wrong-target' ? 8 : target.id, rollbackTargetChecksum: target.checksum }
    }
    throw new Error('unexpected_request')
  })
  const ask = vi.fn(async () => '7' as unknown)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_WEB_SERVER_CLIENT_BINDING)()(ask) }
  return { send, ask, boot, setMode: (value: string) => { resultMode = value }, setDesiredState: (value: typeof desiredState | null | undefined) => { sourceState = value }, setAdmission: (value: boolean | undefined) => { canRollback = value }, setEligibleTargets: (value: number[] | undefined) => { eligibleTargets = value } }
}
describe('WHM web server readback and guarded rollback controller', () => {
  it('uses persisted target/current metadata and exact official-number confirmation', () => {
    expect(buildWhmWebRollbackRequest(current, target, desiredState, '7')).toEqual({ expectedCurrentGenerationId: 9, expectedCurrentStateRevision: 20, expectedTargetChecksum: target.checksum, confirmation: '7' })
    for (const confirmation of ['07', '9', true, null]) expect(() => buildWhmWebRollbackRequest(current, target, desiredState, confirmation)).toThrow()
    expect(() => buildWhmWebRollbackRequest(current, current, desiredState, '9')).toThrow()
    expect(() => buildWhmWebRollbackRequest(current, target, { ...desiredState, pending: true }, '7')).toThrow()
    expect(readWhmWebRollbackAck({ status: 'applied', stateChanged: true, generation: { ...current, id: 10 }, rollbackTargetGenerationId: 7, rollbackTargetChecksum: target.checksum }, target).id).toBe(10)
    expect(() => readWhmWebRollbackAck({ status: 'applied', generation: current, rollbackTargetGenerationId: 8, rollbackTargetChecksum: target.checksum }, target)).toThrow()
    expect(() => readWhmWebRollbackAck({ status: 'applied', generation: current, rollbackTargetGenerationId: 7, rollbackTargetChecksum: target.checksum, unknownOutcome: true }, target)).toThrow()
  })
  it('rejects malformed generation/service observations instead of inferring health', () => {
    expect(readWhmWebGenerations({ generations: [current, target], currentGeneration: current })).toMatchObject({ currentGeneration: current, desiredState: null, canRollback: false })
    expect(readWhmWebGenerations({ generations: [current, target], currentGeneration: current, desiredState, canRollback: true })).toMatchObject({ desiredState, canRollback: true })
    expect(() => readWhmWebGenerations({ generations: [current, target], currentGeneration: current, desiredState: { ...desiredState, revision: -1 }, canRollback: true })).toThrow()
    expect(() => readWhmWebGenerations({ generations: [current, current], currentGeneration: current })).toThrow()
    expect(() => readWhmWebServices({ services: [{ id: 'nginx', label: 'nginx', unit: null, state: 'active' }] })).toThrow()
  })
  it('does not read without a transport or admitted workspace', async () => {
    new Function('return ' + WHM_WEB_SERVER_CLIENT_BINDING)()(undefined)
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-web-readback]')!.removeAttribute('data-web-bound')
    document.querySelector<HTMLElement>('[data-whm-detail-route]')!.dataset.capabilityState = 'unavailable'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('reads actual endpoints and does not infer rollback admission from root/page access', async () => {
    const f = model(); f.boot(); await tick()
    expect(f.send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/settings'], ['GET', '/api/server/services'], ['GET', '/api/generations']])
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('read')
    expect(document.querySelector('[data-whm-web-engine]')!.textContent).toBe('apache')
    expect(document.querySelector('[data-whm-web-current]')!.textContent).toBe('9')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.disabled).toBe(true)
    expect(WHM_WEB_SERVER_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_WEB_SERVER_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('previews the draft without adding a second settings submit handler or sending a write', async () => {
    const f = model(); f.boot(); await tick()
    const engine = document.querySelector<HTMLSelectElement>('[name="engine"]')!; engine.value = 'openlitespeed'; engine.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector('[data-whm-detail-section="web-pending"] tbody')!.textContent).toContain('openlitespeed')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-detail-section="web-pending"] button')!.disabled).toBe(false)
    expect(f.send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it.each(['missing-state', 'pending-state', 'missing-admission', 'denied-admission', 'missing-target-admission', 'denied-target-admission'])('keeps restore disabled for %s even when the page can read', async mode => {
    document.body.innerHTML = render(true)
    const f = model()
    if (mode === 'missing-state') f.setDesiredState(undefined)
    if (mode === 'pending-state') f.setDesiredState({ ...desiredState, pending: true })
    if (mode === 'missing-admission') f.setAdmission(undefined)
    if (mode === 'denied-admission') f.setAdmission(false)
    if (mode === 'missing-target-admission') f.setEligibleTargets(undefined)
    if (mode === 'denied-target-admission') f.setEligibleTargets([])
    f.boot(); await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('read')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.disabled).toBe(true)
    expect(f.send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it.each(['new-revision', 'pending-divergence'])('preserves saved state and refuses %s while the active generation is unchanged', async mode => {
    document.body.innerHTML = render(true)
    const f = model(); f.boot(); await tick()
    f.setDesiredState({ ...desiredState, revision: 21, pending: mode === 'pending-divergence' })
    document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.click(); await tick(); await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('stale')
    expect(document.querySelector<HTMLSelectElement>('[name="engine"]')!.disabled).toBe(true)
    expect(f.send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(0)
  })
  it('requires typed confirmation and fresh guarded metadata before a restore, then verifies the resulting generation', async () => {
    document.body.innerHTML = render(true)
    const f = model(); f.boot(); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.click(); await tick(); await tick()
    const post = f.send.mock.calls.find(call => call[0] === 'POST')
    expect(post).toEqual(['POST', '/api/generations/7/rollback', { expectedCurrentGenerationId: 9, expectedCurrentStateRevision: 20, expectedTargetChecksum: target.checksum, confirmation: '7' }])
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('restored')
    expect(document.querySelector('[data-whm-web-current]')!.textContent).toBe('10')
  })
  it.each(['uncertain', 'wrong-target', 'pending-readback'])('locks after %s with no automatic retry', async mode => {
    document.body.innerHTML = render(true)
    const f = model(); f.setMode(mode); f.boot(); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.click(); await tick(); await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-web-status]')!.dataset.state).toBe('uncertain')
    expect(f.send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('[data-whm-web-rollback]')!.disabled).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('[name="engine"]')!.disabled).toBe(true)
  })
})


describe('full timestamp display additional web generations', () => {
  it.each(['en', 'ar'] as const)('formats generation instants while retaining canonical rollback metadata in %s', async locale => {
    const raw = { generations: [{ ...current, createdAt: '2026-10-27T09:00:11.234567Z' }, { ...target, createdAt: '2026-10-27T11:00:12.1200+02:00' }], currentGeneration: { ...current, createdAt: '2026-10-27T09:00:11.234567Z' }, desiredState, canRollback: false, rollbackEligibleGenerationIds: [] }
    const before = JSON.stringify(raw)
    const send = vi.fn(async (_method: string, path: string) => path === '/api/generations' ? raw : path === '/api/server/settings' ? { settings } : { services: [{ id: 'nginx', label: 'nginx', unit: 'nginx.service', state: 'active' }] })
    document.body.innerHTML = render(false)
      .replace(renderWhmWebServerReadback({ locale: 'en', canRead: true, canRollback: false }), renderWhmWebServerReadback({ locale, canRead: true, canRollback: false }))
      .replace(renderWhmWebGenerationControls({ locale: 'en', canRead: true, canRollback: false }), renderWhmWebGenerationControls({ locale, canRead: true, canRollback: false }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    new Function('return ' + WHM_WEB_SERVER_CLIENT_BINDING)()(undefined); await tick()
    document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
    const rows = document.querySelectorAll('[data-whm-detail-section="web-generations"] tbody tr')
    expect(rows[0]!.querySelectorAll('td')[1]!.textContent).toBe('2026-10-27 09:00 UTC')
    expect(rows[1]!.querySelectorAll('td')[1]!.textContent).toBe('2026-10-27 09:00 UTC')
    expect(rows[0]!.querySelectorAll('td')[1]!.querySelector('bdi')!.getAttribute('dir')).toBe('ltr')
    expect(readWhmWebGenerations(raw).generations[1]!.createdAt).toBe('2026-10-27T11:00:12.1200+02:00')
    expect([...document.querySelectorAll('[data-whm-web-generation] option')].map(option => option.textContent)).toContain(locale === 'ar' ? 'الجيل 7' : 'Generation 7')
    expect(send).toHaveBeenCalledWith('GET', '/api/generations')
    expect(JSON.stringify(raw)).toBe(before)
  })
})
