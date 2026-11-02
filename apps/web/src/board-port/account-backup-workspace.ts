import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export function renderAccountBackupWorkspace(input: { lang: Locale; accountId: string; username: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const button = (key: string, label: string, primary = false) => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-account-backup-${key} disabled>${label}</button>`
  return `<div class="xp-account-backup" data-account-backup data-account-backup-account="${escapeHtml(input.accountId)}" data-account-backup-username="${escapeHtml(input.username)}" data-account-backup-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">
    <style>.xp-account-backup{display:flex;flex-direction:column;gap:var(--xp-space-section);min-inline-size:0}.xp-account-backup :is(h2,h3,p,dl,dd){margin:0}.xp-account-backup__card{display:flex;flex-direction:column;gap:var(--xp-space-group);padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-md);min-inline-size:0;background:var(--xp-bg-surface)}.xp-account-backup__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field);min-inline-size:0}.xp-account-backup .xp-field,.xp-account-backup__fact{display:flex;flex-direction:column;gap:var(--xp-space-label);min-inline-size:0}.xp-account-backup :is(input[type=text],select){inline-size:100%;min-inline-size:0;min-block-size:var(--xp-hit-target);box-sizing:border-box}.xp-account-backup__actions{display:flex;flex-wrap:wrap;gap:var(--xp-space-field)}.xp-account-backup :is(button,.xp-btn){min-block-size:var(--xp-hit-target)}.xp-account-backup__choice{display:flex;align-items:center;gap:var(--xp-space-label);min-block-size:var(--xp-hit-target)}.xp-account-backup__choice input{margin:0}.xp-account-backup__parts{display:flex;flex-direction:column;gap:var(--xp-space-field);border:0;padding:0;margin:0}.xp-account-backup__parts legend{padding:0;margin-block-end:8px;font-weight:600}.xp-account-backup bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-account-backup [dir=ltr]{text-align:start}.xp-account-backup[dir=rtl] [dir=ltr]{text-align:right}.xp-account-backup .xp-table-wrap{max-inline-size:100%;overflow:auto;min-inline-size:0}.xp-account-backup table{inline-size:100%}.xp-account-backup :is(th,td){text-align:start;overflow-wrap:anywhere}.xp-account-backup [aria-disabled=true]{opacity:.65;pointer-events:none}.xp-account-backup [hidden]{display:none}.xp-account-backup__steps{display:flex;flex-wrap:wrap;gap:var(--xp-space-field);list-style:none;padding:0;margin:0}.xp-account-backup__steps li{display:flex;align-items:center;gap:var(--xp-space-label)}.xp-account-backup__steps b{display:inline-grid;place-items:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border);border-radius:50%}@media(min-width:601px){.xp-account-backup__card{padding:var(--xp-space-card)}}.xp-account-backup__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}</style>
    <section class="xp-account-backup__card" data-workspace-section="backup-create">
      <h2>${t('Back up account files')}</h2>
      <ol class="xp-account-backup__steps"><li><b>1</b>${t('Select parts')}</li><li><b>2</b>${t('Create archive')}</li><li><b>3</b>${t(msgctxt('account-backup-workspace', 'Download'))}</li></ol>
      <fieldset class="xp-account-backup__parts"><legend>${t('Archive contents')}</legend>
        <label class="xp-account-backup__choice"><input type="checkbox" checked disabled><span>${t(msgctxt('account-backup-workspace', 'Home files'))}</span></label>
        <label class="xp-account-backup__choice"><input type="checkbox" disabled><span>${t('Databases — separate database archive service required')}</span></label>
        <label class="xp-account-backup__choice"><input type="checkbox" disabled><span>${t('Mailbox data and mail settings — preserved separately')}</span></label>
      </fieldset>
      <p class="xp-help">${t('Create a real archive of home files, up to 2 GiB. Mailbox data and account mail settings are excluded from this home-file workflow. A host archive is not an off-server disaster recovery copy.')}</p>
      <div class="xp-account-backup__actions">${button('create', t('Create home archive'), true)}${button('refresh', t('Read archives'))}</div>
    </section>
    <section class="xp-account-backup__card" data-workspace-section="backup-history">
      <h2>${t('Archives')}</h2>
      <div class="xp-field"><label for="account-backup-selected">${t('Selected archive')}</label><select id="account-backup-selected" class="xp-select" dir="ltr" data-account-backup-select disabled></select></div>
      <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Account archives')}"><table class="xp-table"><thead><tr>${[t('Archive'), t(msgctxt('account-backup-workspace', 'Created (UTC)')), t('Size (bytes)'), t(msgctxt('account-backup-workspace', 'Integrity'))].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-account-backup-archives data-xp-columns="4"><tr><td colspan="4">${t('Archives have not been read.')}</td></tr></tbody></table></div>
      <template data-xp-template="account-backup-archive-row"><tr><td><bdi dir="ltr" data-xp-slot="file"></bdi></td><td><time dir="ltr" data-xp-slot="created"></time></td><td><bdi dir="ltr" data-xp-slot="bytes"></bdi></td><td><span data-xp-slot="integrity"></span></td></tr></template>
      <template data-xp-template="account-backup-difference-row"><tr><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td><span data-xp-slot="result"></span></td><td><bdi dir="ltr" data-xp-slot="archive-bytes"></bdi></td><td><bdi dir="ltr" data-xp-slot="current-bytes"></bdi></td></tr></template>
      <template data-xp-template="account-backup-empty-row"><tr><td data-xp-slot="message"></td></tr></template>
      <div class="xp-account-backup__actions"><a class="xp-btn" data-account-backup-download aria-disabled="true">${t('Download selected archive')}</a>${button('preview', t('Review restore differences'))}</div>
    </section>
    <section class="xp-account-backup__card" data-workspace-section="backup-diff">
      <h2>${t(msgctxt('account-backup-workspace', 'Review the difference'))}</h2>
      <ol class="xp-account-backup__steps"><li><b>1</b>${t('Select archive')}</li><li><b>2</b>${t('Review changes')}</li><li><b>3</b>${t('Confirm restore')}</li></ol>
      <dl class="xp-account-backup__fields">${[['add',t('Added')],['replace',t('Changed')],['unchanged',t('Unchanged')],['keep',t('Missing from archive (kept)')]].map(([state,label]) => `<div class="xp-account-backup__fact"><dt>${label}</dt><dd data-account-backup-count="${state}">${t(msgctxt('account-backup-workspace', 'Not read'))}</dd></div>`).join('')}</dl>
      <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Restore differences')}"><table class="xp-table"><thead><tr>${[t('Path'),t('Result'),t('In archive (bytes)'),t('Current (bytes)')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-account-backup-differences data-xp-columns="4"><tr><td colspan="4">${t('No archive has been compared.')}</td></tr></tbody></table></div>
      <p class="xp-help" data-account-backup-diff-limit hidden></p><a class="xp-btn" data-account-backup-csv aria-disabled="true">${t('Download full difference list (CSV)')}</a>
    </section>
    <section class="xp-account-backup__card" data-workspace-section="backup-restore-review">
      <h2>${t('Before a restore')}</h2>
      <p>${t('Only reviewed home-file changes are applied. Files absent from the archive and mailbox data/settings are kept. A separate recovery archive is created before replacement. Home restore does not restore the control database or databases.')}</p>
      <div class="xp-field"><label for="account-backup-confirmation">${t('Type the account username to confirm')}: <bdi dir="ltr">${escapeHtml(input.username)}</bdi></label><input id="account-backup-confirmation" class="xp-input" type="text" dir="ltr" autocomplete="off" data-account-backup-confirmation disabled></div>
      <label class="xp-account-backup__choice"><input type="checkbox" data-account-backup-ack disabled><span>${t('I reviewed the actual archive and the proposed changes.')}</span></label>
      <div class="xp-account-backup__actions">${button('restore',t('Restore reviewed home files'),true)}</div>
    </section>
    <p class="xp-help" role="status" data-account-backup-status data-state="unread">${t('Account archives have not been read.')}</p>
  </div>`
}
