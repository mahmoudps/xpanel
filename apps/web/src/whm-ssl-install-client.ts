/// <reference lib="dom" />
import { sslObject, sslWriteUncertain } from './whm-ssl-client.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Serialized functions use these module-local aliases: bundler-rewritten import names would not survive toString().
const sslInstallObject = sslObject, sslInstallUncertain = sslWriteUncertain

/** Localized copy for client structural checks and the server's stable `details.reason` refusal codes. */
export const SSL_INSTALL_MESSAGES: Readonly<Record<string, string>> = {
  certificate_missing: msgid('Paste the site certificate.'),
  certificate_format: msgid('The certificate fields accept only PEM CERTIFICATE blocks.'),
  key_missing: msgid('Paste the private key.'),
  key_format: msgid('The private key field must contain exactly one PEM private key block.'),
  key_encrypted: msgid('The private key is protected by a passphrase. Remove the passphrase before installing it.'),
  too_large: msgid('Certificate material is limited to 10 certificates and 64 KiB.'),
  leaf_ca: msgid('The first certificate must be the site certificate, not a certificate authority.'),
  not_yet_valid: msgid('The certificate is not valid yet.'),
  expired: msgid('The certificate has expired.'),
  names: msgid('The certificate does not cover the selected domain and names, or lists entries that are not DNS names.'),
  name_owner: msgid('Every name in the certificate and every chosen name must belong to this account.'),
  chain_order: msgid('The CA bundle is out of order or was not issued by the next certificate. List it from the certificate that signed yours up to the root.'),
  key_mismatch: msgid('The private key does not match the site certificate.'),
  key_strength: msgid('Only RSA keys of 2048 bits or more and EC P-256 or P-384 keys are supported.'),
}
export interface SslInstallWorkspace {
  revision: number; install: boolean
  accounts: { id: string; username: string }[]
  domains: { id: string; accountId: string; name: string; certificateId: string | null }[]
  certificates: { id: string; accountId: string | null; names: string[]; notAfter: string; fingerprintSha256: string | null }[]
}
export interface SslInstallResult {
  certificate: { id: string; names: string[]; notAfter: string; fingerprintSha256: string | null }
  reconcile: { status: 'applied' | 'noop'; generationId: number | null }
}

