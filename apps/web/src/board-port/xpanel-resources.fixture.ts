// Board sample data for the pixel gate only. Product code must not import this module.
import { resourcesNav, type IoBar, type IoPanel, type LimitRow, type ProcRow, type ResourcesView } from './xpanel-resources.ts'

const MONO = "'IBM Plex Mono', monospace"

const enforced = (on: boolean): Pick<LimitRow, 'appliedColor' | 'chipText' | 'chipBg' | 'chipFg' | 'dotBg' | 'dotBorder'> => on
  ? { appliedColor: '#101828', chipText: 'Enforced', chipBg: '#E7F5EE', chipFg: '#0E7A4E', dotBg: '#0E7A4E', dotBorder: 'none' }
  : { appliedColor: '#5D6B7E', chipText: 'Not enforced', chipBg: '#EEF0F3', chipFg: '#344054', dotBg: 'transparent', dotBorder: '1.5px solid #344054' }

const limit = (name: string, sub: string, plan: string, applied: string, on: boolean, live: string, pct: number): LimitRow => {
  const tone = pct >= 95 ? '#B42318' : pct >= 80 ? '#B54708' : '#1D5BD6'
  return {
    name, sub, plan, applied, ...enforced(on),
    live, liveColor: '#101828',
    pct: `${pct}%`, pctText: `${pct}%`,
    barColor: on ? tone : '#5D6B7E',
    pctColor: pct >= 80 ? '#B54708' : '#475467',
  }
}

const series = (id: 'write' | 'read', label: string, cap: number, values: number[], times: string[]): IoPanel => {
  const peak = Math.max(...values)
  const peakAt = times[values.indexOf(peak)] ?? times[0] ?? ''
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  const scaleMax = Math.max(cap, peak) * 1.1
  const plot = 150
  const axis = 22
  const bars: IoBar[] = values.map((value, index) => {
    const atCap = value >= cap
    return {
      value: value.toFixed(1),
      time: times[index] ?? '',
      h: `${Math.max(2, Math.round((value / scaleMax) * plot))}px`,
      color: atCap ? '#B54708' : '#1D5BD6',
      labelColor: atCap ? '#B54708' : '#344054',
      labelWeight: atCap ? '600' : '500',
    }
  })
  const capPx = Math.round((cap / scaleMax) * plot) + axis
  return {
    id,
    label,
    selected: id === 'write',
    tabId: `io-tab-${id}`,
    capLabel: `Cap ${cap} MB/s`,
    capBottom: `${capPx}px`,
    capLabelBottom: `${capPx + 3}px`,
    listLabel: `${label} in MB/s, five-minute averages from 13:10 to 14:05 UTC`,
    bars,
    caption: peak >= cap
      ? `Writes reached the ${cap} MB/s cap at ${peakAt}. The kernel held them at the cap, so other accounts on /dev/sda kept their share. Bars in orange sit at the cap.`
      : `${id === 'read' ? 'Reads' : 'Writes'} peaked at ${peak.toFixed(1)} MB/s at ${peakAt}, well under the ${cap} MB/s cap.`,
    avg: `${avg.toFixed(1)} MB/s`,
    peak: `${peak.toFixed(1)} MB/s at ${peakAt}`,
    now: `${(values[values.length - 1] ?? 0).toFixed(1)} MB/s`,
  }
}

const mono = (text: string): string => `<span style="font-family: ${MONO}">${text}</span>`
const code = (text: string): string => `<code style="font-family: ${MONO}">${text}</code>`
const pill = (text: string, tone: 'ok' | 'neutral'): string => tone === 'ok'
  ? `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; background: #E7F5EE; color: #0E7A4E; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: #0E7A4E"></span>${text}</span>`
  : `<span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${text}</span>`

const procs: ProcRow[] = [
  { pid: '4181', cmd: 'php-fpm: master process (/etc/xpanel/php/8.3/fpm/alice.conf)', unit: 'xpanel-fpm@alice-8.3.service', kind: 'PHP-FPM pool', user: 'alice', cpu: '0.0%', mem: '14 MB', started: '2026-10-22 06:00' },
  { pid: '4182', cmd: 'php-fpm: pool alice-8.3', unit: 'xpanel-fpm@alice-8.3.service', kind: 'PHP-FPM worker', user: 'alice', cpu: '5.2%', mem: '52 MB', started: '2026-10-22 13:52' },
  { pid: '4183', cmd: 'php-fpm: pool alice-8.3', unit: 'xpanel-fpm@alice-8.3.service', kind: 'PHP-FPM worker', user: 'alice', cpu: '4.1%', mem: '49 MB', started: '2026-10-22 13:52' },
  { pid: '4190', cmd: 'php-fpm: pool alice-8.3', unit: 'xpanel-fpm@alice-8.3.service', kind: 'PHP-FPM worker', user: 'alice', cpu: '3.6%', mem: '47 MB', started: '2026-10-22 13:58' },
  { pid: '5120', cmd: 'node /home/alice/apps/shop-api/server.js', unit: 'xpanel-app@shop-api.service', kind: 'Node.js app shop-api', user: 'alice', cpu: '8.3%', mem: '168 MB', started: '2026-10-19 08:12' },
  { pid: '6011', cmd: '/usr/bin/php8.3 /home/alice/public_html/cron/sync-stock.php', unit: 'xpanel-cron-alice-3.service', kind: 'started by xpanel-cron-alice-3.timer', user: 'alice', cpu: '1.8%', mem: '38 MB', started: '2026-10-22 14:05' },
]

