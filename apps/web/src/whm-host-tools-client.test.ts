// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmHostToolCards } from './board-port/whm-host-tools-workspace.ts'
import { renderV2HostTools } from './themes/v2/pages/xwhm/server/host-tools.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { WHM_HOST_TOOLS_CLIENT_BINDING } from './whm-host-tools-client.ts'
import { HOST_TOOL_CARDS, type HostToolCardId } from '@xpanel/core'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const THEMES = {
  classic: (ids: readonly HostToolCardId[], canManage: boolean) => renderWhmHostToolCards({ ids, locale: 'en', canManage }),
  v2: (ids: readonly HostToolCardId[], canManage: boolean) => renderV2HostTools(v2Messages.translator('en'), ids, canManage),
}
const boot = (html: string, send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_HOST_TOOLS_CLIENT_BINDING)()(ask)
}
const field = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!
const status = () => document.querySelector<HTMLElement>('[data-host-tool-status]')!
const submit = () => document.querySelector<HTMLButtonElement>('[data-host-tool-submit]')!.click()
const rowButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-host-tool-rows] button')).find(item => item.textContent === label)!
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })
const taskRow = { id: 'aaaaaaaaaaa1', name: 'Nightly', type: 'command', cycle: 'daily', every: 0, minute: 5, hour: 3, weekday: 0, day: 0, enabled: true, chained: false, alert: false, remark: '', command: '/usr/bin/true', scriptId: '', target: '', keep: 0, exclude: '' }