function sslInstallId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('invalid_certificate_identity')
  return value.toLowerCase()
}
function sslInstallNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(name => typeof name !== 'string' || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) || new Set(value).size !== value.length) throw new Error('invalid_certificate_names')
  return value as string[]
}
/** RFC 6125: exact name, or `*.base` for exactly one extra label. */
function sslInstallCovers(names: readonly string[], host: string): boolean {
  return names.some(name => name === host || name.startsWith('*.') && host.endsWith(name.slice(1)) && host.split('.').length === name.split('.').length)
}
export function readSslInstallWorkspace(value: unknown): SslInstallWorkspace {
  if (!sslInstallObject(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.accounts) || !Array.isArray(value.domains) || !Array.isArray(value.certificates) || !sslInstallObject(value.capabilities) || typeof value.capabilities.install !== 'boolean') throw new Error('invalid_certificate_workspace')
  if (Math.max(value.accounts.length, value.domains.length, value.certificates.length) > 10000) throw new Error('certificate_workspace_too_large')
  const accounts = value.accounts.map(raw => {
    if (!sslInstallObject(raw) || typeof raw.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.username)) throw new Error('invalid_certificate_account')
    return { id: sslInstallId(raw.id), username: raw.username }
  })
  const domains = value.domains.map(raw => {
    if (!sslInstallObject(raw)) throw new Error('invalid_certificate_domain')
    const name = sslInstallNames([raw.name])[0]!
    const domain = { id: sslInstallId(raw.id), accountId: sslInstallId(raw.accountId), name, certificateId: raw.certificateId === null ? null : sslInstallId(raw.certificateId) }
    if (name.startsWith('*.') || !accounts.some(account => account.id === domain.accountId)) throw new Error('foreign_certificate_domain')
    return domain
  })
  const certificates = value.certificates.map(raw => {
    if (!sslInstallObject(raw) || typeof raw.notAfter !== 'string' || !Number.isFinite(Date.parse(raw.notAfter)) || (raw.fingerprintSha256 !== null && (typeof raw.fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.fingerprintSha256)))) throw new Error('invalid_certificate')
    return { id: sslInstallId(raw.id), accountId: raw.accountId === null ? null : sslInstallId(raw.accountId), names: sslInstallNames(raw.names), notAfter: raw.notAfter, fingerprintSha256: raw.fingerprintSha256 as string | null }
  })
  if (new Set(accounts.map(item => item.id)).size !== accounts.length || new Set(domains.map(item => item.id)).size !== domains.length || new Set(certificates.map(item => item.id)).size !== certificates.length) throw new Error('duplicate_certificate_record')
  return { revision: value.revision as number, install: value.capabilities.install, accounts, domains, certificates }
}
/** Accepts only an upload acknowledgement for the reviewed account that covers every requested name. */
export function readSslInstallResult(value: unknown, expected: { accountId: string; names: readonly string[] }): SslInstallResult {
  const certificate = sslInstallObject(value) ? value.certificate : null, reconcile = sslInstallObject(value) ? value.reconcile : null, application = sslInstallObject(value) ? value.application : null
  if (!sslInstallObject(certificate) || !sslInstallObject(reconcile) || !sslInstallObject(application) || application.scope !== 'stored_configuration' || application.servedTlsVerified !== false) throw new Error('certificate_acknowledgement_unknown')
  const names = sslInstallNames(certificate.names)
  if (sslInstallId(certificate.accountId) !== expected.accountId || certificate.source !== 'upload' || typeof certificate.notAfter !== 'string' || !Number.isFinite(Date.parse(certificate.notAfter))
    || (certificate.fingerprintSha256 !== null && (typeof certificate.fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(certificate.fingerprintSha256))) || !expected.names.every(name => sslInstallCovers(names, name))) throw new Error('certificate_acknowledgement_mismatch')
  const generation = sslInstallObject(reconcile.generation) ? reconcile.generation : null
  if (reconcile.status === 'applied' ? !generation || !Number.isSafeInteger(generation.id) || (generation.id as number) < 1 || generation.status !== 'active' : reconcile.status !== 'noop') throw new Error('certificate_application_unknown')
  return { certificate: { id: sslInstallId(certificate.id), names, notAfter: certificate.notAfter, fingerprintSha256: certificate.fingerprintSha256 as string | null },
    reconcile: { status: reconcile.status as 'applied' | 'noop', generationId: generation ? generation.id as number : null } }
}
/** Structural PEM checks only (RFC 7468 labels, counts, size); cryptographic checks stay on the server. */
export function sslInstallStructure(certificate: string, chain: string, key: string): { reasons: string[]; certificates: number; key: string | null } {
  const labels = (text: string): string[] | null => {
    const found: string[] = []
    const rest = text.replace(/-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]*?-----END \1-----/g, (_match: string, label: string) => { found.push(label); return '' })
    return rest.trim() ? null : found
  }
  const reasons: string[] = [], leaf = labels(certificate), bundle = labels(chain), keys = labels(key)
  if (!certificate.trim()) reasons.push('certificate_missing')
  else if (!leaf || !leaf.length || leaf.some(label => label !== 'CERTIFICATE')) reasons.push('certificate_format')
  if (!bundle || bundle.some(label => label !== 'CERTIFICATE')) reasons.push('certificate_format')
  const count = (leaf?.length ?? 0) + (bundle?.length ?? 0)
  if (count > 10 || new TextEncoder().encode(certificate + chain + key).length > 64 * 1024) reasons.push('too_large')
  if (!key.trim()) reasons.push('key_missing')
  else if (/Proc-Type:\s*4,ENCRYPTED/i.test(key) || keys?.includes('ENCRYPTED PRIVATE KEY')) reasons.push('key_encrypted')
  else if (!keys || keys.length !== 1 || !['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'].includes(keys[0]!)) reasons.push('key_format')
  return { reasons: [...new Set(reasons)], certificates: count, key: keys?.length === 1 ? keys[0]! : null }
}

