import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface CodeBlockProps {
  /** File or unit name shown in the header, such as "xpanel-20014.slice". */
  title?: string
  code: string
  /** Hooks of the copy controller; without them no copy button is shown. */
  copy?: HookAttributes
  /** Live log output: announces appended lines (aria-live="polite"). */
  live?: boolean
  hooks?: HookAttributes
}

/** Config and log blocks stay dark in both schemes and always read left to right. */
export function codeBlock(t: Translate, props: CodeBlockProps): string {
  const copy = props.copy
    ? `<button type="button" class="v2-code__copy" aria-label="${escapeHtml(props.title ? t(msgctxt('theme:v2', 'Copy {name}'), { name: props.title }) : t('Copy'))}"${hookAttrs(props.copy)}>${icon('copy', 16)}</button>` : ''
  const head = props.title || copy ? `<div class="v2-code__head">${props.title ? `<code>${escapeHtml(props.title)}</code>` : '<span></span>'}${copy}</div>` : ''
  return `<div class="v2-code" dir="ltr"${hookAttrs(props.hooks)}>${head}<pre tabindex="0"${props.live ? ' aria-live="polite"' : ''}><code>${escapeHtml(props.code)}</code></pre></div>`
}

export const CODE_BLOCK_CSS = `.v2-code{display:flex;flex-direction:column;border-radius:var(--radius-control);background:var(--code);color:var(--code-text);overflow:hidden}
.v2-code__head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);padding-inline:var(--space-2) 4px;border-bottom:1px solid var(--nav-line)}
.v2-code__head code{font-size:12px;color:var(--code-muted)}
.v2-code__copy{display:inline-flex;align-items:center;justify-content:center;width:var(--target);height:var(--target);border:0;border-radius:var(--radius-chip);background:transparent;color:var(--code-muted);cursor:pointer}
.v2-code__copy:hover{color:var(--code-text)}
.v2-code pre{margin:0;padding:var(--space-2);font:12px/1.7 var(--font-mono);overflow-x:auto;white-space:pre}
.v2-code pre code{font-size:inherit}
.v2-code :focus-visible{outline-color:var(--nav-focus)}
`
