/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
const NETTOOLS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NETTOOLS_TOOLS = ['dns', 'ping', 'traceroute', 'port']
const NETTOOLS_DNS = ['answer', 'nxdomain', 'nodata', 'servfail', 'refused', 'timeout', 'failed']
export interface NetworkToolsDnsResult { status: string; records: string[]; truncated: boolean }
export interface NetworkToolsPingResult { transmitted: number; received: number; errors: number; lossPercent: number; rtt: { minMs: number; avgMs: number; maxMs: number } | null }
export interface NetworkToolsHop { hop: number; address: string | null; nonPublic: boolean; rttMs: number | null; note: string | null }
export interface NetworkToolsClientView {
  tool: string; query: Record<string, string | number>; outcome: 'completed' | 'refused' | 'unresolved'; target: { address: string; family: number } | null; observedAt: string
  result: NetworkToolsDnsResult | NetworkToolsPingResult | { hops: NetworkToolsHop[]; reached: boolean } | { state: string; elapsedMs: number } | null
}
export function nettoolsObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const nettoolsCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const nettoolsMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e6
const nettoolsAddress = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f:.]{2,45}$/.test(value)

/** Strict reply for the request just sent: same account, tool and query (the server lowercases names and compresses IPv6). */
export function readNetworkToolsView(value: unknown, accountId: string, tool: string, sent: Record<string, string | number>): NetworkToolsClientView {
  if (!NETTOOLS_ID.test(accountId) || !NETTOOLS_TOOLS.includes(tool) || !nettoolsObject(value) || !nettoolsObject(value.context) || !nettoolsObject(value.query) || Object.keys(value).length !== 6) throw new Error('invalid_nettools_scope')
  const { context, query, outcome, target, result } = value
  if (context.accountId !== accountId || context.tool !== tool || Object.keys(query).join() !== Object.keys(sent).join() || typeof value.observedAt !== 'string' || value.observedAt.length > 64) throw new Error('invalid_nettools_scope')
  for (const key of Object.keys(sent)) {
    const mine = sent[key], theirs = query[key]
    if (typeof mine === 'number' ? theirs !== mine : typeof theirs !== 'string' || theirs.length > 253 || theirs !== String(mine) && theirs !== String(mine).toLowerCase().replace(/\.$/, '') && !(theirs.includes(':') && nettoolsAddress(theirs))) throw new Error('invalid_nettools_query')
  }
  if (outcome === 'refused' || outcome === 'unresolved') { if (target !== null || result !== null || tool === 'dns') throw new Error('invalid_nettools_outcome') }
  else if (outcome !== 'completed' || !nettoolsObject(result) || (tool === 'dns' ? target !== null : !nettoolsObject(target) || !nettoolsAddress(target.address) || target.family !== (target.address.includes(':') ? 6 : 4))) throw new Error('invalid_nettools_outcome')
  else if (tool === 'dns') {
    if (!NETTOOLS_DNS.includes(result.status as string) || typeof result.truncated !== 'boolean' || !Array.isArray(result.records) || result.records.length > 50 || result.records.some(record => typeof record !== 'string' || record.length > 2049 || /[\r\n]/.test(record))) throw new Error('invalid_nettools_dns')
  } else if (tool === 'ping') {
    const rtt = result.rtt
    if (!nettoolsCount(result.transmitted, 20) || !nettoolsCount(result.received, result.transmitted) || !nettoolsCount(result.errors, 999) || typeof result.lossPercent !== 'number' || result.lossPercent < 0 || result.lossPercent > 100
      || !(rtt === null ? result.received === 0 : nettoolsObject(rtt) && nettoolsMs(rtt.minMs) && nettoolsMs(rtt.avgMs) && nettoolsMs(rtt.maxMs))) throw new Error('invalid_nettools_ping')
  } else if (tool === 'traceroute') {
    if (typeof result.reached !== 'boolean' || !Array.isArray(result.hops) || result.hops.length < 1 || result.hops.length > 20 || result.hops.some((hop, index) => !nettoolsObject(hop) || hop.hop !== index + 1 || typeof hop.nonPublic !== 'boolean'
      || !(hop.address === null || nettoolsAddress(hop.address)) || !(hop.rttMs === null || nettoolsMs(hop.rttMs)) || !(hop.note === null || typeof hop.note === 'string' && hop.note.length <= 9))) throw new Error('invalid_nettools_trace')
  } else if (!['open', 'closed', 'filtered'].includes(result.state as string) || !nettoolsCount(result.elapsedMs, 60000)) throw new Error('invalid_nettools_port')
  return value as unknown as NetworkToolsClientView
}

