import { accountWarningMessage, accountWarnings, ONBOARDING_TASKS } from '../../../../account-notices.ts'
import type { PanelSurfaceProps } from '../../../contract.ts'
import type { Translate } from '../../../../i18n.ts'
import { escapeHtml } from '../../html.ts'

/** Unread marker with measured warnings, then Getting Started until it is dismissed. Facts come from core. */
export function renderV2HomeNotices(props: PanelSurfaceProps, t: Translate, routes: ReadonlySet<string>): string {
  const warnings = accountWarnings({ diskBytes: props.usage?.diskBytes, bandwidthBytes: props.usage?.bandwidthMonth?.totalBytes, diskMb: props.plan?.resources.diskMb, bandwidthMb: props.plan?.resources.bandwidthMbMonth }, props.personal)
  const list = warnings.map(item => `<li data-account-warning="${item.id}" data-level="${item.level}">${escapeHtml(t(accountWarningMessage(item), { percent: item.percent }))}</li>`).join('')
  const notices = `<section class="v2-card v2-home-notices" data-account-notices aria-labelledby="v2-home-notices-heading"><h2 id="v2-home-notices-heading">${escapeHtml(t('Notifications'))} <span class="v2-home-notices__count" data-account-notices-count data-account-notices-base="${warnings.length}"${warnings.length ? '' : ' hidden'}>${warnings.length}</span></h2>${list ? `<ul>${list}</ul>` : `<p class="v2-muted">${escapeHtml(t('No warning for this account. Unmeasured usage shows no warning.'))}</p>`}</section>`
  if (props.personal === undefined || props.personal.onboardingDismissed) return notices
  const tasks = ONBOARDING_TASKS.filter(task => routes.has(task.route)).map(task => `<li><a href="${task.route}">${escapeHtml(t(task.label))}</a></li>`).join('')
  return `${notices}<section class="v2-card v2-home-notices" data-onboarding aria-labelledby="v2-home-onboarding-heading"><h2 id="v2-home-onboarding-heading">${escapeHtml(t('Getting started'))}</h2><ul>${tasks}</ul><div><button type="button" class="v2-btn" data-onboarding-dismiss disabled>${escapeHtml(t('Dismiss permanently'))}</button></div></section>`
}

export const V2_HOME_NOTICES_CSS = `.v2-panel-home .v2-home-notices{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-home .v2-home-notices :is(h2,p,ul){margin:0}
.v2-panel-home .v2-home-notices ul{display:flex;flex-direction:column;gap:var(--space-1);padding-inline-start:var(--space-2)}
.v2-panel-home .v2-home-notices[hidden],.v2-panel-home .v2-home-notices__count[hidden]{display:none}
.v2-panel-home .v2-home-notices__count{display:inline-flex;align-items:center;justify-content:center;min-inline-size:24px;padding-inline:var(--space-1);border-radius:var(--radius-pill);background:var(--bad);color:var(--surface);font-size:13px}`
