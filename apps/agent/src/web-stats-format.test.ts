import { describe, expect, it } from 'vitest'
import { awstatsDataFile, parseAwstatsData, renderAwstatsConfig, toCombinedLog, WEB_STATS_TOP_ROWS } from './web-stats-format.ts'

const line = (over: Record<string, unknown> = {}): string => JSON.stringify({ time: '2026-11-07T10:20:30+00:00', host: 'example.com', ip: '203.0.113.7', method: 'GET', uri: '/index.html?a=1',
  status: 200, body_bytes: 512, bytes: 700, request_bytes: 90, request_time: 0.004, scheme: 'https', protocol: 'HTTP/2.0', upstream_time: '', cache: '', referer: 'https://ref.example/', agent: 'Mozilla/5.0', ...over })

describe('edge log lines in the combined log format', () => {
  it('writes the combined format the engines parse, with the scheme kept apart', () => {
    expect(toCombinedLog(line())).toEqual({ scheme: 'https', month: '2026-11',
      text: '203.0.113.7 - - [07/Nov/2026:10:20:30 +0000] "GET /index.html?a=1 HTTP/2.0" 200 512 "https://ref.example/" "Mozilla/5.0"\n' })
    expect(toCombinedLog(line({ scheme: 'http', time: '2026-01-31T23:59:59-05:30', referer: '', agent: '' }))?.text)
      .toBe('203.0.113.7 - - [31/Jan/2026:23:59:59 -0530] "GET /index.html?a=1 HTTP/2.0" 200 512 "-" "-"\n')
  })

  it('cannot let a value end its field early', () => {
    const text = toCombinedLog(line({ uri: '/a b"c\\d', agent: 'x" "y\\z\u0001', referer: 'r"' }))!.text
    expect(text).toContain('"GET /a%20b%22c%5Cd HTTP/2.0"')
    expect(text).toContain(`"r'" "x' 'y/z "`)
    expect(text.split('"').length).toBe(7)
  })

  it('refuses lines it cannot attribute or that are not edge lines', () => {
    for (const bad of [line({ scheme: undefined }), line({ scheme: 'ftp' }), line({ time: 'yesterday' }), line({ ip: '1.2.3.4 x' }), line({ method: 'get' }), line({ status: 99 }), line({ body_bytes: -1 }), 'not json', '[]'])
      expect(toCombinedLog(bad), bad).toBeNull()
    expect(toCombinedLog(line({ protocol: undefined }))?.text).toContain('"GET /index.html?a=1 -"')
  })
})

describe('AWStats configuration', () => {
  it('reads standard input, never resolves names or updates from a browser, and loads GeoIP only when installed', () => {
    const conf = renderAwstatsConfig({ site: 'example.com', names: ['example.com', 'www.example.com', '*.shop.example.com'], dataDir: '/home/alice/tmp/awstats/ssl', geoipDatabase: '/var/lib/xpanel-stats/geoip/dbip-country-lite.mmdb', reverseDns: false, include: null })
    for (const expected of ['LogFile="-"', 'LogFormat=1', 'SiteDomain="example.com"', 'HostAliases="example.com www.example.com REGEX[\\.shop\\.example\\.com$]"', 'DNSLookup=0',
      'DirData="/home/alice/tmp/awstats/ssl"', 'AllowToUpdateStatsFromBrowser=0', 'SaveDatabaseFilesWithPermissionsForEveryone=0', 'LoadPlugin="geoip2_country /var/lib/xpanel-stats/geoip/dbip-country-lite.mmdb"'])
      expect(conf.split('\n')).toContain(expected)
    expect(renderAwstatsConfig({ site: 'example.com', names: ['example.com'], dataDir: '/home/alice/tmp/awstats', geoipDatabase: null, reverseDns: false, include: null })).not.toContain('LoadPlugin')
  })

  it('refuses names and paths that could break out of a value', () => {
    expect(() => renderAwstatsConfig({ site: 'exa"mple.com', names: [], dataDir: '/home/a', geoipDatabase: null, reverseDns: false, include: null })).toThrow()
    expect(() => renderAwstatsConfig({ site: 'example.com', names: ['bad name.com'], dataDir: '/home/a', geoipDatabase: null, reverseDns: false, include: null })).toThrow()
    expect(() => renderAwstatsConfig({ site: 'example.com', names: [], dataDir: '/home/a/../b', geoipDatabase: null, reverseDns: false, include: null })).toThrow()
    expect(() => renderAwstatsConfig({ site: 'example.com', names: [], dataDir: '/home/a"\nLogFile="x', geoipDatabase: null, reverseDns: false, include: null })).toThrow()
    expect(() => renderAwstatsConfig({ site: 'example.com', names: [], dataDir: '/home/a', geoipDatabase: null, reverseDns: false, include: '/home/a/x"\nLogFile="y' })).toThrow()
  })
})

