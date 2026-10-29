/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
/** `text` is an English source message; its placeholders take the manifest limits. */
type ManifestEntry = { id: string; text: string }
type Read = 'read' | 'unavailable'
export type SupportSummaryView = {
  observedAt: string; host: Read
  versions: { panel: { state: Read; version: string | null; releasePath: string | null }; node: string }
  os: { profile: { id: string; versionId: string; family: string }; release: { state: Read; prettyName: string | null } }
  uptime: { state: Read; seconds: number | null }
  services: { state: Read; items: { id: string; label: string; unit: string | null; state: string }[] }
  generation: { state: 'read' | 'none' | 'unavailable'; id: number | null; activatedAt: string | null; checksum: string | null }
  drift: { state: 'read' | 'none' | 'unavailable'; count: number | null; manifestMissing: boolean | null }
  failedJobs: { state: Read; items: { id: string; referenceCode: string | null; kind: string; failureClass: string | null; finishedAt: string | null; error: string | null }[] }
}
export type SupportView = {
  summary: SupportSummaryView | null
  manifest: { id: string; sections: ManifestEntry[]; excluded: ManifestEntry[]; redaction: ManifestEntry[]; hashing: { text: string }; limits: { journalLines: number; failedJobs: number; filesystems: number } }
  contact: { state: 'configured'; url: string | null; email: string | null } | { state: 'not-configured' } | { state: 'unavailable' }
}

