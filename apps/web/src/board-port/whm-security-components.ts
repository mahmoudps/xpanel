import { localeDirection, translator, type Locale } from '../i18n.ts'
type Input = { locale: Locale; canManage?: boolean }
const STYLE = `<style>.xp-security-observation{display:grid;gap:24px;min-inline-size:0}.xp-security-observation :is(p,dl,dd){margin:0}.xp-security-observation__field{display:grid;gap:8px;min-inline-size:0;text-align:start}.xp-security-observation__field>label[for]{box-sizing:border-box;padding-inline-start:var(--xp-control-content-inset,13px)}.xp-security-observation textarea{min-inline-size:0;inline-size:100%;box-sizing:border-box;min-block-size:96px}.xp-security-observation[dir=rtl] [dir=ltr]{text-align:right}.xp-security-observation__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-security-observation button{min-block-size:44px}.xp-security-observation__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.xp-security-observation__fact{display:grid;gap:8px;min-inline-size:0}.xp-security-observation__fact dd{overflow-wrap:anywhere}.xp-security-observation :is(td,th){text-align:start;overflow-wrap:anywhere}.xp-security-observation__technical{direction:ltr;unicode-bidi:isolate;overflow-wrap:anywhere}.xp-security-observation__status{overflow-wrap:anywhere}.xp-security-observation [hidden]{display:none}</style>`
const table = (caption: string, columns: readonly string[], marker: string): string => `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${caption}"><table class="xp-table"><caption class="xp-sr-only">${caption}</caption><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody ${marker}><tr><td colspan="${columns.length}">${caption}</td></tr></tbody></table></div>`

/** Card-body leaves: the host page retains its approved card hierarchy and other controls. */
export function renderWhmSshKeys(input: Input): string {
  const t = translator(input.locale)
  return `${STYLE}<div class="xp-security-observation" data-whm-ssh-keys data-whm-ssh-manage="${input.canManage === true}" dir="${localeDirection(input.locale)}" lang="${input.locale}">
    <p>${t('Existing and fleet keys are protected. Only keys added and tracked by this panel can be removed. Last-use timestamps are unavailable unless separately observed.')}</p>
    ${table(t('Authorized root keys have not been read'), [t('Fingerprint'), t('Type'), t('Comment'), t(msgctxt('whm-security-components', 'Added (UTC)')), t('Last used (UTC)'), t('Action')], 'data-whm-ssh-key-rows')}
    <p data-whm-ssh-opaque hidden></p>
    <div class="xp-security-observation__field"><label for="whm-ssh-public-key">${t('Add a public key')}</label><textarea id="whm-ssh-public-key" class="xp-input" data-whm-ssh-public-key dir="ltr" maxlength="8192" spellcheck="false" autocomplete="off" disabled></textarea></div>
    <div class="xp-security-observation__actions"><button type="button" class="xp-btn" data-whm-ssh-refresh disabled>${t('Read SSH observations')}</button><button type="button" class="xp-btn xp-btn--primary" data-whm-ssh-add disabled>${t('Add public key')}</button></div>
    <p class="xp-security-observation__status xp-help" data-whm-ssh-status data-state="unread" role="status">${t('SSH observations have not been read.')}</p>
  </div>`
}

export function renderWhmSshEffective(input: Input): string {
  const t = translator(input.locale)
  return `<div class="xp-security-observation"><p>${t('These are observed global defaults from sshd -T. Connection-specific Match rules and authentication with a key are not verified here. Saved port configuration is a separate source.')}</p><dl class="xp-security-observation__facts" data-whm-ssh-effective><div class="xp-security-observation__fact"><dt>${t('Observed global policy')}</dt><dd>${t('Not read')}</dd></div></dl></div>`
}

export function renderWhmSshFailures(input: Input): string {
  const t = translator(input.locale)
  return `<div class="xp-security-observation"><div class="xp-security-observation__field"><label for="whm-ssh-window">${t('Show')}</label><select id="whm-ssh-window" class="xp-select" data-whm-ssh-window disabled><option value="24h">${t('Last 24 hours')}</option><option value="7d">${t('Last 7 days')}</option></select></div><p data-whm-ssh-failures-note>${t('Latest 500 trusted sshd journal entries within 24 hours. An observed failure does not establish a ban.')}</p>${table(t('Failed SSH sign-ins have not been read'), [t('Time (UTC)'), t('Address'), t('Username'), t('Method'), t('Count'), t('Result')], 'data-whm-ssh-failure-rows')}</div>`
}

export function renderWhmSecurityEvidence(input: Input): string {
  const t = translator(input.locale)
  return `${STYLE}<div class="xp-security-observation" data-whm-security-evidence lang="${input.locale}" dir="${localeDirection(input.locale)}"><p>${t('Checks show individual host observations. No overall security score or capability qualification is inferred. Configuration values are labeled separately.')}</p><dl class="xp-security-observation__facts" data-whm-security-configuration></dl>${table(t('Security observations have not been read'), [t('Check'), t('State'), t('Observed value')], 'data-whm-security-check-rows')}<div class="xp-security-observation__actions"><button type="button" class="xp-btn" data-whm-security-refresh disabled>${t('Read security observations')}</button></div><p class="xp-security-observation__status xp-help" data-whm-security-status data-state="unread" role="status">${t('Security observations have not been read.')}</p></div>`
}
