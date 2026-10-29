import { escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'

export interface StatusPillProps {
  tone: Tone
  label: string
  /** Hollow dot: a state that is neither good nor bad, such as "Not installed" or "Not enforced". */
  hollow?: boolean
  /** Announces later changes of the label (role="status"). */
  live?: boolean
  hooks?: HookAttributes
}

/** Status is never color alone: a dot and a word. */
export const statusPill = (props: StatusPillProps): string =>
  `<span class="v2-pill v2-pill--${props.tone}${props.hollow ? ' v2-pill--hollow' : ''}"${props.live ? ' role="status"' : ''}${hookAttrs(props.hooks)}><span class="v2-pill__dot" aria-hidden="true"></span>${escapeHtml(props.label)}</span>`

/** The pill of a template clone: core fills the label slot, and the tone follows the clone root's state through
 *  {@link stateTones}, so core never sets a class. */
export const statePill = (slot = 'state'): string =>
  `<span class="v2-pill v2-pill--state"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="${slot}"></span></span>`

const TONE_VARS: Readonly<Record<Tone, readonly [string, string]>> = {
  ok: ['--ok-soft', '--ok'], warn: ['--warn-soft', '--warn'], bad: ['--bad-soft', '--bad'], info: ['--accent-soft', '--accent'], neutral: ['--sunken', '--text-2'],
}

/** CSS that tones the state pills and icon tiles inside a clone root by its state attribute (data-state or
 *  data-level), one rule per token the controller sets. */
export const stateTones = (root: string, attribute: 'data-state' | 'data-level', tokens: Readonly<Record<string, Tone>>): string =>
  Object.entries(tokens).map(([token, tone]) => `${root}[${attribute}=${token}] :is(.v2-pill--state,.v2-tile--state){background:var(${TONE_VARS[tone][0]});color:var(${TONE_VARS[tone][1]})}`).join('\n')

export const STATUS_PILL_CSS = `.v2-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:var(--radius-pill);font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap}
.v2-pill__dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.v2-pill--hollow .v2-pill__dot{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.v2-pill--ok{background:var(--ok-soft);color:var(--ok)}
.v2-pill--warn{background:var(--warn-soft);color:var(--warn)}
.v2-pill--bad{background:var(--bad-soft);color:var(--bad)}
.v2-pill--info{background:var(--accent-soft);color:var(--accent)}
.v2-pill--neutral,.v2-pill--state{background:var(--sunken);color:var(--text-2)}
`