/** English sample copied from the resources board. Not a product route. */
export const resourcesBoardView = (): ResourcesView => {
  const times = ['13:10', '13:15', '13:20', '13:25', '13:30', '13:35', '13:40', '13:45', '13:50', '13:55', '14:00', '14:05']
  return {
    ar: false,
    reload: false,
    username: 'alice',
    domain: 'alice-shop.com',
    planLabel: 'Business',
    diskLabel: 'Disk',
    diskValue: '3.2 / 10 GB',
    diskPct: 32,
    procLabel: 'Processes',
    procValue: '38 / 128',
    procPct: 30,
    nav: resourcesNav(false),
    searchLabel: 'Find a tool, domain or mailbox',
    searchPlaceholder: 'Find a tool',
    crumbHome: 'Home',
    crumbCurrent: 'Resources & quotas',
    title: 'Resources & quotas',
    lede: 'What your Business plan allows, what this host applies to your slice, and what you use right now.',
    updated: 'Updated 2026-10-22 14:05:12 UTC',
    refreshed: 'Updated 2026-10-22 14:05:22 UTC',
    refreshLabel: 'Refresh live values',
    liveError: null,
    cpuBannerHtml: `CPU is not enforced on this host: the ${code('cpu')} controller is not enabled for ${code('xpanel.slice')}. Your plan value is saved and takes effect once the server administrator enables it. Every other limit is enforced.`,
    sliceTitle: 'xpanel-20014.slice',
    activeLabel: 'Active',
    activeBg: '#E7F5EE',
    activeFg: '#0E7A4E',
    cgroupPill: 'cgroup v2',
    uidPill: 'uid 20014',
    sliceBodyHtml: `Your systemd slice. The PHP pool, the Node app, cron jobs and shell sessions of ${mono('alice')} run inside it, so a busy site here cannot slow down the other accounts on ${mono('srv1.xpanel.test')}.`,
    unitShow: 'Show unit file',
    unitHide: 'Hide unit file',
    unitEnabled: true,
    soonHint: 'Coming soon',
    facts: [
      { label: 'cgroup path', valueHtml: mono('/sys/fs/cgroup/xpanel.slice/xpanel-20014.slice') },
      { label: 'Controllers', valueHtml: `${mono('io memory pids')} <span style="color: #5D6B7E">· ${mono('cpu')} not enabled</span>` },
      { label: 'Identity', valueHtml: mono('alice · uid 20014 · gid 20014') },
      { label: 'Applied', valueHtml: '<span style="font-variant-numeric: tabular-nums">Generation 142 · 2026-10-22 13:52 UTC</span>' },
    ],
    unitPre: `# /etc/systemd/system/xpanel-20014.slice
# Written by the reconciler, generation 142
[Unit]
Description=xPanel account alice (uid 20014)

[Slice]
MemoryMax=1024M
TasksMax=128
CPUQuota=100%
IOReadBandwidthMax=/dev/sda 50M
IOWriteBandwidthMax=/dev/sda 20M
IOReadIOPSMax=/dev/sda 1000
IOWriteIOPSMax=/dev/sda 500`,
    unitNoteHtml: `Read only. The reconciler owns this file; change limits through your plan. ${code('CPUQuota')} is written but has no effect until the ${code('cpu')} controller is enabled.`,
    limitsTitle: 'Limits on your slice',
    limitsLedeHtml: 'Plan value is what Business allows. Applied on host is what the reconciler wrote in generation 142, read back from the kernel.',
    liveNote: 'Live values refresh every 10 s',
    columns: ['Limit', 'Plan value', 'Applied on host', 'State', 'Live usage'],
    caption: 'Limits, applied values and live usage of xpanel-20014.slice',
    limits: [
      limit('Disk space', 'Files in /home/alice, filesystem quota', '10 GB', 'usrquota /home · hard 10 GB', true, '3.2 GB', 32),
      limit('Monthly bandwidth', 'HTTP traffic counted from Nginx logs', '100 GB', 'agent meter · resets 2026-11-01', true, '86 GB', 86),
      limit('IO read bandwidth', 'Bytes read from /dev/sda per second', '50 MB/s', 'io.max 8:0 rbps=52428800', true, '6.8 MB/s', 14),
      limit('IO write bandwidth', 'Bytes written to /dev/sda per second', '20 MB/s', 'io.max 8:0 wbps=20971520', true, '4.1 MB/s', 21),
      limit('Read IOPS', 'Read operations per second', '1000', 'io.max 8:0 riops=1000', true, '140', 14),
      limit('Write IOPS', 'Write operations per second', '500', 'io.max 8:0 wiops=500', true, '85', 17),
      limit('Memory', 'Resident memory and page cache', '1024 MB', 'memory.max 1073741824', true, '412 MB', 40),
      limit('Processes', 'Processes and their threads', '128', 'pids.max 128', true, '38', 30),
      limit('CPU', 'Share of one core, measured from cpu.stat', '1 core', 'none · cpu controller not enabled', false, '0.23 core', 23),
    ],
    limitsFootHtml: `Cgroup values are read from ${code('/sys/fs/cgroup/xpanel.slice/xpanel-20014.slice')} every 10 s; disk usage comes from the filesystem quota. At the disk cap, uploads stop with a clear message instead of a half-written file.`,
    ioTitle: 'Disk IO, last hour',
    ioLedeHtml: `Five-minute averages from ${code('io.stat')} on ${code('/dev/sda')}. The dashed line is your cap.`,
    statLabels: ['Average', 'Peak', 'Now', 'Cap'],
    ioPanels: [
      series('write', 'Write bandwidth', 20, [3.2, 2.8, 4.5, 6.1, 18.7, 20.0, 9.4, 3.9, 4.4, 5.2, 3.6, 4.1], times),
      series('read', 'Read bandwidth', 50, [5.1, 4.8, 6.0, 7.2, 12.5, 11.8, 8.1, 6.4, 6.9, 7.0, 6.2, 6.8], times),
    ],
    procTitle: 'Processes in your slice',
    procLedeHtml: `6 processes, 38 tasks. Threads count toward ${code('TasksMax')} 128, which is why tasks outnumber rows.`,
    procHeaders: ['PID', 'Command and unit', 'User', 'CPU', 'Memory', 'Started (UTC)'],
    procs,
    procEmptyTitle: 'Process list unavailable',
    procEmptyBody: 'The agent did not answer. Your processes keep running; the list returns when the agent replies.',
    identityTitleHtml: `Who serves ${mono('alice-shop.com').replace('monospace">', 'monospace; font-size: 15px">')}`,
    identityLedeHtml: `Every request reaches your files as ${mono('alice')}. Nginx only proxies; it never opens files in your home.`,
    steps: [
      {
        titleHtml: '<span style="font-size: 14px; font-weight: 600">Nginx</span>',
        pillHtml: pill('Proxy only', 'neutral'),
        bodyHtml: `Runs as ${code('www-data')}, terminates TLS on 443 and forwards to Apache on ${code('127.0.0.1:8080')}, a port closed in the firewall. Your home is mode ${code('750')}, so Nginx cannot read it.`,
      },
      {
        titleHtml: '<span style="font-size: 14px; font-weight: 600">Apache with mpm-itk</span>',
        pillHtml: pill('Runs as alice', 'ok'),
        bodyHtml: `The child that serves your host switches to ${code('alice')} (uid 20014) with ${code('AssignUserId')} before it reads ${code('.htaccess')} or any file.`,
      },
      {
        titleHtml: `<span style="font-size: 14px; font-weight: 600">PHP-FPM pool <span style="font-family: ${MONO}; font-size: 13px">alice-8.3</span></span>`,
        pillHtml: pill('In your slice', 'ok'),
        bodyHtml: `Runs as ${code('alice')} inside ${code('xpanel-20014.slice')}. Apache hands PHP to it over ${code('proxy_fcgi')}.`,
      },
    ],
    vhostLabel: 'Virtual host, generation 142',
    vhost: `<VirtualHost 127.0.0.1:8080>
  ServerName alice-shop.com
  ServerAlias www.alice-shop.com
  DocumentRoot /home/alice/public_html
  AssignUserId alice alice
  <FilesMatch \\.php$>
    SetHandler "proxy:unix:/run/xpanel/php/alice-8.3.sock|fcgi://localhost"
  </FilesMatch>
</VirtualHost>`,
    identityFacts: [
      { label: 'Home permissions', valueHtml: `<span style="font-family: ${MONO}">750 dirs · 640 files</span>` },
      { label: 'open_basedir', valueHtml: `<span style="font-family: ${MONO}">/home/alice:/home/alice/tmp</span>` },
      { label: 'Private /tmp', valueHtml: `<span style="font-family: ${MONO}">PrivateTmp=yes</span>` },
      { label: 'MariaDB user', valueHtml: `sees only ${mono('alice_*')}` },
    ],
    verifiedHtml: `Verified 2026-10-22 13:52 UTC: a test request to ${code('alice-shop.com')} was served by uid 20014.`,
  }
}
