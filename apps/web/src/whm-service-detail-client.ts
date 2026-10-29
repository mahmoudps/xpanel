/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type ServiceRowView = { id: string; label: string; unit: string | null; state: string } | null
export type DnsZoneView = { zone: string; desired: boolean | null; stateSerial: number | null; file: string; fileSerial: number | null; sizeBytes: number | null }
export type DnsDetailView = { kind: 'dns'; observedAt: string; service: ServiceRowView; control: { state: string; version: string | null }; zoneDir: string; directory: string; savedState: string; otherEntries: number; truncated: boolean; zones: DnsZoneView[] }
export type FtpDetailView = { kind: 'ftp'; observedAt: string; service: ServiceRowView; confDir: string; settings: { name: string; desired: string; observed: string | null; state: string }[]; ftpAccounts: number | null }
export type CertificateView = { subject: string; issuer: string; names: string[]; notBefore: string; notAfter: string; daysLeft: number; fingerprint256: string; chainLength: number; coversHostname: boolean | null }
export type CertificateEndpointView = { id: string; ports: number[]; configPath: string | null; state: string; reason: string | null; certPath: string | null; keyPath: string | null; keyPresent: boolean | null; certificate: CertificateView | null; warnings: string[] }
export type CertificatesDetailView = { kind: 'certificates'; observedAt: string; hostname: string | null; endpoints: CertificateEndpointView[] }
export type ServiceDetailView = DnsDetailView | FtpDetailView | CertificatesDetailView
export type ZoneCheckView = { zone: string; state: 'passed' | 'failed' | 'unavailable'; records: number | null; errors: number | null; warnings: number | null; messages: string[] }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for GET /api/server/services/{dns,ftp,certificates}; unknown fields are dropped and inconsistencies are refused. */
export function readServiceDetailView(kind: string, value: unknown): ServiceDetailView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const int = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const nullable = (item: unknown, check: (entry: unknown) => boolean): boolean => item === null || check(item)
  const one = (item: unknown, list: string[]): item is string => typeof item === 'string' && list.includes(item)
  const invalid = (): never => { throw new Error('invalid_service_detail') }
  if (!object(value) || value.kind !== kind || !iso(value.observedAt)) return invalid()
  const service = (raw: unknown, id: string): ServiceRowView => {
    if (raw === null) return null
    if (!object(raw) || raw.id !== id || !text(raw.label, 64) || !nullable(raw.unit, entry => text(entry, 128)) || !one(raw.state, ['active', 'inactive', 'failed', 'not-installed', 'unchecked'])
      || (raw.unit === null) !== (raw.state === 'not-installed' || raw.state === 'unchecked')) return invalid()
    return { id, label: raw.label, unit: raw.unit as string | null, state: raw.state }
  }
  if (kind === 'dns') {
    const control = value.control
    if (!object(control) || !one(control.state, ['reachable', 'unreachable', 'unavailable']) || !nullable(control.version, entry => text(entry, 64)) || control.state !== 'reachable' && control.version !== null
      || !text(value.zoneDir, 256) || !one(value.directory, ['read', 'missing', 'unavailable']) || !one(value.savedState, ['read', 'unavailable']) || !int(value.otherEntries) || typeof value.truncated !== 'boolean'
      || !Array.isArray(value.zones) || value.zones.length > 2000) return invalid()
    const seen = new Set<string>()
    const zones = value.zones.map(raw => {
      if (!object(raw) || typeof raw.zone !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(raw.zone) || seen.has(raw.zone) || !nullable(raw.desired, entry => typeof entry === 'boolean') || (raw.desired === null) !== (value.savedState === 'unavailable')
        || !nullable(raw.stateSerial, int) || !one(raw.file, ['parsed', 'missing', 'malformed', 'too-large', 'not-regular', 'unreadable', 'not-read']) || !nullable(raw.fileSerial, int) || (raw.fileSerial !== null) !== (raw.file === 'parsed')
        || !nullable(raw.sizeBytes, int)) return invalid()
      seen.add(raw.zone)
      return { zone: raw.zone, desired: raw.desired as boolean | null, stateSerial: raw.stateSerial as number | null, file: raw.file, fileSerial: raw.fileSerial as number | null, sizeBytes: raw.sizeBytes as number | null }
    })
    return { kind: 'dns', observedAt: value.observedAt, service: service(value.service, 'pdns'), control: { state: control.state as string, version: control.version as string | null }, zoneDir: value.zoneDir,
      directory: value.directory, savedState: value.savedState, otherEntries: value.otherEntries, truncated: value.truncated, zones }
  }
  if (kind === 'ftp') {
    if (!text(value.confDir, 256) || !Array.isArray(value.settings) || value.settings.length > 32 || !nullable(value.ftpAccounts, int)) return invalid()
    const settings = value.settings.map(raw => {
      if (!object(raw) || typeof raw.name !== 'string' || !/^[A-Za-z]{1,64}$/.test(raw.name) || !text(raw.desired, 256) || !nullable(raw.observed, entry => text(entry, 256)) || !one(raw.state, ['match', 'drift', 'missing', 'unreadable'])
        || (raw.state === 'match' ? raw.observed !== raw.desired : raw.state === 'drift' ? raw.observed === null || raw.observed === raw.desired : raw.observed !== null)) return invalid()
      return { name: raw.name, desired: raw.desired, observed: raw.observed as string | null, state: raw.state }
    })
    return { kind: 'ftp', observedAt: value.observedAt, service: service(value.service, 'pure-ftpd'), confDir: value.confDir, settings, ftpAccounts: value.ftpAccounts as number | null }
  }
  if (kind !== 'certificates' || !nullable(value.hostname, entry => text(entry, 253)) || !Array.isArray(value.endpoints) || value.endpoints.length > 8) return invalid()
  const endpoints = value.endpoints.map(raw => {
    if (!object(raw) || !one(raw.id, ['panel', 'postfix', 'dovecot', 'pure-ftpd']) || !Array.isArray(raw.ports) || !raw.ports.every(port => int(port) && port > 0 && port <= 65535) || !nullable(raw.configPath, entry => text(entry, 256))
      || !one(raw.state, ['observed', 'not-rendered', 'missing', 'unavailable']) || !nullable(raw.reason, entry => text(entry, 64)) || !nullable(raw.certPath, entry => text(entry, 256)) || !nullable(raw.keyPath, entry => text(entry, 256))
      || !nullable(raw.keyPresent, entry => typeof entry === 'boolean') || !Array.isArray(raw.warnings) || !raw.warnings.every(entry => one(entry, ['expired', 'expiring', 'not-yet-valid', 'hostname-not-covered', 'key-missing']))
      || (raw.state === 'observed') !== (raw.certificate !== null)) return invalid()
    let certificate: CertificateView | null = null
    if (raw.certificate !== null) {
      const cert = raw.certificate
      if (!object(cert) || !text(cert.subject, 512) || !text(cert.issuer, 512) || !Array.isArray(cert.names) || cert.names.length > 100 || !cert.names.every(entry => text(entry, 253)) || !iso(cert.notBefore) || !iso(cert.notAfter)
        || typeof cert.daysLeft !== 'number' || !Number.isSafeInteger(cert.daysLeft) || !text(cert.fingerprint256, 95) || !int(cert.chainLength) || !nullable(cert.coversHostname, entry => typeof entry === 'boolean')) return invalid()
      certificate = { subject: cert.subject, issuer: cert.issuer, names: cert.names as string[], notBefore: cert.notBefore, notAfter: cert.notAfter, daysLeft: cert.daysLeft, fingerprint256: cert.fingerprint256, chainLength: cert.chainLength, coversHostname: cert.coversHostname as boolean | null }
    }
    return { id: raw.id, ports: raw.ports as number[], configPath: raw.configPath as string | null, state: raw.state, reason: raw.reason as string | null, certPath: raw.certPath as string | null, keyPath: raw.keyPath as string | null,
      keyPresent: raw.keyPresent as boolean | null, certificate, warnings: raw.warnings as string[] }
  })
  return { kind: 'certificates', observedAt: value.observedAt, hostname: value.hostname as string | null, endpoints }
}

