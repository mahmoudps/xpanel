import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml, xpTemplate } from '../../../html.ts'
import { WHM_ACCOUNT_TOOLS_CSS } from '../account-tools/common.ts'

export function recoverySteps(t: Translate, marker: 'restore-more' | 'backup-files', steps: readonly (readonly [string, string])[]): string {
  return `<ol class="v2-recovery__steps" data-${marker}-steps aria-label="${escapeHtml(t(msgid('Restore steps')))}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><span class="v2-recovery__step-number" aria-hidden="true">${index + 1}</span><span>${escapeHtml(t(label))}</span></li>`).join('')}</ol>`
}

/** Exactly the selected theme's templates consumed by the component-restore controller. */
export function restoreMoreTemplates(): string {
  const technical = (name: string) => `<bdi dir="ltr" data-xp-slot="${name}"></bdi>`
  return xpTemplate('restore-more-archives', `<tr><td>${technical('created')}</td><td>${technical('archive')}</td><td>${technical('bytes')}</td><td data-xp-slot="integrity"></td><td><button type="button" class="v2-btn" data-xp-slot="open"></button></td></tr>`)
    + xpTemplate('restore-more-components', '<tr><td data-xp-slot="name"></td><td data-xp-slot="contents"></td><td data-xp-slot="action"></td></tr>')
    + xpTemplate('restore-more-mailboxes', `<tr><td><input type="checkbox" data-xp-slot="select"></td><td>${technical('address')}</td><td>${technical('messages')}</td><td>${technical('bytes')}</td><td data-xp-slot="state"></td></tr>`)
    + xpTemplate('restore-more-review', `<tr><td>${technical('path')}</td><td>${technical('bytes')}</td></tr>`)
    + xpTemplate('restore-more-results', `<tr><td>${technical('path')}</td><td data-xp-slot="result"></td><td data-xp-slot="reason"></td></tr>`)
    + xpTemplate('restore-more-empty', '<tr><td data-xp-slot="message"></td></tr>')
    + xpTemplate('restore-more-link', '<a class="v2-btn" href="/whm/backups/files" data-xp-slot="label"></a>')
}

export const WHM_RECOVERY_TOOLS_CSS = WHM_ACCOUNT_TOOLS_CSS + `
.v2-recovery__grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-recovery__column,.v2-recovery__group{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-recovery__steps{display:flex;flex-wrap:wrap;list-style:none;padding:0;gap:var(--space-2)}
.v2-recovery__steps>li{display:flex;flex:1 1 150px;align-items:center;gap:var(--space-1);color:var(--muted)}
.v2-recovery__step-number{display:flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;flex:none;border:1px solid var(--line-strong);border-radius:50%;font-variant-numeric:tabular-nums}
.v2-recovery__steps>li[aria-current=step]{color:var(--text);font-weight:600}
.v2-recovery__steps>li[aria-current=step]>.v2-recovery__step-number{border-color:var(--accent-fill);background:var(--accent-fill);color:var(--on-accent)}
.v2-recovery__rules{display:flex;flex-direction:column;gap:var(--space-2);padding-inline-start:var(--space-2);line-height:1.7}
.v2-recovery-tools :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-recovery-tools td input[type=checkbox]{margin:0;inline-size:20px;block-size:20px}
.v2-recovery-tools :is(td,dd,bdi){overflow-wrap:anywhere}
.v2-recovery-tools [data-acct-convert-facts]:empty{display:none}
.v2-recovery-tools [hidden]{display:none}
@media(max-width:1000px){.v2-recovery__grid{grid-template-columns:minmax(0,1fr)}}`
