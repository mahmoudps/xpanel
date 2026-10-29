// Editor family (TplEditor): a code editor with line numbers, an insert-snippet slot and a test gate: the draft
// is tested before it can be saved, and Save stays aria-disabled with its reason until the test passes.

import type { Translate } from '../../../i18n.ts'
import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'
import { card, type CardProps } from '../components/card.ts'
import { codeBlock } from '../components/code-block.ts'
import { statusPill, type StatusPillProps } from '../components/status-pill.ts'
import { tabPanel, tabs, type TabsProps } from '../components/tabs.ts'
import { cards, commitRegion, factList, layoutRoot, splitWithAside, stateBlock, xpTemplate, type Fact, type LayoutState, type PageBaseProps, type StateSlots } from './common.ts'

export interface EditorSnippet {
  label: string
  description?: string
  /** Text core inserts at the caret; emitted as the item's `<template data-xp-template="snippet">`. */
  code: string
  hooks?: HookAttributes
}

export interface EditorPageProps extends PageBaseProps {
  /** Error and loading replace the editor: nothing is editable before the protected file is read. */
  state?: Exclude<LayoutState, 'empty'>
  states?: StateSlots
  /** The file being edited and its facts, such as "Domain and file". */
  context?: CardProps
  editor: {
    title: string
    titleId: string
    description?: string
    actionsHtml?: string
    /** Views of the same file, such as Draft and Applied; the editor is the selected tab's panel. */
    tabs?: TabsProps
    field: { id: string; name?: string; label: string; value: string; readonly?: boolean; hooks?: HookAttributes }
    /** Hooks on the line-number gutter, which core renumbers as lines change. */
    gutterHooks?: HookAttributes
    /** The draft against the saved version, line by line, shown in the tab panel `panelId` (the board's
     *  Changes tab) with +/- markers in its gutter. Without tabs it follows the editor. */
    diff?: CodeDiffProps
    footer?: { meta?: string; note?: string }
  }
  snippets?: { title: string; titleId: string; description?: string; items: readonly EditorSnippet[] }
  test: {
    title?: string
    titleId: string
    description?: string
    status: StatusPillProps
    run: { label: string; hooks: HookAttributes }
    /** The checker's output, such as "Syntax OK"; announced when it changes. */
    output?: string
    outputLabel: string
    outputHooks?: HookAttributes
    facts?: readonly Fact[]
  }
  save: {
    label: string
    hooks: HookAttributes
    /** False until the current draft passed its test; core flips it after a passing run. */
    ready: boolean
    blockedReason?: string
    discard?: { label?: string; hooks: HookAttributes }
  }
  aside?: readonly CardProps[]
  asideLabel?: string
  extra?: readonly CardProps[]
}

export interface DiffLine {
  text: string
  /** Against the saved version; a removed line has no number in the draft. */
  change?: 'added' | 'removed'
}

export interface CodeDiffProps {
  /** Names the view, such as "Changes to the xPanel error-pages block". */
  label: string
  panelId?: string
  lines: readonly DiffLine[]
  /** Hooks on the line list, which core repaints from the `diff-line` template as the draft changes. */
  hooks?: HookAttributes
}

// One grid row per line: the gutter cell (marker and number) stays at the inline start while long lines scroll.
// The gutter is decorative; each changed line starts with its change in words for assistive technology.
const diffLine = (t: Translate, line: DiffLine | undefined, number: number | undefined): string => {
  const state = line?.change ?? 'unchanged'
  return `<span class="v2-diff__line" data-state="${state}"><span class="v2-diff__gutter v2-num" aria-hidden="true"><span class="v2-diff__mark"></span><span data-xp-slot="item">${number ?? ''}</span></span><span class="v2-diff__code"><span class="v2-sr v2-diff__added">${escapeHtml(t(msgctxt('theme:v2', 'Added line:')))} </span><span class="v2-sr v2-diff__removed">${escapeHtml(t(msgctxt('theme:v2', 'Removed line:')))} </span><span data-xp-slot="message">${escapeHtml(line?.text ?? '')}</span></span></span>`
}

