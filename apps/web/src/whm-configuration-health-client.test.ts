// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmConfigurationHealthWorkspace } from './board-port/whm-configuration-health-workspace.ts'
import { readConfigurationHealthRepair, readConfigurationHealthView, WHM_CONFIGURATION_HEALTH_CLIENT_BINDING } from './whm-configuration-health-client.ts'
const hash = 'a'.repeat(64), target = 'b'.repeat(64), path = '/etc/nginx/nginx.conf'
const view = (extra: Record<string, unknown> = {}) => ({ state: 'read', observedAt: '2026-10-27T00:00:00.000Z', revision: hash, generation: { id: 7, checksum: hash }, desired: { revision: 2, checksum: hash }, drift: 'drift', manifest: 'linked', pending: false, managedFiles: 1, targets: [{ token: target, path, reason: 'content_mismatch', expectedChecksum: hash, observedChecksum: 'c'.repeat(64) }], tests: [{ name: 'nginx', state: 'passed', exitCode: 0 }], canRepair: true, repairReason: 'ready', ...extra })
const fixed = () => view({ drift: 'clean', targets: [], canRepair: false, repairReason: 'no_drift' })
const ack = () => ({ outcome: 'verified', target, generation: { id: 7, checksum: hash }, recoveryVerified: true, verificationRequired: false, view: fixed() })
const tick = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const mount = (ar = false) => { document.body.innerHTML = renderWhmConfigurationHealthWorkspace({ locale: ar ? 'ar' : 'en', canRead: true, canRepair: true }) }
const boot = (request: (method: string, path: string, input?: unknown) => Promise<unknown>, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true, ar = false) => { document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'; (window as Window & { xpanelSessionRequest?: typeof request }).xpanelSessionRequest = request; const bind = new Function('return ' + WHM_CONFIGURATION_HEALTH_CLIENT_BINDING)(); bind(ask) }
const choose = () => { const select = q<HTMLSelectElement>('[data-ch-target]'); select.value = target; select.dispatchEvent(new Event('change')); const input = q<HTMLInputElement>('[data-ch-confirm]'); input.value = 'REPAIR CONFIGURATION'; input.dispatchEvent(new Event('input')) }
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
describe('configuration health strict projections', () => {
  it('strips private commands/output and rejects duplicate or contradictory facts', () => { expect(JSON.stringify(readConfigurationHealthView({ ...view(), output: 'private' }))).not.toContain('private'); for (const raw of [view({ drift: 'clean' }), view({ targets: [...view().targets, ...view().targets] }), view({ tests: [{ name: 'nginx', state: 'passed', exitCode: 1 }] }), view({ revision: null })]) expect(() => readConfigurationHealthView(raw)).toThrow() })
  it('requires exact repair identity, recovery and successful current tests', () => { expect(readConfigurationHealthRepair(ack(), target, { id: 7, checksum: hash }).drift).toBe('clean'); for (const raw of [{ ...ack(), target: hash }, { ...ack(), recoveryVerified: false }, { ...ack(), view: fixedWithFailedTests() }]) expect(() => readConfigurationHealthRepair(raw, target, { id: 7, checksum: hash })).toThrow() })
})
const fixedWithFailedTests = () => ({ ...fixed(), tests: [{ name: 'nginx', state: 'failed', exitCode: 1 }] })
describe('configuration health controller', () => {
  it('reads and paints genuine drift/test states with isolated checksums and no internal references', async () => { const send = vi.fn(async () => view()); boot(send); await tick(); expect(send).toHaveBeenCalledWith('GET', '/api/server/configuration-health'); expect(q('[data-ch-targets]').textContent).toContain(path); expect(q('[data-ch-tests]').textContent).toContain('Passed'); expect(q('[data-ch-fact="files"]').textContent).toBe('1'); expect(q('[data-ch-targets] bdi').getAttribute('dir')).toBe('ltr'); expect(document.body.textContent).not.toContain(target) })
  it('does not transport when the workspace is unavailable', async () => { q<HTMLElement>('[data-whm-configuration-health]').dataset.chCanRead = 'false'; const send = vi.fn(async () => view()); boot(send); await tick(); expect(send).not.toHaveBeenCalled(); expect(q<HTMLButtonElement>('[data-ch-repair]').disabled).toBe(true) })
  it('preserves repair controls honestly when the host provider is missing', async () => { boot(async () => view({ canRepair: false, repairReason: 'provider_unavailable' })); await tick(); expect(q<HTMLButtonElement>('[data-ch-repair]').disabled).toBe(true); expect(q('[data-ch-reason]').textContent).toContain('qualified provider'); expect(q('[data-ch-targets]').textContent).toContain(path) })
  it('requires exact confirmation and sends the observed target and generation only', async () => { const send = vi.fn(async (method: string) => method === 'GET' ? view() : ack()); boot(send); await tick(); expect(q<HTMLButtonElement>('[data-ch-repair]').disabled).toBe(true); choose(); q<HTMLButtonElement>('[data-ch-repair]').click(); await tick(); expect(send).toHaveBeenLastCalledWith('POST', '/api/server/configuration-health/repair', { target, expectedRevision: hash, expectedGenerationId: 7, expectedGenerationChecksum: hash, confirmation: 'REPAIR CONFIGURATION' }); expect(q<HTMLElement>('[data-ch-feedback]').dataset.state).toBe('verified'); expect(q<HTMLButtonElement>('[data-ch-repair]').disabled).toBe(true) })
  it('reauthorizes local admission after the confirmation await', async () => { let resolve!: (value: boolean) => void; const send = vi.fn(async () => view()); boot(send, () => new Promise(done => { resolve = done })); await tick(); choose(); q<HTMLButtonElement>('[data-ch-repair]').click(); q<HTMLElement>('[data-whm-configuration-health]').dataset.chCanRepair = 'false'; resolve(true); await tick(); expect(send).toHaveBeenCalledTimes(1) })
  it('keeps ambiguous and wrong-target acknowledgements locked until a fresh successful read', async () => { for (const post of [async () => { throw new Error('lost') }, async () => ({ ...ack(), target: hash })]) { mount(); const send = vi.fn(async (method: string) => method === 'GET' ? view() : post()); boot(send); await tick(); choose(); q<HTMLButtonElement>('[data-ch-repair]').click(); await tick(); expect(q<HTMLElement>('[data-ch-feedback]').dataset.state).toBe('unknown'); expect(q<HTMLSelectElement>('[data-ch-target]').disabled).toBe(true); q<HTMLButtonElement>('[data-ch-refresh]').click(); await tick(); expect(q<HTMLSelectElement>('[data-ch-target]').disabled).toBe(false) } })
  it('rejects an acknowledgement that clears unrelated drift or changes saved authority', async () => { const send = vi.fn(async (method: string) => method === 'GET' ? view() : { ...ack(), view: { ...fixed(), desired: { revision: 3, checksum: hash } } }); boot(send); await tick(); choose(); q<HTMLButtonElement>('[data-ch-repair]').click(); await tick(); expect(q<HTMLElement>('[data-ch-feedback]').dataset.state).toBe('unknown') })
  it('clears observations on failed refresh without presenting old state as current', async () => { let fail = false; boot(async () => { if (fail) throw new Error('offline'); return view() }); await tick(); fail = true; q<HTMLButtonElement>('[data-ch-refresh]').click(); await tick(); expect(q('[data-ch-targets]').textContent).not.toContain(path); expect(q<HTMLElement>('[data-ch-status]').dataset.state).toBe('failed') })
  it('uses Arabic copy and ASCII facts while keeping technical paths isolated', async () => { mount(true); boot(async () => view(), async () => true, true); await tick(); expect(q('[data-ch-status]').textContent).toContain('اكتملت'); expect(q('[data-ch-fact="files"]').textContent).toBe('1'); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/); expect(q('[data-ch-targets] bdi').getAttribute('dir')).toBe('ltr') })
})


describe('full timestamp display additional configuration health', () => {
  it.each(['en', 'ar'] as const)('formats observed time without changing repair target or checksums in %s', async locale => {
    mount(locale === 'ar')
    const raw = view({ observedAt: '2026-10-27T00:00:10.006Z' }), before = JSON.stringify(raw)
    const send = vi.fn(async () => raw)
    boot(send, undefined, locale === 'ar'); await tick()
    expect(q('[data-ch-fact="observed"]').textContent).toBe('2026-10-27 00:00 UTC')
    expect(q('[data-ch-fact="observed"]').getAttribute('dir')).toBe('ltr')
    expect(readConfigurationHealthView(raw).observedAt).toBe('2026-10-27T00:00:10.006Z')
    expect(q<HTMLSelectElement>('[data-ch-target]').querySelectorAll('option')[1]!.value).toBe(target)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/configuration-health')
    expect(JSON.stringify(raw)).toBe(before)
  })
})
