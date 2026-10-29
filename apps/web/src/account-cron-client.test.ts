// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountCronWorkspace } from './board-port/account-cron-workspace.ts'
import { ACCOUNT_CRON_CLIENT_BINDING, accountCronDraft, readAccountCronObservation, readAccountCronView } from './account-cron-client.ts'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const job = (patch: Record<string, unknown> = {}) => ({ id: jobId, accountId, schedule: '*/5 * * * *', command: '  printf "%s" "one two"  ', comment: 'Scheduled work', enabled: true, maxRuntimeSec: 300,
  onCalendar: ['*-*-* *:00/5:00'], unitPreview: null, ...patch })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const response = (jobs = [job()], revision = '1'.padStart(64, '0')) => ({ context: { accountId, username: 'cronowner', home: '/home/cronowner' }, revision, jobs,
  capacity: { maxJobs: 1000, used: jobs.length, maxRuntimeSec: 604800 }, application: { status: 'configuration_only', nativeApplied: false } })
const hostResponse = (running = false) => ({ context: { accountId, jobId }, revision: response().revision, status: running ? 'accepted' : 'observed', ...(running ? { requested: true, completed: false } : {}), observation: { username: 'cronowner', timerEnabled: true, timerActive: true, serviceRunning: running, lastTriggerAt: null, lastStartedAt: null, nextRunAt: 'Tue 2026-10-27 00:00 UTC', durationMs: null, lastExitCode: null, lastResult: 'unknown' } })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-cron-' + key + ']')!
const field = (key: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-cron-field="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-cron-status]')!
const edit = (key: string, value: string) => { field(key).value = value; field(key).dispatchEvent(new Event('input')) }
let unload: EventListener[]
beforeEach(() => {
  unload = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') unload.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderAccountCronWorkspace({ lang: 'en', expectedAccountId: accountId, canManage: true })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of unload) window.removeEventListener('beforeunload', listener); document.body.replaceChildren(); vi.restoreAllMocks() })
const model = () => {
  let jobs = [job()], revision = 1, mode = 'normal'
  const payload = () => response(clone(jobs), String(revision).padStart(64, '0'))
  const send = vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') { if (mode === 'read-failure') throw { status: 503 }; return payload() }
    if (mode === 'refused') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'stale') throw { status: 409, details: { stateChanged: false } }
    if (mode === 'uncertain') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
    const input = body as Record<string, unknown>
    if (input.expectedRevision !== String(revision).padStart(64, '0')) throw { status: 409, details: { stateChanged: false } }
    const id = path.split('/').at(-1)
    if (method === 'DELETE') jobs = jobs.filter(item => item.id !== id)
    else {
      const { expectedRevision: _expectedRevision, ...draft } = input
      const saved = job({ ...draft, id: method === 'POST' ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : id })
      jobs = method === 'POST' ? [...jobs, saved] : jobs.map(item => item.id === id ? saved : item)
    }
    revision++
    const result = payload()
    if (mode === 'wrong-ack' && result.jobs[0]) result.jobs[0].command = 'other command'
    return result
  })
  const ask = vi.fn(async () => true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + ACCOUNT_CRON_CLIENT_BINDING)()(ask) }
  const select = async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cron-jobs] button')).find(button => button.textContent === 'Edit')!.click(); await tick(); await tick() }
  return { send, ask, boot, select, setMode: (value: string) => { mode = value }, setJobs: (value: ReturnType<typeof job>[]) => { jobs = value }, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('cron response and draft validation', () => {
  it('pins host observations to the saved account, job and revision and refuses invented completion', () => {
    const view = readAccountCronView(response(), accountId)
    expect(readAccountCronObservation(hostResponse(true), view, view.jobs[0]!, true).serviceRunning).toBe(true)
    for (const value of [{ ...hostResponse(true), completed: true }, { ...hostResponse(true), context: { accountId, jobId: 'other' } }, { ...hostResponse(), revision: 'f'.repeat(64) }, { ...hostResponse(), observation: { ...hostResponse().observation, durationMs: -1 } }, { ...hostResponse(true), unknownOutcome: true }]) expect(() => readAccountCronObservation(value, view, view.jobs[0]!, true)).toThrow()
  })
  it('pins the owner scope and refuses malformed, foreign or promoted native claims', () => {
    expect(readAccountCronView(response([job({ schedule: '@reboot', onCalendar: [], scheduleSupported: false })]), accountId).jobs[0]?.scheduleSupported).toBe(false)
    expect(readAccountCronView(response(), accountId).jobs[0]?.command).toBe(job().command)
    for (const bad of [null, {}, { ...response(), context: { ...response().context, accountId: 'other' } },
      response([job({ accountId: 'other' })]), response([job({ enabled: 'yes' })]), response([job({ maxRuntimeSec: 0 })]),
      { ...response(), application: { status: 'applied', nativeApplied: true } }, { ...response(), verificationRequired: true },
      response([job(), job()]), response([job({ command: 'bad\ncommand' })])]) expect(() => readAccountCronView(bad, accountId)).toThrow()
  })
  it('keeps exact command text, five schedule fields and validated runtime values', () => {
    const input = { fields: ['*/5', '*', '*', '*', '*'], command: job().command, comment: '', enabled: true, unlimited: false, runtime: '300' }
    expect(accountCronDraft(input, 604800)).toMatchObject({ schedule: '*/5 * * * *', command: job().command, maxRuntimeSec: 300 })
    expect(accountCronDraft({ ...input, unlimited: true }, 604800).maxRuntimeSec).toBeNull()
    for (const patch of [{ runtime: '-1' }, { runtime: '604801' }, { runtime: '1.2' }, { command: '' }, { fields: ['@reboot'] }]) expect(() => accountCronDraft({ ...input, ...patch }, 604800)).toThrow()
  })
})

describe('account cron page controller', () => {
  it('runs only the confirmed saved job and shows actual accepted host state without completion claims', async () => {
    const f = model(), payload = { ...response(), capabilities: { runNow: true, observation: true } }
    f.send.mockImplementation(async (method, path, body) => {
      if (path.endsWith('/run')) { expect(method).toBe('POST'); expect(body).toEqual({ expectedRevision: payload.revision, confirmation: job().command }); return hostResponse(true) }
      if (path.endsWith('/status')) return hostResponse()
      return clone(payload)
    })
    f.boot(); await tick(); await f.select()
    expect(action('run').disabled).toBe(false)
    action('run').click(); await tick(); await tick()
    expect(f.ask).toHaveBeenCalledOnce(); expect(status().dataset.state).toBe('requested')
    expect(status().textContent).toContain('Completion has not been confirmed')
    expect(f.send.mock.calls.filter(call => call[1].endsWith('/run'))).toHaveLength(1)
    expect(document.querySelector('[data-cron-jobs]')!.textContent).toContain('Tue 2026-10-27')
    action('observe').click(); await tick(); expect(status().dataset.state).toBe('observed')
    edit('command', 'echo unsaved'); expect(action('run').disabled).toBe(true); expect(action('observe').disabled).toBe(true)
  })
  it('locks after an uncertain host request without automatic retry and retains the selected draft', async () => {
    const f = model(), payload = { ...response(), capabilities: { runNow: true, observation: true } }
    f.send.mockImplementation(async (_method, path) => { if (path.endsWith('/run')) throw { status: 412, details: { unknownOutcome: true, stateChanged: true } }; return clone(payload) })
    f.boot(); await tick(); await f.select(); action('run').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(action('run').disabled).toBe(true); expect(field('command').value).toBe(job().command)
    expect(f.send.mock.calls.filter(call => call[1].endsWith('/run'))).toHaveLength(1)
  })
  it('keeps the approved controls and a self-contained safe browser binding', () => {
    expect(() => new Function('return ' + ACCOUNT_CRON_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_CRON_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_CRON_CLIENT_BINDING).not.toContain('fetch(')
    for (const label of ['Scheduled jobs', 'Every 5 minutes', 'Stop the job after', 'Only when it fails', 'After every run', 'Output email', 'Unit preview', 'Run selected job now']) expect(document.body.textContent).toContain(label)
    expect(document.body.textContent).not.toContain(accountId)
  })
  it('does not read or mutate without transport or capability admission', async () => {
    new Function('return ' + ACCOUNT_CRON_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(action('save').disabled).toBe(true)
    const root = document.querySelector<HTMLElement>('[data-account-cron]')!; delete root.dataset.cronBound; root.dataset.cronManage = 'false'
    const f = model(); f.boot(); await tick(); expect(f.send).not.toHaveBeenCalled()
  })
  it('reads actual returned jobs and keeps unavailable host observations honest', async () => {
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-cron-jobs]')!.textContent).toContain('Scheduled work')
    expect(document.querySelector('[data-cron-jobs]')!.textContent).toContain('Not observed')
    expect(document.querySelector('[data-cron-jobs]')!.textContent).not.toContain(jobId)
    expect(document.querySelector('[data-cron-username]')!.textContent).toBe('cronowner')
    expect(action('save').disabled).toBe(true)
  })
  it('creates a real draft and verifies the exact returned job and readback', async () => {
    const f = model(); f.boot(); await tick(); edit('command', '  echo "new command"  '); edit('comment', 'New task')
    action('save').click(); await tick(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]).toEqual(['POST', '/api/account/cron', { schedule: '*/5 * * * *', command: '  echo "new command"  ', comment: 'New task', enabled: true, maxRuntimeSec: null, expectedRevision: '1'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('saved'); expect(field('command').value).toBe('  echo "new command"  ')
  })
  it('edits the selected job without changing unrelated jobs or losing focus during typing', async () => {
    const f = model(); f.boot(); await tick(); await f.select()
    const input = field('command'); input.focus(); edit('command', '  printf "%s" "updated"  ')
    expect(document.activeElement).toBe(input)
    action('save').click(); await tick(); await tick()
    expect(f.writes()[0]).toEqual(['PATCH', '/api/account/cron/' + jobId, { schedule: '*/5 * * * *', command: '  printf "%s" "updated"  ', comment: 'Scheduled work', enabled: true, maxRuntimeSec: 300, expectedRevision: '1'.padStart(64, '0') }])
    expect(status().dataset.state).toBe('saved')
  })
  it('does not dirty a saved macro or rewrite it when editing only the comment', async () => {
    const f = model(); f.setJobs([job({ schedule: '@daily' })]); f.boot(); await tick(); await f.select()
    expect(action('save').disabled).toBe(true)
    edit('comment', 'Renamed daily task'); action('save').click(); await tick(); await tick()
    expect((f.writes()[0]![2] as Record<string, unknown>).schedule).toBe('@daily')
    expect(status().dataset.state).toBe('saved')
  })
  it('cancels save and delete without sending requests or dropping the draft', async () => {
    const f = model(); f.boot(); await tick(); edit('command', 'echo draft'); f.ask.mockResolvedValue(false)
    const before = f.send.mock.calls.length
    action('save').click(); await tick()
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cron-jobs] button')).find(button => button.textContent === 'Delete')!.click(); await tick()
    expect(f.send.mock.calls).toHaveLength(before); expect(field('command').value).toBe('echo draft')
  })
  it('deletes only the confirmed saved command and verifies absence', async () => {
    const f = model(); f.boot(); await tick()
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cron-jobs] button')).find(button => button.textContent === 'Delete')!.click(); await tick(); await tick()
    expect(f.writes()[0]).toEqual(['DELETE', '/api/account/cron/' + jobId, { expectedRevision: '1'.padStart(64, '0'), confirmation: job().command }])
    expect(status().dataset.state).toBe('deleted'); expect(document.querySelector('[data-cron-jobs]')!.textContent).toContain('no cron jobs')
  })
  it.each(['stale', 'uncertain', 'wrong-ack'])('keeps and locks the draft after %s without automatic retries', async mode => {
    const f = model(); f.boot(); await tick(); await f.select(); edit('command', 'echo draft'); f.setMode(mode)
    action('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe(mode === 'stale' ? 'stale' : 'uncertain')
    expect(action('save').disabled).toBe(true); expect(field('command').value).toBe('echo draft'); expect(f.writes()).toHaveLength(1)
    f.ask.mockResolvedValue(false); const reads = f.send.mock.calls.filter(call => call[0] === 'GET').length; action('refresh').click(); await tick()
    expect(f.send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(reads); expect(field('command').value).toBe('echo draft')
  })
  it('keeps a definitely refused draft editable, and validation failure sends nothing', async () => {
    const f = model(); f.boot(); await tick(); edit('command', 'echo draft'); edit('minute', 'bad field'); action('save').click(); await tick()
    expect(f.writes()).toHaveLength(0); expect(status().dataset.state).toBe('failed')
    edit('minute', '*/5'); f.setMode('refused'); action('save').click(); await tick(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(action('save').disabled).toBe(false); expect(field('command').value).toBe('echo draft')
  })
  it('renders hostile command text literally and never fabricates unit source', async () => {
    const f = model(); f.setJobs([job({ command: '<img src=x onerror=alert(1)>' })]); f.boot(); await tick()
    expect(document.querySelector('img')).toBeNull()
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cron-jobs] button')).find(button => button.textContent === 'View unit')!.click()
    expect(document.querySelector('[data-cron-preview]')!.textContent).toContain('OnCalendar=')
    expect(document.querySelector('[data-cron-preview-state]')!.textContent).toContain('configured host profile is unavailable')
  })
})
