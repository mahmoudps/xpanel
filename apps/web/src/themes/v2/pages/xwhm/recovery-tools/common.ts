import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml, xpTemplate } from '../../../html.ts'
import { icon } from '../../../icons.ts'
import { WHM_ACCOUNT_TOOLS_CSS } from '../account-tools/common.ts'
import { whmPolish } from '../monitoring/common.ts'
import { phoneRows, type PhoneRow } from '../lifecycle/shared.ts'

/** Marks a recovery table for the two-column phone rows: which cell is the row name and which value sits opposite it.
 *  These pages carry no style attribute, so the row templates name their other cells with data-phone-label. */
export const phoneTable = (tableHtml: string, phone: PhoneRow): string => tableHtml.replace('<table>', () => `<table${phone.value ? ` data-phone-value="${phone.value}"` : ''}${phone.name ? ` data-phone-name="${phone.name}"` : ''}>`)

/** The column name a stacked phone cell shows above its value; absent without a translator. */
export const phoneLabel = (t: Translate | undefined, label: string): string => t ? ` data-phone-label="${escapeHtml(t(label))}"` : ''

export function recoverySteps(t: Translate, marker: 'restore-more' | 'backup-files', steps: readonly (readonly [string, string])[]): string {
  return `<ol class="v2-recovery__steps" data-${marker}-steps aria-label="${escapeHtml(t(msgid('Restore steps')))}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><span class="v2-recovery__step-number" aria-hidden="true">${index + 1}</span><span>${escapeHtml(t(label))}</span></li>`).join('')}</ol>`
}

/** Standing rules of a recovery workflow: each line carries a check mark, never a state. */
export const recoveryRules = (t: Translate, rules: readonly string[]): string =>
  `<ul class="v2-recovery__rules">${rules.map(rule => `<li>${icon('check', 16)}<span>${escapeHtml(t(rule))}</span></li>`).join('')}</ul>`

/** Exactly the selected theme's templates consumed by the component-restore controller. */
export function restoreMoreTemplates(t?: Translate): string {
  const technical = (name: string) => `<bdi dir="ltr" data-xp-slot="${name}"></bdi>`
  const label = (text: string): string => phoneLabel(t, text)
  return xpTemplate('restore-more-archives', `<tr><td${label(msgid('Created (UTC)'))}>${technical('created')}</td><td>${technical('archive')}</td><td${label(msgid('Size'))}>${technical('bytes')}</td><td data-xp-slot="integrity"></td><td><button type="button" class="v2-btn" data-xp-slot="open"></button></td></tr>`)
    + xpTemplate('restore-more-components', `<tr><td data-xp-slot="name"></td><td data-xp-slot="contents"></td><td data-xp-slot="action"${label(msgid('Restore here'))}></td></tr>`)
    + xpTemplate('restore-more-mailboxes', `<tr><td><input type="checkbox" data-xp-slot="select"></td><td>${technical('address')}</td><td${label(msgid('Messages'))}>${technical('messages')}</td><td${label(msgid('Size'))}>${technical('bytes')}</td><td data-xp-slot="state"${label(msgid('Mailbox now'))}></td></tr>`)
    + xpTemplate('restore-more-review', `<tr><td>${technical('path')}</td><td>${technical('bytes')}</td></tr>`)
    + xpTemplate('restore-more-results', `<tr><td>${technical('path')}</td><td data-xp-slot="result"></td><td data-xp-slot="reason"${label(msgid('Reason'))}></td></tr>`)
    + xpTemplate('restore-more-empty', '<tr><td data-xp-slot="message"></td></tr>')
    + xpTemplate('restore-more-link', '<a class="v2-btn" href="/whm/backups/files" data-xp-slot="label"></a>')
}

export const WHM_RECOVERY_TOOLS_CSS = WHM_ACCOUNT_TOOLS_CSS + `
.v2-recovery__grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-recovery__column,.v2-recovery__group{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-recovery__steps{display:flex;flex-wrap:wrap;list-style:none;padding:0;gap:var(--space-2)}
.v2-recovery__steps>li{display:flex;flex:1 1 150px;align-items:center;gap:var(--space-1);color:var(--muted)}
.v2-recovery__step-number{display:flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;flex:none;border:1px solid var(--line-strong);border-radius:50%;font-variant-numeric:tabular-nums}
.v2-recovery__steps>li[aria-current=step]{color:var(--text);font-weight:600}
.v2-recovery__steps>li[aria-current=step]>.v2-recovery__step-number{border-color:var(--accent-fill);background:var(--accent-fill);color:var(--on-accent)}
.v2-recovery__rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px 24px;list-style:none;padding:0;font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-recovery__rules>li{display:flex;align-items:flex-start;gap:8px}
.v2-recovery__rules>li>.v2-icon{flex:none;margin-block-start:2px;color:var(--ok)}
.v2-recovery__steps{gap:8px 16px;padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--sunken);font-size:13px}
.v2-recovery__steps>li:not(:last-child)::after{content:"";flex:1 1 16px;min-inline-size:16px;block-size:1px;background:var(--line-strong)}
.v2-recovery__step-number{background:var(--surface)}
.v2-recovery-tools>p[role=status]:not([data-state=failed],[data-state=error]),.v2-recovery-tools>[data-acct-convert-empty]{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--sunken);color:var(--text-2);font-size:13px;line-height:1.6}
.v2-recovery-tools>[data-acct-convert-empty]{display:flex;flex-direction:column;gap:8px;border-style:dashed;background:transparent;text-align:center;align-items:center;padding:24px 16px}
.v2-recovery-tools .v2-card__body>.v2-account-tool__field{max-inline-size:480px}
.v2-recovery-tools :is(.v2-account-tool__facts,.v2-account-tool__fields){grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}
.v2-recovery__steps>li{flex-basis:120px}
.v2-recovery-tools .v2-account-tool__scroll{border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-recovery-tools table{inline-size:100%;border-collapse:collapse}
.v2-recovery-tools thead th{white-space:nowrap;overflow-wrap:normal}
.v2-recovery-tools td[colspan]{padding:24px 16px;text-align:center;color:var(--muted)}
.v2-recovery-tools td{font-variant-numeric:tabular-nums}
.v2-recovery-tools :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-recovery-tools td input[type=checkbox]{margin:0;inline-size:20px;block-size:20px}
.v2-recovery-tools :is(td,dd,bdi){overflow-wrap:anywhere}
.v2-recovery-tools [data-acct-convert-facts]:empty{display:none}
.v2-recovery-tools [hidden]{display:none}
${whmPolish('.v2-recovery-tools')}@media(max-width:1000px){.v2-recovery__grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){${phoneRows('.v2-recovery-tools .v2-account-tool__scroll>table')}
.v2-recovery-tools .v2-account-tool__scroll>table>tbody>tr:nth-child(n)>[data-phone-label]:nth-child(n)::before{content:attr(data-phone-label)}
.v2-recovery-tools .v2-account-tool__scroll td:has(>input[type=checkbox]){min-block-size:24px}
.v2-recovery-tools .v2-account-tool__facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-recovery__steps>li:not(:last-child)::after{display:none}.v2-recovery-tools .v2-account-tool__actions>:is(.v2-btn,button){flex:1 1 auto}}`
