import { translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const tr = (locale: Locale) => (message: string, values?: MessageValues): string => escapeHtml(translator(locale)(message, values))
/** A session that cannot save keeps the layout and gets no native form, like every other administrator workspace. */
const formless = (editable: boolean, html: string): string => editable ? html : html.replace(/<form\b([^>]*) novalidate>/g, '<div$1>').replaceAll('</form>', '</div>')
const scroll = (caption: string, headers: string[], rows: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody ${rows}></tbody></table></div>`

/** WHM Force Password Change: rows are painted by WHM_ACCOUNT_ADMIN_CLIENT_BINDING. */
export function renderClassicForcePassword(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  return `<section class="xp-whm-detail-card" data-whm-force-password data-account-admin-editable="${editable}" aria-labelledby="whm-force-password-heading">
    <h2 id="whm-force-password-heading">${t('Force password change')}</h2>
    <p class="xp-help">${t('A selected user is signed out and can only change the password at the next sign-in. The mark stays until the password has been changed.')}</p>
    <template data-xp-template="force-password-row"><tr><td><label class="xp-whm-detail-choice"><input type="checkbox" data-xp-slot="forced"${off}><bdi dir="ltr" class="xp-mono" data-xp-slot="username"></bdi></label></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="domain"></bdi></td><td data-xp-slot="state"></td></tr></template>
    ${scroll(t('Force password change'), [t('Account'), t('Domain'), t('Status')], 'data-force-password-rows')}
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-force-password-all${off}>${t('Select all')}</button><button type="button" class="xp-btn" data-force-password-none${off}>${t('Clear all')}</button><button type="button" class="xp-btn xp-btn--primary" data-force-password-save${off}>${t('Save')}</button></div>
    <p class="xp-whm-detail-status" role="status" data-force-password-status data-state="unread">${t('Accounts have not been read.')}</p>
  </section>`
}

/** WHM Manage Shell Access: one choice per account and a bulk action; the package value stays visible. */
export function renderClassicShellAccess(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  return `<section class="xp-whm-security-tools__card" data-whm-shell-access data-account-admin-editable="${editable}" aria-labelledby="whm-shell-access-heading">
    <h2 id="whm-shell-access-heading">${t('Manage shell access')}</h2>
    <p class="xp-help">${t('Jailed gives a confined shell. Disabled blocks shell sign-in and also stops SFTP. Normal shells are not offered, because they would leave the account confinement.')}</p>
    <template data-xp-template="shell-access-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="username"></bdi></td><td><select class="xp-select" data-xp-slot="shell"${off}><option value="jailed">${t('Jailed')}</option><option value="none">${t('Disabled')}</option></select></td><td data-xp-slot="source"></td></tr></template>
    ${scroll(t('Manage shell access'), [t('Account'), t('Shell'), t('Source')], 'data-shell-rows')}
    <div class="xp-whm-security-tools__actions"><button type="button" class="xp-btn" data-shell-all="jailed"${off}>${t('Jail all accounts')}</button><button type="button" class="xp-btn" data-shell-all="none"${off}>${t('Disable all accounts')}</button></div>
    <p class="xp-whm-detail-status" role="status" data-shell-status data-state="unread">${t('Accounts have not been read.')}</p>
  </section>`
}

/** WHM Rearrange an Account: the destination comes from the home roots this server reports. */
export function renderClassicRearrange(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  const select = (id: string, name: string, label: string, first: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label><select id="${id}" name="${name}" class="xp-select" dir="ltr"${off}><option value="">${first}</option></select></div>`
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-rearrange data-account-admin-editable="${editable}" aria-labelledby="whm-rearrange-heading">
    <h2 id="whm-rearrange-heading">${t('Rearrange an account')}</h2>
    <p class="xp-help">${t('Moves an account to another home root, on the same disk or another one. The account stops serving while its files move, and every copied file is compared before the old directory is removed.')}</p>
    <form class="xp-whm-detail-fields" data-rearrange-form novalidate>
      ${select('whm-rearrange-account', 'account', t('Account'), t('Select an account'))}${select('whm-rearrange-root', 'root', t('Home root'), t('Select a home root'))}
      <label class="xp-whm-detail-choice"><input type="checkbox" name="acknowledge"${off}><span>${t('Scripts with the old home path written in them will break.')}</span></label>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-rearrange-submit${off}>${t('Move account')}</button><button type="button" class="xp-btn" data-rearrange-recover hidden${off}>${t('Settle an interrupted move')}</button></div>
    </form>
    <p class="xp-whm-detail-status" role="status" data-rearrange-status data-state="unread">${t('Accounts have not been read.')}</p>
  </section>`)
}

/** WHM Email All Users: the first step reviews recipients, only the second sends. */
export function renderClassicEmailUsers(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  const input = (id: string, name: string, label: string, attrs: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label><input id="${id}" name="${name}" class="xp-input" autocomplete="off" ${attrs}${off}></div>`
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-email-users data-account-admin-editable="${editable}" aria-labelledby="whm-email-users-heading">
    <h2 id="whm-email-users-heading">${t('Email all users')}</h2>
    <p class="xp-help">${t('One message per account contact address, through the local mail server. Review comes first; nothing is sent until you confirm it.')}</p>
    <form class="xp-whm-detail-fields" data-email-users-form novalidate>
      ${input('whm-email-users-name', 'fromName', t('Sender name'), 'dir="auto" maxlength="80"')}${input('whm-email-users-address', 'fromAddress', t('Sender email'), 'type="email" dir="ltr" maxlength="254"')}${input('whm-email-users-subject', 'subject', t('Subject'), 'dir="auto" maxlength="200"')}
      <div class="xp-whm-detail-field"><label for="whm-email-users-body">${t('Message')}</label><textarea id="whm-email-users-body" name="body" class="xp-input" rows="6" dir="auto" maxlength="20000"${off}></textarea></div>
      <label class="xp-whm-detail-choice"><input type="checkbox" name="includeResellerCustomers"${off}><span>${t("Include resellers' customers")}</span></label>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn" data-email-users-review${off}>${t('Review recipients')}</button><button type="button" class="xp-btn xp-btn--primary" data-email-users-send disabled>${t('Send')}</button></div>
    </form>
    <p class="xp-whm-detail-status" role="status" data-email-users-status data-state="unread">${t('Nothing has been reviewed yet.')}</p>
    <ul data-email-users-recipients hidden></ul>
  </section>`)
}

/** A reseller's view of Account Enhancements: what root gave it, assigned per account. */
export function renderClassicEnhancementAssign(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  const select = (id: string, name: string, label: string, first: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label><select id="${id}" name="${name}" class="xp-select" dir="ltr"${off}><option value="">${first}</option></select></div>`
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-account-enhancements data-account-admin-editable="${editable}" aria-labelledby="whm-account-enhancements-heading">
    <h2 id="whm-account-enhancements-heading">${t('Assign enhancements')}</h2>
    <p class="xp-help">${t('Root sets which enhancements you may assign and how many.')}</p>
    <form class="xp-whm-detail-fields" data-enh-assign-form novalidate>
      ${select('whm-enh-account', 'account', t('Account'), t('Select an account'))}${select('whm-enh-enhancement', 'enhancement', t('Enhancement'), t('Select an enhancement'))}
      <div class="xp-whm-detail-field"><label for="whm-enh-value">${t('Value')}</label><input id="whm-enh-value" name="value" type="number" dir="ltr" min="0" class="xp-input"${off}></div>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-enh-assign${off}>${t('Assign')}</button><button type="button" class="xp-btn" data-enh-unassign${off}>${t('Remove')}</button></div>
    </form>
    <p class="xp-whm-detail-status" role="status" data-enh-assign-status data-state="unread">${t('Enhancements have not been read.')}</p>
  </section>`)
}

/** WHM Home: the administrator's favorites and notifications, filled by WHM_HOME_CLIENT_BINDING. */
export function renderClassicWhmHome(locale: Locale): string {
  const t = tr(locale), box = 'min-width: 0; flex: 1 1 320px; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))'
  const copyStyle = 'margin: 0; font-size: 13px; line-height: 1.6; color: light-dark(#475467,var(--xp-text-secondary,#475467))'
  return `<div style="display: flex; flex-wrap: wrap; align-items: stretch; gap: 16px">
    <section data-whm-favorites aria-labelledby="whm-favorites-heading" style="${box}"><h2 id="whm-favorites-heading" style="margin: 0; font-size: 16px; font-weight: 600">${t('Favorites')}</h2>
      <p data-whm-favorites-empty style="${copyStyle}">${t('Star a page in the quick bar to keep it here and in the side menu.')}</p>
      <ul data-whm-favorites-list style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px"></ul>
      <label class="xp-whm-detail-choice" style="margin-block-start: auto; display: flex; gap: 8px; align-items: center; min-block-size: 44px; font-size: 14px"><input type="checkbox" data-whm-favorites-descriptions checked><span>${t('Show descriptions')}</span></label>
      <p role="status" data-whm-favorites-status hidden style="${copyStyle}"></p></section>
    <section data-whm-inbox aria-labelledby="whm-inbox-heading" style="${box}"><h2 id="whm-inbox-heading" style="margin: 0; font-size: 16px; font-weight: 600">${t('Notifications')}</h2>
      <p role="status" data-whm-inbox-status data-state="unread" style="${copyStyle}">${t('Notifications have not been read.')}</p>
      <ul data-whm-inbox-list style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px"></ul>
      <div style="margin-block-start: auto"><button type="button" class="xp-btn" data-whm-inbox-read disabled>${t('Mark all as read')}</button></div></section>
  </div>`
}

/** WHM Web Template Editor: one editor per page; the host publishes each save. */
export function renderClassicWebTemplates(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  const page = (kind: 'default' | 'suspended', label: string, help: string): string => `<form class="xp-whm-detail-field" data-web-template-form="${kind}" novalidate>
      <h3>${label}</h3><p class="xp-help">${help}</p><p class="xp-help" data-web-template-state></p>
      <label class="xp-sr-only" for="whm-web-template-${kind}">${label}</label><textarea id="whm-web-template-${kind}" name="html" class="xp-input xp-mono" rows="12" dir="ltr" spellcheck="false"${off}></textarea>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Save')}</button><button type="button" class="xp-btn" data-web-template-action="revert"${off}>${t('Revert to last saved')}</button><button type="button" class="xp-btn" data-web-template-action="shipped"${off}>${t('Restore the shipped page')}</button><button type="button" class="xp-btn" data-web-template-action="preview"${off}>${t('Preview')}</button><label class="xp-btn">${t('Upload a file')}<input type="file" accept=".html,.htm,text/html" hidden data-web-template-upload${off}></label></div>
    </form>`
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-web-templates data-account-admin-editable="${editable}" aria-labelledby="whm-web-templates-heading">
    <h2 id="whm-web-templates-heading">${t('Web template editor')}</h2>
    <p class="xp-help">${t('Your pages apply to the accounts you own. %contact% becomes your contact address. Saving publishes the page through the web server.')}</p>
    ${page('default', t('Default website page'), t('Shown for a site with an empty public_html instead of an access error.'))}
    ${page('suspended', t('Suspended account page'), t('Shown while an account is suspended.'))}
    <iframe title="${t('Preview')}" sandbox="" data-web-template-preview hidden style="inline-size:100%;block-size:320px;border:1px solid currentColor"></iframe>
    <p class="xp-whm-detail-status" role="status" data-web-template-status data-state="unread">${t('Templates have not been read.')}</p>
  </section>`)
}

