import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />

/**
 * Account spam-filter settings browser controller.
 * Reads/writes the real `/api/mail/spam-settings` route for the signed-in owner.
 * Stored configuration only; no MTA/spamassassin effect is claimed.
 */

const spamControl = /[\u0000-\u001f\u007f-\u009f]/
const spamEntry = /^[a-z0-9._:@[\]/-]+$/

export interface SpamSettingsView {
  enabled: boolean; rewriteSubjectScore: number; addHeaderScore: number; greylistScore: number; rejectScore: number
  spamBoxEnabled: boolean; autoDeleteSpam: boolean; autoDeleteScore: number; allowlist: string[]; blocklist: string[]; updatedAt: string
}
export interface SpamSettingsDraft {
  enabled: boolean; rewriteSubjectScore: number; addHeaderScore: number; greylistScore: number; rejectScore: number
  spamBoxEnabled: boolean; autoDeleteSpam: boolean; autoDeleteScore: number; allowlist: string[]; blocklist: string[]
}

export function spamSettingsObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const spamScore = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('invalid_' + field)
  return value
}
const spamList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 500) throw new Error('invalid_' + field)
  const seen = new Set<string>()
  return value.map(raw => {
    if (typeof raw !== 'string') throw new Error('invalid_' + field)
    const entry = raw.trim().toLowerCase()
    if (!entry || entry.length > 254 || spamControl.test(entry) || !spamEntry.test(entry) || entry.includes('..')) throw new Error('invalid_' + field)
    if (seen.has(entry)) throw new Error('invalid_' + field)
    seen.add(entry)
    return entry
  })
}
export function readSpamSettings(value: unknown): SpamSettingsView {
  if (!spamSettingsObject(value) || !spamSettingsObject(value.settings)) throw new Error('invalid_spam_settings')
  const settings = value.settings
  for (const key of ['enabled', 'spamBoxEnabled', 'autoDeleteSpam'] as const) if (typeof settings[key] !== 'boolean') throw new Error('invalid_spam_settings')
  return {
    enabled: settings.enabled as boolean,
    rewriteSubjectScore: spamScore(settings.rewriteSubjectScore, 'rewrite_score'),
    addHeaderScore: spamScore(settings.addHeaderScore, 'header_score'),
    greylistScore: spamScore(settings.greylistScore, 'greylist_score'),
    rejectScore: spamScore(settings.rejectScore, 'reject_score'),
    spamBoxEnabled: settings.spamBoxEnabled as boolean,
    autoDeleteSpam: settings.autoDeleteSpam as boolean,
    autoDeleteScore: spamScore(settings.autoDeleteScore, 'autodelete_score'),
    allowlist: spamList(settings.allowlist, 'allowlist'),
    blocklist: spamList(settings.blocklist, 'blocklist'),
    updatedAt: typeof settings.updatedAt === 'string' && Number.isFinite(Date.parse(settings.updatedAt)) ? settings.updatedAt : '',
  }
}

const parseList = (value: string, field: string): string[] => {
  const entries: string[] = []
  for (const raw of value.split(/[\n,]/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry.length > 254 || spamControl.test(entry) || !spamEntry.test(entry) || entry.includes('..')) throw new Error('invalid_' + field)
    if (entries.includes(entry)) throw new Error('duplicate_' + field)
    entries.push(entry)
  }
  if (entries.length > 500) throw new Error('too_many_' + field)
  return entries
}
export function spamSettingsDraft(input: {
  enabled: boolean; spamBoxEnabled: boolean; autoDeleteSpam: boolean
  rewriteSubjectScore: string; addHeaderScore: string; greylistScore: string; rejectScore: string; autoDeleteScore: string
  allowlist: string; blocklist: string
}): SpamSettingsDraft {
  const numeric = (raw: string, field: string): number => {
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(raw.trim())) throw new Error('invalid_' + field)
    const value = Number(raw.trim())
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('invalid_' + field)
    return value
  }
  return {
    enabled: input.enabled,
    rewriteSubjectScore: numeric(input.rewriteSubjectScore, 'rewrite_score'),
    addHeaderScore: numeric(input.addHeaderScore, 'header_score'),
    greylistScore: numeric(input.greylistScore, 'greylist_score'),
    rejectScore: numeric(input.rejectScore, 'reject_score'),
    spamBoxEnabled: input.spamBoxEnabled,
    autoDeleteSpam: input.autoDeleteSpam,
    autoDeleteScore: numeric(input.autoDeleteScore, 'autodelete_score'),
    allowlist: parseList(input.allowlist, 'allowlist'),
    blocklist: parseList(input.blocklist, 'blocklist'),
  }
}
export function spamSettingsMatch(observed: SpamSettingsView, draft: SpamSettingsDraft): boolean {
  return observed.enabled === draft.enabled && observed.spamBoxEnabled === draft.spamBoxEnabled
    && observed.autoDeleteSpam === draft.autoDeleteSpam
    && observed.rewriteSubjectScore === draft.rewriteSubjectScore && observed.addHeaderScore === draft.addHeaderScore
    && observed.greylistScore === draft.greylistScore && observed.rejectScore === draft.rejectScore
    && observed.autoDeleteScore === draft.autoDeleteScore
    && observed.allowlist.join(',') === draft.allowlist.join(',') && observed.blocklist.join(',') === draft.blocklist.join(',')
}

