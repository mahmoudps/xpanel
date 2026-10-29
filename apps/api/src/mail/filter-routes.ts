import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account, Id } from '@xpanel/core'
import type { AuthenticatedCaller } from '../auth.ts'
import type { ExtendedRouteHelpers } from '../extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal, requireMailboxPrincipalAccess } from '../authorization.ts'
import { services } from '@xpanel/render'
import { MAX_FILTER_RULES, compileValidatedFilters, filterRevision, validateFilterDraft, validateFilterPatch, validateSampleMessage, validateStoredFilterRule } from './filter-validation.ts'
import type { FilterScopeContext, ValidatedFilterRule } from './filter-validation.ts'
import { canonicalForwarderAddress } from './forwarder-validation.ts'
import type { WriterLease } from '@xpanel/state'
import type { MailRoutingStatusView } from './routing-application.ts'

type Row = Record<string, unknown> & { accountId: Id | null }
type Hints = { accountId?: string; scope?: 'global' | 'mailbox'; mailbox?: string | null }
export interface FilterRoutePorts extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'emitAudit'> {
  readFilters: () => Promise<unknown>
  writeFilters: (filters: readonly unknown[]) => Promise<unknown>
  requireAccountId: (caller: AuthenticatedCaller, requested: Id | null | undefined, action: string) => Promise<Id>
  assertRecordAccount: (caller: AuthenticatedCaller, record: { accountId: Id | null } | undefined, action: string) => Promise<void>
  scopedRecords: <T extends { accountId: Id | null }>(caller: AuthenticatedCaller, rows: readonly T[]) => Promise<T[]>
  commitRoutingRevision: (lease: WriterLease) => Promise<number>
  /** applies on the host; a failed configuration test restores `previous` and throws */
  applyFilters: (caller: AuthenticatedCaller, revision: number, previous: readonly unknown[] | null) => Promise<MailRoutingStatusView>
  readRoutingStatus: () => Promise<MailRoutingStatusView>
}
const metadata = (value: unknown, limit: number): string | null => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? value : null
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const row = (value: unknown): value is Row => object(value) && (value.accountId === null || typeof value.accountId === 'string')
const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (req.body === null) return {}
  let value: unknown
  try { value = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
  if (!object(value)) return fail('VALIDATION', 'request body must be a JSON object')
  return value
}
const hints = (url: URL, body?: Record<string, unknown>): Hints => {
  const result: Hints = {}
  for (const key of ['accountId', 'scope', 'mailbox'] as const) {
    const query = url.searchParams.has(key) ? url.searchParams.get(key) : undefined
    const provided = body?.[key]
    if (query !== undefined && provided !== undefined && query !== provided) return fail('VALIDATION', 'conflicting filter selection')
    const value = provided !== undefined ? provided : query
    if (value === undefined) continue
    if (key === 'scope') {
      if (value !== 'global' && value !== 'mailbox') return fail('VALIDATION', 'scope must be global or mailbox')
      result.scope = value
    } else if (key === 'mailbox') {
      if (typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return fail('VALIDATION', 'mailbox contains a forbidden control')
      result.mailbox = value === null ? null : canonicalForwarderAddress(value)
    } else {
      if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return fail('VALIDATION', 'accountId must be a nonempty string')
      result.accountId = value
    }
  }
  return result
}
const inContext = (value: unknown, context: FilterScopeContext): value is Row => row(value) && value.accountId === context.accountId && value.scope === context.scope
  && (context.scope === 'global' ? value.mailbox === null : typeof value.mailbox === 'string' && value.mailbox.toLowerCase() === context.mailbox)
const revisionMatches = (body: Record<string, unknown>, actual: string, mandatory: boolean): void => {
  if (body.expectedRevision === undefined && !mandatory) return
  if (body.expectedRevision === undefined) return fail('PRECONDITION_FAILED', 'expectedRevision is required', { stateChanged: false })
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/i.test(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be a SHA256 revision')
  if (body.expectedRevision.toLowerCase() !== actual) return fail('CONFLICT', 'filter configuration changed; refresh before another change', { stateChanged: false })
}
const content = (body: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([key]) => !['accountId', 'scope', 'mailbox', 'expectedRevision'].includes(key)))
const sorted = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => (typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER) - (typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER))