/** A zone check is "passed" only with zero reported errors; anything else stays failed or unavailable. */
export function readZoneCheckView(value: unknown, zone: string): ZoneCheckView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const int = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  if (!object(value) || value.zone !== zone || !['passed', 'failed', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.messages) || value.messages.length > 50 || !value.messages.every(item => typeof item === 'string' && item.length <= 300)) throw new Error('invalid_zone_check')
  const numbers = [value.records, value.errors, value.warnings]
  if (value.state === 'unavailable' ? numbers.some(item => item !== null) : !numbers.every(int) || (value.state === 'passed') !== (value.errors === 0)) throw new Error('invalid_zone_check')
  return { zone, state: value.state as ZoneCheckView['state'], records: value.records as number | null, errors: value.errors as number | null, warnings: value.warnings as number | null, messages: value.messages as string[] }
}

function bindWhmServiceDetail(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-service-detail-workspace]').forEach(root => {
    if (root.dataset.serviceDetailBound === 'true') return
    root.dataset.serviceDetailBound = 'true'
    const kind = root.dataset.whmServiceDetailWorkspace ?? ''
    const status = root.querySelector<HTMLElement>('[data-whm-service-detail-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-service-detail-refresh]')
    const rows = root.querySelector<HTMLElement>('[data-whm-service-detail-rows]'), banner = root.querySelector<HTMLElement>('[data-whm-service-detail-result]')
    const restartButton = root.querySelector<HTMLButtonElement>('[data-whm-service-detail-restart]'), check = root.querySelector<HTMLElement>('[data-whm-service-detail-check]'), messages = root.querySelector<HTMLElement>('[data-whm-service-detail-check-messages]')
    const filters = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-whm-service-detail-filter]')]
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!['dns', 'ftp', 'certificates'].includes(kind) || !status || !refresh || !rows || !banner) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.serviceDetailCanRead === 'true' && !root.closest(denied) && !!request
    const manageable = (): boolean => admitted() && root.dataset.serviceDetailCanRestart === 'true' && !!restartButton
    let view: ServiceDetailView | null = null, busy = false
    const notRead = t('Not read'), none = t('Not applicable')
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (target: HTMLElement, kindOf: string, message: string): void => { target.hidden = false; target.dataset.outcome = kindOf; target.textContent = message; target.setAttribute('role', ['unknown', 'failed'].includes(kindOf) ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const fact = (key: string, value: string | null): void => { const cell = root.querySelector<HTMLElement>('[data-whm-service-detail-fact="' + key + '"]'); if (cell) cell.textContent = value ?? notRead }
    const size = (bytes: number): string => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'
    const serviceStates: Record<string, string> = { active: t(msgctxt('whm-service-detail-client', 'Running')), inactive: t('Stopped'), failed: t(msgctxt('whm-service-detail-client', 'Failed')), 'not-installed': t('Not installed'), unchecked: t(msgctxt('whm-service-detail-client', 'Not checked')) }
    const controlStates: Record<string, string> = { reachable: t('Answering (rping)'), unreachable: t('Not answering'), unavailable: t('Reply not readable') }
    const fileStates: Record<string, string> = { parsed: t('SOA read'), missing: t('Missing'), malformed: t('SOA not readable'), 'too-large': t('Too large to read'), 'not-regular': t('Not a regular file'), unreadable: t('Unreadable'), 'not-read': notRead }
    const settingStates: Record<string, string> = { match: t('Matches'), drift: t('Differs'), missing: t('Not present'), unreadable: t('Unreadable') }
    const tlsModes: Record<string, string> = { '0': t(msgctxt('whm-service-detail-client', 'Disabled')), '1': t('Optional'), '2': t('Required'), '3': t('Required for control and data') }
    const endpoints: Record<string, string> = { panel: t('Panel listeners (xPanel, xWHM, xMail)'), postfix: t('Postfix SMTP'), dovecot: t('Dovecot IMAP and POP3'), 'pure-ftpd': t('pure-ftpd FTP') }
    const reasons: Record<string, string> = { config_missing: t('The rendered listener configuration is not present.'), listener_not_found: t('No TLS listener was found in the rendered configuration.'),
      inconsistent_render: t('The listeners name different certificates.'), unexpected_path: t('The certificate path is not one xPanel renders; it was not read.'),
      certificate_missing: t('The certificate file is missing.'), too_large: t('The file exceeds the bounded read size.'), not_pem: t('The file is not certificate-only PEM; it was not parsed.'),
      unparsable: t('The certificate could not be parsed.'), unreadable: t('The file could not be read.') }
    const warnings: Record<string, string> = { expired: t(msgctxt('whm-service-detail-client', 'Expired')), expiring: t('Expires within 30 days'), 'not-yet-valid': t('Not yet valid'), 'hostname-not-covered': t('Hostname not covered'), 'key-missing': t('Private key missing') }
    const empty = (columns: number, message: string): void => { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = message; row.append(cell); rows.append(row) }
    const row = (cells: (string | Node)[][]): HTMLTableRowElement => { const tr = document.createElement('tr'); for (const content of cells) { const td = document.createElement('td'); td.append(...content); tr.append(td) } rows.append(tr); return tr }
    const zonesShown = (current: DnsDetailView): DnsZoneView[] => {
      const state = filters.find(item => item.dataset.whmServiceDetailFilter === 'state')?.value ?? '', needle = (filters.find(item => item.dataset.whmServiceDetailFilter === 'text')?.value ?? '').trim().toLowerCase()
      return current.zones.filter(zone => (!needle || zone.zone.includes(needle)) && (state === 'attention' ? zone.file !== 'parsed' || zone.desired === false : state === 'rendered' ? zone.desired === true : state === 'unmanaged' ? zone.desired === false : true))
    }
    const controls = (): void => {
      refresh.disabled = busy || !admitted()
      if (restartButton) restartButton.disabled = busy || !manageable() || !view || view.kind === 'certificates' || !view.service?.unit
      for (const item of filters) item.disabled = !admitted()
      root.querySelectorAll<HTMLButtonElement>('[data-whm-service-detail-check-zone]').forEach(button => { button.disabled = busy || !admitted() })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      rows.textContent = ''
      const current = view
      fact('observed-at', current ? formatDisplayDateTime(current.observedAt) : null)
      if (!current) { empty(10, t('Nothing has been read yet.')); controls(); return }
      if (current.kind !== 'certificates') {
        fact('unit', current.service ? current.service.unit ?? serviceStates[current.service.state]! : t('Unavailable'))
        fact('state', current.service ? serviceStates[current.service.state]! : t('Unavailable'))
      }
      if (current.kind === 'dns') {
        fact('control', controlStates[current.control.state]!); fact('version', current.control.version ?? t(msgctxt('whm-service-detail-client', 'Not reported')))
        fact('zone-dir', current.zoneDir + (current.directory === 'read' ? '' : ' · ' + (current.directory === 'missing' ? t('Missing') : t('Unreadable'))))
        fact('rendered', current.savedState === 'read' ? String(current.zones.filter(zone => zone.desired === true).length) : t('Saved state not read'))
        fact('present', current.directory === 'read' ? String(current.zones.filter(zone => !['missing', 'not-read'].includes(zone.file)).length) : notRead)
        const truncated = root.querySelector<HTMLElement>('[data-whm-service-detail-truncated]'); if (truncated) truncated.hidden = !current.truncated
        const shown = zonesShown(current)
        for (const zone of shown) {
          const action: (string | Node)[] = []
          if (zone.desired === true) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.dataset.whmServiceDetailCheckZone = zone.zone
            button.textContent = t('Check zone'); button.setAttribute('aria-label', t('Check zone {zone}', { zone: zone.zone })); action.push(button)
          } else action.push(t('Not rendered by xPanel'))
          row([[technical(zone.zone)], [zone.desired === null ? t('Saved state not read') : zone.desired ? t(msgctxt('whm-service-detail-client', 'Rendered by xPanel')) : t('Not in saved state')],
            [fileStates[zone.file]!], [zone.stateSerial === null ? none : technical(String(zone.stateSerial))], [zone.fileSerial === null ? none : technical(String(zone.fileSerial))], [zone.sizeBytes === null ? none : technical(size(zone.sizeBytes))], action])
        }
        if (!shown.length) empty(7, current.zones.length ? t('No zones match the filters.') : current.directory === 'read' || current.savedState === 'read' ? t('No zones are rendered or present.') : t('Zones could not be read.'))
      } else if (current.kind === 'ftp') {
        const setting = (name: string) => current.settings.find(item => item.name === name)
        const tls = setting('TLS'), passive = setting('PassivePortRange'), range = (value: string): string => value.trim().replace(/\s+/, '-')
        fact('tls', tls ? (tlsModes[tls.desired] ?? tls.desired) + ' / ' + (tls.observed === null ? settingStates[tls.state]! : tlsModes[tls.observed] ?? tls.observed) : notRead)
        fact('passive', passive ? range(passive.desired) + ' / ' + (passive.observed === null ? settingStates[passive.state]! : range(passive.observed)) : notRead)
        fact('accounts', current.ftpAccounts === null ? t('Saved state not read') : String(current.ftpAccounts)); fact('conf-dir', current.confDir)
        for (const item of current.settings) row([[technical(item.name)], [technical(item.desired)], [item.observed === null ? settingStates[item.state]! : technical(item.observed)], [settingStates[item.state]!]])
        if (!current.settings.length) empty(4, t('No settings were read.'))
      } else {
        fact('hostname', current.hostname ?? t('Not set in saved state'))
        fact('observed', String(current.endpoints.filter(endpoint => endpoint.state === 'observed').length) + ' / ' + current.endpoints.filter(endpoint => endpoint.state !== 'not-rendered').length)
        fact('warnings', String(current.endpoints.filter(endpoint => endpoint.warnings.length).length))
        for (const endpoint of current.endpoints) {
          const cert = endpoint.certificate, file: (string | Node)[] = endpoint.certPath ? [technical(endpoint.certPath)] : []
          if (endpoint.state === 'not-rendered') file.push(t('xPanel does not render a certificate path for this service.'))
          else if (endpoint.reason) file.push((file.length ? ' · ' : '') + (reasons[endpoint.reason] ?? endpoint.reason))
          const covered = !cert || cert.coversHostname === null ? (cert ? t('Hostname not set') : none) : cert.coversHostname ? t('Covered') : t('Not covered')
          row([[endpoints[endpoint.id] ?? endpoint.id], [endpoint.ports.length ? technical(endpoint.ports.join(', ')) : none], file, [cert ? technical(cert.names.join(', ')) : none], [cert ? technical(cert.issuer) : none],
            [cert ? technical(formatDisplayDateTime(cert.notAfter)) : none], [cert ? technical(String(cert.daysLeft)) : none], [covered],
            [endpoint.keyPresent === null ? (endpoint.keyPath ? t('Not checked') : none) : endpoint.keyPresent ? t('Present (not read)') : t('Missing')],
            [endpoint.warnings.length ? endpoint.warnings.map(item => warnings[item] ?? item).join('; ') : endpoint.state === 'observed' ? t('None') : none]]).dataset.endpoint = endpoint.id
        }
        if (!current.endpoints.length) empty(10, t('No endpoints were reported.'))
      }
      controls()
    }
    const load = async (): Promise<boolean> => {
      if (busy || !admitted()) return false
      busy = true; controls(); note('reading', t('Reading from the host…'))
      let fresh = false
      try {
        const next = readServiceDetailView(kind, await request!('GET', '/api/server/services/' + kind))
        if (admitted()) { view = next; fresh = true; note('read', t('Read from the host. Nothing was changed.')) }
      } catch { if (admitted()) note('failed', t('The service could not be read. Values shown are from the last successful read.')) }
      finally { busy = false; paint() }
      return fresh
    }
    const definiteRefusal = (error: unknown): boolean => {
      const problem = error && typeof error === 'object' ? error as { status?: number; stateChanged?: boolean; details?: Record<string, unknown> } : null
      if (!problem) return false
      const details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      if ([problem as Record<string, unknown>, details].some(value => value.stateChanged === true || value.verificationRequired === true || value.unknownOutcome === true)) return false
      return details.stateChanged === false || typeof problem.status === 'number' && problem.status >= 400 && problem.status < 500 && problem.status !== 408
    }
    const restart = async (): Promise<void> => {
      const id = restartButton?.dataset.whmServiceDetailRestart ?? ''
      if (busy || !manageable() || !view || view.kind === 'certificates' || !view.service?.unit || !['pdns', 'pure-ftpd'].includes(id)) return
      if (!askDialog) { show(banner, 'refused', t('Restart confirmation is unavailable. No restart was sent.')); return }
      const impact = id === 'pdns' ? t('DNS answers stop until it is back; resolvers retry and may serve cached records.') : t('Open FTP sessions disconnect; transfers in progress must restart.')
      busy = true; controls()
      let confirmed = false
      try { confirmed = await askDialog({ title: t('Restart service'), body: view.service.unit + '\n' + impact, confirm: t('Restart'), danger: true }) === true } catch { confirmed = false }
      finally { busy = false; controls() }
      if (!confirmed || !manageable()) { show(banner, 'cancelled', t('Restart cancelled. No restart request was sent.')); return }
      busy = true; controls(); show(banner, 'pending', t('Restarting the service…'))
      let outcome = 'unknown'
      try {
        const result = await request!('POST', '/api/server/services/' + id + '/restart', {}) as { service?: { id?: unknown; state?: unknown } } | null
        outcome = result && typeof result === 'object' && result.service && result.service.id === id && result.service.state === 'active' ? 'accepted' : 'unknown'
      } catch (error) { outcome = definiteRefusal(error) ? 'refused' : 'unknown' }
      busy = false
      const fresh = await load(), after = view as ServiceDetailView | null
      if (outcome === 'accepted') outcome = fresh && after && after.kind !== 'certificates' && after.service?.state === 'active' ? 'confirmed' : 'unknown'
      show(banner, outcome, outcome === 'confirmed' ? t('The restart completed and the service was read back as running.')
        : outcome === 'refused' ? t('The restart was refused. Nothing was changed.') : t('The restart outcome is unverified. Inspect the service before retrying.'))
    }
    const checkZone = async (zone: string): Promise<void> => {
      if (busy || !admitted() || !check || !messages || !view || view.kind !== 'dns' || !view.zones.some(item => item.zone === zone && item.desired === true)) return
      busy = true; controls(); messages.hidden = true; messages.textContent = ''
      show(check, 'reading', t('Checking {zone}…', { zone }))
      try {
        const result = readZoneCheckView(await request!('GET', '/api/server/services/dns/zone-check?zone=' + encodeURIComponent(zone)), zone)
        const counts = { zone, records: String(result.records), errors: String(result.errors), warnings: String(result.warnings) }
        show(check, result.state === 'passed' ? 'passed' : result.state === 'failed' ? 'failed' : 'unknown', result.state === 'passed' ? t('{zone} passed pdnsutil check-zone: {records} records, {errors} errors, {warnings} warnings.', counts)
          : result.state === 'failed' ? t('{zone} failed pdnsutil check-zone: {records} records, {errors} errors, {warnings} warnings.', counts) : t('{zone}: pdnsutil did not return a readable result. Nothing was changed.', { zone }))
        for (const line of result.messages) { const item = document.createElement('li'); item.append(technical(line)); messages.append(item) }
        messages.hidden = result.messages.length === 0
      } catch (error) {
        const missing = !!error && typeof error === 'object' && (error as { status?: number }).status === 404
        show(check, 'failed', missing ? t('This zone is not rendered by xPanel; nothing was checked.') : t('The zone check could not be read. Nothing was changed.'))
      } finally { busy = false; controls() }
    }
    rows.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-whm-service-detail-check-zone]')
      if (button && !button.disabled) void checkZone(button.dataset.whmServiceDetailCheckZone ?? '')
    })
    for (const item of filters) item.addEventListener(item.tagName === 'INPUT' ? 'input' : 'change', () => { if (view) paint() })
    refresh.addEventListener('click', () => { void load() })
    restartButton?.addEventListener('click', () => { void restart() })
    if (!admitted()) {
      refresh.disabled = true; if (restartButton) restartButton.disabled = true; for (const item of filters) item.disabled = true
      note('unavailable', t('This service view is unavailable here. Nothing was read or changed.')); return
    }
    void load()
  })
}

export const WHM_SERVICE_DETAIL_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readServiceDetailView=${readServiceDetailView.toString()};const readZoneCheckView=${readZoneCheckView.toString()};return ${bindWhmServiceDetail.toString()};})()`