describe('AWStats data file', () => {
  it('reduces the shown sections and skips the rest', async () => {
    const file = [
      'AWSTATS DATA FILE 7.9', '# comment', 'BEGIN_GENERAL 8', 'LastLine 20261107101010 1 2 3', 'FirstTime 20261101000001', 'LastUpdate 20261107101500 1 0 0 0 0', 'TotalVisits 12', 'TotalUnique 10', 'END_GENERAL',
      'BEGIN_TIME 24', ...Array.from({ length: 24 }, (_, h) => `${h} ${h} ${2 * h} ${100 * h} 0 0 0`), 'END_TIME',
      'BEGIN_DAY 3', '20261102 5 9 900 2', '20261101 3 4 400 1', '20261031 99 99 99 99', 'END_DAY',
      'BEGIN_VISITOR 2', '203.0.113.7 4 9 900 20261101000001 20261101000002', 'END_VISITOR',
      'BEGIN_DOMAIN 2', 'au 3 5 500', 'ip 1 2 3', 'END_DOMAIN',
      'BEGIN_OS 1', 'linuxubuntu 7', 'END_OS', 'BEGIN_BROWSER 1', 'firefox131 6 3', 'END_BROWSER',
      'BEGIN_ERRORS 2', '404 3 300', '301 1 0', 'END_ERRORS',
      'BEGIN_SIDER 1', '/index.html 8 800 5 4', 'END_SIDER', 'BEGIN_PAGEREFS 1', 'https://ref.example/ 2 3', 'END_PAGEREFS', 'BEGIN_ROBOT 1', 'googlebot 4 400 20261101 1', 'END_ROBOT',
    ]
    const month = await parseAwstatsData(file, '2026-11')
    expect(month).toMatchObject({ month: '2026-11', lastUpdate: '2026-11-07T10:15:00Z', visits: 12, unique: 10, pages: 8, hits: 13, bytes: 1300,
      days: [['2026-11-01', 3, 4, 400, 1], ['2026-11-02', 5, 9, 900, 2]], countries: [['au', 3, 5, 500], ['ip', 1, 2, 3]], os: [['linuxubuntu', 7]], browsers: [['firefox131', 6]],
      status: [['404', 3, 300], ['301', 1, 0]], urls: [['/index.html', 8, 800, 5, 4]], referrers: [['https://ref.example/', 2, 3]], robots: [['googlebot', 4, 400]] })
    expect(month.hours).toHaveLength(24)
    expect(month.hours[23]).toEqual([23, 23, 46, 2300])
  })

  it('keeps the exact top rows of a long section in bounded memory', async () => {
    const rows = Array.from({ length: 1000 }, (_, n) => `/page-${n} ${(n * 7919) % 1000} 0 0 0`)
    const month = await parseAwstatsData(['BEGIN_SIDER 1000', ...rows, 'END_SIDER'], '2026-11')
    expect(month.urls).toHaveLength(WEB_STATS_TOP_ROWS)
    expect(month.urls.map(row => row[1])).toEqual(Array.from({ length: WEB_STATS_TOP_ROWS }, (_, n) => 999 - n))
  })

  it('names the monthly data file the way AWStats does', () => {
    expect(awstatsDataFile('2026-03', 'example.com')).toBe('awstats032026.example.com.txt')
  })
})