export function readSupportView(value: unknown): SupportView {
  const reference = (item: unknown): item is string => typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(item) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) && item !== 'XP-JOB-000000'
  const bad = (): never => { throw new Error('invalid_support_view') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const safe = (item: unknown, max: number, pattern?: RegExp): string => {
    if (typeof item !== 'string' || item.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(item) || (pattern && !pattern.test(item))) return bad()
    // Line separators and bidirectional controls would reorder neighbouring text.
    for (const character of item) { const code = character.codePointAt(0)!; if (code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return bad() }
    return item as string
  }
  const opt = <T>(item: unknown, read: (raw: unknown) => T): T | null => item === null ? null : read(item)
  const time = (item: unknown): string => typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item)) ? safe(item, 40) : bad()
  const int = (item: unknown): number => Number.isSafeInteger(item) && (item as number) >= 0 ? item as number : bad()
  const one = <T>(item: unknown, allowed: readonly T[]): T => allowed.includes(item as T) ? item as T : bad()
  const list = <T>(item: unknown, max: number, read: (raw: unknown) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(read) : bad()
  const READ = ['read', 'unavailable'] as const, KNOWN = ['read', 'none', 'unavailable'] as const
  if (!object(value) || !object(value.manifest) || !object(value.manifest.hashing) || !object(value.manifest.limits) || !object(value.contact)) return bad()
  const m = value.manifest as Record<string, unknown> & { hashing: Record<string, unknown>; limits: Record<string, unknown> }
  const entry = (raw: unknown): ManifestEntry => object(raw) ? { id: safe(raw.id, 32, /^[A-Za-z][A-Za-z-]{0,31}$/), text: safe(raw.text, 600) } : bad()
  if (m.schemaVersion !== 1 || typeof m.id !== 'string' || !/^[0-9a-f]{16}$/.test(m.id)) return bad()
  const manifest = { id: m.id, sections: list(m.sections, 16, entry), excluded: list(m.excluded, 16, entry), redaction: list(m.redaction, 16, entry), hashing: { text: safe(m.hashing.text, 600) }, limits: { journalLines: int(m.limits.journalLines), failedJobs: int(m.limits.failedJobs), filesystems: int(m.limits.filesystems) } }
  if (!manifest.sections.length || !manifest.redaction.length) return bad()
  const c = value.contact
  let contact: SupportView['contact'] = { state: 'not-configured' }
  if (c.state === 'configured') {
    const url = opt(c.url, raw => safe(raw, 512, /^https?:\/\/[^\s<>"'`]+$/i)), email = opt(c.email, raw => safe(raw, 320, /^[^\s@<>"'`]+@[^\s@<>"'`]+$/))
    if (url === null && email === null) return bad()
    contact = { state: 'configured', url, email }
  } else if ((c.state !== 'not-configured' && c.state !== 'unavailable') || Object.keys(c).length !== 1) return bad()
  else contact = { state: c.state as 'not-configured' | 'unavailable' }
  let summary: SupportSummaryView | null = null
  if (value.summary !== null) {
    const s = value.summary
    if (!object(s) || !object(s.versions) || !object(s.versions.panel) || !object(s.os) || !object(s.os.profile) || !object(s.os.release) || !object(s.uptime) || !object(s.services) || !object(s.generation) || !object(s.drift) || !object(s.failedJobs)) return bad()
    const panel = s.versions.panel as Record<string, unknown>, profile = s.os.profile as Record<string, unknown>, release = s.os.release as Record<string, unknown>
    const uptime = s.uptime as Record<string, unknown>, services = s.services as Record<string, unknown>, g = s.generation as Record<string, unknown>, d = s.drift as Record<string, unknown>, jobs = s.failedJobs as Record<string, unknown>
    summary = {
      observedAt: time(s.observedAt), host: one(s.host, READ),
      versions: { panel: { state: one(panel.state, READ), version: opt(panel.version, raw => safe(raw, 32, /^\d{1,9}\.\d{1,9}\.\d{1,9}$/)), releasePath: opt(panel.releasePath, raw => safe(raw, 256, /^\//)) }, node: safe((s.versions as Record<string, unknown>).node, 32) },
      os: { profile: { id: safe(profile.id, 64), versionId: safe(profile.versionId, 64), family: safe(profile.family, 32) }, release: { state: one(release.state, READ), prettyName: opt(release.prettyName, raw => safe(raw, 160)) } },
      uptime: { state: one(uptime.state, READ), seconds: opt(uptime.seconds, int) },
      services: { state: one(services.state, READ), items: list(services.items, 32, raw => object(raw) ? { id: safe(raw.id, 32), label: safe(raw.label, 64), unit: opt(raw.unit, item => safe(item, 128)), state: one(raw.state, ['active', 'inactive', 'failed', 'not-installed', 'unchecked']) } : bad()) },
      generation: { state: one(g.state, KNOWN), id: opt(g.id, int), activatedAt: opt(g.activatedAt, time), checksum: opt(g.checksum, raw => safe(raw, 64, /^[0-9a-f]{64}$/)) },
      drift: { state: one(d.state, KNOWN), count: opt(d.count, int), manifestMissing: opt(d.manifestMissing, raw => typeof raw === 'boolean' ? raw : bad()) },
      failedJobs: { state: one(jobs.state, READ), items: list(jobs.items, 10, raw => object(raw) ? { id: safe(raw.id, 128), referenceCode: opt(raw.referenceCode, item => reference(item) ? item : bad()), kind: safe(raw.kind, 128), failureClass: one(raw.failureClass, [null, 'retryable', 'permanent', 'unknown_outcome']), finishedAt: opt(raw.finishedAt, time), error: opt(raw.error, item => safe(item, 1024)) } : bad()) },
    }
    // A read state must carry its value, so a missing value never renders as observed.
    if ((summary.versions.panel.state === 'read') !== (summary.versions.panel.version !== null) || (summary.uptime.state === 'read') !== (summary.uptime.seconds !== null) || (summary.generation.state === 'read') !== (summary.generation.id !== null)) return bad()
  }
  return { summary, manifest, contact }
}

function bindWhmSupport(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-support-workspace]').forEach(root => {
    if (root.dataset.supportBound === 'true') return
    root.dataset.supportBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-whm-support-status]'), bundleStatus = one<HTMLElement>('[data-whm-support-bundle-status]'), refresh = one<HTMLButtonElement>('[data-whm-support-refresh]')
    const confirm = one<HTMLInputElement>('[data-whm-support-confirm]'), download = one<HTMLButtonElement>('[data-whm-support-download]'), contactBox = one<HTMLElement>('[data-whm-support-contact]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !bundleStatus || !refresh || !confirm || !download || !contactBox) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.supportCanRead === 'true' && !root.closest(denied) && typeof request === 'function'
    let view: SupportView | null = null, busy = false
    const notRead = t('Not read')
    const note = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const ltr = (content: string, wrap = false): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = content; if (wrap) node.style.overflowWrap = 'anywhere'; return node }
    const fact = (key: string, content: string | Node): void => { root.querySelector('[data-whm-support-fact="' + key + '"]')?.replaceChildren(content) }
    const when = (iso: string): string => formatDisplayDateTime(iso)
    const rows = (marker: string, cells: (string | Node)[][], empty: string, span: number): void => {
      const body = root.querySelector('[data-whm-support-' + marker + ']')
      if (!body) return
      const lines = (cells.length ? cells : [[empty]]).map(values => {
        const row = document.createElement('tr')
        for (const value of values) { const cell = document.createElement('td'); cell.append(value); if (!cells.length) cell.colSpan = span; row.append(cell) }
        return row
      })
      body.replaceChildren(...lines)
    }
    const SERVICE: Record<string, string> = { active: t(msgctxt('whm-support-client', 'Active')), inactive: t('Inactive'), failed: t(msgctxt('whm-support-client', 'Failed')), 'not-installed': t('Not installed'), unchecked: t(msgctxt('whm-support-client', 'Not checked')) }
    const FAILURE: Record<string, string> = { retryable: t('Retryable'), permanent: t('Permanent'), unknown_outcome: t('Outcome unknown') }
    const paintSummary = (s: SupportSummaryView | null): void => {
      for (const key of ['panel-version', 'release-path', 'os', 'os-profile', 'uptime', 'node', 'observed-at', 'generation', 'generation-activated', 'generation-checksum', 'drift']) fact(key, notRead)
      rows('services', [], s ? t('No panel service was reported.') : t('No services have been read.'), 3)
      rows('jobs', [], s?.failedJobs.state === 'read' ? t('No host job has failed.') : t('Failed jobs were not read.'), 5)
      if (!s) return
      const p = s.versions.panel, seconds = s.uptime.seconds, g = s.generation, d = s.drift
      fact('panel-version', p.version ? ltr(p.version) : t('Not verified: the current release link and its VERSION marker were not confirmed'))
      if (p.releasePath) fact('release-path', ltr(p.releasePath))
      if (s.os.release.prettyName) fact('os', ltr(s.os.release.prettyName))
      fact('os-profile', ltr(s.os.profile.id + ' ' + s.os.profile.versionId + ' (' + s.os.profile.family + ')'))
      if (seconds !== null) { const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60); fact('uptime', t('{days} d {hours} h {minutes} min', { days, hours, minutes })) }
      fact('node', ltr(s.versions.node))
      fact('observed-at', ltr(when(s.observedAt)))
      if (g.state === 'none') fact('generation', t('No configuration generation is active'))
      if (g.id !== null) fact('generation', ltr('#' + g.id))
      if (g.activatedAt) fact('generation-activated', ltr(when(g.activatedAt)))
      if (g.checksum) fact('generation-checksum', ltr(g.checksum, true))
      if (d.state === 'none') fact('drift', t('No active generation to compare'))
      else if (d.manifestMissing) fact('drift', t('The file manifest of the active generation is missing'))
      else if (d.state === 'read' && d.count !== null) fact('drift', d.count === 0 ? t('No drift found') : t('{count} managed files differ', { count: d.count }))
      rows('services', s.services.items.map(item => [item.label, item.unit ? ltr(item.unit) : '-', SERVICE[item.state] ?? item.state]), s.services.state === 'read' ? t('No panel service was reported.') : t('Services could not be read.'), 3)
      rows('jobs', s.failedJobs.items.map(job => [job.referenceCode === null ? t('Unnumbered') : ltr(job.referenceCode), ltr(job.kind), job.failureClass ? FAILURE[job.failureClass] ?? job.failureClass : t('Not classified'), job.finishedAt ? ltr(when(job.finishedAt)) : '-', job.error ? ltr(job.error) : '-']),
        s.failedJobs.state === 'read' ? t('No host job has failed.') : t('Failed jobs could not be read.'), 5)
    }
    const paintManifest = (manifest: SupportView['manifest']): void => {
      fact('manifest-id', ltr(manifest.id))
      for (const [marker, entries] of [['included', manifest.sections], ['excluded', manifest.excluded], ['redaction', manifest.redaction]] as const) {
        root.querySelector('[data-whm-support-' + marker + ']')?.replaceChildren(...entries.map(entry => { const item = document.createElement('li'); item.dataset.manifestEntry = entry.id; item.textContent = t(entry.text, manifest.limits); return item }))
      }
      const hashing = one<HTMLElement>('[data-whm-support-hashing]')
      if (hashing) hashing.textContent = t(manifest.hashing.text)
    }
    const paintContact = (contact: SupportView['contact']): void => {
      const line = (label: string, href: string, text: string): HTMLElement => { const p = document.createElement('p'), a = document.createElement('a'); p.append(label + ' '); a.href = href; a.rel = 'noopener noreferrer'; a.append(ltr(text)); p.append(a); return p }
      if (contact.state === 'unavailable') { const p = document.createElement('p'); p.className = 'xp-help'; p.dataset.contactState = 'unavailable'; p.textContent = t('The support contact setting could not be read. Nothing is assumed.'); contactBox.replaceChildren(p); return }
      if (contact.state === 'not-configured') { const p = document.createElement('p'); p.className = 'xp-help'; p.dataset.contactState = 'not-configured'; p.textContent = t('No support contact is configured. A contact appears here only after the server owner saves one; none is suggested.'); contactBox.replaceChildren(p); return }
      contactBox.replaceChildren(...[contact.url ? line(t('Support website:'), contact.url, contact.url) : null, contact.email ? line(t('Support email:'), 'mailto:' + contact.email, contact.email) : null].filter((node): node is HTMLElement => node !== null))
      contactBox.dataset.contactState = 'configured'
    }
    const lock = (): void => {
      const ready = !busy && admitted() && !!view?.summary
      refresh.disabled = busy || !admitted(); confirm.disabled = !ready; download.disabled = !ready || !confirm.checked
      root.setAttribute('aria-busy', String(busy))
    }
    const failText = (error: unknown, fallback: string): string => {
      const code = (error as { status?: number })?.status
      return code === 403 ? t('Root authorization is required for support diagnostics.')
        : code === 409 ? t('The manifest changed since it was shown. It was read again; review it before downloading.')
          : code === 412 ? t('The host agent is not connected. Nothing was generated.') : fallback
    }
    const load = async (): Promise<void> => {
      if (!admitted() || busy || !request) return
      busy = true; confirm.checked = false; lock()
      note(status, 'reading', t('Reading the support summary…'))
      try {
        view = readSupportView(await request('GET', '/api/server/support'))
        paintSummary(view.summary); paintManifest(view.manifest); paintContact(view.contact)
        note(status, view.summary ? 'read' : 'unavailable', !view.summary ? t('The host agent is not connected. Host facts and the bundle are unavailable; the manifest and contact are shown.')
          : view.summary.host === 'read' ? t('Support summary read from this server.') : t('The agent has no native host access; host facts are not verified.'))
        note(bundleStatus, view.summary ? 'unread' : 'unavailable', view.summary ? t('Review the manifest, then confirm to enable the download.') : t('The bundle needs the host agent. Nothing was generated.'))
      } catch (error) {
        view = null; paintSummary(null)
        note(status, 'failed', failText(error, t('The support summary could not be read or verified. Nothing was changed.')))
      } finally { busy = false; lock() }
    }
    if (!admitted()) {
      refresh.disabled = true; confirm.disabled = true; download.disabled = true
      note(status, 'unavailable', t('Support diagnostics are unavailable here. Nothing was read.'))
      note(bundleStatus, 'unavailable', t('The support bundle is unavailable here. Nothing was generated.'))
      return
    }
    refresh.addEventListener('click', () => { void load() })
    confirm.addEventListener('change', lock)
    download.addEventListener('click', async () => {
      if (busy || !view?.summary || !confirm.checked || !admitted() || !request) return
      const id = view.manifest.id
      let reload = false
      busy = true; lock()
      note(bundleStatus, 'reading', t('Generating the support bundle…'))
      try {
        const bundle = await request('GET', '/api/server/support/bundle?manifest=' + id) as Record<string, unknown> | null
        const manifest = bundle && typeof bundle === 'object' && !Array.isArray(bundle) ? bundle.manifest as Record<string, unknown> | null : null
        if (!manifest || manifest.id !== id || typeof bundle!.generatedAt !== 'string') throw new Error('invalid_bundle')
        const stamp = (bundle!.generatedAt as string).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
        const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
        try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'xpanel-support-' + (/^\d{8}T\d{6}Z$/.test(stamp) ? stamp : 'bundle') + '.json'; anchor.click() } finally { URL.revokeObjectURL(url) }
        note(bundleStatus, 'read', t('The support bundle was generated with the reviewed manifest and saved. Share it only with someone you trust.'))
      } catch (error) {
        reload = (error as { status?: number })?.status === 409
        note(bundleStatus, 'failed', failText(error, t('The support bundle could not be generated or verified. Nothing was downloaded.')))
      } finally { busy = false; confirm.checked = false; lock() }
      if (reload) void load()
    })
    void load()
  })
}

export const WHM_SUPPORT_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readSupportView=${readSupportView.toString()};return ${bindWhmSupport.toString()};})()`
