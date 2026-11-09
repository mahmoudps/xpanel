import type { Translate } from '../../../../../i18n.ts'
import { SERVER_OPS_API, SERVER_OPS_CARDS, type ServerOpsCardId, type ServerOpsField } from '@xpanel/core'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'

export const WHM_SERVER_OPS_ROUTES = ['/whm/server/networking', '/whm/server/role', '/whm/server/cron', '/whm/server/upgrade', '/whm/dns/more', '/whm/domains', '/whm/email/quality', '/whm/services/dns', '/whm/services/ftp', '/whm/services/certificates', '/whm/panel/notifications'] as const
export const WHM_SERVER_OPS_CSS = `.v2-server-ops,.v2-server-ops__form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-server-ops :is(p,dl,dd){margin:0}
.v2-server-ops__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-server-ops__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-server-ops__check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-server-ops__scroll{overflow:auto;min-inline-size:0;max-inline-size:100%}
.v2-server-ops__scroll table{inline-size:100%;border-collapse:collapse}
.v2-server-ops__scroll :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere;border-block-end:1px solid var(--line)}
.v2-server-ops [hidden]{display:none!important}
@media(max-width:600px){.v2-server-ops__fields{grid-template-columns:minmax(0,1fr)}}
`

/** V2 cards of the server operation tools, with the hooks the shared client binds. */
export function renderV2ServerOps(t: Translate, ids: readonly ServerOpsCardId[], canManage: boolean, canRead = true): string {
  const e = (value: string): string => escapeHtml(t(value))
  const control = (id: string, field: ServerOpsField): string => {
    const key = `whm-ops-${id}-${field.name}`
    if (field.kind === 'check') return `<div><label class="v2-server-ops__check"><input id="${key}" type="checkbox" name="${escapeHtml(field.name)}" disabled> ${e(field.label)}</label>${field.help ? `<p class="v2-muted">${e(field.help)}</p>` : ''}</div>`
    return formField({ id: key, label: t(field.label), ...(field.help ? { help: t(field.help) } : {}), control: field.kind === 'select'
      ? { kind: 'select', name: field.name, disabled: true, options: (field.choices ?? []).map(([value, label]) => ({ value, label: t(label) })) }
      : { kind: 'input', name: field.name, disabled: true, ...(field.technical ? { dir: 'ltr' as const, mono: true, spellcheck: false } : {}), ...(field.maxLength ? { maxlength: field.maxLength } : {}), ...(field.placeholder ? { placeholder: field.placeholder } : {}) } })
  }
  const body = ids.map(id => {
    const spec = SERVER_OPS_CARDS[id]
    const table = spec.columns ? `<div class="v2-server-ops__scroll" role="region" tabindex="0" aria-label="${e(spec.title)}"><table><caption class="v2-sr">${e(spec.title)}</caption><thead><tr>${spec.columns.map(title => `<th scope="col">${e(title)}</th>`).join('')}</tr></thead><tbody data-server-ops-rows><tr><td colspan="${spec.columns.length}">${e(msgid('Not read'))}</td></tr></tbody></table></div>` : ''
    const fields = spec.fields.length ? `<div class="v2-server-ops__fields">${spec.fields.map(field => control(id, field)).join('')}</div>` : ''
    const job = spec.jobLink ? `<a class="v2-btn" href="/whm/jobs" data-server-ops-job hidden>${e(msgid('Open job'))}</a>` : ''
    return card({ id: `v2-server-ops-${id}`, title: t(spec.title), titleId: `v2-server-ops-${id}-heading`, bodyHtml: `<div class="v2-server-ops__form" role="group" aria-labelledby="v2-server-ops-${id}-heading" data-server-ops="${id}" data-server-ops-api="${SERVER_OPS_API[id]}" data-server-ops-can-read="${canRead}" data-server-ops-can-manage="${canManage}"><p class="v2-muted">${e(spec.lede)}</p>${fields}${table}<p role="status" data-state="unread" data-server-ops-status>${e(msgid('Not read'))}</p><div class="v2-server-ops__actions"><button type="button" class="v2-btn${spec.danger ? ' v2-btn--danger' : ' v2-btn--primary'}" data-server-ops-submit disabled>${e(spec.submit)}</button>${job}</div></div>` })
  }).join('')
  return `<div class="v2-server-ops">${body}</div>`
}