function bindAccountNetworkTools(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-network-tools]').forEach(root => {
    if (root.dataset.nettoolsBound === 'true') return
    root.dataset.nettoolsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.nettoolsManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-nettools-' + key + ']')!
    const tool = find<HTMLSelectElement>('tool'), host = find<HTMLInputElement>('host'), type = find<HTMLSelectElement>('type'), port = find<HTMLInputElement>('port'), run = find<HTMLButtonElement>('run')
    const head = find('head'), rows = find('rows'), summary = find('summary'), status = find('status'), targetText = find('target'), addressText = find('address'), atText = find('at')
    if (!tool || !host || !type || !port || !run || !head || !rows || !summary || !status || !targetText || !addressText || !atText) return
    let busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'invalid' ? 'alert' : 'status') }
    const lock = (): void => { for (const control of [tool, host, type, port, run]) control.disabled = !eligible() || busy; root.setAttribute('aria-busy', String(busy)) }
    const layout = (): void => { type.closest<HTMLElement>('[data-nettools-field]')!.hidden = tool.value !== 'dns'; port.closest<HTMLElement>('[data-nettools-field]')!.hidden = tool.value !== 'port' }
    const table = (labels: string[], data: readonly (readonly (readonly [string, boolean])[])[]): void => {
      head.textContent = ''; rows.textContent = ''
      const top = document.createElement('tr')
      for (const label of labels) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; top.append(th) }
      head.append(top)
      for (const cells of data) {
        const row = document.createElement('tr')
        for (const [text, technical] of cells) { const td = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = text; td.append(bdi) } else td.textContent = text; row.append(td) }
        rows.append(row)
      }
    }
    const reset = (message: string): void => { table([t('Details')], [[[message, false]]]); summary.textContent = message; for (const fact of [targetText, addressText, atText]) fact.textContent = t('Not run') }
    const paint = (view: NetworkToolsClientView): void => {
      targetText.textContent = String(view.query.host ?? view.query.name) + (view.query.port === undefined ? '' : ' : ' + String(view.query.port)); addressText.textContent = view.target?.address ?? '-'; atText.textContent = displayDateTime(view.observedAt)
      if (view.outcome !== 'completed' || !view.result) {
        const message = view.outcome === 'refused' ? t('The target is a private, loopback, link-local or reserved address, or a name that resolves to one. Only public internet addresses are tested. Nothing was sent.')
          : t('The name has no A or AAAA record, so nothing was sent.')
        table([t('Details')], [[[message, false]]]); summary.textContent = message; return
      }
      const result = view.result
      if ('records' in result) {
        const kind = String(view.query.type), text: Record<string, string> = { nxdomain: t('The name does not exist (NXDOMAIN).'), nodata: t('The name has no {kind} records.', { kind }),
          servfail: t('The DNS server failed to answer (SERVFAIL).'), refused: t('The DNS server refused the query.'), timeout: t('The DNS lookup timed out.'), failed: t('The DNS lookup failed.') }
        table([t('Type'), t('Value')], result.records.map(record => [[kind, true], [record, true]] as const))
        summary.textContent = result.status === 'answer' ? t('{count} records found.', { count: result.records.length }) + (result.truncated ? ' ' + t('The answer was shortened.') : '') : text[result.status] ?? ''
      } else if ('transmitted' in result) {
        const rtt = result.rtt ? String(result.rtt.minMs) + ' / ' + String(result.rtt.avgMs) + ' / ' + String(result.rtt.maxMs) : '-'
        table([t('Measure'), t('Value')], [[[t('Probes sent'), false], [String(result.transmitted), true]], [[t('Replies received'), false], [String(result.received), true]],
          [[t('Packet loss (%)'), false], [String(result.lossPercent), true]], [[t('Errors'), false], [String(result.errors), true]], [[t('Round trip min / avg / max (ms)'), false], [rtt, true]]])
        summary.textContent = result.received ? t('The target replied to {received} / {transmitted} probes.', { received: result.received, transmitted: result.transmitted }) : t('The target did not reply. It may be down or may block ping.')
      } else if ('hops' in result) {
        table([t('Hop'), t('Address'), t('Round trip (ms)'), t(msgctxt('account-network-tools-client', 'Note'))], result.hops.map(hop => [[String(hop.hop), true],
          hop.address ? [hop.address, true] : [hop.nonPublic ? t('Private network (hidden)') : t('No reply'), false], [hop.rttMs === null ? '-' : String(hop.rttMs), true], [hop.note ?? '-', true]] as const))
        summary.textContent = result.reached ? t('Reached the target in {count} hops.', { count: result.hops.length }) : t('The target did not answer the trace after {count} hops. Routers that do not answer show as no reply.', { count: result.hops.length })
      } else {
        const label = String(view.query.port), state: Record<string, string> = { open: t('Open'), closed: t('Closed'), filtered: t('No answer') }
        table([t('Port'), t('State'), t('Time (ms)')], [[[label, true], [state[result.state] ?? '', false], [String(result.elapsedMs), true]]])
        summary.textContent = result.state === 'open' ? t('Port {port} is open: the server accepted the connection.', { port: label }) : result.state === 'closed' ? t('Port {port} is closed: the connection was refused.', { port: label })
          : t('Port {port} did not answer within 3 seconds; a firewall may be dropping the connection.', { port: label })
      }
    }
    async function start(): Promise<void> {
      const selected = tool.value, target = host.value.trim()
      if (!eligible() || busy || !send || !NETTOOLS_TOOLS.includes(selected)) return
      if (!target || target.length > 253 || /\s/.test(target)) { note('invalid', t('Enter a host name or IP address without spaces.')); host.focus(); return }
      const portValue = Number(port.value)
      if (selected === 'port' && (!/^[0-9]{1,5}$/.test(port.value) || portValue < 1 || portValue > 65535)) { note('invalid', t('Enter a port from 1 to 65535.')); port.focus(); return }
      const query: Record<string, string | number> = selected === 'dns' ? { name: target, type: type.value } : selected === 'port' ? { host: target, port: portValue } : { host: target }
      busy = true; lock(); reset(t('Running…')); note('reading', t('Running the diagnostic from the server…'))
      try {
        const view = readNetworkToolsView(await send('POST', '/api/account/network-tools/' + selected, query), accountId, selected, query)
        paint(view); const [before, after] = t('Finished at {time}.').split('{time}'); note('read', before ?? ''); const observed = document.createElement('bdi'); observed.dir = 'ltr'; observed.textContent = displayDateTime(view.observedAt); status.append(observed, after ?? '')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
        reset(t('No result was read.'))
        note('failed', code === 'VALIDATION' ? t('Enter a valid host name or IP address. DNS lookup needs a domain name.')
          : code === 'LIMIT_EXCEEDED' ? t('At most 10 diagnostics can run per minute. Try again shortly.')
            : code === 'CONFLICT' ? t('Another diagnostic is still running for this account.') : t('The diagnostic could not run. Nothing was changed.'))
      } finally { busy = false; lock() }
    }
    if (!send || !eligible() || !NETTOOLS_ID.test(accountId)) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input')) control.disabled = true
      note('unavailable', t('Network tools are unavailable here. Nothing was run.')); return
    }
    tool.addEventListener('change', () => { layout(); reset(t('No diagnostic has run.')); note('unread', t('Enter a target and run the diagnostic.')) })
    run.addEventListener('click', () => { void start() })
    for (const field of [host, port]) field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void start() } })
    layout(); lock()
  })
}

export const ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const NETTOOLS_ID=${NETTOOLS_ID.toString()};const NETTOOLS_TOOLS=${JSON.stringify(NETTOOLS_TOOLS)};const NETTOOLS_DNS=${JSON.stringify(NETTOOLS_DNS)};const nettoolsObject=${nettoolsObject.toString()};const nettoolsCount=${nettoolsCount.toString()};const nettoolsMs=${nettoolsMs.toString()};const nettoolsAddress=${nettoolsAddress.toString()};const readNetworkToolsView=${readNetworkToolsView.toString()};return ${bindAccountNetworkTools.toString()};})()`
