import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderFpmPool } from './phpfpm.ts'
import { renderNginxMain } from './nginx-main.ts'
import { renderNginxSite } from './nginx.ts'
import { account, debianOs, domain, php, settings } from './testkit.ts'

const NGINX = '/usr/sbin/nginx', FPM = '/usr/sbin/php-fpm8.3'
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const get = (port: number, host: string, path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body })) })
  req.on('error', reject); req.end()
})
const ready = async (port: number): Promise<void> => { for (let i = 0; i < 100; i++) { try { await get(port, 'ready.test', '/'); return } catch { await wait(50) } } throw new Error('nginx did not start') }

const portable = (text: string, root: string, port: number): string => text
  .replace(/^\s*user .*;\n/m, '').replace(/^include .*modules.*;\n/gm, '').replace(/^\s*listen \[::\].*\n/gm, '').replace(/listen \d+( ssl)?;/g, `listen 127.0.0.1:${port};`)
  .replace(/\/run\/nginx\.pid/g, join(root, 'nginx.pid')).replace(/\/var\/(?:log|cache|lib)\/[^\s;]*/g, match => join(root, 'var', match.replaceAll('/', '_')))
  .replace(/include \/etc\/nginx\/mime\.types;/, '').replace(/include \/etc\/nginx\/[^\n]*\*\.conf;/, `include ${join(root, 'site.conf')};`)

/** The rendered configuration on the real nginx binary: what `nginx -t` passes and what a request gets. Skipped where nginx is not installed. */
describe.skipIf(!existsSync(NGINX))('site settings on nginx', () => {
  let root = '', nginx: ChildProcess, backend: Server
  const port = 18000 + (process.pid % 2000), backendPort = port + 2000
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'site-edge-')); mkdirSync(join(root, 'var'))
    backend = createServer((req, res) => setTimeout(() => res.end('content ' + req.url), req.url === '/slow' ? 400 : 0)).listen(backendPort, '127.0.0.1')
    const config = settings({ backendPort })
    const limited = domain({ id: 'd1', name: 'limited.test', kind: 'primary', site: { denyRules: [{ name: 'uploads', directory: '/uploads', extensions: ['php'] }], traffic: { siteConnections: null, ipConnections: 2, rateKbPerConnection: 1024 }, visitorLogOff: true } })
    const stopped = domain({ id: 'd2', name: 'stopped.test', kind: 'addon', suspended: true, site: { stoppedMessage: 'Back soon for $5 <now>' } })
    writeFileSync(join(root, 'site.conf'), portable(renderNginxSite(account(), [limited, stopped], config, null, { cache: false }), root, port))
    writeFileSync(join(root, 'nginx.conf'), portable(renderNginxMain(config, debianOs).content, root, port))
    const test = spawnSync(NGINX, ['-t', '-c', join(root, 'nginx.conf')], { encoding: 'utf8' })
    expect(test.stderr).toContain('test is successful')
    nginx = spawn(NGINX, ['-c', join(root, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' })
    await ready(port)
  }, 15_000)
  afterAll(async () => { nginx?.kill('SIGQUIT'); backend?.close(); await wait(100); rmSync(root, { recursive: true, force: true }) })

  it('denies an extension below the directory and serves the rest', async () => {
    expect((await get(port, 'limited.test', '/uploads/x.php')).status).toBe(403)
    expect((await get(port, 'limited.test', '/uploads/a/b/X.PHP')).status).toBe(403)
    expect((await get(port, 'limited.test', '/uploads/x.php/y.jpg')).status).toBe(403)
    expect((await get(port, 'limited.test', '/uploads/x.jpg')).status).toBe(200)
    expect((await get(port, 'limited.test', '/other/x.php')).status).toBe(200)
  })
  it('answers 503 past the connection limit of one address', async () => {
    const replies = await Promise.all([1, 2, 3].map(() => get(port, 'limited.test', '/slow')))
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 200, 503])
  })
  it('shows the owner message on the stopped page for every path', async () => {
    for (const path of ['/', '/any/where.php']) {
      const reply = await get(port, 'stopped.test', path)
      expect(reply.status).toBe(503)
      expect(reply.body).toContain('Back soon for &#36;5 &#60;now&#62;')
    }
  })
})

/** The reason for php_value in an isolated pool: .user.ini cannot narrow an admin value. */
describe.skipIf(!existsSync(NGINX) || !existsSync(FPM))('site isolation on php-fpm', () => {
  let root = '', fpm: ChildProcess, nginx: ChildProcess
  const port = 20100 + (process.pid % 2000)
  const pool = (name: string, line: string): string => `[${name}]\nlisten = ${join(root, name + '.sock')}\npm = ondemand\npm.max_children = 2\n${line}\n`
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'site-iso-'))
    chmodSync(root, 0o755)
    const allowed = join(root, 'home')
    for (const site of ['a', 'b']) {
      mkdirSync(join(allowed, site), { recursive: true })
      writeFileSync(join(allowed, site, 'index.php'), `<?php echo @file_get_contents('${join(allowed, 'b', 'secret.txt')}') === false ? 'blocked' : 'read';`)
      writeFileSync(join(allowed, site, '.user.ini'), `open_basedir = ${join(allowed, site)}\n`)
    }
    writeFileSync(join(allowed, 'b', 'secret.txt'), 'secret')
    const line = (narrowable: boolean): string => renderFpmPool(account(), php(), debianOs, { narrowableBasedir: narrowable }).content.split('\n').find(text => text.includes('[open_basedir]'))!.replaceAll(account().home, allowed)
    writeFileSync(join(root, 'fpm.conf'), `[global]\npid = ${join(root, 'fpm.pid')}\nerror_log = ${join(root, 'fpm.log')}\n${pool('narrow', line(true))}\n${pool('locked', line(false))}`)
    fpm = spawn(FPM, ['--nodaemonize', '--fpm-config', join(root, 'fpm.conf'), '-n'], { stdio: 'ignore' })
    const site = (name: string): string => `server { listen 127.0.0.1:${port}; server_name ${name}.test; root ${join(allowed, 'a')}; location / { include /etc/nginx/fastcgi.conf; fastcgi_param SCRIPT_FILENAME ${join(allowed, 'a', 'index.php')}; fastcgi_pass unix:${join(root, name + '.sock')}; } }`
    writeFileSync(join(root, 'nginx.conf'), `pid ${join(root, 'nginx.pid')};\nerror_log ${join(root, 'nginx-error.log')};\nevents {}\nhttp { access_log off; ${site('narrow')} ${site('locked')} server { listen 127.0.0.1:${port} default_server; return 200; } }\n`)
    expect(spawnSync(NGINX, ['-t', '-c', join(root, 'nginx.conf')], { encoding: 'utf8' }).stderr).toContain('test is successful')
    nginx = spawn(NGINX, ['-c', join(root, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' })
    await ready(port)
    for (let i = 0; i < 60 && !existsSync(join(root, 'locked.sock')); i++) await wait(50)
  }, 15_000)
  afterAll(async () => { fpm?.kill('SIGQUIT'); nginx?.kill('SIGQUIT'); await wait(100); rmSync(root, { recursive: true, force: true }) })

  it('lets .user.ini narrow open_basedir in a pool with an isolated site, and only there', async () => {
    expect((await get(port, 'narrow.test', '/')).body).toBe('blocked')
    expect((await get(port, 'locked.test', '/')).body).toBe('read')
  })
})
