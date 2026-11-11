/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
// Module-local alias: the binding source defines it again from ASCII_BYTES_BINDING.
const formatClientBytes = canonicalFormatClientBytes

interface WebsiteView { domains: { id: string; name: string }[]; databases: string[]; contactEmail: string; job: { kind: string } | null; selected: null | { domainId: string; estimateBytes: number | null; remainingBytes: number | null; fits: boolean | null; backups: { id: string; createdAt: string; bytes: number; databases: string[] }[] } }

function bindWebsiteBackups(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  for (const root of document.querySelectorAll<HTMLElement>('[data-website-backups]')) {
    if (!request || root.dataset.bound === 'true') continue
    root.dataset.bound = 'true'
    const domain = root.querySelector<HTMLSelectElement>('[data-website-domain]'), rows = root.querySelector<HTMLElement>('[data-website-rows]'), status = root.querySelector<HTMLElement>('[data-website-status]'), create = root.querySelector<HTMLButtonElement>('[data-website-create]'), dbs = root.querySelector<HTMLInputElement>('[data-website-databases]'), mode = root.querySelector<HTMLSelectElement>('[data-website-mode]'), facts = root.querySelector<HTMLElement>('[data-website-fit]'), notify = root.querySelector<HTMLInputElement>('[data-website-notify]')
    if (!domain || !rows || !status || !create || !dbs || !mode || !facts || !notify) continue
    let timer: ReturnType<typeof setTimeout> | null = null, contactRead = false
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text }
    const size = (bytes: number): string => formatClientBytes(bytes)
    const failed = (error: { details?: { reason?: string } }): void => note('failed', error?.details?.reason === 'OPERATION_IN_PROGRESS' ? t('A backup or restore is already running for this account.') : error?.details?.reason === 'invalid_email' ? t('Check the email address. Nothing was started.') : t('The operation was refused. Nothing was changed.'))
    const send = (body: Record<string, unknown>, done: string): void => { note('saving', t('Starting…')); request('POST', '/api/account/website-backups', { ...body, domainId: domain.value }).then(() => { note('read', done); schedule() }).catch(failed) }
    const paint = (v: WebsiteView): void => {
      const keep = domain.value
      domain.replaceChildren(...v.domains.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option }))
      if (v.domains.some(item => item.id === keep)) domain.value = keep
      create.disabled = !!v.job || !v.domains.length; domain.disabled = false; dbs.disabled = !v.databases.length; notify.disabled = false
      if (!contactRead) { contactRead = true; notify.value = v.contactEmail }
      dbs.checked = v.databases.length > 0
      const s = v.selected
      facts.textContent = !s || s.estimateBytes === null ? t('Size has not been measured.') : s.remainingBytes === null ? t('This site is {size}.', { size: size(s.estimateBytes) }) : s.fits ? t('This site is {size} and fits your remaining {free}.', { size: size(s.estimateBytes), free: size(s.remainingBytes) }) : t('This site is {size}, more than your remaining {free}.', { size: size(s.estimateBytes), free: size(Math.max(0, s.remainingBytes)) })
      rows.replaceChildren(...(s?.backups ?? []).map(item => {
        const row = document.createElement('tr'), when = document.createElement('td'), bytes = document.createElement('td'), data = document.createElement('td'), actions = document.createElement('td')
        when.textContent = item.createdAt.slice(0, 16).replace('T', ' '); bytes.textContent = size(item.bytes); data.textContent = item.databases.join(', ') || '—'
        const button = (label: string, run: () => void): void => { const b = root.querySelector<HTMLTemplateElement>('template[data-website-button]')?.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined; if (!b) return; b.textContent = label; b.disabled = !!v.job; b.addEventListener('click', run); actions.append(b) }
        button(t('Restore'), () => send({ op: 'restore', id: item.id, mode: mode.value, databases: true }, t('The restore started.')))
        button(t('Extract to a new folder'), () => send({ op: 'extract', id: item.id }, t('Extraction started. The live site is not touched.')))
        button(t('Delete'), () => { request('POST', '/api/account/website-backups', { op: 'delete', domainId: domain.value, ids: [item.id] }).then(load).catch(failed) })
        row.append(when, bytes, data, actions); return row
      }))
      note(v.job ? 'reading' : 'read', v.job ? t('An operation is running. This list updates by itself.') : t('Backups read.'))
      if (v.job) schedule()
    }
    const load = (): Promise<void> => (request('GET', '/api/account/website-backups' + (domain.value ? '?domainId=' + encodeURIComponent(domain.value) : '')) as Promise<WebsiteView>).then(view => { paint(view); if (!domain.value || view.selected) return; return load() }).catch(() => note('failed', t('Website backups could not be read.')))
    const schedule = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (root.isConnected) void load() }, 5000) }
    domain.addEventListener('change', () => { void load() })
    create.addEventListener('click', () => { request('GET', '/api/account/website-backups').then(raw => send({ op: 'create', databases: dbs.checked ? (raw as WebsiteView).databases : [], notify: notify.value.trim() || null }, t('The backup started. It appears here when it is complete.'))).catch(failed) })
    void load()
  }
}

export const WEBSITE_BACKUPS_CLIENT_BINDING = `(()=>{const formatClientBytes=${ASCII_BYTES_BINDING};(${bindWebsiteBackups.toString()})()})`
