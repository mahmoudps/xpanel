import type { Translate } from '../../../../../i18n.ts'
import { HOST_TOOL_CARDS, hostToolSpec, type HostToolCardId, type HostToolField } from '@xpanel/core'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { whmPolish } from '../monitoring/common.ts'

export const WHM_HOST_TOOLS_ROUTES = ['/whm/server/cron', '/whm/server/terminal', '/whm/server/networking', '/whm/server/setup', '/whm/services/more', '/whm/software/php', '/whm/monitoring/logs'] as const
export const WHM_HOST_TOOLS_CSS = `.v2-host-tools,.v2-host-tools__form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-host-tools .v2-btn{min-inline-size:var(--target);min-block-size:var(--target);transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out,box-shadow 140ms ease-out,opacity 140ms ease-out,transform 140ms ease-out}
@media(prefers-reduced-motion:reduce){.v2-host-tools .v2-btn,.v2-host-tools__scroll tbody tr{transition:none}}
.v2-host-tools :is(p,dl,dd,pre){margin:0}
.v2-host-tools__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-host-tools dl.v2-host-tools__fields>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-host-tools dl.v2-host-tools__fields dt{font-size:12px;color:var(--muted)}
.v2-host-tools [data-host-tool-fact],.v2-host-tools__scroll td{font-variant-numeric:tabular-nums}
.v2-host-tools__fields textarea{inline-size:100%;box-sizing:border-box}
.v2-host-tools__actions,.v2-host-tools [data-host-tool-row-actions]{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-host-tools__actions{gap:var(--space-2)}
.v2-host-tools__check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-host-tools__scroll{overflow:auto;min-inline-size:0;max-inline-size:100%}
@media(min-width:601px){.v2-host-tools__scroll{border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}.v2-host-tools__scroll tbody tr:last-child>:is(th,td){border-block-end:0}.v2-host-tools__scroll tbody tr{transition:background-color 140ms ease-out}.v2-host-tools__scroll tbody tr:hover{background:var(--subtle)}}
.v2-host-tools__scroll table{inline-size:100%;border-collapse:collapse}
.v2-host-tools__scroll :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere;border-block-end:1px solid var(--line)}
.v2-host-tools__scroll thead th{background:var(--subtle);font-size:12px;font-weight:600;color:var(--muted);white-space:normal;overflow-wrap:normal;word-break:normal}
.v2-host-tools pre{max-block-size:320px;overflow:auto;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--code);color:var(--code-text);font-size:13px;font-variant-numeric:tabular-nums;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-host-tools code{display:block;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.v2-host-tools [hidden]{display:none!important}
${whmPolish('.v2-host-tools')}@media(max-width:600px){.v2-host-tools__fields{grid-template-columns:minmax(0,1fr)}}
`

