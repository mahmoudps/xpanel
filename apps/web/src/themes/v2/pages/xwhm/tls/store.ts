import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml } from '../../../html.ts'
import { netButton, netField, netTable } from '../domains/common.ts'

/**
 * WHM views of a store: browse an owned account or root's own store (SSL Storage Manager), generate a key, certificate and
 * CSR at once, or install a certificate from root's store for the services that take one.
 */
export function v2WhmSslStore(t: Translate, mode: 'storage' | 'generate' | 'service', accounts: readonly { username: string }[], canManage: boolean, server = false): string {
  const id = 'ssl-store-' + mode, unread = t(msgid('SSL storage has not been read.'))
  const options = [...server ? [{ value: '', label: t(msgid('Server store (root)')) }] : [], ...accounts.map(item => ({ value: item.username, label: item.username }))]
  const account = mode === 'service' ? '' : netField(id + '-account', t(msgid('Account')), { kind: 'select', dir: 'ltr', disabled: !canManage, hooks: { 'data-ssl-store-account': true }, options })
  const head = `${account}<p role="status" data-ssl-store-status data-state="unread">${escapeHtml(unread)}</p><div class="v2-whm-network__actions">${netButton(t(msgid('Read SSL storage')), { 'data-ssl-store-refresh': true })}</div>`
  const template = `<template data-xp-template="ssl-store-action"><button type="button" class="v2-btn" data-xp-slot="label" disabled></button></template>`
  const ellipsis = (html: string): string => html
    .replace(/<select (?![^>]*\bstyle=)/g, '<select style="min-inline-size:0;max-inline-size:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" ')
    .replace(/<button (?![^>]*\bstyle=)/g, '<button style="min-inline-size:var(--target);min-block-size:var(--target)" ')
  const root = (body: string) => ellipsis(`<div class="v2-whm-network__groups" data-ssl-store data-ssl-store-mode="${mode}"${mode === 'service' ? ' data-ssl-store-scope="server"' : ''}${server ? ' data-ssl-store-server="true"' : ''} data-ssl-store-username="" data-ssl-store-can-read="${canManage}" data-ssl-store-can-manage="${canManage}">${body}${template}</div>`)
  const table = (key: string, hook: string, caption: string, columns: string[]) => netTable(t, id + '-' + key, caption, columns, [], unread, { [hook]: true })
  const certificates = table('certificates', 'data-ssl-store-certificates', t(msgid('Certificates')), [t(msgid('ID')), t(msgid('Names')), t(msgid('Issuer')), t(msgid('Expires (UTC)')), t(msgid('Private key')), t(msgid('Public key')), t(msgid('Actions'))])
  const viewer = `<section class="v2-whm-network__groups" data-ssl-store-viewer hidden aria-labelledby="v2-whm-${id}-viewer"><h3 id="v2-whm-${id}-viewer" data-ssl-store-viewer-title></h3><pre class="v2-mono" style="padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--code);color:var(--code-text);font-size:12px;line-height:1.6;overflow-x:auto;font-variant-numeric:tabular-nums" dir="ltr" data-ssl-store-pem></pre><div class="v2-whm-network__actions">${netButton(t(msgid('Close')), { 'data-ssl-store-viewer-close': true })}</div></section>`
  // Without authority the same layout renders with no live form, so nothing can submit.
  const form = (hook: string, extra: string, body: string) => `<${canManage ? 'form' : 'div'} class="v2-whm-network__groups" ${canManage ? hook : hook.replace(/-form$/, '-layout')}${extra}>${body}</${canManage ? 'form' : 'div'}>`
  if (mode === 'storage') {
    return root(head + `<p>${escapeHtml(t(msgid('Keys, signing requests and certificates are files in ~/ssl of this account, readable only by it, and account backups include them. A private key is shown only when you choose View.')))}</p>`
      + `<p>${escapeHtml(t(msgid('Items that share a public key belong together: a key, its signing requests and the certificates issued for it.')))}</p>`
      + certificates + table('keys', 'data-ssl-store-keys', t(msgid('Private keys')), [t(msgid('ID')), t(msgid('Type')), t(msgid('Public key')), t(msgid('Actions'))])
      + table('csrs', 'data-ssl-store-csrs', t(msgid('Certificate signing requests')), [t(msgid('ID')), t(msgid('Names')), t(msgid('Public key')), t(msgid('Actions'))]) + viewer)
  }
  if (mode === 'service') {
    const service = netField(id + '-service', t(msgid('Service')), { kind: 'select', name: 'service', required: true, options: [{ value: 'mail', label: t(msgid('Mail: SMTP, IMAP and POP3')) }] })
    return root(head + certificates + form('data-ssl-store-service-form', '', `<div class="v2-whm-network__fields">${netField(id + '-certificate', t(msgid('Stored certificate')), { kind: 'select', name: 'storeCertificateId', required: true, options: [] })}${service}</div>`
      + netField(id + '-bundle', t(msgid('CA bundle (optional)')), { kind: 'textarea', name: 'caBundlePem', rows: 4, dir: 'ltr', mono: true, spellcheck: false, autocomplete: 'off' })
      + `<div class="v2-whm-network__actions">${canManage ? netButton(t(msgid('Install')), undefined, { primary: true, submit: true }) : ''}</div>`)
      + `<p>${escapeHtml(t(msgid('Postfix and Dovecot use the saved certificate that covers the server hostname and expires last; it must be issued by a certificate authority. The panel listener keeps its own certificate lifecycle, and FTP takes no certificate.')))}</p>` + viewer)
  }
  return root(head + form('data-ssl-store-certificate-form', ' data-ssl-store-with-csr="true"', `<div class="v2-whm-network__fields">${netField(id + '-key-type', t(msgid('Key type')), { kind: 'select', name: 'keyType', options: [] })}${netField(id + '-days', t(msgid('Valid for (days)')), { kind: 'input', type: 'number', name: 'days', value: '365', min: 1, max: 3650, required: true, dir: 'ltr' })}</div>`
    + netField(id + '-names', t(msgid('Names')), { kind: 'textarea', name: 'names', rows: 3, dir: 'ltr', mono: true, spellcheck: false, autocomplete: 'off', required: true }, t(msgid('One host name per line. The first name is the common name.')))
    + `<div class="v2-whm-network__fields">${netField(id + '-org', t(msgid('Organization')), { kind: 'input', name: 'organization', maxlength: 64, dir: 'auto' })}${netField(id + '-country', t(msgid('Country code')), { kind: 'input', name: 'country', maxlength: 2, dir: 'ltr' })}${netField(id + '-email', t(msgid('Contact email')), { kind: 'input', type: 'email', name: 'email', maxlength: 200, dir: 'ltr' })}</div>`
    + netField(id + '-passphrase', t(msgid('Challenge passphrase (optional)')), { kind: 'input', type: 'password', name: 'passphrase', maxlength: 64, dir: 'ltr', autocomplete: 'off' }, t(msgid('Some certificate authorities ask for it to revoke a certificate. It is written into the request and not stored anywhere else.')))
    + `<div class="v2-whm-network__actions">${netButton(t(msgid('Generate key, certificate and CSR')), undefined, { primary: true, submit: canManage })}</div>`)
    + `<p>${escapeHtml(t(msgid('The new private key, self-signed certificate and signing request are saved in ~/ssl of the chosen account. Send the signing request to a certificate authority, then install the certificate it returns.')))}</p>`)
}