/** WHM Skeleton Directory: files copied once, when an account is created. */
export function renderClassicSkeleton(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-skeleton data-account-admin-editable="${editable}" aria-labelledby="whm-skeleton-heading">
    <h2 id="whm-skeleton-heading">${t('Skeleton directory')}</h2>
    <p class="xp-help">${t('Files here are copied into public_html or public_ftp of each new account you create. Existing accounts do not change.')}</p>
    <template data-xp-template="skeleton-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="path"></bdi></td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="remove"${off}>${t('Remove')}</button></td></tr></template>
    ${scroll(t('Skeleton directory'), [t('File'), t('Size'), t('Actions')], 'data-skeleton-rows')}
    <form class="xp-whm-detail-fields" data-skeleton-form novalidate>
      <div class="xp-whm-detail-field"><label for="whm-skeleton-path">${t('File path')}</label><input id="whm-skeleton-path" name="path" class="xp-input xp-mono" dir="ltr" maxlength="240" placeholder="public_html/index.html" autocomplete="off" spellcheck="false"${off}></div>
      <div class="xp-whm-detail-field"><label for="whm-skeleton-file">${t('File')}</label><input id="whm-skeleton-file" name="file" type="file"${off}></div>
      <div class="xp-whm-detail-field"><label for="whm-skeleton-text">${t('Or type the content')}</label><textarea id="whm-skeleton-text" name="text" class="xp-input xp-mono" rows="4" dir="ltr" spellcheck="false"${off}></textarea></div>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Save file')}</button></div>
    </form>
    <p class="xp-whm-detail-status" role="status" data-skeleton-status data-state="unread">${t('The skeleton has not been read.')}</p>
  </section>`)
}

/** WHM Copy a Locale: a new code starts as a full copy of a locale, then its catalog is uploaded like any other. */
export function renderClassicLocaleCopy(locale: Locale, editable: boolean): string {
  const t = tr(locale), off = editable ? '' : ' disabled'
  return formless(editable, `<section class="xp-whm-detail-card" data-whm-locale-copy data-account-admin-editable="${editable}" aria-labelledby="whm-locale-copy-heading">
    <h2 id="whm-locale-copy-heading">${t('Copy a locale')}</h2>
    <p class="xp-help">${t('A copy holds every string of its source. It joins the panels at the next panel start, and can then be offered and translated like any other language.')}</p>
    <template data-xp-template="locale-copy-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="tag"></bdi></td><td data-xp-slot="name"></td><td><bdi dir="ltr" data-xp-slot="source"></bdi></td><td><bdi dir="ltr" data-xp-slot="messages"></bdi></td><td data-xp-slot="state"></td><td><button type="button" class="xp-btn" data-xp-slot="remove"${off}>${t('Delete')}</button></td></tr></template>
    ${scroll(t('Locale copies'), [t('Code'), t('Name'), t('Source'), t('Strings'), t('Status'), t('Actions')], 'data-locale-copy-rows')}
    <form class="xp-whm-detail-fields" data-locale-copy-form novalidate>
      <div class="xp-whm-detail-field"><label for="whm-locale-copy-source">${t('Source locale')}</label><select id="whm-locale-copy-source" name="source" class="xp-select" dir="ltr"${off}></select></div>
      <div class="xp-whm-detail-field"><label for="whm-locale-copy-tag">${t('New code')}</label><input id="whm-locale-copy-tag" name="tag" class="xp-input xp-mono" dir="ltr" maxlength="35" placeholder="pt-BR" autocomplete="off" spellcheck="false"${off}></div>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary"${off}>${t('Copy locale')}</button></div>
    </form>
    <p class="xp-whm-detail-status" role="status" data-locale-copy-status data-state="unread">${t('Locale copies have not been read.')}</p>
  </section>`)
}
