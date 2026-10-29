// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDefaultIndexWorkspace } from './board-port/whm-default-index-workspace.ts'
import { parseIndexDraft, readDefaultIndex, WHM_DEFAULT_INDEX_CLIENT_BINDING } from './whm-default-index-client.ts'

const name = 'index.example.test', initial = () => ({ configuration: { state: 'read', source: 'saved-domain-configuration', domain: { name, kind: 'primary', siteType: 'php' }, engine: 'apache', indexFiles: ['index.php', 'index.html', 'index.htm'], explicit: false, revision: 'a'.repeat(64) }, actions: { preview: true, save: true, reset: true }, application: { status: 'unverified', targetVerified: false } })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const control = <T extends HTMLElement = HTMLElement>(key: string): T => document.querySelector<T>('[data-default-index-' + key + ']')!
let listeners: EventListener[]
beforeEach(() => {
  listeners = []; const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderWhmDefaultIndexWorkspace({ locale: 'en', canManage: true })
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const model = () => {
  let saved = initial(), mode = 'normal'
  const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (path === '/api/server/default-index') return mode === 'empty' ? { source: 'saved-domain-configuration', domains: [] } : { source: 'saved-domain-configuration', domains: [{ name, kind: 'primary', siteType: 'php' }] }
    if (method === 'GET') { if (mode === 'read-failure') throw new Error('Synthetic read failure'); return clone(saved) }
    const raw = body as { indexFiles?: string; expectedRevision: string; confirmation?: string }
    expect(raw.expectedRevision).toBe(saved.configuration.revision)
    if (path.endsWith('/preview')) return { ...clone(saved), preview: { indexFiles: raw.indexFiles!.split(','), revision: saved.configuration.revision, engine: 'apache', syntaxChecked: false, lines: ['DirectoryIndex disabled', 'DirectoryIndex ' + raw.indexFiles!.replaceAll(',', ' ')] } }
    if (mode === 'conflict') throw { status: 409, details: { stateChanged: false } }
    if (mode === 'unknown') throw new Error('Synthetic transport interruption')
    expect(raw.confirmation).toBe(name)
    saved = { ...saved, configuration: { ...saved.configuration, indexFiles: path.endsWith('/reset') ? initial().configuration.indexFiles : raw.indexFiles!.split(','), explicit: true, revision: 'b'.repeat(64) } }
    const ack = { ...clone(saved), stateChanged: true, application: { status: 'not_requested', targetVerified: false } }
    if (mode === 'mismatch') saved.configuration.indexFiles = ['changed.html']
    if (mode === 'wrong-target') ack.configuration.domain.name = 'foreign.example.test'
    if (mode === 'invalid-ack') ack.application.status = 'unverified'
    return ack
  })
  const ask = vi.fn(async () => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport; new Function('return ' + WHM_DEFAULT_INDEX_CLIENT_BINDING)()(ask) }
  return { transport, ask, boot, setMode: (value: string) => { mode = value }, unqualified: () => { saved.actions.save = false; saved.actions.reset = false }, writes: () => transport.mock.calls.filter(call => call[0] === 'PUT' || call[1].endsWith('/reset')) }
}
const edit = (value = 'home.html,index.php') => { const input = control<HTMLInputElement>('files'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
const ready = async (f: ReturnType<typeof model>) => { f.boot(); await tick(); await tick() }

describe('default-index strict client and saved-state binding', () => {
  it('requires complete pinned authority and never permits unsafe filenames or fabricated application', () => {
    expect(readDefaultIndex(initial(), name)?.indexFiles).toEqual(['index.php', 'index.html', 'index.htm'])
    expect(readDefaultIndex(initial(), 'foreign.example.test')).toBeNull()
    expect(readDefaultIndex({ ...initial(), actions: {} }, name)).toBeNull()
    for (const raw of ['../index.html', 'index.php,index.php', 'index.php\nInjected', 'disabled', 'é.html']) expect(parseIndexDraft(raw)).toBeNull()
    expect(WHM_DEFAULT_INDEX_CLIENT_BINDING).not.toMatch(/fetch\(|innerHTML/)
    expect(() => new Function('return ' + WHM_DEFAULT_INDEX_CLIENT_BINDING)()).not.toThrow()
  })
  it('keeps every unavailable control visible without sending session requests', async () => {
    document.body.innerHTML = '<section data-capability-state="soon">' + renderWhmDefaultIndexWorkspace({ locale: 'ar', canManage: false }) + '</section>'
    const f = model(); await ready(f)
    expect(f.transport).not.toHaveBeenCalled()
    for (const item of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(item.disabled).toBe(true)
    expect(document.querySelector('bdi[dir=ltr]')).not.toBeNull()
  })
  it('reads saved qualification honestly and keeps read-only preview available', async () => {
    const f = model(); f.unqualified(); await ready(f)
    expect(control('status').dataset.state).toBe('unavailable'); expect(control<HTMLInputElement>('files').disabled).toBe(true)
    expect(control<HTMLButtonElement>('preview').disabled).toBe(false); expect(control<HTMLButtonElement>('save').disabled).toBe(true)
  })
  it('handles empty saved domains without inventing a target or enabling mutations', async () => {
    const f = model(); f.setMode('empty'); await ready(f)
    expect(control('status').dataset.state).toBe('empty'); expect(control<HTMLButtonElement>('save').disabled).toBe(true)
    expect(f.transport).toHaveBeenCalledOnce()
  })
  it('previews exact draft directives without requesting a write or native success', async () => {
    const f = model(); await ready(f); edit(); control<HTMLButtonElement>('preview').click(); await tick()
    expect(control('output').textContent).toBe('DirectoryIndex disabled\nDirectoryIndex home.html index.php')
    expect(control('status').dataset.state).toBe('previewed'); expect(f.writes()).toHaveLength(0)
  })
  it('saves only after confirmation with the selected domain and exact revision/readback', async () => {
    const f = model(); await ready(f); edit(); control<HTMLButtonElement>('save').click(); await tick(); await tick()
    expect(f.ask).toHaveBeenCalledOnce(); expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ indexFiles: 'home.html,index.php', confirmation: name, expectedRevision: 'a'.repeat(64) })
    expect(control('status').dataset.state).toBe('saved'); expect(control('status').textContent).toContain('Native application was not requested')
    expect(control<HTMLButtonElement>('save').disabled).toBe(true)
  })
  it('resets the selected domain using a separate confirmed mutation and saved readback', async () => {
    const f = model(); await ready(f); control<HTMLButtonElement>('reset').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1); expect(f.writes()[0]![1]).toBe('/api/server/default-index/' + name + '/reset')
    expect(f.writes()[0]![2]).toEqual({ confirmation: name, expectedRevision: 'a'.repeat(64) })
    expect(control('status').dataset.state).toBe('saved')
  })
  it('preserves drafts when confirmation is cancelled', async () => {
    const f = model(); await ready(f); f.ask.mockResolvedValue(false); edit(); control<HTMLButtonElement>('save').click(); await tick()
    expect(f.writes()).toHaveLength(0); expect(control<HTMLInputElement>('files').value).toBe('home.html,index.php')
  })
  it.each(['mismatch', 'wrong-target', 'invalid-ack', 'unknown'])('locks %s outcomes without retries or false saved state', async mode => {
    const f = model(); await ready(f); edit(); f.setMode(mode); control<HTMLButtonElement>('save').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('uncertain'); expect(control<HTMLInputElement>('files').value).toBe('home.html,index.php')
    control<HTMLButtonElement>('save').click(); await tick(); expect(f.writes()).toHaveLength(1)
  })
  it('retains stale drafts and unlocks only after an explicit confirmed saved-source reload', async () => {
    const f = model(); await ready(f); edit(); f.setMode('conflict'); control<HTMLButtonElement>('save').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('stale'); expect(control<HTMLButtonElement>('save').disabled).toBe(true)
    f.setMode('read-failure'); control<HTMLButtonElement>('refresh').click(); await tick(); await tick()
    expect(control<HTMLInputElement>('files').value).toBe('home.html,index.php')
    f.setMode('normal'); control<HTMLButtonElement>('refresh').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('read'); expect(control<HTMLInputElement>('files').value).toBe('index.php,index.html,index.htm')
  })
})
