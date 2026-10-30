import { xpTemplate } from '../../html.ts'

/** Selected-theme dynamic nodes for server/account health, alert delivery and repair previews. */
export function v2WhmDiagnosticTemplates(): string {
  const tags = ['article', 'bdi', 'button', 'details', 'div', 'h3', 'h4', 'header', 'input', 'li', 'p', 'span', 'summary', 'ul'] as const
  const variants: readonly (readonly [string, string, string])[] = [
    ['account-health-row', 'article', 'v2-diagnostic__account'], ['account-selection', 'div', 'v2-diagnostic__selection'], ['account-headline', 'span', 'v2-diagnostic__head'], ['account-checks', 'ul', 'v2-diagnostic__list'], ['account-check', 'li', 'v2-diagnostic__item'], ['account-check-head', 'div', 'v2-diagnostic__head'], ['account-items', 'ul', 'v2-diagnostic__children'],
    ['server-health-item', 'li', 'v2-diagnostic__item'], ['server-health-head', 'div', 'v2-diagnostic__head'], ['server-health-items', 'ul', 'v2-diagnostic__children'], ['repair-item', 'article', 'v2-diagnostic__item'], ['repair-head', 'header', 'v2-diagnostic__head'], ['alert-result', 'li', 'v2-diagnostic__item'], ['alert-head', 'div', 'v2-diagnostic__head'], ['alert-badges', 'span', 'v2-diagnostic__badges'],
    ['evidence', 'pre', 'v2-diagnostic__evidence'], ['actions', 'div', 'v2-diagnostic__actions'], ['note', 'p', 'v2-muted'], ['note-item', 'li', 'v2-muted'], ['link', 'a', 'v2-btn'], ['action', 'button', 'v2-btn'], ['badge', 'span', 'v2-pill v2-pill--neutral'], ['badge-ok', 'span', 'v2-pill v2-pill--ok'], ['badge-critical', 'span', 'v2-pill v2-pill--bad'], ['badge-warn', 'span', 'v2-pill v2-pill--warn'],
  ]
  const node = (name: string, tag: string, cls = '') => xpTemplate('whm-diagnostic-' + name, `<${tag}${cls ? ` class="${cls}"` : ''}${tag === 'input' ? ' type="checkbox"' : ''}${tag === 'button' ? ' type="button"' : ''} data-xp-slot="content">${tag === 'input' ? '' : `</${tag}>`}`)
  const slot = (name: string) => `<span data-xp-slot="${name}"></span>`
  return tags.map(tag => node(tag, tag)).join('') + variants.map(([name, tag, cls]) => node(name, tag, cls)).join('')
    + xpTemplate('whm-diagnostic-threshold-row', `<tr><td>${slot('label')}</td><td>${slot('warning')}</td><td>${slot('problem')}</td></tr>`)
    + xpTemplate('whm-diagnostic-limits-row', `<tr><td>${slot('resource')}</td><td>${slot('plan')}</td><td>${slot('enforced')}</td><td>${slot('comparison')}</td><td>${slot('usage')}</td><td>${slot('percent')}</td></tr>`)
    + xpTemplate('whm-diagnostic-limits-table', `<div class="v2-diagnostic__scroll"><table><thead><tr>${['resource', 'plan', 'enforced', 'comparison', 'usage', 'percent'].map(name => `<th scope="col">${slot('heading-' + name)}</th>`).join('')}</tr></thead><tbody data-xp-slot="rows"></tbody></table></div>`)
    + xpTemplate('whm-diagnostic-alert-delivery-row', `<tr>${['at', 'rule', 'kind', 'channel', 'result'].map(name => `<td>${slot(name)}</td>`).join('')}</tr>`)
    + xpTemplate('whm-diagnostic-alert-delivery-empty', '<tr><td colspan="5" data-xp-slot="message"></td></tr>')
}

export const WHM_DIAGNOSTIC_CLIENT_CSS = `.v2-diagnostic__account{display:flex;align-items:flex-start;gap:var(--space-2);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-diagnostic__account>details{flex:1 1 auto;min-inline-size:0}
.v2-diagnostic__selection{flex:none;display:flex;align-items:center;min-block-size:var(--target)}
.v2-diagnostic__head,.v2-diagnostic__badges,.v2-diagnostic__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);min-inline-size:0}
.v2-diagnostic__head{justify-content:space-between}
.v2-diagnostic__list,.v2-diagnostic__children{display:flex;flex-direction:column;gap:var(--space-2);padding:0;list-style:none;min-inline-size:0}
.v2-diagnostic__children{padding-inline-start:var(--space-2);border-inline-start:2px solid var(--line)}
.v2-diagnostic__children>li{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-diagnostic__item{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-diagnostic__item[data-state=problem],.v2-diagnostic__account[data-state=problem]{border-color:var(--bad-line)}
.v2-diagnostic__evidence{max-block-size:240px;overflow:auto;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:13px/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;text-align:start}
.v2-diagnostic__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-diagnostic__scroll :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere}
.v2-observation [data-whm-repair-start][data-severity=danger]{background:var(--bad);border-color:var(--bad);color:var(--surface)}
`
