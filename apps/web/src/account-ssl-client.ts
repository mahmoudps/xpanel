/// <reference lib="dom" />
import { WHM_SSL_PARSER_BINDING } from './whm-ssl-client.ts'
import type { readSslWorkspace, sslCoversHost, sslObject, sslWriteUncertain } from './whm-ssl-client.ts'
import type { SslCertificateView, SslWorkspaceView } from './whm-ssl-client.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
const DAY_MS = 86400000

/** Localized refusal for the stable reasons certificate-install.ts returns; never echoes key material. */
export function accountSslRefusal(error: unknown, t: (message: string, values?: MessageValues) => string): string {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const value = object(error) ? error : {}, details = object(value.details) ? value.details : {}
  const reasons: Record<string, string> = {
    certificate_format: t('The certificate field must hold PEM certificates only.'),
    key_format: t('The private key must be one unencrypted PEM key.'),
    key_encrypted: t('The private key is protected by a passphrase. Remove the passphrase and try again.'),
    too_large: t('The certificate material is too large.'),
    leaf_ca: t('Put the site certificate first, not a certificate authority.'),
    not_yet_valid: t('The certificate is not valid yet.'),
    expired: t('The certificate has expired.'),
    names: t('The certificate does not cover the domain you chose.'),
    name_owner: t('The certificate names a domain that is not on this account.'),
    chain_order: t('The CA bundle is out of order. List it from the certificate that signed yours up to the root.'),
    key_mismatch: t('The private key does not match the certificate.'),
    key_strength: t('Only RSA keys of 2048 bits or more and EC P-256 or P-384 keys are supported.'),
  }
  return typeof details.reason === 'string' && reasons[details.reason] ? reasons[details.reason]! : t('The request was refused. Nothing was changed.')
}

