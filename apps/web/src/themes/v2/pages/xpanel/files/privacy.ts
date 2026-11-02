import { v2DirectoryPrivacyClientTemplates } from './directory-privacy-client-templates.ts'
import type { SurfaceAuthority } from '../../../../../models/theme-surface.ts'
import { scopePrimaryPanelFacts } from '../home.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { notice } from '../../../components/notice.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml } from '../../../html.ts'

export interface V2DirectoryPrivacyPageProps {
  readonly surface: PanelSurfaceProps
  /** Server-resolved operation permission; rendering never grants this permission. */
  readonly canManage: boolean
  readonly authority?: SurfaceAuthority
}

/** Saved configuration is read by core; a saved rule is never described as deployed protection. */
export function renderV2DirectoryPrivacyPage(t: Translate, props: V2DirectoryPrivacyPageProps): string {
  const head = pageHeader(t, { breadcrumb: [{ label: t('Files') }, { label: t('Directory privacy') }], route: '/files/directory-privacy', title: t('Directory privacy') })
  const surface = scopePrimaryPanelFacts(props.surface, props.authority)
  props = { ...props, surface }
  const account = props.surface.account
  const disabled = !account || props.authority?.presentation === 'read-only' || !props.canManage
  const fields = [
    formField({ id: 'v2-privacy-path', label: t('Folder'), help: t(msgctxt('theme:v2', 'Account-relative directory')), control: { kind: 'input', name: 'path', mono: true, dir: 'ltr', autocomplete: 'off', disabled, hooks: { 'data-directory-privacy-path': true } } }),
    formField({ id: 'v2-privacy-prompt', label: t(msgctxt('theme:v2', 'Authentication prompt')), control: { kind: 'input', name: 'authName', autocomplete: 'off', disabled, hooks: { 'data-directory-privacy-prompt': true } } }),
    formField({ id: 'v2-privacy-username', label: t('Username'), control: { kind: 'input', name: 'username', mono: true, dir: 'ltr', autocomplete: 'off', disabled, hooks: { 'data-directory-privacy-username': true } } }),
    formField({ id: 'v2-privacy-password', label: t('Password'), help: t('Password (required on save)'), control: { kind: 'input', name: 'password', type: 'password', mono: true, dir: 'ltr', autocomplete: 'new-password', disabled, hooks: { 'data-directory-privacy-password': true } } }),
  ].join('')
  const add = `<button type="button" class="v2-btn" data-directory-privacy-add${disabled ? ' disabled' : ''}>${escapeHtml(t(msgctxt('theme:v2', 'Add folder')))}</button>`
  const save = `<button type="button" class="v2-btn v2-btn--primary" data-directory-privacy-save${disabled ? ' disabled' : ''}>${escapeHtml(t('Save'))}</button>`
  const headers = [t('Folder'), t(msgctxt('theme:v2', 'Authentication prompt')), t('Users'), t('Enabled'), t('Actions')]
  const table = `<div class="v2-table-scroll" role="region" tabindex="0" aria-label="${escapeHtml(t('Protected folders'))}"><table class="v2-table"><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-directory-privacy-rows><tr><td colspan="5"><p role="status">${escapeHtml(t('Protected folders have not been read.'))}</p></td></tr></tbody></table></div>`
  const preview = `<section data-directory-privacy-preview-wrap hidden aria-labelledby="v2-directory-preview-heading"><h2 id="v2-directory-preview-heading">${escapeHtml(t('Configuration preview'))}</h2><pre class="v2-code"><code dir="ltr" data-directory-privacy-preview></code></pre></section>`
  return `${head}<div class="v2-files v2-directory-privacy" data-directory-privacy ${account ? `data-account-username="${escapeHtml(account.username)}"` : ''}${disabled ? ' data-read-only="true"' : ''}>${notice(t, { tone: 'info', text: t(msgctxt('theme:v2', 'Saved configuration only; web-server protection is not verified here.')) })}${notice(t, { tone: 'warn', text: t('Enter a password for every kept user. Saved password hashes are never returned, so each save re-proves the credentials.') })}<p role="status" aria-live="polite" data-directory-privacy-status>${escapeHtml(disabled ? t('File operations are unavailable.') : t('Protected folders have not been read.'))}</p>${card({ title: t(msgctxt('theme:v2', 'Add folder')), titleId: 'v2-privacy-add-heading', bodyHtml: `<div class="v2-file-fields">${fields}</div>`, footerHtml: add })}${card({ title: t('Protected folders'), titleId: 'v2-privacy-list-heading', flush: true, bodyHtml: table, footerHtml: save })}${preview}${v2DirectoryPrivacyClientTemplates()}</div>`
}
