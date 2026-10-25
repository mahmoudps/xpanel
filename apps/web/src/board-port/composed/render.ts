import { escapeHtml, formatBytes, normalizeAsciiDigits } from '../../tokens.ts'
import { composedXpanelRoutes, composedXwhmRoutes, nativeComposedRoutePaths } from './all.ts'
import { canReadSelectedAccount, canReadWhm, type ComposedContext } from './context.ts'
import { copyOf, type ComposedRoute, type Copy } from './types.ts'
import { COMPOSED_LAYOUT_CSS, renderComposedLayout } from './layout.ts'

type ReadState = 'unread' | 'empty' | 'loaded' | 'denied' | 'unavailable' | 'failed'
type Cell = { text: string; technical?: boolean }
type ReadView = { state: ReadState; rows?: Cell[][]; facts?: Array<{ label: Copy; value: Cell }> }
const cell = (text: unknown, technical = false): Cell => ({ text: text === null || text === undefined ? '' : String(text), technical })
const choose = (context: ComposedContext, english: string, arabic: string): string => context.locale === 'ar' ? arabic : english
const missing = (context: ComposedContext): string => choose(context, 'Not read', 'غير مقروء')
const unlimited = (context: ComposedContext, value: unknown): string => value === 'unlimited' ? choose(context, 'Unlimited', 'غير محدود') : String(value)
const complete = (rows: Cell[][]): ReadView => ({ state: rows.length ? 'loaded' : 'empty', rows })

const readView = (spec: ComposedRoute, context: ComposedContext): ReadView => {
  if (spec.surface === 'xpanel' ? !canReadSelectedAccount(context) : !canReadWhm(context)) return { state: 'denied' }
  if (spec.bind === 'soon' || spec.bind === 'git') return { state: 'unavailable' }
  if (spec.bind === 'webdisk') {
    if (context.failedReads?.includes('serviceUsers')) return { state: 'failed' }
    if (context.serviceUsers === undefined) return { state: 'unread' }
    return complete(context.serviceUsers.filter(row => row.accountId === context.account?.id && row.services.webdisk).map(row => [cell(row.login, true), cell(row.ftpDir, true)]))
  }
  if (spec.bind === 'ssl-files') {
    if (context.failedReads?.includes('domains')) return { state: 'failed' }
    if (context.domains === undefined) return { state: 'unread' }
    return complete(context.domains.filter(row => row.accountId === context.account?.id).map(row => [cell(row.name, true), cell(row.certificateId ? choose(context, 'Assigned', 'معيّنة') : choose(context, 'Unassigned', 'غير معيّنة'))]))
  }
  if (spec.bind === 'panel-usage') {
    if (context.failedReads?.includes('usage')) return { state: 'failed' }
    const account = context.account!
    return { state: 'loaded', facts: [
      { label: ['Account', 'الحساب'], value: cell(account.username, true) },
      { label: ['Domain', 'النطاق'], value: cell(account.primaryDomain, true) },
      { label: ['Plan', 'الخطة'], value: cell(context.plan?.id === account.planId ? context.plan.name : missing(context)) },
      { label: ['PHP version', 'إصدار PHP'], value: cell(context.usage?.phpVersion ?? missing(context), true) },
      { label: ['Disk usage', 'استخدام القرص'], value: cell(context.usage?.diskBytes === undefined || context.usage.diskBytes === null ? missing(context) : formatBytes(context.usage.diskBytes), true) },
      { label: ['Bandwidth', 'النطاق الترددي'], value: cell(choose(context, 'Not measured', 'غير مقاس')) },
    ] }
  }
  if (spec.bind === 'accounts') {
    if (context.failedReads?.includes('accounts')) return { state: 'failed' }
    if (context.accounts === undefined) return { state: 'unread' }
    const principal = context.principal!
    const rows = context.accounts.filter(account => principal.kind === 'root' || account.ownerId === principal.id)
    const status = { active: ['Active', 'نشط'], suspended: ['Suspended', 'موقوف'], terminating: ['Terminating', 'جار الحذف'] } as const
    return complete(rows.map(row => [cell(row.username, true), cell(row.primaryDomain, true), cell(copyOf(status[row.status], context.locale)), cell(choose(context, 'Not measured', 'غير مقاس'))]))
  }
  if (spec.bind === 'resellers' || spec.bind === 'reseller-acl') {
    if (context.failedReads?.includes('resellers')) return { state: 'failed' }
    if (context.resellers === undefined) return { state: 'unread' }
    const principal = context.principal!
    return complete(context.resellers.filter(row => principal.kind === 'root' || row.id === principal.id).map(row => spec.bind === 'reseller-acl'
      ? [cell(row.username, true), cell(row.acl.join(', ') || choose(context, 'None', 'لا توجد'), true)]
      : [cell(row.username, true), cell(unlimited(context, row.maxAccounts), typeof row.maxAccounts === 'number'), cell(row.nameservers.join(', ') || choose(context, 'None', 'لا توجد'), true)]))
  }
  // The remaining bindings belong to existing native controllers or lack a read model.
  // A metadata entry never manufactures service results or a parallel mutation form.
  return { state: 'unavailable' }
}

