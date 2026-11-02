import { accountPgpClientTemplates } from './routing-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, field, fields, header, input, missingAccount, page, section, select, state, table, unread, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelEmailEncryption(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage } = emailContext(props, authority)
  const route = '/email/encryption', title = t(msgid('Email encryption'))
  const keys = section('v2-pgp-keyring', t(msgid('OpenPGP keys')),
    `<p>${esc(t(msgid('Manage keys for your account mailbox addresses. Keys are stored privately in')))} <bdi dir="ltr" class="v2-mono">~/.gnupg</bdi>.</p><p>${esc(t(msgid('This page manages keys only. xMail does not sign, encrypt or decrypt messages with these keys. Exported files contain public keys only; keep your passphrase safe.')))}</p>`
    + table('v2-pgp-records', t(msgid('OpenPGP keys')), [t(msgid('Identity / fingerprint')), t(msgid('Algorithm')), t(msgid('Created / expires')), t(msgid('Private key')), t(msgid('Actions'))], unread(t, 5), { 'data-pgp-rows': true })
    + state(t(msgid('Read the keyring to begin.')), { 'data-pgp-status': true })
    + actions(button(t(msgid('Read keys')), { 'data-pgp-refresh': true }, !canManage)))
  const generate = section('v2-pgp-generate', t(msgid('Generate key pair')),
    fields(field('pgp-name', t(msgid('Name')), input('pgp-name', { 'data-pgp-name': true }, ' type="text" maxlength="100" autocomplete="off"', !canManage))
      + field('pgp-address', t(msgctxt('account-pgp-workspace', 'Mailbox address')), select('pgp-address', [['', t(msgctxt('account-pgp-workspace', 'Read mailboxes first'))]], { 'data-pgp-address': true }, !canManage, ' dir="ltr"'))
      + field('pgp-algorithm', t(msgid('Algorithm')), select('pgp-algorithm', [['ed25519', 'Ed25519 / Cv25519'], ['rsa3072', 'RSA 3072']], { 'data-pgp-algorithm': true }, !canManage, ' dir="ltr"'))
      + field('pgp-days', t(msgid('Expires after (days)')), input('pgp-days', { 'data-pgp-days': true }, ' type="number" dir="ltr" min="1" max="3650" value="365"', !canManage)))
    + field('pgp-passphrase', t(msgid('Passphrase')), input('pgp-passphrase', { 'data-pgp-passphrase': true }, ' type="password" autocomplete="new-password" minlength="12" maxlength="1024"', !canManage), t(msgid('At least 12 characters. Used by GnuPG for the key and encryption subkey; never saved by the panel.')))
    + actions(button(t(msgid('Generate key pair')), { 'data-pgp-generate': true }, true, true)))
  const imported = section('v2-pgp-import', t(msgid('Import key')),
    field('pgp-file', t(msgid('Armored key file (.asc)')), input('pgp-file', { 'data-pgp-file': true }, ' type="file" accept=".asc,application/pgp-keys,text/plain"', !canManage), t(msgid('Import one public or private key, up to 256 KiB. Every identity must use one of your current mailbox addresses. File contents are not displayed.')))
    + actions(button(t(msgctxt('account-pgp-workspace', 'Import key')), { 'data-pgp-import': true })))
  const remove = section('v2-pgp-delete', t(msgid('Delete a key pair')),
    `<p>${esc(t(msgid('Select Delete on a key above, then type its complete fingerprint. Deletion removes the public and private key from this account. Keep your own backup before deleting.')))}</p>`
    + field('pgp-confirm', t(msgid('Fingerprint to delete')), input('pgp-confirm', { 'data-pgp-confirm': true }, ' type="text" dir="ltr" autocomplete="off" spellcheck="false" maxlength="64"', !canManage))
    + `<p><bdi dir="ltr" class="v2-mono" data-pgp-selected>—</bdi></p>`
    + actions(button(t(msgid('Delete selected key pair')), { 'data-pgp-delete': true })))
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Generate, import, export and explicitly remove account mailbox keys.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-pgp data-account="${esc((account?.id ?? ''))}" data-pgp-manage="${canManage}">${keys}${generate}${imported}${remove}${accountPgpClientTemplates()}</div>`)
}