/** Read-only view of the draft against the saved version, with the `diff-line` template core repaints it from. */
export function codeDiff(t: Translate, props: CodeDiffProps): string {
  let number = 0
  const lines = props.lines.map(line => diffLine(t, line, line.change === 'removed' ? undefined : ++number)).join('')
  return `<div class="v2-diff" dir="ltr"><pre class="v2-diff__lines" role="region" tabindex="0" aria-label="${escapeHtml(props.label)}"${hookAttrs(props.hooks)}>${lines}</pre>${xpTemplate('diff-line', diffLine(t, undefined, undefined))}</div>`
}

/** Code editor: a decorative line-number gutter beside a plain textarea, both on the 22px code line grid. Code
 *  reads left to right in every locale. */
export function codeEditor(props: EditorPageProps['editor']): string {
  const { field } = props
  const lines = field.value.split('\n').length
  return `<div class="v2-editor" dir="ltr"><div class="v2-editor__gutter v2-num" aria-hidden="true"${hookAttrs(props.gutterHooks)}>${Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join('')}</div><label class="v2-sr" for="${escapeHtml(field.id)}">${escapeHtml(field.label)}</label><textarea class="v2-editor__input" id="${escapeHtml(field.id)}"${attr('name', field.name)} rows="${Math.max(lines, 8)}" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off"${field.readonly ? ' readonly' : ''}${hookAttrs(field.hooks)}>${escapeHtml(field.value)}</textarea></div>`
}

export function editorPage(t: Translate, props: EditorPageProps): string {
  const state = props.state ?? 'ready'
  const context = props.context ? card(props.context) : ''
  if (state !== 'ready') return layoutRoot(t, props, `${context}${stateBlock(t, state, props.states)}`)
  const { editor, test, save } = props
  const region = codeEditor(editor)
  const diff = editor.diff ? codeDiff(t, editor.diff) : ''
  // The Changes tab owns the diff panel; every other tab shows the editor, and only the selected panel is visible.
  const diffTab = editor.tabs?.tabs.find(tab => editor.diff?.panelId !== undefined && tab.panelId === editor.diff.panelId)
  const editTabs = editor.tabs?.tabs.filter(tab => tab !== diffTab) ?? []
  const editTab = editTabs.find(tab => tab.selected) ?? editTabs[0]
  const panels = editTab ? `${tabPanel({ id: editTab.panelId, tabId: editTab.id, hidden: diffTab?.selected, bodyHtml: region })}${diffTab ? tabPanel({ id: diffTab.panelId, tabId: diffTab.id, hidden: !diffTab.selected, bodyHtml: diff }) : diff}` : `${region}${diff}`
  const editorCard = card({
    title: editor.title, titleId: editor.titleId, description: editor.description, actionsHtml: editor.actionsHtml, flush: true,
    bodyHtml: editor.tabs ? `${tabs(editor.tabs)}${panels}` : `${region}${diff}`,
    footerHtml: editor.footer ? `<div class="v2-editor__foot">${editor.footer.meta ? `<span class="v2-num v2-mono">${escapeHtml(editor.footer.meta)}</span>` : ''}${editor.footer.note ? `<span>${escapeHtml(editor.footer.note)}</span>` : ''}</div>` : undefined,
  })
  const reasonId = `${editor.field.id}-save-reason`
  const gate = `<div class="v2-apply"><p class="v2-apply__text"${save.ready ? '' : ` id="${escapeHtml(reasonId)}"`}>${escapeHtml(save.ready ? t(msgctxt('theme:v2', 'The draft passed its test. Saving writes exactly the tested draft.')) : save.blockedReason ?? t(msgctxt('theme:v2', 'Save is available after the draft passes its test.')))}</p><span class="v2-apply__actions">${save.discard ? `<button type="button" class="v2-btn"${hookAttrs(save.discard.hooks)}>${escapeHtml(save.discard.label ?? t('Discard'))}</button>` : ''}<button type="button" class="v2-btn v2-btn--primary"${save.ready ? '' : ` aria-disabled="true" aria-describedby="${escapeHtml(reasonId)}"`}${hookAttrs(save.hooks)}>${escapeHtml(save.label)}</button></span></div>`
  const testCard = card({
    title: test.title ?? t(msgctxt('theme:v2', 'Test before the switch')), titleId: test.titleId, description: test.description,
    actionsHtml: `${statusPill({ ...test.status, live: true })}<button type="button" class="v2-btn"${hookAttrs(test.run.hooks)}>${icon('check', 16)}${escapeHtml(test.run.label)}</button>`,
    bodyHtml: `${codeBlock(t, { title: test.outputLabel, code: test.output ?? '', live: true, hooks: test.outputHooks })}${test.facts?.length ? factList(test.facts) : ''}`,
  })
  const snippets = props.snippets ? card({
    title: props.snippets.title, titleId: props.snippets.titleId, description: props.snippets.description,
    bodyHtml: `<ul class="v2-snippets">${props.snippets.items.map(item => `<li><button type="button" class="v2-btn" aria-controls="${escapeHtml(editor.field.id)}"${hookAttrs(item.hooks)}>${icon('plus', 16)}${escapeHtml(item.label)}</button>${item.description ? `<span>${escapeHtml(item.description)}</span>` : ''}${xpTemplate('snippet', escapeHtml(item.code))}</li>`).join('')}</ul>`,
  }) : ''
  const side = `${snippets}${cards(props.aside)}`
  return layoutRoot(t, props, `${context}${splitWithAside(`${editorCard}${testCard}`, side ? { label: props.asideLabel ?? props.snippets?.title ?? editor.title, html: side } : undefined)}${cards(props.extra)}${commitRegion(t('Save changes'), gate)}`)
}