/** V2 cards of the scheduler and host tools, with the hooks the shared client binds. */
export function renderV2HostTools(t: Translate, ids: readonly HostToolCardId[], canManage: boolean): string {
  const e = (value: string): string => escapeHtml(t(value))
  const control = (id: string, field: HostToolField): string => {
    const key = `whm-tool-${id}-${field.name}`, when = field.when ? ` data-host-tool-when="${escapeHtml(`${field.when[0]}:${field.when[1].join(',')}`)}"` : ''
    if (field.kind === 'check') return `<div${when}><label class="v2-host-tools__check"><input id="${key}" type="checkbox" name="${escapeHtml(field.name)}" disabled> ${e(field.label)}</label>${field.help ? `<p class="v2-muted">${e(field.help)}</p>` : ''}</div>`
    const help = field.help ? { help: t(field.help) } : {}
    const body = field.kind === 'select'
      ? formField({ id: key, label: t(field.label), ...help, control: { kind: 'select', name: field.name, disabled: true, ...(field.from ? { hooks: { 'data-host-tool-from': field.from } } : {}), options: (field.choices ?? []).map(([value, label]) => ({ value, label: t(label) })) } })
      : field.kind === 'area'
        ? formField({ id: key, label: t(field.label), ...help, control: { kind: 'textarea', name: field.name, disabled: true, dir: 'ltr', mono: true, spellcheck: false, rows: 4, autocomplete: 'off', ...(field.maxLength ? { maxlength: field.maxLength } : {}) } })
        : formField({ id: key, label: t(field.label), ...help, control: { kind: 'input', type: field.kind === 'password' ? 'password' : 'text', name: field.name, disabled: true, autocomplete: field.kind === 'password' ? 'new-password' : 'off', ...(field.technical || field.kind === 'password' ? { dir: 'ltr' as const, mono: true, spellcheck: false } : {}), ...(field.maxLength ? { maxlength: field.maxLength } : {}), ...(field.placeholder ? { placeholder: field.placeholder } : {}) } })
    return when ? `<div${when}>${body}</div>` : body
  }
  const body = ids.map(id => {
    const spec = HOST_TOOL_CARDS[id], columns = spec.columns ?? [], extra = spec.actions?.length ? 1 : 0
    const table = columns.length ? `<div class="v2-host-tools__scroll" role="region" tabindex="0" aria-label="${e(spec.title)}"><table><caption class="v2-sr">${e(spec.title)}</caption><thead><tr>${columns.map(([title]) => `<th scope="col">${e(title)}</th>`).join('')}${extra ? `<th scope="col">${e(msgid('Actions'))}</th>` : ''}</tr></thead><tbody data-host-tool-rows><tr><td colspan="${columns.length + extra}">${e(msgid('Not read'))}</td></tr></tbody></table></div>` : ''
    const facts = spec.facts?.length ? `<dl class="v2-host-tools__fields">${spec.facts.map(([key, label]) => `<div><dt>${e(label)}</dt><dd><bdi dir="ltr" data-host-tool-fact="${escapeHtml(key)}">${e(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>` : ''
    const fields = spec.fields.length ? `<div class="v2-host-tools__fields" data-host-tool-fields>${spec.fields.map(field => control(id, field)).join('')}</div>` : ''
    const tools = (spec.tools ?? []).map(([label, path]) => `<button type="button" class="v2-btn" data-host-tool-tool="${escapeHtml(path)}" disabled>${e(label)}</button>`).join('')
    const link = spec.link ? `<a class="v2-btn" href="${escapeHtml(spec.link[0])}">${e(spec.link[1])}</a>` : ''
    const submit = spec.submit ? `<button type="button" class="v2-btn${spec.danger ? ' v2-btn--danger' : ' v2-btn--primary'}" data-host-tool-submit disabled>${e(spec.submit)}</button><button type="button" class="v2-btn" data-host-tool-cancel hidden disabled>${e(msgid('Cancel'))}</button>` : ''
    const job = spec.jobLink ? `<a class="v2-btn" href="/whm/jobs" data-host-tool-job hidden>${e(msgid('Open job'))}</a>` : ''
    return card({ id: `v2-host-tool-${id}`, title: t(spec.title), titleId: `v2-host-tool-${id}-heading`, bodyHtml: `<div class="v2-host-tools__form" role="group" aria-labelledby="v2-host-tool-${id}-heading" data-host-tool="${id}" data-host-tool-api="${escapeHtml(spec.api)}" data-host-tool-can-read="${canManage}" data-host-tool-can-manage="${canManage}" data-host-tool-spec="${escapeHtml(hostToolSpec(spec, t))}"><p class="v2-muted">${e(spec.lede)}</p>${facts}${table}${fields}<p role="status" data-state="unread" data-host-tool-status>${e(msgid('Not read'))}</p><code data-host-tool-reveal dir="ltr" hidden></code><div class="v2-host-tools__actions">${submit}${tools}${job}${link}</div>${spec.log ? `<pre data-host-tool-log dir="ltr" tabindex="0" hidden></pre>` : ''}</div>` })
  }).join('')
  return `<div class="v2-host-tools">${body}</div>`
}
