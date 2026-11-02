// Document chrome the realtime runtime binds by id: the quick bar (#xp-cmdk-modal), the activity drawer
// (#xp-activity-drawer) and the reconcile banner (#xp-reconcile-banner). Data comes from core; v2 only renders it.

import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon, type IconName } from '../icons.ts'
import { statusPill } from '../components/status-pill.ts'
import { stepper } from '../components/stepper.ts'

export type V2Surface = 'xpanel' | 'xwhm' | 'xmail'

/** One quick bar result, as core's command palette entries describe it. */
export interface PaletteEntry {
  key: string
  kind: 'page' | 'action' | 'account' | 'domain'
  label: string
  section: string
  route: string
  href: string
  hint: string
  /** Normalized search text (ASCII digits). */
  search: string
  persistable: boolean
}

export interface CommandPaletteProps {
  surface: V2Surface
  entries: readonly PaletteEntry[]
}

const KIND_ICONS: Readonly<Record<PaletteEntry['kind'], IconName>> = { page: 'services', action: 'plus', account: 'user', domain: 'globe' }

export function commandPalette(t: Translate, props: CommandPaletteProps): string {
  const groups: readonly [PaletteEntry['kind'], string][] = [['page', t('Tools')], ['action', t('Actions')], ['account', t('Accounts')], ['domain', t('Domains')]]
  const scopes: readonly [string, string][] = [['all', t('All')], ['action', t('> Actions')], ['account', t('@ Accounts')], ['domain', t('# Domains')]]
  let index = 0
  const rows = groups.map(([kind, name]) => {
    const matches = props.entries.filter(entry => entry.kind === kind)
    if (!matches.length) return ''
    const items = matches.map(item => {
      const favorite = item.persistable
        ? `<button type="button" class="v2-cmdk__fav" data-cmdk-favorite="${escapeHtml(item.route)}" aria-pressed="false" aria-label="${escapeHtml(`${t('Favorite page')}: ${item.label}`)}">${icon('star', 16)}</button>`
        : ''
      return `<li data-cmdk-row role="presentation" class="v2-cmdk__row"><a id="xp-cmdk-option-${index++}" href="${escapeHtml(item.href)}" class="v2-cmdk__item" data-cmdk-item="${escapeHtml(item.route)}" data-cmdk-kind="${item.kind}" data-cmdk-key="${escapeHtml(item.key)}" data-cmdk-persistable="${item.persistable}" data-cmdk-search-text="${escapeHtml(item.search)}" role="option" aria-selected="false" tabindex="-1"><span class="v2-cmdk__tile" aria-hidden="true">${icon(KIND_ICONS[kind], 16)}</span><span class="v2-cmdk__copy"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.section)}</span></span><code dir="ltr">${escapeHtml(item.hint)}</code></a>${favorite}</li>`
    }).join('')
    return `<li data-cmdk-group="${kind}" role="presentation" class="v2-cmdk__group"><span class="v2-cmdk__group-label">${escapeHtml(name)}</span><ul role="group" aria-label="${escapeHtml(name)}">${items}</ul></li>`
  }).join('')
  return `<div id="xp-cmdk-modal" class="v2-cmdk" data-xp-cmdk="true" data-cmdk-surface="${props.surface}" hidden role="dialog" aria-modal="true" aria-labelledby="xp-cmdk-title"><div class="v2-cmdk__panel">
<div class="v2-cmdk__head"><h2 id="xp-cmdk-title" class="v2-sr">${escapeHtml(t('Quick bar'))}</h2>${icon('search')}<label class="v2-sr" for="xp-cmdk-input">${escapeHtml(t('Search tools, accounts and domains'))}</label><input id="xp-cmdk-input" type="search" data-xp-filter-input="true" data-cmdk-search="true" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="xp-cmdk-results" autocomplete="off" maxlength="160" placeholder="${escapeHtml(t('Search tools, @account, #domain or >action'))}"><button type="button" class="v2-cmdk__close" data-action="close-cmdk" aria-label="${escapeHtml(t('Close'))}"><kbd>Esc</kbd></button></div>
<div class="v2-segmented v2-cmdk__scopes" role="group" aria-label="${escapeHtml(t('Search scope'))}">${scopes.map(([kind, name]) => `<button type="button" data-cmdk-scope="${kind}" aria-pressed="${kind === 'all'}">${escapeHtml(name)}</button>`).join('')}</div>
<div class="v2-cmdk__history" data-cmdk-history hidden><div data-cmdk-favorites-section hidden><h3>${escapeHtml(t('Favorites'))}</h3><div class="v2-cmdk__links" data-cmdk-favorites></div></div><div data-cmdk-recents-section hidden><h3>${escapeHtml(t('Recent pages'))}</h3><div class="v2-cmdk__links" data-cmdk-recents></div></div></div>
<ul id="xp-cmdk-results" class="v2-cmdk__results" data-cmdk-results role="listbox" aria-label="${escapeHtml(t('Results'))}">${rows}</ul>
<p class="v2-cmdk__empty" data-cmdk-empty role="status"${props.entries.length ? ' hidden' : ''}>${escapeHtml(t('No matching pages.'))}</p>
<div class="v2-cmdk__foot"><p><kbd>↑ ↓</kbd> ${escapeHtml(t('move'))} · <kbd>Enter</kbd> ${escapeHtml(t('open'))} · <kbd>Ctrl Enter</kbd> ${escapeHtml(t('new tab'))}</p><p class="v2-num" data-cmdk-status aria-live="polite" aria-atomic="true" data-count-label="${escapeHtml(t('Results'))}"></p></div>
</div></div>`
}