function bindWhmSslInstall(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const message = (reason: string): string => { const copy = SSL_INSTALL_MESSAGES[reason]; return copy ? xpT(copy) : '' }
  document.querySelectorAll<HTMLElement>('[data-whm-ssl-install]').forEach(root => {
    if (root.dataset.sslInstallBound === 'true') return
    root.dataset.sslInstallBound = 'true'
    const control = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-ssl-install-' + key + ']')!
    const domain = control<HTMLSelectElement>('domain'), names = control<HTMLFieldSetElement>('names'), certificate = control<HTMLTextAreaElement>('certificate'), chain = control<HTMLTextAreaElement>('chain'), key = control<HTMLTextAreaElement>('key')
    const checks = control<HTMLElement>('checks'), status = control<HTMLElement>('status'), result = control<HTMLElement>('result'), facts = control<HTMLElement>('facts')
    const refreshButton = control<HTMLButtonElement>('refresh'), submit = control<HTMLButtonElement>('submit'), clear = control<HTMLButtonElement>('clear')
    if (![domain, names, certificate, chain, key, checks, status, result, facts, refreshButton, submit, clear].every(Boolean)) return
    const choices = (root.closest('[data-whm-detail-route]') ?? document).querySelector<HTMLElement>('[data-ssl-install-choices]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.sslInstallCanManage === 'true' && !root.closest(denied)
    let workspace: SslInstallWorkspace | null = null, busy = false, review = false
    const announce = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !transport || !admitted() ? Promise.reject({ stateChanged: false }) : body === undefined ? transport(method, path) : transport(method, path, body)
    const read = async (): Promise<SslInstallWorkspace> => readSslInstallWorkspace(await request('GET', '/api/certificate-workspace'))
    const selected = () => { const item = workspace?.domains.find(row => row.id === domain.value), owner = item && workspace?.accounts.find(row => row.id === item.accountId); return item && owner ? { domain: item, account: owner } : null }
    const chosenNames = (): string[] => Array.from(names.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value)
    const structure = () => sslInstallStructure(certificate.value, chain.value, key.value)
    const isolated = (text: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.style.overflowWrap = 'anywhere'; node.textContent = text; return node }
    const step = (current: number): void => root.querySelectorAll<HTMLElement>('[data-ssl-install-step]').forEach(item => { if (item.dataset.sslInstallStep === String(current)) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current') })
    const paintChoices = (): void => {
      if (!choices) return
      const target = selected(), shape = structure()
      const values: Record<string, string | null> = { domain: target ? target.domain.name + ' (' + target.account.username + ')' : null, names: target ? [target.domain.name, ...chosenNames()].join(', ') : null,
        certificates: shape.certificates ? String(shape.certificates) : null, key: shape.key === 'PRIVATE KEY' ? 'PKCS#8' : shape.key === 'RSA PRIVATE KEY' ? 'RSA' : shape.key === 'EC PRIVATE KEY' ? 'EC' : null }
      choices.querySelectorAll<HTMLElement>('[data-ssl-install-choice]').forEach(cell => { const value = values[cell.dataset.sslInstallChoice!]; cell.textContent = ''; cell.append(value ? isolated(value) : document.createTextNode(t('Not chosen'))) })
    }
    const paintChecks = (): void => {
      checks.textContent = ''
      const shape = structure(), add = (text: string): void => { const item = document.createElement('li'); item.textContent = text; checks.append(item) }
      if (!certificate.value.trim() && !chain.value.trim() && !key.value.trim()) add(t('No certificate material entered.'))
      else if (!shape.reasons.length) add(t('Structure is complete. Certificate blocks: {certificates}. Private key blocks: 1. The server performs the full checks.', { certificates: shape.certificates }))
      else for (const reason of shape.reasons) add(message(reason))
      paintChoices()
    }
    const lock = (): void => {
      const blocked = !admitted() || busy || review || !workspace?.install
      domain.disabled = blocked || !workspace?.domains.length
      for (const area of [certificate, chain, key]) area.disabled = blocked
      names.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = blocked })
      submit.disabled = blocked || !selected() || structure().reasons.length > 0
      clear.disabled = !admitted() || busy
      refreshButton.disabled = !admitted() || busy
      root.setAttribute('aria-busy', String(busy))
    }
    const paintNames = (): void => {
      const previous = new Set(chosenNames()), target = selected(), empty = control<HTMLElement>('names-empty')
      names.querySelectorAll('label').forEach(label => label.remove())
      const candidates = !target ? [] : [...new Set([...target.domain.name.startsWith('www.') ? [] : ['www.' + target.domain.name],
        ...workspace!.domains.filter(row => row.accountId === target.account.id && row.id !== target.domain.id).map(row => row.name)])].slice(0, 20)
      for (const name of candidates) {
        const label = document.createElement('label'), input = document.createElement('input')
        input.type = 'checkbox'; input.value = name; input.checked = previous.has(name); input.addEventListener('change', () => { paintChoices(); lock() })
        label.append(input, isolated(name)); names.append(label)
      }
      if (empty) { empty.hidden = candidates.length > 0; empty.textContent = target ? t('This account has no other names to require.') : t('Choose a domain to list its www name and the other domains of its account.') }
    }
    const paintDomains = (): void => {
      const previous = domain.value; domain.textContent = ''
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = workspace?.domains.length ? t('Choose a domain') : t('No hosted domains'); domain.append(placeholder)
      for (const account of workspace?.accounts ?? []) {
        const rows = workspace!.domains.filter(row => row.accountId === account.id)
        if (!rows.length) continue
        const group = document.createElement('optgroup'); group.label = account.username
        for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; group.append(option) }
        domain.append(group)
      }
      domain.value = Array.from(domain.options).some(option => option.value === previous) ? previous : ''
    }
    const paintResult = (ack: SslInstallResult): void => {
      facts.textContent = ''
      const row = (label: string, ...value: (string | HTMLElement)[]): void => { const group = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.append(...value); group.append(term, detail); facts.append(group) }
      row(t('Names'), isolated(ack.certificate.names.join(', ')))
      row(t('Expires (UTC)'), isolated(displayDateTime(ack.certificate.notAfter)))
      row('SHA-256', isolated(ack.certificate.fingerprintSha256 ?? t('Not read')))
      row(t('Saved configuration'), t('Saved and read back'))
      if (ack.reconcile.generationId !== null) { const [before = '', after = ''] = t('Applied in generation {generation}').split('{generation}'); row(t('Configuration'), before, isolated('#' + ack.reconcile.generationId), after) }
      else row(t('Configuration'), t('No configuration change was needed'))
      row(t('Served TLS'), t('Not verified. Check the site over HTTPS separately.'))
      result.hidden = false
    }
    const refresh = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); announce('reading', t('Reading hosted domains…'))
      try {
        workspace = await read(); review = false; paintDomains(); paintNames(); paintChecks(); step(selected() ? 2 : 1)
        announce(workspace.install ? 'read' : 'unavailable', workspace.install ? t('Hosted domains read. Choose a domain, then paste the certificate and key.')
          : t('Manual installation is unavailable on this host. Nothing will be uploaded.'))
      } catch { announce('failed', t('Hosted domains could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const install = async (): Promise<void> => {
      const target = selected(), baseline = workspace
      if (!admitted() || busy || review || !baseline?.install || !target || structure().reasons.length) return
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      const required = chosenNames()
      busy = true; lock()
      let confirmed = false, submitted = false
      try { confirmed = await askDialog({ title: t('Install certificate'), body: [target.domain.name, ...required].join(', ') + '\n' + t('This replaces the certificate assigned to this domain in saved configuration. Served TLS is verified separately.'), confirm: t('Install') }) === true } catch { confirmed = false }
      try {
        if (!confirmed || !admitted()) return
        const current = await read()
        if (current.revision !== baseline.revision) { workspace = current; review = true; announce('stale', t('Certificate configuration changed. Read hosted domains again and review before installing.')); return }
        const body = { username: target.account.username, domain: target.domain.name, expectedRevision: current.revision,
          fullchainPem: [certificate.value.trim(), chain.value.trim()].filter(Boolean).join('\n') + '\n', privateKeyPem: key.value, ...(required.length ? { requiredNames: required } : {}) }
        key.value = ''; submitted = true
        const ack = readSslInstallResult(await request('POST', '/api/certificate-workspace/install', body), { accountId: target.account.id, names: [target.domain.name, ...required] })
        const observed = await read(), found = observed.certificates.find(item => item.id === ack.certificate.id)
        if (!found || found.accountId !== target.account.id || found.notAfter !== ack.certificate.notAfter || found.fingerprintSha256 !== ack.certificate.fingerprintSha256 || [...found.names].sort().join('\n') !== [...ack.certificate.names].sort().join('\n')
          || !observed.domains.some(item => item.id === target.domain.id && item.certificateId === found.id)) throw new Error('certificate_saved_readback_mismatch')
        workspace = observed; certificate.value = ''; chain.value = ''
        paintDomains(); paintNames(); paintChecks(); paintResult(ack); step(3)
        announce('saved', t('Certificate saved and read back. Served TLS remains unverified.'))
      } catch (error) {
        key.value = ''
        const conflict = sslInstallObject(error) && error.status === 409
        review = conflict || submitted && sslInstallUncertain(error)
        const reason = sslInstallObject(error) && sslInstallObject(error.details) && typeof error.details.reason === 'string' ? message(error.details.reason) : ''
        if (conflict) announce('stale', t('Certificate configuration changed. Read hosted domains again and review before installing.'))
        else if (review) announce('uncertain', t('The outcome requires review. No retry was sent. Read hosted domains and the SSL/TLS list before continuing.'))
        else announce('failed', (reason ? reason + ' ' : '') + t('Nothing was changed. The private key was cleared; paste it again to retry.'))
      } finally { busy = false; paintChecks(); lock() }
    }
    if (!transport || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button').forEach(element => { element.disabled = true }); announce('unavailable', t('Certificate installation is unavailable here. Nothing was read or changed.')); return }
    domain.addEventListener('change', () => { paintNames(); paintChecks(); step(selected() ? 2 : 1); lock() })
    for (const area of [certificate, chain, key]) area.addEventListener('input', () => { paintChecks(); lock() })
    clear.addEventListener('click', () => { if (busy) return; certificate.value = ''; chain.value = ''; key.value = ''; names.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = false }); result.hidden = true; step(selected() ? 2 : 1); paintChecks(); lock() })
    refreshButton.addEventListener('click', () => { void refresh() }); submit.addEventListener('click', () => { void install() })
    window.addEventListener('beforeunload', event => { if (review || certificate.value || chain.value || key.value) { event.preventDefault(); event.returnValue = '' } })
    void refresh()
  })
}

export const WHM_SSL_INSTALL_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const SSL_INSTALL_MESSAGES=${JSON.stringify(SSL_INSTALL_MESSAGES)};const sslObject=${sslObject.toString()};const sslInstallObject=sslObject;const sslInstallUncertain=${sslWriteUncertain.toString()};const sslInstallId=${sslInstallId.toString()};const sslInstallNames=${sslInstallNames.toString()};const sslInstallCovers=${sslInstallCovers.toString()};const readSslInstallWorkspace=${readSslInstallWorkspace.toString()};const readSslInstallResult=${readSslInstallResult.toString()};const sslInstallStructure=${sslInstallStructure.toString()};return ${bindWhmSslInstall.toString()};})()`
