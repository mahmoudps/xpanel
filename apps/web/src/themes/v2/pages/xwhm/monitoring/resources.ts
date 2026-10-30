import { actions, button, context, facts, help, link, markerFacts, page, section, status, table, esc, type WhmObservationInput } from './common.ts'

export function renderV2WhmTraffic(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'traffic-summary', msgid('Network traffic'), help(t, msgid('Read two kernel interface samples 1 second apart. Loopback is listed separately. Reads do not run in the background.'))
    + actions(button(t, msgid('Read traffic'), { 'data-traffic-refresh': true }, false, true))
    + status(t, msgid('Traffic has not been read.'), { 'data-traffic-status': true })
    + markerFacts(t, [['observed', msgid('Observed at (UTC)')], ['interval', msgid('Sample interval')]], 'traffic'))
    + section(t, 'traffic-interfaces', msgid('Interfaces'), table(t, msgid('Interfaces'), [msgid('Interface'), msgid('Receive (bytes/s)'), msgid('Send (bytes/s)'), msgid('State')], { 'data-traffic-table': 'interfaces' }))
    + section(t, 'traffic-sites', msgid('HTTP traffic from saved site logs'), help(t, msgid('A bounded tail of up to 32 configured site logs, 64 KiB each. These are recorded request totals within the available log tails, not live network rates or monthly billing usage. Shared aliases use the same log and are counted once.'))
      + help(t, msgid('Log coverage has not been read.'), { 'data-traffic-coverage': true })
      + table(t, msgid('Top domains by bytes sent'), [msgid('Domain'), msgid('Account'), msgid('Requests'), msgid('Received bytes'), msgid('Sent bytes'), '4xx / 5xx'], { 'data-traffic-table': 'domains' })
      + table(t, msgid('Account totals'), [msgid('Account'), msgid('Requests'), msgid('Received bytes'), msgid('Sent bytes'), '4xx / 5xx'], { 'data-traffic-table': 'accounts' }))
    + section(t, 'traffic-history', msgid('History'), help(t, msgid('Network-rate history is unavailable: the current metrics writer does not record interface network counters. No missing sample is displayed as zero.')) + actions(link(t, msgid('Open performance history'), '/whm/monitoring/performance')))
  return page(input, '/whm/monitoring/traffic', msgid('Traffic monitor'), msgctxt('theme:v2', 'Kernel interface rates and saved site-log totals retain their distinct meanings.'), body, { 'data-whm-traffic': true, 'data-can-read': String(canRead) })
}

export function renderV2WhmIo(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'io-usage', msgid('Resource usage'), help(t, msgid('Account resources and configured limits.'))
    + actions(button(t, msgid('Read resources'), { 'data-whm-metering-refresh': true }, canRead, true))
    + status(t, msgid('Resource usage has not been read.'), { 'data-whm-metering-status': true })
    + facts(t, [['observed', msgid('Sampled at (UTC)')], ['read', msgid('Account read total')], ['write', msgid('Account write total')], ['iops', msgid('Account IOPS total')], ['latency', msgid('Disk latency')], ['pressure', msgid('IO pressure')], ['host', msgid('Host CPU and memory')]], 'data-whm-metering-fact'))
    + section(t, 'io-history', msgid('Read and write history'), help(t, msgid('Account IO history is not recorded. Each read shows the latest sample; host history is in Performance history.')) + actions(link(t, msgid('Open performance history'), '/whm/monitoring/performance')))
    + section(t, 'io-devices', msgid('Disk devices'), help(t, msgid('Average wait per completed operation and busy time over the last host sample interval, from /proc/diskstats.'))
      + table(t, msgid('Disk devices'), [msgid('Device'), msgid('Read wait'), msgid('Write wait'), msgid('Busy')], { 'data-whm-metering-rows': 'devices' }, msgid('No disk devices have been read.'), [1, 2, 3]))
    + section(t, 'io-accounts', msgid('Account resources'), help(t, msgid('Not read'), { 'data-whm-metering-count': true })
      + table(t, msgid('Account resources'), [msgid('Account'), msgid('Read / write'), 'IOPS', msgid('Memory'), msgid('CPU (% of 1 core)'), msgid('Processes')], { 'data-whm-metering-rows': 'io' }, msgid('No account resources have been read.'), [1, 2, 3, 4, 5]))
  return page(input, '/whm/monitoring/io', msgid('IO monitor'), msgctxt('theme:v2', 'Latest account samples and host disk latency; missing IO history remains explicit.'), body, { 'data-whm-metering': 'io', 'data-metering-can-read': String(canRead) })
}

export function renderV2WhmServerInfo(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'server-info', msgid('Server information'), `<div ${canRead ? 'data-host-info="true"' : 'data-host-info-unread="true"'}><dl class="v2-observation__facts" data-host-info-grid="true">${[[msgid('Load'), 'data-host-load'], [msgctxt('theme:v2', 'Available memory / total'), 'data-host-memory'], [msgctxt('theme:v2', 'Available disk / total'), 'data-host-disk']].map(([label, hook]) => `<div><dt>${esc(t(label!))}</dt><dd><bdi dir="ltr" ${hook}="true">${esc(t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl><p data-host-info-status role="status">${esc(t(msgid('Not read')))}</p></div>`)
    + section(t, 'server-identity', msgctxt('theme:v2', 'Saved server identity'), help(t, msgctxt('theme:v2', 'Saved identity is distinct from live host observations.'))
      + `<dl class="v2-observation__facts">${[[msgid('Hostname'), canRead ? input.hostname : undefined], [msgid('Panel version'), canRead ? input.version : undefined], [msgid('System'), canRead ? input.hostSample?.system : undefined], [msgid('Kernel'), canRead ? input.hostSample?.kernel : undefined]].map(([label, value]) => `<div><dt>${esc(t(label!))}</dt><dd><bdi dir="ltr">${esc(value ?? t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`)
  // The existing reader has no can-read hook: do not mount it for an unauthorized document.
  return page(input, '/whm/monitoring/server-info', msgid('Server information'), msgctxt('theme:v2', 'Read host resources without turning absent values into healthy zeroes.'), body)
}
