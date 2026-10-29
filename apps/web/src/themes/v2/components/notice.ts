import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'
import { icon, type IconName } from '../icons.ts'

export interface NoticeProps {
  tone: Exclude<Tone, 'neutral'>
  /** Bold lead, such as "Not enforced." */
  lead?: string
  text: string
  action?: { label: string; href: string; hooks?: HookAttributes }
  /** Interrupting notices (failed test, risky action) use role="alert"; the default is role="status". */
  urgent?: boolean
  /** Hooks of the controller that dismisses this notice; without them no dismiss button is shown. */
  dismiss?: HookAttributes
  hooks?: HookAttributes
}

const NOTICE_ICONS: Readonly<Record<NoticeProps['tone'], IconName>> = { info: 'info', ok: 'okCircle', warn: 'alert', bad: 'xCircle' }

export function notice(t: Translate, props: NoticeProps): string {
  const action = props.action ? `<a class="v2-notice__action" href="${escapeHtml(props.action.href)}"${hookAttrs(props.action.hooks)}>${escapeHtml(props.action.label)}</a>` : ''
  const dismiss = props.dismiss ? `<button type="button" class="v2-notice__dismiss" aria-label="${escapeHtml(t('Dismiss'))}"${hookAttrs(props.dismiss)}>${icon('x', 16)}</button>` : ''
  return `<div class="v2-notice v2-notice--${props.tone}" role="${props.urgent ? 'alert' : 'status'}"${hookAttrs(props.hooks)}>${icon(NOTICE_ICONS[props.tone])}<div class="v2-notice__body"><p>${props.lead ? `<strong>${escapeHtml(props.lead)}</strong> ` : ''}${escapeHtml(props.text)}</p>${action}</div>${dismiss}</div>`
}

export const NOTICE_CSS = `.v2-notice{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-radius:var(--radius-notice);border:1px solid;font-size:13px;line-height:1.6;color:var(--text)}
.v2-notice>.v2-icon{margin-top:2px}
.v2-notice__body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start}
.v2-notice__body strong{font-weight:600}
.v2-notice__action{display:inline-flex;align-items:center;min-height:var(--target);font-weight:600}
.v2-notice:has(.v2-notice__action){padding-block-end:0}
.v2-notice__dismiss{flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--target);height:var(--target);margin:-10px;margin-inline-start:0;border:0;border-radius:var(--radius-control);background:transparent;cursor:pointer}
.v2-notice__dismiss:hover{background:var(--surface)}
.v2-notice>.v2-icon,.v2-notice__action,.v2-notice__dismiss{color:var(--tone)}
.v2-notice--info{--tone:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.v2-notice--ok{--tone:var(--ok);border-color:var(--ok-line);background:var(--ok-soft)}
.v2-notice--warn{--tone:var(--warn);border-color:var(--warn-line);background:var(--warn-soft)}
.v2-notice--bad{--tone:var(--bad);border-color:var(--bad-line);background:var(--bad-soft)}
`