const styles = `<style>
.xp-composed-page{display:flex;flex-direction:column;gap:32px;min-inline-size:0;font-family:var(--xp-font-sans-ltr);text-align:start}html[dir="rtl"] .xp-composed-page{font-family:var(--xp-font-sans-rtl)}
.xp-composed-heading{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-composed-page h1,.xp-composed-page h2,.xp-composed-page p,.xp-composed-page dl,.xp-composed-page dd{margin:0}.xp-composed-heading h1{font-size:24px;line-height:1.6}.xp-composed-heading p{line-height:1.8;overflow-wrap:anywhere}
.xp-composed-card{display:flex;flex-direction:column;gap:24px;padding:16px;border:1px solid var(--xp-border,#d5dce4);border-radius:8px;min-inline-size:0}.xp-composed-card h2{font-size:18px;line-height:1.7}.xp-composed-card p{line-height:1.8}.xp-composed-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.xp-composed-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;align-items:stretch;text-align:start}.xp-composed-field dt{font-weight:600}.xp-composed-field dd{min-inline-size:0;text-align:start;overflow-wrap:anywhere}
.xp-composed-page bdi{unicode-bidi:isolate;display:inline;overflow-wrap:anywhere}.xp-composed-scroll{min-inline-size:0;max-inline-size:100%;overflow:auto;border:1px solid var(--xp-border,#d5dce4);border-radius:8px}.xp-composed-scroll:focus-visible{outline:2px solid currentColor;outline-offset:2px}.xp-composed-table{inline-size:100%;border-collapse:collapse;table-layout:fixed}.xp-composed-table th,.xp-composed-table td{padding:16px;text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-composed-table th{font-weight:600}.xp-composed-table tr+tr td,.xp-composed-table tbody tr:first-child td{border-block-start:1px solid var(--xp-border,#d5dce4)}.xp-composed-cell-label{display:none}.xp-composed-cell-value{display:block;text-align:start;min-inline-size:0}
@media(min-width:801px){.xp-composed-card{padding:24px}}
@media(max-width:600px){.xp-composed-table thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}.xp-composed-table,.xp-composed-table tbody,.xp-composed-table tr{display:block;inline-size:100%}.xp-composed-table tr{padding:16px;box-sizing:border-box}.xp-composed-table tr+tr{border-block-start:1px solid var(--xp-border,#d5dce4)}.xp-composed-table td{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:0;border:0!important;inline-size:auto}.xp-composed-table td+td{margin-block-start:16px}.xp-composed-cell-label{display:block;font-weight:600;text-align:start}}
</style>`

const valueHtml = (value: Cell): string => value.technical ? `<bdi dir="ltr">${escapeHtml(normalizeAsciiDigits(value.text))}</bdi>` : escapeHtml(normalizeAsciiDigits(value.text))
const messages: Record<ReadState, Copy> = {
  unread: ['This information has not been read.', 'لم تُقرأ هذه المعلومات.'],
  empty: ['The authorized read returned no records.', 'لم تُرجع القراءة المصرّح بها أي سجلات.'],
  loaded: ['Stored information; no changes are made here.', 'معلومات محفوظة؛ لا تُجرى تغييرات هنا.'],
  denied: ['This view requires an authorized account context.', 'تتطلب هذه الواجهة سياق حساب مصرّحاً به.'],
  unavailable: ['This operation is unavailable. No task has been started.', 'هذه العملية غير متاحة. لم تبدأ أي مهمة.'],
  failed: ['This information could not be read. No empty result is assumed.', 'تعذرت قراءة هذه المعلومات. لا تُفترض نتيجة فارغة.'],
}

export const renderComposedRoutes = (routes: readonly ComposedRoute[], context: ComposedContext): string | undefined => {
  if (nativeComposedRoutePaths.has(context.route)) return undefined
  const spec = routes.find(row => row.route === context.route)
  if (!spec) return undefined
  const title = copyOf(spec.title, context.locale)
  const view = readView(spec, context)
  const facts = view.facts?.length ? `<dl class="xp-composed-facts">${view.facts.map(row => `<div class="xp-composed-field"><dt>${escapeHtml(copyOf(row.label, context.locale))}</dt><dd>${valueHtml(row.value)}</dd></div>`).join('')}</dl>` : ''
  const emptyRow = `<tr><td colspan="${spec.columns.length}" class="xp-composed-empty-cell">${escapeHtml(copyOf(messages[view.state], context.locale))}</td></tr>`
  const table = spec.columns.length && view.state !== 'denied' ? `<div class="xp-composed-scroll" tabindex="0" role="region" aria-label="${escapeHtml(title)}"><table class="xp-table xp-composed-table"><caption class="sr-only">${escapeHtml(title)}</caption><thead><tr>${spec.columns.map(column => `<th scope="col">${escapeHtml(copyOf(column, context.locale))}</th>`).join('')}</tr></thead><tbody>${view.rows?.length ? view.rows.map(row => `<tr>${spec.columns.map((column, index) => `<td><span class="xp-composed-cell-label" aria-hidden="true">${escapeHtml(copyOf(column, context.locale))}</span><span class="xp-composed-cell-value">${valueHtml(row[index] ?? cell(missing(context)))}</span></td>`).join('')}</tr>`).join('') : emptyRow}</tbody></table></div>` : ''
  const body = renderComposedLayout(spec, context, { state: view.state, message: copyOf(messages[view.state], context.locale), facts, table })
  return `${styles}${COMPOSED_LAYOUT_CSS}<section class="xp-composed-page" data-composed-route="${escapeHtml(spec.route)}" data-composed-layout="${escapeHtml(spec.layout)}" data-read-state="${view.state}" data-wiring="${view.state === 'loaded' || view.state === 'empty' ? 'read-only' : 'unavailable'}"><header class="xp-composed-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copyOf(spec.lede, context.locale))}</p></header>${body}</section>`
}

export const renderComposedXpanel = (context: ComposedContext): string | undefined => renderComposedRoutes(composedXpanelRoutes, context)
export const renderComposedXwhm = (context: ComposedContext): string | undefined => renderComposedRoutes(composedXwhmRoutes, context)
export type { ComposedContext } from './context.ts'
