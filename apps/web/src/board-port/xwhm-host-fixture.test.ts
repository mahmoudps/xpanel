import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  parseApacheVersion,
  parseCpuinfo,
  parseDf,
  parseDfInodes,
  parseHostname,
  parseKernelRelease,
  parseLoadavg,
  parseMeminfo,
  parseNginxVersion,
  parseOsRelease,
  parseProcUptime,
} from '../../../agent/src/host-info.ts'
import { formatBytes } from '../tokens.ts'
import {
  APACHE_V,
  CPUINFO,
  DF_HOME,
  DF_INODES,
  DF_ROOT,
  HOSTNAME_F,
  LOADAVG,
  MEMINFO,
  NGINX_V,
  OS_RELEASE,
  PANEL_DOMAIN,
  PROC_UPTIME,
  UNAME_R,
  labHostDashboard,
} from './xwhm-host-fixture.ts'
import { renderWhmDashboard, whmDashboardFromProps } from './xwhm-dashboard.ts'

describe('lab host command fixture', () => {
  it('checks every host field against the raw command output', async () => {
    assert.equal(parseHostname(HOSTNAME_F), 'license.developments.world')
    assert.equal(parseOsRelease(OS_RELEASE), 'Ubuntu 24.04.3 LTS')
    assert.equal(parseKernelRelease(UNAME_R), '6.8.0-90-generic')
    assert.equal(parseProcUptime(PROC_UPTIME), 126000)
    assert.equal(parseNginxVersion(NGINX_V), '1.24.0')
    assert.equal(parseApacheVersion(APACHE_V), '2.4.58')
    assert.deepEqual(parseCpuinfo(CPUINFO), { cores: 4, model: 'AMD EPYC-Rome' })
    assert.deepEqual(parseLoadavg(LOADAVG), { load1: 0, load5: 0.02, load15: 0 })
    const memory = parseMeminfo(MEMINFO)
    assert.equal(memory.totalBytes, 7939453 * 1024)
    assert.equal(formatBytes(memory.totalBytes), '8.13 GB')
    const disk = parseDf(DF_ROOT)
    assert.equal(formatBytes(disk.totalBytes), '161 GB')
    assert.equal(parseDf(DF_HOME).mount, '/')
    const inodes = parseDfInodes(DF_INODES)
    assert.deepEqual({ used: inodes.used, total: inodes.total, mount: inodes.mount }, { used: 148410, total: 9732496, mount: '/' })

    const model = await labHostDashboard()
    assert.equal(model.hostname, 'license.developments.world')
    assert.equal(model.ledeHost, 'license.developments.world')
    assert.equal(model.hostRows.find(row => row.label === 'System')?.value, 'Ubuntu 24.04.3 LTS')
    assert.equal(model.hostRows.find(row => row.label === 'Kernel')?.value, '6.8.0-90-generic')
    assert.equal(model.hostRows.find(row => row.label === 'Uptime')?.value, '1 day, 11 hours')
    assert.equal(model.hostRows.find(row => row.label === 'Hardware')?.value, '4 cores · AMD EPYC-Rome · 8.13 GB')
    assert.equal(model.hostRows.find(row => row.label === 'Engine')?.value, 'nginx 1.24.0 → Apache 2.4.58')
    assert.equal(model.hostRows.find(row => row.label === 'xPanel')?.value, '0.1.0')
    assert.equal(model.hostRows.find(row => row.label === 'Panel domain')?.value, PANEL_DOMAIN)
    assert.equal(model.meters[0]?.value, '0.00 / 0.02 / 0.00')
    assert.equal(model.meters[0]?.note, '4 cores')
    assert.equal(model.meters[0]?.showBar, false)
    assert.equal(model.meters[2]?.value, '40.0 GB / 161 GB')
    assert.equal(model.meters[3]?.label, 'Inodes on /')
    assert.equal(model.meters[3]?.value, '148,410 / 9,732,496')
    assert.equal(model.meters[3]?.pct, '2%')
    assert.equal(model.meters[3]?.note, '/home is on /')
    assert.equal(model.servicesMeta, '8 / 9')
    assert.deepEqual(model.services.map(row => [row.name, row.status.label]), [
      ['nginx', 'Running'],
      ['Apache', 'Running'],
      ['PHP-FPM', 'Running'],
      ['MariaDB', 'Running'],
      ['PostgreSQL', 'Not installed'],
      ['Redis', 'Stopped'],
      ['Postfix', 'Running'],
      ['Dovecot', 'Running'],
      ['pure-ftpd', 'Running'],
      ['PowerDNS', 'Running'],
    ])

    const html = renderWhmDashboard(model)
    for (const marker of [
      'license.developments.world',
      'Panel domain',
      PANEL_DOMAIN,
      'Ubuntu 24.04.3 LTS',
      '6.8.0-90-generic',
      '1 day, 11 hours',
      '4 cores · AMD EPYC-Rome · 8.13 GB',
      'nginx 1.24.0 → Apache 2.4.58',
      '0.1.0',
      '0.00 / 0.02 / 0.00',
      '4 cores',
      '161 GB',
      'Inodes on /',
      '148,410 / 9,732,496',
      '/home is on /',
      '>nginx ',
      'PHP-FPM',
      'PostgreSQL',
      'Not installed',
      '>Redis ',
      'Stopped',
      '8 / 9',
    ]) {
      assert.ok(html.includes(marker), marker)
    }
    assert.ok(html.indexOf('license.developments.world') < html.indexOf(PANEL_DOMAIN))
    assert.equal(html.includes('aria-label="CPU"'), false)
    assert.equal(html.includes('aria-valuenow="0"'), false)
    assert.equal(html.includes('7.57'), false)
    assert.equal(html.includes('150 GB'), false)
    assert.equal(html.includes('6 / 6'), false)

    const arabic = renderWhmDashboard(whmDashboardFromProps({
      locale: 'ar',
      hostSample: {
        hostname: 'license.developments.world',
        load1: 0,
        load5: 0.02,
        load15: 0,
        cores: 4,
        cpuModel: 'AMD EPYC-Rome',
        memory: parseMeminfo(MEMINFO),
        uptimeSeconds: 126000,
        inodes: { mount: '/', total: 9732496, used: 148410, homeOnRoot: true },
      },
    }))
    assert.match(arabic, /<bdi dir="ltr">4<\/bdi> أنوية/)
    assert.match(arabic, /<bdi dir="ltr">8\.13 GB<\/bdi>/)
    assert.match(arabic, /<bdi dir="ltr">1<\/bdi> يوم و<bdi dir="ltr">11<\/bdi> ساعة/)
    assert.match(arabic, /«\/home» على «\/»|\/home/)
    assert.match(arabic, /<bdi dir="ltr">\/home<\/bdi> على <bdi dir="ltr">\/<\/bdi>/)
  })
})