function bindSpamSettings(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-spam-settings]').forEach(root => {
    if (root.dataset.spamBound === 'true') return
    root.dataset.spamBound = 'true'
    const manageable = root.dataset.spamCanManage === 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const status = root.querySelector<HTMLElement>('[data-spam-status]')
    const saveButton = root.querySelector<HTMLButtonElement>('[data-spam-save]')
    const enabled = root.querySelector<HTMLInputElement>('[data-spam-enabled]')
    const box = root.querySelector<HTMLInputElement>('[data-spam-box]')
    const autodelete = root.querySelector<HTMLInputElement>('[data-spam-autodelete]')
    const textarea = (selector: string) => root.querySelector<HTMLTextAreaElement>(selector)
    const scoreInput = (id: string) => root.querySelector<HTMLInputElement>('[data-spam-score="' + id + '"]')
    if (!status || !saveButton || !enabled || !box || !autodelete) return
    const scores = { rewrite: scoreInput('spam-rewrite'), header: scoreInput('spam-header'), greylist: scoreInput('spam-greylist'), reject: scoreInput('spam-reject'), autodelete: scoreInput('spam-autodelete-score') }
    if (!scores.rewrite || !scores.header || !scores.greylist || !scores.reject || !scores.autodelete) return
    const allowlist = textarea('[data-spam-allowlist]'), blocklist = textarea('[data-spam-blocklist]')
    if (!allowlist || !blocklist) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && manageable && !root.closest(denied)
    let loaded = false, busy = false, uncertain = false
    const controls = (): (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button,input,textarea')]
    const setStatus = (message: string, kind: string): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => { const blocked = busy || uncertain || !eligible() || !loaded; controls().forEach(control => { control.disabled = blocked }) }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport) return Promise.reject(Object.assign(new Error('transport_unavailable'), { stateChanged: false }))
      return transport(method, path, body)
    }
    const fill = (settings: SpamSettingsView): void => {
      enabled.checked = settings.enabled
      box.checked = settings.spamBoxEnabled
      autodelete.checked = settings.autoDeleteSpam
      scores.rewrite!.value = String(settings.rewriteSubjectScore)
      scores.header!.value = String(settings.addHeaderScore)
      scores.greylist!.value = String(settings.greylistScore)
      scores.reject!.value = String(settings.rejectScore)
      scores.autodelete!.value = String(settings.autoDeleteScore)
      allowlist.value = settings.allowlist.join('\n')
      blocklist.value = settings.blocklist.join('\n')
    }
    const readDraft = (): SpamSettingsDraft => spamSettingsDraft({
      enabled: enabled.checked, spamBoxEnabled: box.checked, autoDeleteSpam: autodelete.checked,
      rewriteSubjectScore: scores.rewrite!.value, addHeaderScore: scores.header!.value,
      greylistScore: scores.greylist!.value, rejectScore: scores.reject!.value,
      autoDeleteScore: scores.autodelete!.value, allowlist: allowlist.value, blocklist: blocklist.value,
    })
    const load = async (): Promise<void> => {
      const settings = readSpamSettings(await request('GET', '/api/mail/spam-settings'))
      fill(settings)
      loaded = true
      setStatus(copy('Stored spam settings read. Mail-server application is not verified here.'), 'read')
      lock()
    }
    const save = async (): Promise<void> => {
      if (!eligible() || busy || uncertain || !loaded) return
      let draft: SpamSettingsDraft
      try { draft = readDraft() } catch {
        setStatus(copy('Scores must be numbers from 0 through 100 and the allow/block lists must contain unique bounded entries. Nothing was sent.'), 'failed')
        return
      }
      busy = true; lock()
      try {
        const reply = readSpamSettings(await request('PUT', '/api/mail/spam-settings', draft))
        if (!spamSettingsMatch(reply, draft)) throw new Error('spam_readback_mismatch')
        const persisted = readSpamSettings(await request('GET', '/api/mail/spam-settings'))
        if (!spamSettingsMatch(persisted, draft)) throw new Error('spam_not_observed')
        fill(persisted)
        setStatus(copy('Spam settings were stored and read back. Mail-server application remains unverified until host reconciliation reports it.'), 'saved')
      } catch (error) {
        if (spamSettingsObject(error) && (error.stateChanged === false || (spamSettingsObject(error.details) && (error.details as Record<string, unknown>).stateChanged === false))) {
          setStatus(copy('The spam settings request was refused. Your edits are kept and nothing was retried.'), 'failed')
        } else {
          uncertain = true
          setStatus(copy('The outcome is uncertain. Reload the page and inspect stored spam settings before retrying; no automatic retry was sent.'), 'uncertain')
        }
      } finally { busy = false; lock() }
    }
    if (!transport || !eligible()) {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Spam settings are unavailable here. Nothing was read or changed.'), 'unavailable')
      return
    }
    saveButton.addEventListener('click', event => { event.preventDefault(); void save() })
    lock()
    void load().catch(() => setStatus(copy('Stored spam settings could not be read. Editing stays unavailable.'), 'failed'))
  })
}

export const ACCOUNT_SPAM_CLIENT_BINDING = `(function(askDialog){const spamControl=${spamControl.toString()};const spamEntry=${spamEntry.toString()};const spamSettingsObject=${spamSettingsObject.toString()};const spamScore=${spamScore.toString()};const spamList=${spamList.toString()};const readSpamSettings=${readSpamSettings.toString()};const parseList=${parseList.toString()};const spamSettingsDraft=${spamSettingsDraft.toString()};const spamSettingsMatch=${spamSettingsMatch.toString()};(${bindSpamSettings.toString()})(askDialog);})`