export const EDITOR_LAYOUT_CSS = `.v2-editor{display:flex;background:var(--code);color:var(--code-text)}
.v2-editor__gutter{flex:none;display:flex;flex-direction:column;align-items:flex-end;min-inline-size:56px;padding:var(--space-2) 12px;border-inline-end:1px solid var(--nav-line);font:13px/22px var(--font-mono);color:var(--code-muted);user-select:none}
.v2-editor>.v2-editor__input{flex:1 1 auto;min-width:0;min-height:0;padding:var(--space-2);border:0;border-radius:0;background:transparent;color:var(--code-text);font:13px/22px var(--font-mono);white-space:pre;overflow-x:auto;resize:vertical}
.v2-editor>.v2-editor__input:focus-visible{outline-color:var(--nav-focus);outline-offset:-2px}
.v2-card--flush>.v2-card__body>.v2-tabs{padding-inline:var(--space-3)}
.v2-tabpanel:has(>:is(.v2-editor,.v2-diff)){padding-top:0}
.v2-diff{background:var(--code);color:var(--code-text)}
.v2-diff__lines{display:grid;grid-template-columns:auto 1fr;min-inline-size:100%;margin:0;padding:var(--space-2) 0;overflow-x:auto;font:13px/22px var(--font-mono);color:var(--code-text)}
.v2-diff__lines:focus-visible{outline-color:var(--nav-focus);outline-offset:-2px}
.v2-diff__line{display:contents}
.v2-diff__gutter{position:sticky;inset-inline-start:0;display:flex;justify-content:space-between;gap:var(--space-1);min-inline-size:72px;padding-block:0;padding-inline:12px 10px;border-inline-end:1px solid var(--nav-line);background:var(--code);color:var(--code-muted);user-select:none}
.v2-diff__mark{font-weight:600;color:var(--code-text)}
.v2-diff__code{padding:0 var(--space-2);white-space:pre}
.v2-diff__line[data-state=added]>*{background-image:linear-gradient(color-mix(in srgb,var(--chart-2) 26%,transparent),color-mix(in srgb,var(--chart-2) 26%,transparent))}
.v2-diff__line[data-state=removed]>*{background-image:linear-gradient(color-mix(in srgb,var(--bad) 26%,transparent),color-mix(in srgb,var(--bad) 26%,transparent))}
.v2-diff__line[data-state=added] .v2-diff__mark::before{content:"+"}
.v2-diff__line[data-state=removed] .v2-diff__mark::before{content:"-"}
.v2-diff__line:not([data-state=added]) .v2-diff__added,.v2-diff__line:not([data-state=removed]) .v2-diff__removed{display:none}
.v2-editor__foot{flex:1 1 auto;display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px var(--space-2);font-size:12px;color:var(--muted)}
.v2-snippets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.v2-snippets>li{display:flex;flex-direction:column;align-items:flex-start;gap:4px;font-size:12px;color:var(--muted)}
`
