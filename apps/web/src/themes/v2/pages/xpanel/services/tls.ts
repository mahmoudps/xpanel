import { accountSslTemplates } from '../../../client-templates/data-workspaces.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { card, kpiCard, statusPill, stepper } from '../../../components/index.ts'
import { escapeHtml } from '../../../html.ts'
import { missingServiceAccount, serviceButton, serviceFacts, serviceField, serviceHeader, technical, type PanelServiceAuthority } from './common.ts'

export function renderV2TlsPage(props: PanelSurfaceProps, authority: PanelServiceAuthority = { canManage: false }): string {
  const t = v2Messages.translator(props.locale ?? 'en')
  const missing = missingServiceAccount(t, props)
  const principal = props.visibility?.principal
  const readOnly = authority.presentation === 'read-only'
  const account = !readOnly || authority.canReadFacts === true && principal?.kind === 'user' && props.account?.id === principal.accountId ? props.account : undefined
  const domains = (account && (!readOnly || authority.authorizedTools?.has('domains')) ? props.domains ?? [] : []).filter(domain => domain.accountId === (account?.id ?? ''))
  const certificates = (account && (!readOnly || authority.authorizedTools?.has('ssl-tls-status')) ? props.certificates ?? [] : []).filter(certificate => certificate.accountId === (account?.id ?? ''))
  const canManage = !!account && !readOnly && authority.canManage && domains.length > 0
  const domainOptions = domains.map(domain => `<option value="${escapeHtml(domain.name)}"${domain.name === props.activeDomain ? ' selected' : ''}>${escapeHtml(domain.name)}</option>`).join('')
  const storedRows = certificates.map(certificate => {
    const assigned = domains.filter(domain => domain.certificateId === certificate.id).map(domain => domain.name)
    const source = certificate.source === 'acme' ? t('ACME (Let’s Encrypt)') : certificate.source === 'upload' ? t('Uploaded') : t('Self-signed')
    const actions = [t('View'), t('Renew now'), t('Remove')].map(label => serviceButton(label, undefined, true)).join('')
    return `<tr><td>${certificate.names.map(name => `<div>${technical(name)}</div>`).join('')}</td><td>${escapeHtml(source)}</td><td>${technical(certificate.notAfter)}</td><td>${escapeHtml(certificate.source === 'acme' && certificate.autoRenew ? t('Requested') : t('Not available'))}</td><td>${assigned.length ? assigned.map(name => `<div>${technical(name)}</div>`).join('') : escapeHtml(t('Not installed'))}</td><td><div class="v2-panel-service__actions">${actions}</div></td></tr>`
  }).join('')
  const rows = (!account || props.certificates === undefined || readOnly && !authority.authorizedTools?.has('ssl-tls-status'))
    ? `<tr><td colspan="6">${escapeHtml(t(msgctxt('theme:v2', 'Stored certificates have not been read.')))}</td></tr>`
    : storedRows || `<tr><td colspan="6">${escapeHtml(t('No certificates are installed on this account yet.'))}</td></tr>`
  const summary = `<section class="v2-kpi-row" aria-label="${escapeHtml(t('Certificate summary'))}">${kpiCard({ label: t('Stored certificates'), headingLevel: 2, value: (!account || props.certificates === undefined || readOnly && !authority.authorizedTools?.has('ssl-tls-status')) ? t('Not read') : String(certificates.length), tone: 'neutral', note: t(msgctxt('theme:v2', 'Stored state does not verify the certificate served by the host.')) })}${kpiCard({ label: t(msgctxt('theme:v2', 'Renewing soon')), headingLevel: 2, value: t('Not observed'), tone: 'neutral', note: t('The renewal schedule has not been read yet.') })}${kpiCard({ label: t(msgctxt('theme:v2', 'Host name coverage')), headingLevel: 2, value: t('Not observed'), tone: 'neutral', note: t(msgctxt('theme:v2', 'Certificate coverage and live installation are checked separately.')) })}</section>`
  const table = `<div class="v2-panel-service__table" tabindex="0" role="region" aria-label="${escapeHtml(t('Installed certificates'))}"><table class="v2-table"><thead><tr>${[t('Names'), t('Issuer and key'), t('Expires'), t('Auto-renew'), t('Installed on'), t('Actions')].map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-account-ssl-rows>${rows}</tbody></table></div>`
  const installed = card({
    title: t('Installed certificates'), titleId: 'v2-ssl-installed-heading',
    actionsHtml: `<span data-account-ssl-autossl-chip>${statusPill({ tone: 'neutral', label: t('AutoSSL not read') })}</span>`,
    bodyHtml: `<p data-account-ssl-autossl>${escapeHtml(t('The renewal schedule has not been read yet.'))}</p>${table}<p data-account-ssl-status data-state="unread" role="status" hidden></p><section data-account-ssl-detail hidden aria-labelledby="v2-ssl-detail-heading"><h3 id="v2-ssl-detail-heading">${escapeHtml(t('Certificate details'))}</h3><dl class="v2-panel-service-facts" data-account-ssl-facts></dl></section>`,
  })
  const issue = card({
    title: t('Issue or renew a certificate'), titleId: 'v2-ssl-issue-heading',
    description: t('The server answers the HTTP-01 check on port 80. Application to the web server remains unverified until host reconciliation reports it.'),
    bodyHtml: domains.length ? `<form data-certificate-form data-account-username="${escapeHtml((account?.username ?? ''))}" class="v2-stack"><fieldset${canManage ? '' : ' disabled'}>${serviceField('v2-ssl-certificate-domain', t('Domain'), `<select id="v2-ssl-certificate-domain" name="domain" dir="ltr" required>${domainOptions}</select>`)}<p data-certificate-status role="status" hidden></p><div class="v2-panel-service__actions"><button type="submit" class="v2-btn v2-btn--primary">${escapeHtml(t('Issue or renew'))}</button></div></fieldset></form>` : `<p>${escapeHtml(t('Add a domain before issuing a certificate.'))}</p>`,
  })
  const pem = (key: string, id: string): string => `<textarea id="${id}" class="v2-mono" dir="ltr" rows="6" spellcheck="false" autocomplete="off" data-account-ssl-${key} disabled></textarea>`
  const upload = card({
    title: t('Upload a private key and certificate'), titleId: 'v2-ssl-upload-heading',
    description: t('For a certificate bought from another authority. You renew it yourself.'),
    bodyHtml: `<div class="v2-stack">${serviceField('v2-ssl-upload-domain', t('Install on'), `<select id="v2-ssl-upload-domain" data-account-ssl-domain dir="ltr" disabled>${domainOptions}</select>`)}${serviceField('v2-ssl-upload-key', t('Private key'), pem('key', 'v2-ssl-upload-key'), t(msgctxt('theme:v2', 'PEM format. The key is never displayed after installation.')))}${serviceField('v2-ssl-upload-cert', t('Certificate'), pem('cert', 'v2-ssl-upload-cert'))}${serviceField('v2-ssl-upload-bundle', t('CA bundle (optional)'), pem('bundle', 'v2-ssl-upload-bundle'), t(msgctxt('theme:v2', 'The key, certificate names, validity and chain are checked before installation.')))}<div class="v2-panel-service__actions">${serviceButton(t('Install'), { 'data-account-ssl-install': true }, true, true)}</div></div>`,
  })
  const choices = card({
    title: t('Your choices'), titleId: 'v2-ssl-choices-heading',
    bodyHtml: serviceFacts([
      { label: t('Validation'), valueHtml: technical('HTTP-01') },
      { label: t(msgctxt('theme:v2', 'Installation')), valueHtml: escapeHtml(t(msgctxt('theme:v2', 'No installation result has been read.'))) },
      { label: t('Renewal'), valueHtml: escapeHtml(t('Not observed')) },
    ]),
  })
  const wildcard = card({
    title: t('About wildcard certificates'), titleId: 'v2-ssl-wildcard-heading',
    bodyHtml: `<div class="v2-panel-service__note"><p>${escapeHtml(t('A wildcard covers one label level and requires DNS validation.'))}</p><p>${escapeHtml(t(msgctxt('theme:v2', 'The account issue action uses HTTP-01. It does not issue wildcard certificates.')))}</p><a href="/domains/zone-editor">${escapeHtml(t(msgctxt('theme:v2', 'Open the zone editor')))}</a></div>`,
  })
  const source = card({
    title: t('Certificate wizard'), titleId: 'v2-ssl-wizard-heading',
    description: t(msgctxt('theme:v2', 'Choose the certificate source and review names, validation and installation before continuing.')),
    bodyHtml: `${stepper({ label: t(msgctxt('theme:v2', 'Certificate steps')), inline: true, steps: [t('Source'), t('Names'), t('Validation'), t('Install'), t('Result')].map((label, index) => ({ label, state: index === 0 ? 'current' as const : 'upcoming' as const })) })}<div class="v2-panel-service__note"><h3>${escapeHtml(t('Use an existing certificate'))}</h3><p>${escapeHtml(t(msgctxt('theme:v2', 'Installing an existing certificate on more names is unavailable from this page.')))}</p>${serviceButton(t('Use an existing certificate'), undefined, true)}</div>`,
  })
  return `<section class="v2-panel-service"${readOnly || !account ? ' data-readonly="true"' : ''} data-v2-panel-service="tls" data-account-ssl data-ssl-can-manage="${canManage}" data-account-username="${escapeHtml((account?.username ?? ''))}">${serviceHeader(t, '/security/ssl', 'SSL/TLS', t('Choose the certificate, names and validation, then review installation.'))}${summary}${installed}<div class="v2-panel-service__columns"><div class="v2-panel-service__main">${source}${issue}${upload}</div><aside class="v2-panel-service__aside" aria-label="${escapeHtml(t('Workspace information'))}">${choices}${wildcard}</aside></div>${accountSslTemplates()}</section>`
}