describe.each(Object.entries(THEMES))('host tool cards in %s', (_theme, render) => {
  it('renders every card disabled until the client read its state', () => {
    document.body.innerHTML = render(Object.keys(HOST_TOOL_CARDS) as HostToolCardId[], true)
    expect(document.querySelectorAll('[data-host-tool]').length).toBe(22)
    expect(document.querySelectorAll('[data-host-tool] :is(input,select,textarea):not([disabled])').length).toBe(0)
    expect(document.querySelectorAll('[data-host-tool-submit]:not([disabled])').length).toBe(0)
  })

  it('lists tasks, reads labels from the spec and hides fields of other types', async () => {
    const send = vi.fn<Send>(async () => ({ revision: R1, rows: [taskRow, { ...taskRow, id: 'aaaaaaaaaaa2', name: 'Chained', chained: true }], scripts: [], tasks: [], runs: { aaaaaaaaaaa1: { at: '2026-11-07T01:02:03.000Z', result: 'ok' } } }))
    boot(render(['tasks'], true), send); await tick()
    const cells = Array.from(document.querySelectorAll('[data-host-tool-rows] td')).map(cell => cell.textContent)
    expect(document.querySelectorAll('[data-host-tool-rows] tr')).toHaveLength(1)
    expect(cells.slice(0, 5)).toEqual(['Nightly', 'Command', 'Daily', 'Yes', 'Succeeded 2026-11-07 01:02 UTC'])
    expect(field('command').closest<HTMLElement>('[data-host-tool-when]')!.hidden).toBe(false)
    expect(field('target').closest<HTMLElement>('[data-host-tool-when]')!.hidden).toBe(true)
    field('type').value = 'url'; field('type').dispatchEvent(new Event('change', { bubbles: true }))
    expect(field('target').closest<HTMLElement>('[data-host-tool-when]')!.hidden).toBe(false)
  })

  it('creates with the revision, leaves out hidden fields and shows the reconcile result', async () => {
    const send = vi.fn<Send>(async method => method === 'GET' ? { revision: R1, rows: [], scripts: [], tasks: [] } : { revision: R2, id: 'x', reconcile: { status: 'applied' } })
    boot(render(['tasks'], true), send); await tick()
    field('name').value = 'Nightly'
    submit(); await tick()
    const [, path, body] = send.mock.calls.find(call => call[0] === 'POST')! as [string, string, Record<string, unknown>]
    expect(path).toBe('/api/server/host-tools/tasks')
    expect(body).toMatchObject({ name: 'Nightly', type: 'command', cycle: 'manual', chained: false, expectedRevision: R1 })
    expect(body).not.toHaveProperty('target')
    expect(status().textContent).toBe('Applied on this server.')
  })

  it('edits a row and turns a refusal into the stable message', async () => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return { revision: R1, rows: [taskRow], scripts: [], tasks: [] }; throw { status: 422, details: { reason: 'task_cycle_invalid', stateChanged: false } } })
    boot(render(['tasks'], true), send); await tick()
    rowButton('Edit').click()
    expect(field('name').value).toBe('Nightly')
    expect(field('hour').value).toBe('3')
    submit(); await tick()
    expect(send.mock.calls.at(-1)!.slice(0, 2)).toEqual(['PUT', '/api/server/host-tools/tasks/aaaaaaaaaaa1'])
    expect(status().textContent).toContain('A backup cannot run every N seconds')
    expect(status().getAttribute('role')).toBe('alert')
  })

  it('runs, shows a log and deletes after confirmation', async () => {
    const send = vi.fn<Send>(async (method, path) => method === 'GET' ? (path.endsWith('/log') ? { log: 'hello', runs: [{ at: '2026-11-07T01:02:03.000Z', result: 'failed' }] } : { revision: R1, rows: [taskRow], scripts: [], tasks: [] }) : { revision: R2 })
    const ask = vi.fn(async () => false)
    boot(render(['tasks'], true), send, ask); await tick()
    rowButton('Run now').click(); await tick()
    expect(send.mock.calls.some(call => call[0] === 'POST' && call[1] === '/api/server/host-tools/tasks/aaaaaaaaaaa1/run')).toBe(true)
    rowButton('Log').click(); await tick()
    expect(document.querySelector<HTMLElement>('[data-host-tool-log]')!.textContent).toBe('2026-11-07 01:02 UTC failed\nhello')
    rowButton('Delete').click(); await tick()
    expect(send.mock.calls.some(call => call[0] === 'DELETE')).toBe(false)
    expect(status().textContent).toBe('Nothing was sent.')
  })

  it('shows a hook URL once, and only from the reply', async () => {
    const send = vi.fn<Send>(async method => method === 'GET' ? { revision: R1, rows: [], scripts: [{ id: 'bbbbbbbbbbb1', name: 'Deploy' }], runs: {} } : { revision: R2, id: 'x', reveal: `curl -X POST -H 'X-Hook-Key: k' https://panel/hook/x`, reconcile: { status: 'applied' } })
    boot(render(['hooks'], true), send); await tick()
    expect((field('scriptId') as unknown as HTMLSelectElement).options.length).toBe(1)
    field('name').value = 'Deploy'; field('scriptId').value = 'bbbbbbbbbbb1'
    submit(); await tick()
    expect(document.querySelector<HTMLElement>('[data-host-tool-reveal]')!.textContent).toBe(`curl -X POST -H 'X-Hook-Key: k' https://panel/hook/x`)
    expect(status().textContent).toBe('Copy this command now. The key is shown only once.')
  })

  it('sends a saved command to the session once, or says no session is open', async () => {
    const send = vi.fn<Send>(async () => ({ revision: R1, rows: [{ id: 'aaaaaaaaaaa1', name: 'Disk', content: 'df -h' }] }))
    boot(render(['saved-commands'], true), send); await tick()
    rowButton('Send').click(); await tick()
    expect(status().textContent).toBe('Open a terminal session first. Nothing was sent.')
    const seen: string[] = []
    const session = (event: Event): void => { const detail = (event as CustomEvent<{ text: string; sent: boolean }>).detail; seen.push(detail.text); detail.sent = true }
    document.body.addEventListener('xpanel:terminal-input', session)
    rowButton('Send').click(); await tick()
    document.body.removeEventListener('xpanel:terminal-input', session)
    expect(seen).toEqual(['df -h'])
    expect(status().textContent).toBe('Sent to the open session.')
  })

  it('previews the log cleanup and reports what was freed', async () => {
    const send = vi.fn<Send>(async method => method === 'GET' ? { rows: [{ id: 'web', name: 'web', files: 2, bytes: 2097152 }] } : { freedBytes: 2097152, removed: 2, failed: 0 })
    boot(render(['log-cleanup'], true), send); await tick()
    expect(Array.from(document.querySelectorAll('[data-host-tool-rows] td')).map(cell => cell.textContent)).toEqual(['Web server rotated logs', '2', '2.0 MB'])
    field('web').checked = true
    submit(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'POST')![2]).toMatchObject({ web: true, mail: false })
    expect(status().textContent).toBe('2.0 MB freed, 2 files handled, 0 failed.')
  })

  it('saves a single setting with PUT and fills the facts', async () => {
    const send = vi.fn<Send>(async method => method === 'GET' ? { revision: R1, swapMb: 1024, swapTotalMb: 1024 } : { revision: R2, job: { id: 'job1' } })
    boot(render(['swap'], true), send); await tick()
    expect(field('swapMb').value).toBe('1024')
    expect(document.querySelector('[data-host-tool-fact="swapTotalMb"]')!.textContent).toBe('1024')
    submit(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PUT')![2]).toMatchObject({ swapMb: '1024', expectedRevision: R1 })
    expect(document.querySelector<HTMLAnchorElement>('[data-host-tool-job]')!.hidden).toBe(false)
  })

  it('stays inert without manage authority', async () => {
    const send = vi.fn<Send>(async () => ({ revision: R1, rows: [taskRow], scripts: [], tasks: [] }))
    boot(render(['tasks'], false), send); await tick()
    expect(document.querySelectorAll('[data-host-tool] :is(input,select,textarea,button):not([disabled])').length).toBe(0)
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})
