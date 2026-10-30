import type { SurfaceAuthority } from '../../../../../models/theme-surface.ts'
import { scopePrimaryPanelFacts } from '../home.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { notice } from '../../../components/notice.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { icon } from '../../../icons.ts'
import { fileWorkspaceTemplates } from './templates.ts'

export interface V2FilesPageProps {
  readonly surface: PanelSurfaceProps
  /** Core resolves account authorization and host capability before rendering. */
  readonly canManage: boolean
  readonly authority?: SurfaceAuthority
}

const technical = (text: string | number): string => `<bdi dir="ltr" class="v2-mono">${escapeHtml(text)}</bdi>`
const trashIcon = '<svg class="v2-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"></path></svg>'

function button(label: string, hooks: HookAttributes, disabled = false, primary = false): string {
  return `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

function fileRows(t: Translate, props: V2FilesPageProps, trash: boolean): string {
  const files = props.surface.files?.filter(file => trash ? file.trashed === true : !file.trashed)
  if (!files?.length) {
    const message = files === undefined ? t('Directory contents have not been read.') : trash ? t('The trash is empty') : t('This directory is empty.')
    return `<tr><td colspan="6"><p role="status">${escapeHtml(message)}</p></td></tr>`
  }
  return files.map(file => `<tr data-file-path="${escapeHtml(file.path)}"><td><span class="v2-file-name">${icon(file.kind === 'folder' ? 'folder' : 'files', 18)}${technical(file.name)}</span><span class="v2-file-path">${technical(file.path)}</span></td><td>${escapeHtml(t(file.kind === 'folder' ? msgctxt('files', 'Folder') : msgctxt('files', 'File')))}</td><td>${technical(`${file.sizeBytes} B`)}</td><td>${technical(file.modeOctal)}</td><td>${trash ? escapeHtml(t('Not recorded')) : `<time datetime="${escapeHtml(file.modifiedAt)}">${technical(file.modifiedAt)}</time>`}</td><td><span class="v2-muted">${escapeHtml(t('Refresh files'))}</span></td></tr>`).join('')
}

function fileTable(t: Translate, props: V2FilesPageProps, trash: boolean): string {
  const headers = [t('Name / Path'), t('Type'), t('Size'), t('Permissions'), t(trash ? msgctxt('xpanel', 'Deleted (UTC)') : msgctxt('xpanel', 'Modified (UTC)')), t('Actions')]
  return `<div class="v2-table-scroll" role="region" tabindex="0" aria-label="${escapeHtml(t('Account files'))}" data-file-table-wrap><table class="v2-table" data-file-manager-table="true"><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${fileRows(t, props, trash)}</tbody></table></div>`
}

function editor(t: Translate, disabled: boolean): string {
  return card({ title: t(msgctxt('theme:v2', 'Text editor')), titleId: 'v2-file-editor-heading', bodyHtml: `<div data-in-browser-editor class="v2-file-editor"><div class="v2-field"><span class="v2-file-label">${escapeHtml(t('Selected file'))}</span><bdi dir="ltr" class="v2-mono" data-file-selected-path></bdi></div><div class="v2-field"><label for="jailed-code-editor">${escapeHtml(t('File contents'))}</label><textarea id="jailed-code-editor" name="contents" class="v2-mono" rows="14" dir="ltr" data-editor-path="" spellcheck="false"${disabled ? ' disabled' : ''}></textarea></div><div class="v2-file-actions">${button(t('Save text'), { 'data-action': 'save-file' }, true, true)}${button(t('Reload file'), { 'data-action': 'reload-file' }, true)}</div><p class="v2-field__help">${escapeHtml(t('Your draft will be replaced only after the new file or directory is read successfully.'))}</p></div>` })
}

function permissionPolicy(t: Translate, disabled: boolean): string {
  return card({ title: t('Permissions'), titleId: 'v2-file-permissions-heading', bodyHtml: `<div class="v2-field"><label for="chmod-octal-input">${escapeHtml(t('Permissions (octal)'))}</label><input id="chmod-octal-input" name="permissions" class="v2-mono" type="text" dir="ltr" inputmode="numeric" autocomplete="off" spellcheck="false" pattern="0?[0-7]{3}" maxlength="4" value="0640"${disabled ? ' disabled' : ''} aria-describedby="v2-file-permission-help"><span id="v2-file-permission-help" class="v2-field__help">${escapeHtml(t('Maximum 0640 for files and 0750 for folders; world-writable modes are refused.'))}</span></div>` })
}

/** File bodies use the existing account file controller; core mounts the surrounding shell. */
export function renderV2FilesPage(t: Translate, props: V2FilesPageProps): string {
  const surface = scopePrimaryPanelFacts(props.surface, props.authority)
  props = { ...props, surface }
  const account = props.surface.account
  const trash = props.surface.activeRoute === '/files/trash'
  const title = t(trash ? msgctxt('xpanel-files', 'Trash') : 'File manager')
  const route = trash ? '/files/trash' : '/files/manager'
  const head = pageHeader(t, { breadcrumb: [{ label: t('Files') }, { label: title }], route, title, description: t('Chroot enforced inside account home directory (0750 home, 0640 files, symlink traversal blocked).') })
  const disabled = !account || props.authority?.presentation === 'read-only' || !props.canManage
  const actions = `${button(t('Refresh files'), { 'data-action': 'refresh-files' }, disabled)}${trash ? '' : `${button(t('New File'), { 'data-action': 'new-file' }, disabled)}${button(t('New Folder'), { 'data-action': 'new-folder' }, disabled)}${button(t('Upload File'), { 'data-action': 'upload-file' }, disabled, true)}<input type="file" data-file-upload hidden${disabled ? ' disabled' : ''}>`}${button(t('Empty trash'), { 'data-action': 'empty-trash' }, disabled)}`
  const location = trash ? '' : `<nav class="v2-file-location" aria-label="${escapeHtml(t('Current directory'))}">${button(t('Parent folder'), { 'data-action': 'parent-directory' }, true)}<span><bdi dir="ltr" class="v2-mono" data-file-home-path>${escapeHtml(account?.home ?? t('Not read'))}</bdi><span aria-hidden="true">/</span><bdi dir="ltr" class="v2-mono" data-file-current-path></bdi></span></nav>`
  const views = `<nav class="v2-file-views" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'File manager views')))}"><a href="/files/manager"${trash ? '' : ' aria-current="page"'}>${icon('folder', 16)}${escapeHtml(t('Files'))}</a><a href="/files/trash"${trash ? ' aria-current="page"' : ''}>${trashIcon}${escapeHtml(t(msgctxt('xpanel-files', 'Trash')))}</a></nav>`
  const empty = trash ? `<div data-trash-empty hidden><h2>${escapeHtml(t('The trash is empty'))}</h2><p>${escapeHtml(t('Files you move to the trash stay here until you restore them or delete them for good.'))}</p></div>` : ''
  const tree = trash ? '' : card({ title: t('Folders'), titleId: 'v2-file-tree-heading', bodyHtml: `<ul class="v2-file-tree"><li>${icon('home', 16)}${technical(account?.home ?? t('Not read'))}<ul>${(props.surface.files ?? []).filter(file => file.kind === 'folder' && !file.trashed).map(file => `<li>${icon('folder', 16)}${technical(file.name)}</li>`).join('')}</ul></li></ul><p class="v2-field__help">${escapeHtml(t(msgctxt('theme:v2', 'Open a folder from the file list.')))}</p>` })
  const unsupported = trash ? '' : `<div class="v2-file-actions" data-wiring="soon" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Unavailable file actions')))}">${['Copy', 'Move', 'Compress', 'Extract'].map(label => button(t(label), { 'data-capability-unavailable': true }, true)).join('')}</div>`
  return `${head}<div class="v2-files" data-file-manager="${trash ? 'trash' : 'browse'}" data-section="jailed-file-manager" ${account ? `data-account-username="${escapeHtml(account.username)}"` : ''}${disabled ? ' data-read-only="true"' : ''}><div class="v2-file-controls">${views}${disabled ? notice(t, { tone: 'warn', text: t('File operations are unavailable.') }) : ''}<div class="v2-file-toolbar">${actions}</div>${location}${unsupported}<p data-file-status role="status" aria-live="polite" hidden></p></div><div class="v2-file-browser">${tree}${card({ title: title, titleId: 'v2-file-list-heading', flush: true, bodyHtml: `${fileTable(t, props, trash)}${empty}` })}</div>${trash ? '' : `<div class="v2-file-details">${editor(t, disabled)}${permissionPolicy(t, disabled)}</div>`}<p class="v2-field__help">${escapeHtml(t('Files up to 2 MB. The upload stays inside this account.'))}</p>${fileWorkspaceTemplates()}</div>`
}

export { renderV2DirectoryPrivacyPage, type V2DirectoryPrivacyPageProps } from './privacy.ts'
export { V2_FILES_CSS } from './styles.ts'