export interface ActivityDrawerProps {
  /** The active generation, when the reconciler has been observed. */
  generation?: { id: number; applied: boolean }
  /** Live activity rendered by core (jobs, audit entries), built with the kit. */
  bodyHtml?: string
}

export function activityDrawer(t: Translate, props: ActivityDrawerProps): string {
  const generation = props.generation
    ? statusPill({ tone: props.generation.applied ? 'ok' : 'warn', label: t('Generation {generation}', { generation: props.generation.id }) })
    : ''
  const body = props.bodyHtml ?? `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Jobs, configuration generations and audit entries appear here as they happen.')))}</p>`
  return `<div id="xp-activity-drawer" class="v2-sheet" data-xp-drawer="activity" hidden role="dialog" aria-modal="true" aria-labelledby="xp-activity-drawer-title"><aside class="v2-sheet__panel" tabindex="-1">
<header class="v2-drawer__head"><h2 id="xp-activity-drawer-title">${escapeHtml(t('Activity & Jobs'))}</h2><button type="button" class="v2-btn v2-btn--icon v2-btn--bare" data-action="close-activity-drawer" aria-label="${escapeHtml(t('Close'))}">${icon('x', 16)}</button></header>
<div class="v2-drawer__body">${generation}${body}</div>
</aside></div>`
}

export interface ReconcileStage {
  /** Stage id the runtime updates: render, test, switch, reload or verify. */
  stage: string
  label: string
  status: 'pending' | 'running' | 'passed' | 'failed'
}

export interface ReconcileBannerProps {
  generationId: number
  status: 'idle' | 'running' | 'applied' | 'failed'
  /** Whether the reconciler has been observed at all (it has an update time). */
  observed: boolean
  stages: readonly ReconcileStage[]
  failedTest?: string
  error?: string
  hooks?: HookAttributes
}

export function reconcileBanner(t: Translate, props: ReconcileBannerProps): string {
  const values = { generationId: props.generationId }
  const pill = !props.observed || props.generationId <= 0 ? statusPill({ tone: 'warn', label: t('Reconciliation has not been observed') })
    : props.status === 'running' ? statusPill({ tone: 'info', label: t('Reconciling generation #{generationId}...', values) })
    : props.status === 'failed' ? statusPill({ tone: 'bad', label: t('Rolled back from generation #{generationId}', values) })
    : statusPill({ tone: 'ok', label: t('Applied in generation #{generationId}', values) })
  const error = props.status === 'failed' && (props.error || props.failedTest)
    ? `<details class="v2-reconcile__error" open><summary>${escapeHtml(t('Failed validation test: {failedTest}', { failedTest: props.failedTest ?? 'configtest' }))}</summary><pre dir="ltr">${escapeHtml(props.error ?? '')}</pre></details>`
    : ''
  const steps = stepper({ label: t(msgctxt('theme:v2', 'Reconcile pipeline')), steps: props.stages.map(stage => ({ label: stage.label, state: stage.status, hooks: { 'data-stage': stage.stage } })) })
  return `<section id="xp-reconcile-banner" class="v2-card v2-reconcile" data-reconcile-banner="true" data-generation-id="${props.generationId}" data-reconcile-status="${props.status}" aria-labelledby="xp-reconcile-title"${hookAttrs(props.hooks)}>
<div class="v2-card__head"><h2 id="xp-reconcile-title">${escapeHtml(t(msgctxt('theme:v2', 'Reconcile pipeline')))}</h2>${pill}</div>
${steps}${error}
</section>`
}

