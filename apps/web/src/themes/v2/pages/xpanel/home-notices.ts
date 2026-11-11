import { accountWarningMessage, accountWarnings, ONBOARDING_TASKS } from '../../../../account-notices.ts'
import type { PanelSurfaceProps } from '../../../contract.ts'
import type { Translate } from '../../../../i18n.ts'
import { escapeHtml } from '../../html.ts'
import { icon } from '../../icons.ts'

/** Unread marker with measured warnings, then Getting Started until it is dismissed. Facts come from core. */
export function renderV2HomeNotices(props: PanelSurfaceProps, t: Translate, routes: ReadonlySet<string>): string {
  const warnings = accountWarnings({ diskBytes: props.usage?.diskBytes, bandwidthBytes: props.usage?.bandwidthMonth?.totalBytes, diskMb: props.plan?.resources.diskMb, bandwidthMb: props.plan?.resources.bandwidthMbMonth }, props.personal)
  const list = warnings.map(item => `<li data-account-warning="${item.id}" data-level="${item.level}">${escapeHtml(t(accountWarningMessage(item), { percent: item.percent }))}</li>`).join('')
  const notices = `<section class="v2-card v2-home-notices" data-account-notices aria-labelledby="v2-home-notices-heading"><h2 id="v2-home-notices-heading">${warnings.length ? icon('alert', 18) : ''}${escapeHtml(t('Notifications'))} <span class="v2-home-notices__count" data-account-notices-count data-account-notices-base="${warnings.length}"${warnings.length ? '' : ' hidden'}>${warnings.length}</span></h2>${list ? `<ul>${list}</ul>` : `<p class="v2-muted">${escapeHtml(t('No warning for this account. Unmeasured usage shows no warning.'))}</p>`}</section>`
  if (props.personal === undefined || props.personal.onboardingDismissed) return notices
  const tasks = ONBOARDING_TASKS.filter(task => routes.has(task.route)).map(task => `<li><a href="${task.route}">${escapeHtml(t(task.label))}</a></li>`).join('')
  return `${notices}<section class="v2-card v2-home-notices" data-onboarding aria-labelledby="v2-home-onboarding-heading"><h2 id="v2-home-onboarding-heading">${escapeHtml(t('Getting started'))}</h2><ul>${tasks}</ul><div><button type="button" class="v2-btn" data-onboarding-dismiss disabled>${escapeHtml(t('Dismiss permanently'))}</button></div></section>`
}

export const V2_HOME_NOTICES_CSS = `.v2-panel-home .v2-home-notices{display:flex;flex-flow:row wrap;align-items:center;gap:var(--space-1) var(--space-2);min-inline-size:0;padding:12px var(--space-2);border-radius:12px}
.v2-panel-home .v2-home-notices>h2{display:inline-flex;align-items:center;gap:var(--space-1);font-size:16px;line-height:1.35}
.v2-panel-home .v2-home-notices>:is(p,ul){flex:1 1 280px;min-inline-size:0;font-size:13px;line-height:1.6}
.v2-panel-home .v2-home-notices[data-onboarding]>ul{flex-flow:row wrap;gap:0 var(--space-3);padding:0;list-style:none}
.v2-panel-home .v2-home-notices[data-onboarding] a,.v2-panel-home .v2-home-notices button{display:inline-flex;align-items:center;min-inline-size:44px;min-block-size:44px;font-weight:600;transition-property:background-color,border-color,color,box-shadow,opacity,transform;transition-duration:140ms;transition-timing-function:ease-out}
.v2-panel-home .v2-home-notices :is(h2,p,ul){margin:0}
.v2-panel-home .v2-home-notices ul{display:flex;flex-direction:column;gap:var(--space-1);padding-inline-start:var(--space-2)}
.v2-panel-home .v2-home-notices:has([data-account-warning]){border-color:var(--warn-line);background:var(--warn-soft);box-shadow:none}
.v2-panel-home .v2-home-notices:has([data-account-warning])>h2>.v2-icon{color:var(--warn)}
.v2-panel-home .v2-home-notices>ul:has([data-account-warning]){flex-flow:row wrap;gap:var(--space-1) var(--space-3);padding:0;list-style:none}
.v2-panel-home .v2-home-notices li[data-account-warning]{font-weight:600;color:var(--warn);font-variant-numeric:tabular-nums}
.v2-panel-home .v2-home-notices li[data-level=critical]{color:var(--bad)}
.v2-panel-home .v2-home-notices[hidden],.v2-panel-home .v2-home-notices__count[hidden]{display:none}
.v2-panel-home .v2-home-notices__count{display:inline-flex;align-items:center;justify-content:center;min-inline-size:24px;padding-inline:var(--space-1);border-radius:8px;background:var(--bad);color:var(--surface);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
@media(prefers-reduced-motion:reduce){.v2-panel-home .v2-home-notices[data-onboarding] a,.v2-panel-home .v2-home-notices button{transition-duration:0ms}}`
