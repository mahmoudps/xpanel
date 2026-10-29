// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountSpamSettings } from './board-port/extensions/account-spam.ts'
import {
  ACCOUNT_SPAM_CLIENT_BINDING, readSpamSettings, spamSettingsDraft, spamSettingsMatch,
} from './account-spam-client.ts'

const settings = (patch: Record<string, unknown> = {}) => ({
  settings: {
    enabled: true, rewriteSubjectScore: 6, addHeaderScore: 5, greylistScore: 4, rejectScore: 15,
    spamBoxEnabled: true, autoDeleteSpam: false, autoDeleteScore: 12, allowlist: ['192.0.2.10'],
    blocklist: ['bad.example.test'], updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  },
})
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const status = () => document.querySelector<HTMLElement>('[data-spam-status]')!

describe('spam settings helpers', () => {
  it('validates the settings payload and refuses malformed values', () => {
    expect(readSpamSettings(settings()).rejectScore).toBe(15)
    for (const bad of [
      settings({ rejectScore: 101 }), settings({ rejectScore: '15' }), settings({ enabled: 'yes' }),
      settings({ allowlist: ['bad entry'] }), settings({ blocklist: ['1.2.3.4', '1.2.3.4'] }),
      settings({ allowlist: 'x' }), null, {},
    ]) expect(() => readSpamSettings(bad)).toThrow()
  })
  it('builds a normalized draft and compares it with a readback', () => {
    const draft = spamSettingsDraft({
      enabled: true, spamBoxEnabled: false, autoDeleteSpam: true,
      rewriteSubjectScore: '6.5', addHeaderScore: '5', greylistScore: '4', rejectScore: '15', autoDeleteScore: '12.5',
      allowlist: '192.0.2.10\n 2001:db8::1 ', blocklist: 'bad.example.test, other.example.test',
    })
    expect(draft).toMatchObject({ spamBoxEnabled: false, autoDeleteSpam: true, rewriteSubjectScore: 6.5, allowlist: ['192.0.2.10', '2001:db8::1'], blocklist: ['bad.example.test', 'other.example.test'] })
    expect(spamSettingsMatch(readSpamSettings(settings()), draft)).toBe(false)
    for (const bad of [
      { ...draft, rejectScore: '101' }, { ...draft, rejectScore: '1.234' }, { ...draft, rewriteSubjectScore: '-1' },
      { ...draft, allowlist: 'bad entry' }, { ...draft, blocklist: 'a@b.test,a@b.test' },
    ]) expect(() => spamSettingsDraft({ enabled: bad.enabled, spamBoxEnabled: bad.spamBoxEnabled, autoDeleteSpam: bad.autoDeleteSpam, rewriteSubjectScore: String(bad.rewriteSubjectScore), addHeaderScore: '5', greylistScore: '4', rejectScore: String(bad.rejectScore), autoDeleteScore: '12', allowlist: String(bad.allowlist), blocklist: String(bad.blocklist) })).toThrow()
  })
})

describe('spam settings browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = renderAccountSpamSettings({ lang: 'en', expectedAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', canManage: true })
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function(`(${ACCOUNT_SPAM_CLIENT_BINDING})((options) => Promise.resolve(true));`)()
  }
  it('constructs the binding and renders without forms or fetch', () => {
    expect(() => new Function('return ' + ACCOUNT_SPAM_CLIENT_BINDING)()).not.toThrow()
    expect(ACCOUNT_SPAM_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-spam-settings]')).not.toBeNull()
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('disables controls with an explicit unavailable state without a transport', () => {
    new Function(`(${ACCOUNT_SPAM_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-spam-save]')!.disabled).toBe(true)
  })
  it('reads settings, saves a valid draft and verifies the readback', async () => {
    let current = settings()
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return current
      if (method === 'PUT') {
        current = settings({ ...(body as Record<string, unknown>), enabled: true })
        return current
      }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    expect(status().dataset.state).toBe('read')
    document.querySelector<HTMLInputElement>('[data-spam-box]')!.checked = false
    document.querySelector<HTMLInputElement>('[data-spam-score="spam-reject"]')!.value = '20'
    document.querySelector<HTMLTextAreaElement>('[data-spam-blocklist]')!.value = 'bad.example.test\nother.example.test'
    document.querySelector<HTMLButtonElement>('[data-spam-save]')!.click(); await tick(); await tick()
    const put = calls.find(call => call.method === 'PUT')
    expect(put?.body).toMatchObject({ spamBoxEnabled: false, rejectScore: 20, blocklist: ['bad.example.test', 'other.example.test'] })
    expect(status().dataset.state).toBe('saved')
  })
  it('keeps a local validation failure explicit without sending, and locks after uncertainty', async () => {
    let mode: 'invalid' | 'uncertain' = 'invalid'
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return settings()
      if (mode === 'invalid') throw { status: 422, stateChanged: false }
      throw { status: 503, details: { verificationRequired: true } }
    })
    boot(transport); await tick()
    document.querySelector<HTMLInputElement>('[data-spam-score="spam-reject"]')!.value = '150'
    const before = transport.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-spam-save]')!.click(); await tick()
    expect(transport.mock.calls.length).toBe(before)
    expect(status().dataset.state).toBe('failed')
    mode = 'uncertain'
    document.querySelector<HTMLInputElement>('[data-spam-score="spam-reject"]')!.value = '20'
    document.querySelector<HTMLButtonElement>('[data-spam-save]')!.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('[data-spam-save]')!.disabled).toBe(true)
  })
})