/** Shared parsers arrive as an argument so the serialized function carries no module imports. */
interface SslParsers { readSslWorkspace: typeof readSslWorkspace; sslCoversHost: typeof sslCoversHost; sslObject: typeof sslObject; sslWriteUncertain: typeof sslWriteUncertain }
function bindAccountSsl(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, ssl: SslParsers): void {
  const { readSslWorkspace, sslCoversHost, sslObject, sslWriteUncertain } = ssl
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-ssl]').forEach(root => {
    if (root.dataset.sslBound === 'true') return
    root.dataset.sslBound = 'true'
    const control = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-account-ssl-' + key + ']')!
    const rows = control<HTMLElement>('rows'), status = control<HTMLElement>('status'), autossl = control<HTMLElement>('autossl'), chip = control<HTMLElement>('autossl-chip')
    const domain = control<HTMLSelectElement>('domain'), key = control<HTMLTextAreaElement>('key'), cert = control<HTMLTextAreaElement>('cert'), bundle = control<HTMLTextAreaElement>('bundle'), install = control<HTMLButtonElement>('install')
    if (![rows, status, autossl, chip, domain, key, cert, bundle, install, control('detail'), control('facts')].every(Boolean)) return
    const username = root.dataset.accountUsername ?? ''
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const admitted = (): boolean => root.isConnected && root.dataset.sslCanManage === 'true' && /^[a-z][a-z0-9]{0,15}$/.test(username)
    const base = '/api/accounts/' + encodeURIComponent(username) + '/certificates'
    let workspace: SslWorkspaceView | null = null, scheduled = false, busy = false
    const announce = (state: string, message: string): void => { status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !transport || !admitted() ? Promise.reject({ stateChanged: false }) : body === undefined ? transport(method, path) : transport(method, path, body)
    const lock = (): void => {
      const blocked = busy || !workspace || !admitted()
      install.disabled = blocked || !workspace?.capabilities.install || !domain.value
      for (const field of [domain, key, cert, bundle]) field.disabled = blocked || !workspace?.capabilities.install
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked || button.dataset.available !== 'true' })
      root.setAttribute('aria-busy', String(busy))
    }
    const cellText = (cell: HTMLElement, text: string, note?: string): void => {
      const main = document.createElement('bdi'); main.dir = 'auto'; main.textContent = text; cell.append(main)
      if (note) { const extra = document.createElement('p'); extra.className = 'xp-help'; extra.textContent = note; cell.append(extra) }
    }
    const details = (certificate: SslCertificateView): void => {
      const facts = control<HTMLElement>('facts'); facts.textContent = ''
      const values: [string, string][] = [[t('Names'), certificate.names.join(', ')], [t('Installed on'), certificate.assignedDomains.join(', ') || t('Not installed')],
        [t('Not before (UTC)'), certificate.notBefore === null ? t('Not read') : displayDateTime(certificate.notBefore)], [t('Expires (UTC)'), displayDateTime(certificate.notAfter)],
        [t('Validation'), certificate.challenge ?? t('Not needed')], ['SHA-256', certificate.fingerprintSha256 ?? t('Not read')]]
      for (const [label, text] of values) { const group = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd'), isolated = document.createElement('bdi'); term.textContent = label; isolated.dir = 'ltr'; isolated.textContent = text; value.append(isolated); group.append(term, value); facts.append(group) }
      control<HTMLElement>('detail').hidden = false
    }
    const show = (): void => {
      rows.textContent = ''
      const now = Date.now()
      for (const certificate of workspace?.certificates ?? []) {
        const row = document.createElement('tr'), cells = Array.from({ length: 6 }, () => document.createElement('td'))
        const names = cells[0]!; for (const name of certificate.names) { const line = document.createElement('bdi'); line.dir = 'ltr'; line.style.display = 'block'; line.textContent = name; names.append(line) }
        cellText(cells[1]!, certificate.source === 'acme' ? t('ACME (Let’s Encrypt)') : certificate.source === 'upload' ? t('Uploaded') : t('Self-signed'),
          certificate.fingerprintSha256 ? 'SHA-256 ' + certificate.fingerprintSha256.slice(0, 16) : undefined)
        const days = Math.floor((Date.parse(certificate.notAfter) - now) / DAY_MS)
        cellText(cells[2]!, displayDateTime(certificate.notAfter), days < 0 ? t('Expired') : t('{days, plural, one {# day left} other {# days left}}', { days }))
        if (certificate.source !== 'acme' || !certificate.autoRenew) cellText(cells[3]!, t('Not available'), certificate.source === 'upload' ? t('Uploaded certificates are renewed by you') : undefined)
        else cellText(cells[3]!, scheduled ? t('On') : t('Requested'), scheduled
          ? t('Renews from {date}', { date: displayDateTime(new Date(Date.parse(certificate.notAfter) - 30 * DAY_MS).toISOString()) })
          : t('Not scheduled on this server. Use Renew now.'))
        cellText(cells[4]!, certificate.assignedDomains.join(', ') || t('Not installed'))
        const group = document.createElement('div'); group.className = 'xp-panel-detail__actions'
        const action = (label: string, aria: string, available: boolean, run: () => void, reason?: string): void => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = label; button.setAttribute('aria-label', aria)
          button.dataset.available = String(available); if (!available && reason) button.title = reason
          button.addEventListener('click', () => { if (!button.disabled) run() }); group.append(button)
        }
        const first = certificate.names[0] ?? ''
        action(t('View'), t('View certificate for {name}', { name: first }), true, () => details(certificate))
        const renewable = certificate.source === 'acme' && certificate.challenge === 'http-01' && certificate.assignedDomains.length > 0 && workspace?.capabilities.renew === true
        action(t('Renew now'), t('Renew now: certificate for {name}', { name: first }), renewable, () => { void mutate('renew', certificate) },
          certificate.source === 'acme' ? t('Renewal needs an installed HTTP-01 certificate and a connected host.') : t('Uploaded certificates are renewed by you'))
        action(t('Remove'), t('Remove certificate for {name} expiring {date}', { name: first, date: displayDateTime(certificate.notAfter) }), workspace?.capabilities.remove === true, () => { void mutate('remove', certificate) })
        cells[5]!.append(group); row.append(...cells); rows.append(row)
      }
      if (!workspace?.certificates.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.textContent = t('No certificates are installed on this account yet.'); row.append(cell); rows.append(row) }
      lock()
    }
    const read = async (): Promise<void> => {
      const value = await request('GET', base)
      workspace = readSslWorkspace(value)
      if (workspace.accounts.length !== 1 || workspace.accounts[0]!.username !== username) { workspace = null; throw new Error('foreign_certificate_scope') }
      scheduled = sslObject(value) && sslObject(value.renewalScheduler) && value.renewalScheduler.state === 'active'
      chip.textContent = scheduled ? t('AutoSSL on') : t('AutoSSL not connected')
      chip.dataset.state = scheduled ? 'on' : 'off'
      autossl.textContent = scheduled
        ? t('AutoSSL renews issued certificates 30 days before they expire.')
        : t('Automatic renewal is not scheduled on this server yet. Renew a Let’s Encrypt certificate with Renew now before it expires.')
      const previous = domain.value; domain.textContent = ''
      for (const item of workspace.domains) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; domain.append(option) }
      if (Array.from(domain.options).some(option => option.value === previous)) domain.value = previous
      control<HTMLElement>('detail').hidden = true
      show()
    }
    /** Every outcome ends with a fresh read; an uncertain write is reported, never retried. */
    async function mutate(kind: 'renew' | 'remove' | 'install', target?: SslCertificateView): Promise<void> {
      if (busy || !workspace || !admitted()) return
      const baseline = workspace
      if (kind === 'install' && (!cert.value.trim() || !key.value.trim())) { announce('failed', t('Paste the private key and the certificate. Nothing was sent.')); return }
      if (kind === 'remove') {
        const names = target!.names.join(', ')
        const body = target!.assignedDomains.length
          ? t('{names} is installed on {domains}. Those sites switch to another certificate that covers them, or to the server default certificate. The certificate is not revoked.', { names, domains: target!.assignedDomains.join(', ') })
          : t('{names} is not installed on any site. The certificate is not revoked.', { names })
        let confirmed = false
        try { confirmed = !!askDialog && await askDialog({ title: t('Remove this certificate?'), body, danger: true, confirm: t('Remove') }) === true } catch { confirmed = false }
        if (!confirmed) { if (!askDialog) announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      }
      busy = true; lock(); let submitted = false
      announce('busy', kind === 'renew' ? t('Renewing the certificate. This can take about a minute.') : kind === 'remove' ? t('Removing the certificate.') : t('Checking and installing the certificate.'))
      try {
        submitted = true
        if (kind === 'remove') {
          const response = await request('DELETE', base + '/' + encodeURIComponent(target!.id), { expectedRevision: baseline.revision })
          await read()
          if (!sslObject(response) || response.removedCertificateId !== target!.id || workspace!.certificates.some(item => item.id === target!.id)) throw new Error('certificate_removal_readback_mismatch')
          announce('saved', t('Certificate removed. The web server configuration was applied.'))
        } else if (kind === 'renew') {
          const response = await request('POST', base, { domain: target!.assignedDomains[0], certificateId: target!.id, expectedRevision: baseline.revision })
          await read()
          const found = workspace!.certificates.find(item => item.id === target!.id)
          if (!sslObject(response) || !found || found.notAfter !== (sslObject(response.certificate) ? response.certificate.notAfter : null)) throw new Error('certificate_renewal_readback_mismatch')
          announce('saved', t('Certificate renewed. It is valid until {date}.', { date: displayDateTime(found.notAfter) }))
        } else {
          const chosen = domain.value, fullchainPem = cert.value.trim() + '\n' + (bundle.value.trim() ? bundle.value.trim() + '\n' : '')
          const body = { domain: chosen, expectedRevision: baseline.revision, fullchainPem, privateKeyPem: key.value }
          key.value = ''
          const response = await request('POST', base + '/install', body)
          await read()
          const ack = sslObject(response) && sslObject(response.certificate) ? response.certificate : null
          const found = ack && workspace!.certificates.find(item => item.id === ack.id)
          if (!found || !found.assignedDomains.includes(chosen) || !sslCoversHost(found.names, chosen)) throw new Error('certificate_install_readback_mismatch')
          cert.value = ''; bundle.value = ''
          announce('saved', t('Installed on {domain}. Uploaded certificates are not renewed automatically.', { domain: chosen }))
        }
      } catch (error) {
        key.value = ''
        const uncertain = submitted && sslWriteUncertain(error)
        try { await read() } catch { workspace = null; rows.textContent = '' }
        if (sslObject(error) && error.status === 409) announce('failed', t('Certificates changed while you were working. The list was read again; review it and try again.'))
        else announce(uncertain ? 'uncertain' : 'failed', uncertain ? t('The outcome needs review. The list was read again and nothing was retried.') : accountSslRefusal(error, t))
      } finally { busy = false; lock() }
    }
    if (!transport || !admitted()) { for (const field of [domain, key, cert, bundle, install]) field.disabled = true; announce('unavailable', t('Certificate management is unavailable here. Nothing was read or changed.')); return }
    install.addEventListener('click', () => { void mutate('install') })
    domain.addEventListener('change', lock)
    window.addEventListener('beforeunload', event => { if (key.value || cert.value) { event.preventDefault(); event.returnValue = '' } })
    lock()
    void read().catch(() => { announce('failed', t('Installed certificates could not be read. Nothing was changed.')); lock() })
  })
}

export const ACCOUNT_SSL_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const DAY_MS=${DAY_MS};${WHM_SSL_PARSER_BINDING};const accountSslRefusal=${accountSslRefusal.toString()};const bind=${bindAccountSsl.toString()};return(askDialog)=>bind(askDialog,{readSslWorkspace,sslCoversHost,sslObject,sslWriteUncertain});})()`
