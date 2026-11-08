// Pure parts of the web statistics run: edge log lines to the combined log format both engines read, the AWStats
// configuration, and the AWStats monthly data file reduced to the bounded report the panel shows.

/** awstats.pl on Ubuntu, then on EL from EPEL or the installer's pinned build. */
export const AWSTATS_BINARIES = ['/usr/lib/cgi-bin/awstats.pl', '/usr/share/awstats/wwwroot/cgi-bin/awstats.pl'] as const
/** The distribution package, or the installer's pinned build on EL. */
export const WEBALIZER_BINARY = '/usr/bin/webalizer'
/** Each engine's own check: a source build can outlive a library or Perl module a later package update removed. */
export const awstatsCheckArgv = (program: string): string[] => ['/usr/bin/perl', '-c', program]
export const WEBALIZER_CHECK_ARGV: readonly string[] = [WEBALIZER_BINARY, '-V']
export const isWebStatsEngineCheck = (argv: readonly string[]): boolean =>
  argv.join('\0') === WEBALIZER_CHECK_ARGV.join('\0') || AWSTATS_BINARIES.some(program => argv.join('\0') === awstatsCheckArgv(program).join('\0'))

export const WEB_STATS_ENGINES = ['awstats', 'webalizer'] as const
/** Analog is the edge-log traffic report: it has a switch and no run of its own. */
export type WebStatsGenerator = WebStatsEngine | 'analog'
export const WEB_STATS_GENERATORS: readonly WebStatsGenerator[] = ['analog', ...WEB_STATS_ENGINES]
export type WebStatsEngine = typeof WEB_STATS_ENGINES[number]
export const WEB_STATS_SCHEMES = ['http', 'https'] as const
export type WebStatsScheme = typeof WEB_STATS_SCHEMES[number]
/** Rows each report section keeps. */
export const WEB_STATS_TOP_ROWS = 25
const LINE_MAX_CHARS = 16 * 1024
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface CombinedLogLine { scheme: WebStatsScheme; month: string; text: string }

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
// Both engines split fields on spaces and quotes: a quote or control character in a value would end its field early.
const quoted = (value: string): string => value === '' ? '-' : value.replace(/["\\\u0000-\u001f\u007f]/g, ch => ch === '"' ? "'" : ch === '\\' ? '/' : ' ')
const unspaced = (value: string): string => value.replace(/[\s"\\\u0000-\u001f\u007f]/g, ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())

/** One `xpanel_metrics` JSON line (packages/render/src/edge/nginx-main.ts) as a combined log line; null when it cannot be attributed. */
export function toCombinedLog(line: string): CombinedLogLine | null {
  let v: unknown
  try { v = line.length <= LINE_MAX_CHARS ? JSON.parse(line) : null } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const time = text(r.time, 40) ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(r.time) : null
  if (!time || (r.scheme !== 'http' && r.scheme !== 'https') || !text(r.ip, 64) || !/^[0-9A-Fa-f:.]+$/.test(r.ip) || !text(r.method, 32) || !/^[A-Z]+$/.test(r.method)
    || !text(r.uri, LINE_MAX_CHARS) || !count(r.status) || r.status < 100 || r.status > 599 || !count(r.body_bytes) || !text(r.referer, LINE_MAX_CHARS) || !text(r.agent, LINE_MAX_CHARS)) return null
  const [, year, month, day, hour, minute, secondPart, zone] = time
  const monthIndex = Number(month) - 1
  if (monthIndex < 0 || monthIndex > 11) return null
  const offset = zone === 'Z' ? '+0000' : zone!.replace(':', '')
  const protocol = text(r.protocol, 16) && /^[A-Z0-9./]+$/.test(r.protocol) ? r.protocol : '-'
  return {
    scheme: r.scheme, month: `${year}-${month}`,
    text: `${r.ip} - - [${day}/${MONTHS[monthIndex]}/${year}:${hour}:${minute}:${secondPart} ${offset}] "${r.method} ${unspaced(r.uri || '/')} ${protocol}" ${r.status} ${r.body_bytes} "${quoted(r.referer)}" "${quoted(r.agent)}"\n`,
  }
}

const SITE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
export const isStatsSiteName = (name: string): boolean => name.length <= 253 && SITE.test(name)
const configPath = (value: string, label: string): string => {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes('//') || value.split('/').some(part => part === '..' || part === '.')) throw new Error('invalid ' + label)
  return value
}

export interface AwstatsConfigInput { site: string; names: readonly string[]; dataDir: string; geoipDatabase: string | null; reverseDns: boolean; include: string | null }
/** awstats.<site>.conf: the log comes on standard input; no browser-triggered updates, private data files. */
export function renderAwstatsConfig(input: AwstatsConfigInput): string {
  if (!isStatsSiteName(input.site) || input.names.some(name => !isStatsSiteName(name.replace(/^\*\./, '')))) throw new Error('invalid site name')
  const aliases = [...new Set(input.names.filter(name => name !== input.site).map(name => name.startsWith('*.') ? 'REGEX[\\.' + name.slice(2).replaceAll('.', '\\.') + '$]' : name))]
  return [
    '# Managed by xPanel: web statistics for one site; regenerated before each run.',
    'LogFile="-"', 'LogType=W', 'LogFormat=1', 'LogSeparator=" "',
    `SiteDomain="${input.site}"`, `HostAliases="${[input.site, ...aliases].join(' ')}"`,
    `DNSLookup=${input.reverseDns ? 1 : 0}`, `DirData="${configPath(input.dataDir, 'data directory')}"`, 'DirIcons="/awstatsicons"',
    'AllowToUpdateStatsFromBrowser=0', 'AllowFullYearView=2', 'SaveDatabaseFilesWithPermissionsForEveryone=0',
    'PurgeLogFile=0', 'ArchiveLogRecords=0', 'KeepBackupOfHistoricFiles=0', 'DefaultFile="index.html index.php"',
    'LevelForBrowsersDetection=2', 'LevelForOSDetection=2', 'LevelForRefererAnalyze=2', 'LevelForRobotsDetection=2', 'LevelForWormsDetection=0',
    ...(input.geoipDatabase ? [`LoadPlugin="geoip2_country ${configPath(input.geoipDatabase, 'GeoIP database')}"`] : []),
    // Last, as cPanel: the account's own settings run as the account and override the ones above.
    ...(input.include ? [`Include "${configPath(input.include, 'include file')}"`] : []),
    '',
  ].join('\n')
}

export interface AwstatsMonth {
  month: string
  lastUpdate: string | null
  visits: number; unique: number; pages: number; hits: number; bytes: number
  /** [YYYY-MM-DD, pages, hits, bytes, visits] */
  days: [string, number, number, number, number][]
  /** [hour, pages, hits, bytes] */
  hours: [number, number, number, number][]
  /** [code, pages, hits, bytes]: country codes from the GeoIP plugin, or `ip`/`unknown` without it */
  countries: [string, number, number, number][]
  /** [code, hits] */
  os: [string, number][]
  browsers: [string, number][]
  /** [HTTP status, hits, bytes] for responses other than 200 and 304 */
  status: [string, number, number][]
  /** [URL, pages, bytes, entries, exits] */
  urls: [string, number, number, number, number][]
  /** [URL, pages, hits] */
  referrers: [string, number, number][]
  /** [robot id, hits, bytes] */
  robots: [string, number, number][]
}

const int = (value: string | undefined): number => { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0 }
const key = (value: string | undefined, max = 512): string | null => value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null
const awstatsTime = (value: string | undefined): string | null => {
  const m = value ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value) : null
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null
}
const top = (rows: [string, ...number[]][], by: number): void => {
  rows.sort((a, b) => (b[by] as number) - (a[by] as number) || a[0].localeCompare(b[0]))
  if (rows.length > WEB_STATS_TOP_ROWS) rows.length = WEB_STATS_TOP_ROWS
}

const sections = (m: AwstatsMonth): [[string, ...number[]][], number][] =>
  [[m.countries, 2], [m.os, 1], [m.browsers, 1], [m.status, 1], [m.urls, 1], [m.referrers, 2], [m.robots, 1]]

/** Reads the sections the report shows from an AWStats data file (`awstatsMMYYYY.<site>.txt`), line by line; others, such as the visitor list, are skipped. */
export async function parseAwstatsData(lines: AsyncIterable<string> | Iterable<string>, month: string): Promise<AwstatsMonth> {
  const out: AwstatsMonth = { month, lastUpdate: null, visits: 0, unique: 0, pages: 0, hits: 0, bytes: 0, days: [], hours: [], countries: [], os: [], browsers: [], status: [], urls: [], referrers: [], robots: [] }
  let section: string | null = null
  for await (const raw of lines) {
    const line = raw.trimEnd()
    if (!line || line.startsWith('#')) continue
    const begin = /^BEGIN_([A-Z_]+)\b/.exec(line)
    if (begin) { section = begin[1]!; continue }
    if (line.startsWith('END_')) { section = null; continue }
    const f = line.split(' ')
    switch (section) {
      case 'GENERAL':
        if (f[0] === 'TotalVisits') out.visits = int(f[1])
        else if (f[0] === 'TotalUnique') out.unique = int(f[1])
        else if (f[0] === 'LastUpdate') out.lastUpdate = awstatsTime(f[1])
        break
      case 'DAY': {
        const day = /^(\d{4})(\d{2})(\d{2})$/.exec(f[0] ?? '')
        if (day && `${day[1]}-${day[2]}` === month && out.days.length < 31) out.days.push([`${day[1]}-${day[2]}-${day[3]}`, int(f[1]), int(f[2]), int(f[3]), int(f[4])])
        break
      }
      case 'TIME': { const hour = int(f[0]); if (/^\d{1,2}$/.test(f[0] ?? '') && hour < 24 && out.hours.length < 24) out.hours.push([hour, int(f[1]), int(f[2]), int(f[3])]); break }
      case 'DOMAIN': { const k = key(f[0], 64); if (k) out.countries.push([k, int(f[1]), int(f[2]), int(f[3])]); break }
      case 'OS': { const k = key(f[0], 64); if (k) out.os.push([k, int(f[1])]); break }
      case 'BROWSER': { const k = key(f[0], 64); if (k) out.browsers.push([k, int(f[1])]); break }
      case 'ERRORS': { if (/^\d{3}$/.test(f[0] ?? '')) out.status.push([f[0]!, int(f[1]), int(f[2])]); break }
      case 'SIDER': { const k = key(f[0]); if (k) out.urls.push([k, int(f[1]), int(f[2]), int(f[3]), int(f[4])]); break }
      case 'PAGEREFS': { const k = key(f[0]); if (k) out.referrers.push([k, int(f[1]), int(f[2])]); break }
      case 'ROBOT': { const k = key(f[0], 64); if (k) out.robots.push([k, int(f[1]), int(f[2])]); break }
    }
    // Each key appears once per section, so trimming to the largest rows seen so far keeps the exact top rows in bounded memory.
    for (const [rows, by] of sections(out)) if (rows.length > 4 * WEB_STATS_TOP_ROWS) top(rows, by)
  }
  out.days.sort((a, b) => a[0].localeCompare(b[0])); out.hours.sort((a, b) => a[0] - b[0])
  for (const [, pages, hits, bytes] of out.days) { out.pages += pages; out.hits += hits; out.bytes += bytes }
  for (const [rows, by] of sections(out)) top(rows, by)
  return out
}

/** `awstatsMMYYYY.<site>.txt` for a `YYYY-MM` month. */
export const awstatsDataFile = (month: string, site: string): string => `awstats${month.slice(5, 7)}${month.slice(0, 4)}.${site}.txt`