export const OVERLAYS_CSS = `.v2-cmdk{position:fixed;inset:0;z-index:90;display:flex;justify-content:center;align-items:flex-start;padding:min(12vh,96px) var(--space-2) var(--space-2);background:var(--scrim)}
.v2-cmdk__panel{inline-size:min(720px,100%);max-block-size:100%;display:flex;flex-direction:column;border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line-strong);box-shadow:0 16px 40px rgba(0,0,0,.24);overflow:hidden}
.v2-cmdk__head{display:flex;align-items:center;gap:12px;padding-block:var(--space-1);padding-inline:var(--space-2) var(--space-1);border-bottom:1px solid var(--line);color:var(--muted)}
.v2-cmdk__head>input{flex:1 1 auto;min-width:0;min-height:var(--target);padding:0;border:0;background:transparent;font-size:16px;color:var(--text)}
.v2-cmdk__head>input:focus-visible{outline:none}
.v2-cmdk__close{display:inline-flex;align-items:center;justify-content:center;min-width:var(--target);min-height:var(--target);border:0;background:transparent;color:var(--muted);cursor:pointer}
.v2-cmdk kbd{display:inline-flex;align-items:center;height:22px;padding:0 6px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);font-size:11px;color:var(--muted)}
.v2-cmdk__scopes{margin:12px var(--space-2) 0;align-self:flex-start}
.v2-cmdk__history{display:flex;flex-direction:column;gap:12px;padding:12px var(--space-2) 0}
.v2-cmdk__history h3{margin-bottom:var(--space-1);font-size:12px;color:var(--muted)}
.v2-cmdk__links{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-cmdk__links>a{display:inline-flex;align-items:center;min-height:var(--target);padding:0 12px;border-radius:var(--radius-control);border:1px solid var(--line);color:var(--text);font-weight:600;text-decoration:none}
.v2-cmdk__results{list-style:none;margin:0;padding:var(--space-1);display:flex;flex-direction:column;gap:var(--space-1);max-block-size:min(420px,50dvh);overflow-y:auto;overscroll-behavior:contain}
.v2-cmdk__group>ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.v2-cmdk__group-label{display:block;padding:var(--space-1) 12px 4px;font-size:12px;font-weight:600;color:var(--muted)}
.v2-cmdk__row{display:flex;align-items:center;gap:4px}
.v2-cmdk__item{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px;min-height:var(--target);padding:6px 12px;border-radius:var(--radius-control);color:var(--text);text-decoration:none}
.v2-cmdk__item:hover,.v2-cmdk__item[aria-selected="true"]{background:var(--accent-soft);color:var(--text)}
.v2-cmdk__tile{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--radius-chip);background:var(--accent-soft);color:var(--accent)}
.v2-cmdk__copy{display:flex;flex-direction:column;min-width:0}
.v2-cmdk__copy>strong{font-weight:600}
.v2-cmdk__copy>span{font-size:12px;color:var(--muted)}
.v2-cmdk__item>code{margin-inline-start:auto;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.v2-cmdk__fav{flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--target);height:var(--target);border:0;border-radius:var(--radius-control);background:transparent;color:var(--muted);cursor:pointer}
.v2-cmdk__fav[aria-pressed="true"]{color:var(--warn)}
.v2-cmdk__fav[aria-pressed="true"] svg{fill:currentColor}
.v2-cmdk__empty{padding:var(--space-2);color:var(--muted);text-align:center}
.v2-cmdk__foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1);padding:12px var(--space-2);border-top:1px solid var(--line);background:var(--subtle);font-size:12px;color:var(--text-2)}
.v2-sheet{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--scrim)}
.v2-sheet__panel{inline-size:min(440px,100%);block-size:100%;display:flex;flex-direction:column;background:var(--surface);border-inline-start:1px solid var(--line-strong);overflow-y:auto}
.v2-reconcile{gap:var(--space-3)}
.v2-reconcile__error summary{min-height:var(--target);display:flex;align-items:center;font-weight:600;color:var(--bad);cursor:pointer}
.v2-reconcile__error pre{padding:var(--space-2);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font-size:12px;overflow-x:auto}
`
