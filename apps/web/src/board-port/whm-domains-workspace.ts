import type { Account } from '@xpanel/core'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface WhmDomainsWorkspaceInput {
  locale: Locale
  accounts: readonly Pick<Account, 'id' | 'username' | 'home' | 'status'>[]
  canManage: boolean
}

/** Functional editor inside the approved WHM domain page; the page retains its list and supplements. */
export function renderWhmDomainsWorkspace({ locale, accounts, canManage }: WhmDomainsWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const field = (id: string, label: string, control: string): string => `<div class="xp-whm-domains__field"><label for="${id}">${label}</label>${control}</div>`
  const text = (id: string, name: string, extra = ''): string => `<input id="${id}" class="xp-input xp-mono" name="${name}" dir="ltr" type="text" disabled ${extra}>`
  const formTag = canManage ? 'form' : 'div'
  return `<section class="xp-whm-domains" data-whm-domains-workspace data-whm-domains-manage="${canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="whm-domains-workspace-heading">
    <style>
    .xp-whm-domains{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-domains :is(h2,h3,p,dl,dd,fieldset){margin:0}.xp-whm-domains__card>:is(h2,h3){font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-whm-domains__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}.xp-whm-domains__fields,.xp-whm-domains__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-inline-size:0}.xp-whm-domains__field,.xp-whm-domains__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-domains :is(label,dt){text-align:start}.xp-whm-domains dt{font-weight:600}.xp-whm-domains dd{overflow-wrap:anywhere;text-align:start}.xp-whm-domains dd>bdi{unicode-bidi:isolate}.xp-whm-domains :is(input,select){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-domains[dir=rtl] :is(input,select)[dir=ltr]{text-align:right}.xp-whm-domains form,.xp-whm-domains fieldset{display:flex;flex-direction:column;gap:24px;min-inline-size:0;padding:0;border:0}.xp-whm-domains__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-whm-domains button{min-block-size:44px}.xp-whm-domains [data-whm-domain-status]{overflow-wrap:anywhere}.xp-whm-domains [hidden]{display:none}.xp-whm-domains :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
    @media(min-width:601px){.xp-whm-domains__card{padding:24px}}@media(max-width:639px){.xp-whm-domains__fields,.xp-whm-domains__facts{grid-template-columns:minmax(0,1fr)}.xp-whm-domains__actions>*{flex:1 1 auto}}
    .xp-whm-domains .xp-whm-domains__form{display:flex;flex-direction:column;gap:24px;min-inline-size:0;padding:0;border:0}
    </style>
    <section class="xp-whm-domains__card">
      <h2 id="whm-domains-workspace-heading">${t('Manage account domains')}</h2>
      <p>${t('Read an authorized account before changing its saved domain configuration. Website serving, DNS and TLS require separate verification.')}</p>
      <p class="xp-help" data-whm-domain-permission${canManage ? ' hidden' : ''}>${t('Read-only configuration. Domain management permission is required to edit.')}</p>
      <div class="xp-whm-domains__fields">
        ${field('whm-domain-workspace-account', t('Account'), `<select id="whm-domain-workspace-account" class="xp-select" data-whm-domain-account${canManage ? '' : ' disabled'}>${accounts.map(account => `<option value="${escapeHtml(account.id)}" data-home="${escapeHtml(account.home)}" data-status="${escapeHtml(account.status)}">${escapeHtml(account.username)}</option>`).join('')}</select>`)}
        ${field('whm-domain-workspace-domain', t('Domain'), '<select id="whm-domain-workspace-domain" class="xp-select xp-mono" data-whm-domain-selected dir="ltr" disabled></select>')}
      </div>
      <p class="xp-help" data-whm-domain-status data-state="unread" role="status">${t('Saved domain configuration has not been read.')}</p>
      <div class="xp-whm-domains__actions"><button type="button" class="xp-btn" data-whm-domain-refresh${canManage ? '' : ' disabled'}>${t('Read saved configuration')}</button><button type="button" class="xp-btn" data-whm-domain-reload disabled>${t(msgctxt('whm-domains-workspace', 'Discard draft and reload'))}</button></div>
      <dl class="xp-whm-domains__facts" data-whm-domain-limits></dl>
      <p class="xp-help" data-whm-domain-application>${t('Native serving, DNS and TLS have not been verified.')}</p>
    </section>
    <section class="xp-whm-domains__card" data-whm-domain-details hidden>
      <h3>${t('Selected domain')}</h3>
      <dl class="xp-whm-domains__facts" data-whm-domain-facts></dl>
      <${formTag} class="xp-whm-domains__form" data-whm-domain-settings>
        ${field('whm-domain-document-root', t('Document root'), text('whm-domain-document-root', 'docRoot', 'maxlength="4096" required'))}
        <p class="xp-help">${t('Use an account-relative folder or an absolute path inside its home. Changing this setting does not move files. Aliases inherit the parent folder.')}</p>
        <div class="xp-whm-domains__actions"><button class="xp-btn xp-btn--primary" type="submit" data-whm-domain-save-root disabled>${t('Save document root')}</button><button class="xp-btn" type="button" data-whm-domain-cancel disabled>${t(msgctxt('whm-domains-workspace', 'Cancel editing'))}</button><button class="xp-btn" type="button" data-whm-domain-remove disabled>${t('Remove saved domain')}</button></div>
      </${formTag}>
      <p class="xp-help" data-whm-domain-removal-reason></p>
    </section>
    <section class="xp-whm-domains__card">
      <h3>${t('Create a domain')}</h3>
      <${formTag} class="xp-whm-domains__form" data-whm-domain-create>
        <div class="xp-whm-domains__fields">
          ${field('whm-domain-create-kind', t('Kind'), `<select id="whm-domain-create-kind" class="xp-select" name="kind" disabled><option value="addon">${t('Addon domain')}</option><option value="subdomain">${t('Subdomain')}</option><option value="alias">${t('Alias')}</option></select>`)}
          ${field('whm-domain-create-name', t('Full domain name'), text('whm-domain-create-name', 'name', 'maxlength="1024" required autocomplete="off"'))}
        </div>
        <div class="xp-whm-domains__field" data-whm-domain-parent-field hidden><label for="whm-domain-create-parent">${t('Parent domain')}</label><select id="whm-domain-create-parent" class="xp-select xp-mono" name="parentId" dir="ltr" disabled></select></div>
        <div class="xp-whm-domains__fields">
          ${field('whm-domain-create-root', t('Document root'), text('whm-domain-create-root', 'docRoot', 'maxlength="4096"'))}
          ${field('whm-domain-create-site', t('Site type'), `<select id="whm-domain-create-site" class="xp-select" name="siteType" disabled><option value="php">PHP</option><option value="static">${t('Static files')}</option><option value="proxy" disabled>${t('Reverse proxy — separate runtime workflow')}</option><option value="node" disabled>${t('Node — separate runtime workflow')}</option><option value="python" disabled>${t('Python — separate runtime workflow')}</option></select>`)}
        </div>
        <p class="xp-help" data-whm-domain-alias-help hidden>${t('An alias shares the selected parent’s document root and runtime. No independent folder or runtime is submitted.')}</p>
        <p class="xp-help">${t('Leave the root empty for the server default. This creates saved domain configuration; it does not purchase a domain or establish DNS, TLS or serving.')}</p>
        <div class="xp-whm-domains__actions"><button class="xp-btn xp-btn--primary" type="submit" data-whm-domain-create-submit disabled>${t('Review and create domain')}</button><button class="xp-btn" type="button" data-whm-domain-create-cancel disabled>${t('Cancel draft')}</button></div>
      </${formTag}>
    </section>
  </section>`
}
