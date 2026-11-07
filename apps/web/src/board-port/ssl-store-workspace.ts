import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface SslStoreWorkspaceInput {
  locale: Locale
  /**
   * account: one account's store (xPanel); storage: browse an owned account or root's store (WHM SSL Storage Manager);
   * generate: key, self-signed certificate and CSR in one step (WHM); service: root's store for the service certificates.
   */
  mode: 'account' | 'storage' | 'generate' | 'service'
  canManage: boolean
  /** Fixed account for account mode. */
  username?: string
  /** Owned accounts for the WHM modes; the first is read first. */
  accounts?: readonly { username: string }[]
  /** Root only: offer root's own store before the accounts. */
  server?: boolean
}

/** Classic markup for the ~/ssl storage client. Every control starts disabled; the SSL storage client enables them after an authorized read. */
export function renderSslStoreWorkspace(input: SslStoreWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const k = { card: 'xp-card', button: 'xp-btn', primary: 'xp-btn xp-btn--primary', field: 'xp-field', fields: 'xp-whm-detail-fields', actions: 'xp-whm-detail-actions', table: 'xp-table', input: 'xp-input', muted: 'xp-help' }, id = 'ssl-store-' + input.mode
  const text = (name: string, label: string, extra = '', type = 'text') => `<div class="${k.field}"><label for="${id}-${name}">${label}</label><input id="${id}-${name}" name="${name}" type="${type}" class="${k.input}"${extra} disabled></div>`
  const choose = (name: string, label: string, extra = '') => `<div class="${k.field}"><label for="${id}-${name}">${label}</label><select id="${id}-${name}" name="${name}"${extra} disabled></select></div>`
  const area = (name: string, label: string, help = '', extra = '') => `<div class="${k.field}"><label for="${id}-${name}">${label}</label><textarea id="${id}-${name}" name="${name}" class="${k.input}" dir="ltr" rows="4" spellcheck="false" autocomplete="off"${help ? ` aria-describedby="${id}-${name}-help"` : ''}${extra} disabled></textarea>${help ? `<p class="${k.muted}" id="${id}-${name}-help">${help}</p>` : ''}</div>`
  const submit = (label: string) => `<div class="${k.actions}"><button type="submit" class="${k.primary}" disabled>${label}</button></div>`
  // Without authority the same layout renders with no live form, so nothing can submit.
  const form = (hooks: string, body: string) => input.canManage ? `<form ${hooks}>${body}</form>` : `<div ${hooks.replace(/data-ssl-store-([a-z-]+)-form/, 'data-ssl-store-$1-layout')}>${body}</div>`
  const card = (key: string, title: string, body: string) => `<section class="${k.card}" aria-labelledby="${id}-${key}-heading"><h2 id="${id}-${key}-heading">${title}</h2>${body}</section>`
  const table = (hook: string, title: string, heads: string[]) => `<div class="${k.table}" role="region" tabindex="0" aria-label="${title}"><table><caption>${title}</caption><thead><tr>${heads.map(head => `<th scope="col">${head}</th>`).join('')}</tr></thead><tbody ${hook}><tr><td colspan="${heads.length}">${t('SSL storage has not been read.')}</td></tr></tbody></table></div>`
  const names = area('names', t('Names'), t('One host name per line. The first name is the common name.'), ' required')
  const subject = `<div class="${k.fields}">${text('organization', t('Organization'), ' dir="auto" maxlength="64"')}${text('country', t('Country code'), ' dir="ltr" maxlength="2" pattern="[A-Z]{2}"')}${text('email', t('Contact email'), ' dir="ltr" maxlength="200"', 'email')}</div>`
  const keyType = choose('keyType', t('Key type'))
  const days = text('days', t('Valid for (days)'), ' dir="ltr" min="1" max="3650" value="365" required', 'number')
  const passphrase = `<div class="${k.field}"><label for="${id}-passphrase">${t('Challenge passphrase (optional)')}</label><input id="${id}-passphrase" name="passphrase" type="password" class="${k.input}" dir="ltr" maxlength="64" autocomplete="off" aria-describedby="${id}-passphrase-help" disabled><p class="${k.muted}" id="${id}-passphrase-help">${t('Some certificate authorities ask for it to revoke a certificate. It is written into the request and not stored anywhere else.')}</p></div>`
  const keys = table('data-ssl-store-keys', t('Private keys'), [t('ID'), t('Type'), t('Public key'), t('Actions')])
  const csrs = table('data-ssl-store-csrs', t('Certificate signing requests'), [t('ID'), t('Names'), t('Public key'), t('Actions')])
  const certificates = table('data-ssl-store-certificates', t('Certificates'), [t('ID'), t('Names'), t('Issuer'), t('Expires (UTC)'), t('Private key'), t('Public key'), t('Actions')])
  const viewer = `<section class="${k.card}" data-ssl-store-viewer hidden aria-labelledby="${id}-viewer-title"><h2 id="${id}-viewer-title" data-ssl-store-viewer-title></h2><pre dir="ltr" data-ssl-store-pem></pre><div class="${k.actions}"><button type="button" class="${k.button}" data-ssl-store-viewer-close disabled>${t('Close')}</button></div></section>`
  const accountChoice = input.mode === 'account' || input.mode === 'service' ? '' : `<div class="${k.field}"><label for="${id}-account">${t('Account')}</label><select id="${id}-account" dir="ltr" data-ssl-store-account${input.canManage ? '' : ' disabled'}>${input.server ? `<option value="">${t('Server store (root)')}</option>` : ''}${(input.accounts ?? []).map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>`
  const head = `${accountChoice}<p role="status" data-ssl-store-status data-state="unread">${t('SSL storage has not been read.')}</p><div class="${k.actions}"><button type="button" class="${k.button}" data-ssl-store-refresh disabled>${t('Read SSL storage')}</button></div>`
  const scope = `<p class="${k.muted}">${t('Keys, signing requests and certificates are files in ~/ssl of this account, readable only by it, and account backups include them. A private key is shown only when you choose View.')}</p>`
  const services = `<div class="${k.field}"><label for="${id}-service">${t('Service')}</label><select id="${id}-service" name="service" required disabled><option value="mail">${t('Mail: SMTP, IMAP and POP3')}</option><option value="panel" disabled>${t('Panel listener (not from SSL storage)')}</option><option value="ftp" disabled>${t('FTP (no TLS certificate)')}</option></select></div>`
  const body = input.mode === 'service'
    ? card('service', t('Install from the server SSL storage'), head + certificates + form('data-ssl-store-service-form', `<div class="${k.fields}">${choose('storeCertificateId', t('Stored certificate'), ' required')}${services}</div>${area('caBundlePem', t('CA bundle (optional)'))}${submit(t('Install'))}`)
      + `<p class="${k.muted}">${t('Postfix and Dovecot use the saved certificate that covers the server hostname and expires last; it must be issued by a certificate authority. The panel listener keeps its own certificate lifecycle, and FTP takes no certificate.')}</p>`) + viewer
    : input.mode === 'generate'
    ? card('generate', t('Generate a certificate and signing request'), head + form('data-ssl-store-certificate-form data-ssl-store-with-csr="true"', `<div class="${k.fields}">${keyType}${days}</div>${names}${subject}${passphrase}${submit(t('Generate key, certificate and CSR'))}`)
      + `<p class="${k.muted}">${t('The new private key, self-signed certificate and signing request are saved in ~/ssl of the chosen account. Send the signing request to a certificate authority, then install the certificate it returns.')}</p>`)
    : input.mode === 'storage'
      ? card('storage', t('SSL storage'), head + scope + `<p class="${k.muted}">${t('Items that share a public key belong together: a key, its signing requests and the certificates issued for it.')}</p>` + certificates + keys + csrs) + viewer
      : card('certificates', t('Certificates'), head + certificates + form('data-ssl-store-install-form', `<div class="${k.fields}">${choose('storeCertificateId', t('Stored certificate'), ' required')}${choose('domain', t('Domain'), ' dir="ltr" required')}</div>${area('caBundlePem', t('CA bundle (optional)'))}${submit(t('Install'))}`))
        + card('upload', t('Upload a private key and certificate'), form('data-ssl-store-import-form', `${area('keyPem', t('Private key'))}${area('certificatePem', t('Certificate'))}${submit(t('Save to SSL storage'))}`))
        + viewer
        + card('keys', t('Private keys'), form('data-ssl-store-key-form', `<div class="${k.fields}">${keyType}${text('label', t('Name'), ' dir="auto" maxlength="64"')}</div>${submit(t('Generate key'))}`) + keys)
        + card('csrs', t('Certificate signing requests'), form('data-ssl-store-csr-form', `<div class="${k.fields}">${choose('keyId', t('Private key'))}${keyType}</div>${names}${subject}${passphrase}${submit(t('Generate CSR'))}`) + csrs)
        + card('self-signed', t('Self-signed certificate'), form('data-ssl-store-certificate-form', `<div class="${k.fields}">${choose('keyId', t('Private key'))}${keyType}${days}</div>${names}${subject}${submit(t('Generate certificate'))}`))
        + card('limits', t('Limits of this page'), scope + `<p class="${k.muted}">${t('Requests and self-signed certificates are made with openssl on the server. Installing saves the certificate for the domain; the served certificate is not verified here.')}</p>`)
  return `<div class="xp-ssl-store" data-ssl-store data-ssl-store-mode="${input.mode}"${input.mode === 'service' ? ' data-ssl-store-scope="server"' : ''}${input.server ? ' data-ssl-store-server="true"' : ''} data-ssl-store-username="${escapeHtml(input.username ?? '')}" data-ssl-store-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
<style>.xp-ssl-store{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-ssl-store form{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-ssl-store :is(h2,p){margin:0}.xp-ssl-store section{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-ssl-store pre{margin:0;max-block-size:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.xp-ssl-store [data-ssl-store-actions]{display:flex;flex-wrap:wrap;gap:8px}.xp-ssl-store table{inline-size:100%}.xp-ssl-store caption{text-align:start}</style>
${body}<template data-xp-template="ssl-store-action"><button type="button" class="${k.button}" data-xp-slot="label" disabled></button></template></div>`
}