export function createFilterRoutes(ports: FilterRoutePorts) {
  const load = async (): Promise<unknown[]> => {
    const values = await ports.readFilters()
    if (!Array.isArray(values)) return fail('CONFLICT', 'saved filter collection is unavailable')
    return values
  }
  const accountFor = async (caller: AuthenticatedCaller, accountId: string, action: string): Promise<Account> => {
    const id = await ports.requireAccountId(caller, accountId, action)
    const account = await ports.store.getAccount(id)
    if (!account) return fail('NOT_FOUND', 'account not found')
    return account
  }
  const authorize = async (caller: AuthenticatedCaller, selection: Hints, action: string): Promise<FilterScopeContext> => {
    if (isMailboxPrincipal(caller)) {
      if (selection.scope === 'global') return fail('FORBIDDEN', 'mailbox principals cannot manage account-wide filters')
      const bound = await requireMailboxPrincipalAccess(ports.store, caller)
      if (selection.accountId && selection.accountId !== bound.account.id) return fail('NOT_FOUND', 'account not found')
      if (selection.mailbox != null && selection.mailbox !== bound.mailbox) return fail('NOT_FOUND', 'mailbox not found')
      const mailbox = bound.mailbox
      await assertAccountFeatures(ports.store, caller, bound.account, ['email-filters'])
      return { accountId: bound.account.id, scope: 'mailbox', mailbox }
    }
    const id = await ports.requireAccountId(caller, selection.accountId, action)
    const account = await accountFor(caller, id, action)
    const scope = selection.scope ?? (selection.mailbox ? 'mailbox' : 'global')
    if (scope === 'global' && selection.mailbox != null) return fail('VALIDATION', 'account-wide filters cannot select a mailbox')
    let mailbox: string | null = null
    if (scope === 'mailbox') {
      if (!selection.mailbox) return fail('VALIDATION', 'mailbox scope requires a mailbox')
      const serviceUser = await ports.store.getServiceUserByLogin(selection.mailbox)
      if (!serviceUser || serviceUser.accountId !== account.id || !serviceUser.services.email) return fail('NOT_FOUND', 'mailbox not found')
      mailbox = serviceUser.login.toLowerCase()
      await assertAccountFeatures(ports.store, caller, account, ['email-accounts'])
    }
    await assertAccountFeatures(ports.store, caller, account, [scope === 'global' ? 'global-email-filters' : 'email-filters'])
    return { accountId: account.id, scope, mailbox }
  }
  const project = (raw: Row, context: FilterScopeContext): Record<string, unknown> => {
    try {
      const valid = validateStoredFilterRule(raw, context)
      return { ...valid, compiledSieve: compileValidatedFilters([valid], context), validation: { status: 'valid' } }
    } catch {
      return { id: metadata(raw.id, 128), name: metadata(raw.name, 128),
        ...context, priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null, matchAll: typeof raw.matchAll === 'boolean' ? raw.matchAll : null,
        conditions: [], actions: [], compiledSieve: null, createdAt: metadata(raw.createdAt, 64),
        validation: { status: 'invalid', reasonCode: 'invalid_saved_filter' } }
    }
  }
  const selected = (values: readonly unknown[], context: FilterScopeContext) => sorted(values.filter(value => inContext(value, context)))
  const view = (values: readonly unknown[], context: FilterScopeContext): Record<string, unknown> => {
    const records = selected(values, context)
    const revision = filterRevision(context, records)
    let compiledSieve: string | null = null
    let compilation: { status: 'ready' | 'blocked'; reason?: string }
    try { compiledSieve = compileValidatedFilters(records, context); compilation = { status: 'ready' } }
    catch { compilation = { status: 'blocked', reason: 'invalid_saved_filter_or_preview_limit' } }
    return { filters: records.map(value => project(value, context)), context, revision, compilation, compiledSieve }
  }
  const inventory = async (caller: AuthenticatedCaller, values: readonly unknown[]): Promise<Record<string, unknown>> => {
    const visible = await ports.scopedRecords(caller, values.filter(row))
    const permitted: Row[] = []
    const checked = new Map<string, boolean>()
    for (const value of visible) {
      if (value.accountId === null) { if (caller.principal.kind === 'root') permitted.push(value); continue }
      if (value.scope !== 'global' && value.scope !== 'mailbox' || value.scope === 'global' && value.mailbox !== null || value.scope === 'mailbox' && typeof value.mailbox !== 'string') continue
      const key = JSON.stringify([value.accountId, value.scope, value.scope === 'mailbox' ? (value.mailbox as string).toLowerCase() : null])
      let allowed = checked.get(key)
      if (allowed === undefined) {
        try { await authorize(caller, { accountId: value.accountId, scope: value.scope, mailbox: value.scope === 'mailbox' && typeof value.mailbox === 'string' ? value.mailbox : null }, 'mail.filter.read'); allowed = true }
        catch (error) { if (!object(error) || !['FORBIDDEN', 'NOT_FOUND', 'VALIDATION'].includes(String(error.code))) throw error; allowed = false }
        checked.set(key, allowed)
      }
      if (allowed) permitted.push(value)
    }
    if (caller.principal.kind === 'user') {
      const account = await accountFor(caller, caller.principal.accountId, 'mail.filter.read')
      let admitted = false
      for (const tool of ['global-email-filters', 'email-filters']) {
        try { await assertAccountFeatures(ports.store, caller, account, [tool]); admitted = true } catch (error) { if (!object(error) || error.code !== 'FORBIDDEN') throw error }
      }
      if (!admitted) return fail('FORBIDDEN', 'filter features are disabled by the account plan')
    }
    const contexts = new Map<string, FilterScopeContext>()
    for (const value of permitted) {
      if (typeof value.accountId !== 'string' || value.scope !== 'global' && value.scope !== 'mailbox' || value.scope === 'global' && value.mailbox !== null || value.scope === 'mailbox' && typeof value.mailbox !== 'string') continue
      const context = { accountId: value.accountId, scope: value.scope, mailbox: value.scope === 'mailbox' ? (value.mailbox as string).toLowerCase() : null } as FilterScopeContext
      contexts.set(JSON.stringify(context), context)
    }
    if (contexts.size === 1 && permitted.every(value => inContext(value, [...contexts.values()][0]!))) return view(values, [...contexts.values()][0]!)
    return { filters: permitted.map(value => typeof value.accountId === 'string'
      ? { ...project(value, { accountId: value.accountId, scope: value.scope as 'global' | 'mailbox', mailbox: value.scope === 'mailbox' ? (value.mailbox as string).toLowerCase() : null }), compiledSieve: null }
      : { id: metadata(value.id, 128), name: metadata(value.name, 128),
          accountId: null, scope: value.scope === 'global' || value.scope === 'mailbox' ? value.scope : null,
          mailbox: metadata(value.mailbox, 254), compiledSieve: null,
          validation: { status: 'invalid', reasonCode: 'legacy_server_filter_context' } }), context: null, revision: null,
      compilation: { status: 'selection_required', reason: 'select_one_account_filter_scope' }, compiledSieve: null }
  }
  const targetContext = async (caller: AuthenticatedCaller, values: readonly unknown[], id: string, action: string): Promise<{ target: Row; context: FilterScopeContext }> => {
    const matches = values.filter(row).filter(value => value.id === id)
    if (!matches.length) return fail('NOT_FOUND', 'resource not found')
    if (isMailboxPrincipal(caller)) {
      const context = await authorize(caller, {}, action)
      const own = matches.filter(value => inContext(value, context))
      if (!own.length) {
        if (matches.some(value => value.accountId === context.accountId && value.scope === 'global')) return fail('FORBIDDEN', 'mailbox principals cannot manage account-wide filters')
        return fail('NOT_FOUND', 'resource not found')
      }
      if (own.length !== 1) return fail('CONFLICT', 'saved filter identity is ambiguous')
      return { target: own[0]!, context }
    }
    const visible = await ports.scopedRecords(caller, matches)
    if (!visible.length) { await ports.assertRecordAccount(caller, matches[0], action); return fail('NOT_FOUND', 'resource not found') }
    if (visible.length !== 1) return fail('CONFLICT', 'saved filter identity is ambiguous')
    const target = visible[0]!
    await ports.assertRecordAccount(caller, target, action)
    if (target.accountId === null || target.scope !== 'global' && target.scope !== 'mailbox') return fail('PRECONDITION_FAILED', 'legacy filter context requires review')
    const context = await authorize(caller, { accountId: target.accountId, scope: target.scope, mailbox: typeof target.mailbox === 'string' ? target.mailbox : null }, action)
    if (!inContext(target, context)) return fail('PRECONDITION_FAILED', 'legacy filter context requires review')
    return { target, context }
  }
  /** Each rule's host state: an account-wide rule is live only when every mailbox script carries it. */
  const decorate = (body: Record<string, unknown>, status: MailRoutingStatusView): Record<string, unknown> => {
    const one = (value: unknown): unknown => {
      if (!object(value) || typeof value.id !== 'string' || typeof value.accountId !== 'string') return value
      const target = value.scope === 'mailbox' && typeof value.mailbox === 'string' ? { mailbox: value.mailbox } : { accountId: value.accountId }
      return { ...value, application: status.record('filter', value.id, target) }
    }
    return { ...body, ...(Array.isArray(body.filters) ? { filters: body.filters.map(one) } : {}), ...(body.filter ? { filter: one(body.filter) } : {}),
      application: { generationId: status.generationId } }
  }
  /**
   * Runs a sample message through the rules the host runs for the scope: a mailbox gets the account-wide
   * rules first, then its own. Account-wide rules the caller may not read show only whether they matched,
   * the kinds of action they ran, and no names, values or redirect addresses.
   */
  const dryRun = async (caller: AuthenticatedCaller, body: Record<string, unknown>, url: URL): Promise<Record<string, unknown>> => {
    if (Object.keys(body).some(key => !['accountId', 'scope', 'mailbox', 'message'].includes(key))) return fail('VALIDATION', 'unknown filter test field')
    const context = await authorize(caller, hints(url, body), 'mail.filter.read')
    const message = validateSampleMessage(body.message)
    const values = await load()
    const accountWide: FilterScopeContext = { accountId: context.accountId, scope: 'global', mailbox: null }
    let shown = true
    if (context.scope === 'mailbox') {
      if (isMailboxPrincipal(caller)) shown = false
      else try { await authorize(caller, accountWide, 'mail.filter.read') } catch (error) { if (!object(error) || !['FORBIDDEN', 'NOT_FOUND'].includes(String(error.code))) throw error; shown = false }
    }
    const rules: { rule: ValidatedFilterRule; hidden: boolean }[] = []
    try {
      if (context.scope === 'mailbox') rules.push(...selected(values, accountWide).map(value => ({ rule: validateStoredFilterRule(value, accountWide), hidden: !shown })))
      rules.push(...selected(values, context).map(value => ({ rule: validateStoredFilterRule(value, context), hidden: false })))
    } catch { return fail('CONFLICT', 'a saved filter is blocked; repair it before a test', { stateChanged: false }) }
    const active = rules.filter(entry => entry.rule.enabled)
    const trace: services.FilterTrace = services.traceMailFilters(active.map(entry => services.mailFilterOf(entry.rule as unknown as Record<string, unknown>)), message)
    const projected = trace.rules.map(step => {
      const { rule, hidden } = active[step.index]!
      const ran = rule.actions.slice(0, step.ran.length)
      return hidden
        ? { id: null, name: null, scope: rule.scope, hidden: true, matched: step.matched, stopped: step.stopped, tests: [], actions: ran.map(action => ({ type: action.type })) }
        : { id: rule.id, name: rule.name, scope: rule.scope, hidden: false, matched: step.matched, stopped: step.stopped,
            tests: step.tests.map((test, index) => ({ ...rule.conditions[index]!, actual: test.actual, matched: test.matched })), actions: ran }
    })
    const { folders, discarded, rejected, markedRead } = trace.outcome
    return { context, rules: projected, notRun: active.length - projected.length,
      outcome: { folders, discarded, rejected, markedRead, stopped: trace.outcome.stoppedAt !== null,
        redirects: projected.flatMap(step => step.actions.filter(action => action.type === 'redirect').map(action => ('target' in action ? action.target ?? null : null))) } }
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const base = '/api/mail/filters'
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return null
    const suffix = url.pathname === base ? null : url.pathname.slice(base.length + 1)
    if (suffix?.includes('/') || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return null
    if (method === 'GET' && suffix || method === 'POST' && suffix && suffix !== 'reorder' && suffix !== 'test' || method === 'PATCH' && !suffix) return null
    let caller = await ports.requireCaller(req)
    if (method === 'GET') {
      const selection = hints(url)
      const values = await load()
      if (isMailboxPrincipal(caller) || selection.scope !== undefined || selection.mailbox !== undefined) return json(decorate(view(values, await authorize(caller, selection, 'mail.filter.read')), await ports.readRoutingStatus()))
      if (selection.accountId !== undefined) {
        const account = await accountFor(caller, selection.accountId, 'mail.filter.read')
        return json(decorate(await inventory(caller, values.filter(value => row(value) && value.accountId === account.id)), await ports.readRoutingStatus()))
      }
      return json(decorate(await inventory(caller, values), await ports.readRoutingStatus()))
    }
    const body = await readBody(req)
    if (suffix === 'test') return json(await dryRun(caller, body, url))
    const lease = await ports.store.getWriterLock().acquire()
    let response: Record<string, unknown>
    let audit: { action: string; target: string; detail: Record<string, unknown> }
    let status = 200
    let writeAttempted = false
    let revision = 0
    let previous: unknown[] | null = null
    const persist = async (values: readonly unknown[]): Promise<void> => {
      await lease.assertFencingToken()
      writeAttempted = true
      await ports.writeFilters(values)
      revision = await ports.commitRoutingRevision(lease)
    }
    try {
      caller = await ports.requireCaller(req)
      const values = await load()
      previous = values
      if (method === 'POST' && suffix !== 'reorder') {
        const context = await authorize(caller, hints(url, body), 'mail.filter.create')
        const records = selected(values, context)
        revisionMatches(body, filterRevision(context, records), false)
        if (records.length >= MAX_FILTER_RULES) return fail('LIMIT_EXCEEDED', 'filter scope safety limit reached')
        const nextPriority = records.reduce((value, current) => typeof current.priority === 'number' && Number.isInteger(current.priority) ? Math.max(value, current.priority) : value, 0) + 1
        const draft = validateFilterDraft(content(body), { priority: nextPriority })
        const created: ValidatedFilterRule = { ...draft, ...context, id: randomUUID(), createdAt: new Date().toISOString() }
        const saved = { ...created, compiledSieve: compileValidatedFilters([created], context) }
        const next = [...values, saved]
        compileValidatedFilters(selected(next, context), context)
        response = { ...view(next, context), filter: project(saved, context) }; status = 201
        await persist(next)
        audit = { action: 'mail.filter.created', target: 'sieve-filter:' + saved.name, detail: { context } }
      } else if (method === 'POST') {
        const context = await authorize(caller, hints(url, body), 'mail.filter.reorder')
        if (Object.keys(body).some(key => !['accountId', 'scope', 'mailbox', 'orderedIds', 'expectedRevision'].includes(key))) return fail('VALIDATION', 'unknown reorder field')
        const records = selected(values, context)
        revisionMatches(body, filterRevision(context, records), true)
        const ids = body.orderedIds
        if (!Array.isArray(ids) || ids.length !== records.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length || records.some(value => !ids.includes(value.id))) return fail('VALIDATION', 'orderedIds must contain the exact selected filter ID set')
        if (new Set(records.map(value => value.id)).size !== records.length) return fail('CONFLICT', 'saved filter identities are ambiguous')
        const replacements = new Map<unknown, Row>()
        for (const [index, id] of ids.entries()) {
          const current = records.find(value => value.id === id)!
          const valid = validateStoredFilterRule(current, context)
          const saved = { ...valid, priority: index + 1, compiledSieve: '' }
          saved.compiledSieve = compileValidatedFilters([saved], context)
          replacements.set(current, saved)
        }
        const next = values.map(value => replacements.get(value) ?? value)
        compileValidatedFilters(selected(next, context), context)
        response = { ...view(next, context), ok: true }
        await persist(next)
        audit = { action: 'mail.filter.reordered', target: 'sieve-filter-scope:' + context.scope, detail: { context, count: ids.length } }
      } else {
        const selectors = [suffix, Object.hasOwn(body, 'id') ? body.id : null, url.searchParams.get('id')].filter(value => value !== null)
        if (selectors.some(value => typeof value !== 'string') || new Set(selectors).size > 1) return fail('VALIDATION', 'conflicting filter ID selectors')
        const id = selectors[0] as string | undefined
        if (!id || id === 'reorder') return fail('VALIDATION', 'filter ID is required')
        const { target, context } = await targetContext(caller, values, id, 'mail.filter.' + (method === 'PATCH' ? 'update' : 'delete'))
        revisionMatches(body, filterRevision(context, selected(values, context)), true)
        if (method === 'PATCH') {
          const patch = validateFilterPatch(body)
          const current = validateStoredFilterRule(target, context)
          const saved = { ...current, ...patch, compiledSieve: '' }
          saved.compiledSieve = compileValidatedFilters([saved], context)
          const next = values.map(value => value === target ? saved : value)
          compileValidatedFilters(selected(next, context), context)
          response = { ...view(next, context), filter: project(saved, context), ok: true }
          await persist(next)
          audit = { action: 'mail.filter.updated', target: 'sieve-filter:' + saved.name, detail: { context } }
        } else {
          if (Object.keys(body).some(key => !['id', 'expectedRevision'].includes(key))) return fail('VALIDATION', 'unknown removal field')
          const next = values.filter(value => value !== target)
          response = { ...view(next, context), ok: true }
          await persist(next)
          audit = { action: 'mail.filter.deleted', target: 'sieve-filter:' + id, detail: { context } }
        }
      }
    } catch (error) {
      if (writeAttempted) return fail('CONFLICT', 'filter write requires verification before another change', { stateChanged: true, verificationRequired: true })
      throw error
    } finally { await lease.release() }
    const routing = await ports.applyFilters(caller, revision, previous)
    try { await ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, outcome: 'ok', ...audit!, detail: { ...audit!.detail, revision } }) }
    catch { return fail('CONFLICT', 'saved filter audit requires verification before another change', { stateChanged: true, verificationRequired: true }) }
    return json(decorate(response!, routing), status)
  }
}