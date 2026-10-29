import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fail, validateDomainName } from '@xpanel/core'
import { inspectHtaccess } from './htaccess-policy.ts'
import type { HtaccessTarget, HtaccessValidation, HtaccessValidator } from './htaccess-workspace.ts'

const CONTROL_PATHS = ['/usr/sbin/apache2ctl', '/usr/sbin/apachectl', '/usr/sbin/httpd']
const MAIN_PATHS = ['/etc/apache2/apache2.conf', '/etc/httpd/conf/httpd.conf']
const SAFE_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } // Fixed daemon environment.
let validationAdmissions = 0, validationActive = false
const validationWaiters: (() => void)[] = []
async function validationSlot<T>(work: () => Promise<T>): Promise<T> {
  if (validationAdmissions >= 8) return fail('PRECONDITION_FAILED', 'Apache validation is busy; no file change was made', { stateChanged: false })
  validationAdmissions++
  if (validationActive) await new Promise<void>(resolve => validationWaiters.push(resolve))
  else validationActive = true
  try { return await work() }
  finally { validationAdmissions--; const next = validationWaiters.shift(); if (next) next(); else validationActive = false }
}
async function secure(path: string, file = false): Promise<void> {
  if (!path.startsWith('/') || posix.normalize(path) !== path) return fail('PRECONDITION_FAILED', 'Apache validation path is not canonical', { stateChanged: false })
  let current = ''
  for (const part of path.slice(1).split('/')) {
    current += '/' + part
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || (current === path && file ? !metadata.isFile() : !metadata.isDirectory())) return fail('PRECONDITION_FAILED', 'Apache validation paths must be root-owned and protected', { stateChanged: false })
  }
}
function configTest(binary: string, config: string): Promise<{ valid: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-t', '-f', config], { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: SAFE_ENV })
    const chunks: Buffer[] = []; let size = 0, failed = false
    const kill = (): void => { failed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } } }
    const timer = setTimeout(kill, 10000)
    const capture = (chunk: Buffer): void => { size += chunk.length; if (size > 64 * 1024) kill(); else chunks.push(chunk) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ valid: code === 0 && !failed, stderr: Buffer.concat(chunks).toString('utf8') }) })
  })
}

/** Actual protected Apache parser adapter. Only policy-vetted per-directory input is included. */
export function createNativeHtaccessValidator(options: { apacheControlPath: string; apacheMainConfigPath: string; workRoot: string }): HtaccessValidator {
  if (!CONTROL_PATHS.includes(options.apacheControlPath) || !MAIN_PATHS.includes(options.apacheMainConfigPath) || !/^\/run\/xpanel\/[a-z0-9-]+$/.test(options.workRoot)) fail('VALIDATION', 'trusted Apache validation configuration is required')
  const available = async (): Promise<boolean> => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return false
    try {
      await secure(options.apacheControlPath, true); await secure(options.apacheMainConfigPath, true); await secure('/run')
      for (const path of [posix.dirname(options.workRoot), options.workRoot]) {
        try { await secure(path) }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      return true
    } catch { return false }
  }
  return { available, async check(target: HtaccessTarget, content: string): Promise<HtaccessValidation> {
    const policy = inspectHtaccess(content)
    if (!policy.valid) return { valid: false, nativeChecked: false, issues: policy.issues, checkedAt: new Date().toISOString() }
    if (!await available() || target.engine !== 'apache' || /["\\\u0000-\u001f\u007f]/.test(target.docRoot) || !posix.isAbsolute(target.docRoot)) return fail('PRECONDITION_FAILED', 'protected Apache candidate validation is unavailable', { stateChanged: false })
    // Only these fixed runtime directories may be created. Each protected
    // ancestor is checked before the next nonrecursive mkdir, never repaired.
    for (const path of [posix.dirname(options.workRoot), options.workRoot]) {
      await secure(posix.dirname(path))
      try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
      await secure(path)
    }
    const directory = await mkdtemp(options.workRoot + '/candidate-')
    const candidatePath = directory + '/candidate.conf', configPath = directory + '/apache.conf'
    try {
      await writeFile(candidatePath, content, { mode: 0o600, flag: 'wx' })
      // Server configuration is an existing trusted root-owned file. The tenant
      // contributes only the strictly vetted Directory include above.
      await writeFile(configPath, 'Include "' + options.apacheMainConfigPath + '"\n<Directory "' + target.docRoot + '">\nInclude "' + candidatePath + '"\n</Directory>\n', { mode: 0o600, flag: 'wx' })
      const result = await validationSlot(() => configTest(options.apacheControlPath, configPath))
      const candidateError = result.stderr.includes(candidatePath), line = candidateError ? /(?:line|at line)\s+(\d+)/i.exec(result.stderr)?.[1] : undefined
      return { valid: result.valid, nativeChecked: true, issues: result.valid ? [] : [{ line: line ? Number(line) : 1, code: candidateError ? 'apache_config_test' : 'apache_baseline', message: candidateError ? 'Apache rejected the protected per-directory candidate; review the directive at this line.' : 'The trusted Apache configuration could not be checked. No file change was made.' }], checkedAt: new Date().toISOString() }
    } finally {
      if (posix.dirname(directory) !== options.workRoot || !posix.basename(directory).startsWith('candidate-')) throw new Error('Apache validation cleanup target changed')
      await rm(directory, { recursive: true, force: true })
    }
  } }
}

/** Fixed loopback only, with an authoritative Host and no redirect following. */
export async function probeHtaccessTarget(target: HtaccessTarget): Promise<number> {
  if (target.engine !== 'apache' || !Number.isSafeInteger(target.backendPort) || target.backendPort < 1 || target.backendPort > 65535 || validateDomainName(target.domainName) !== target.domainName) return fail('PRECONDITION_FAILED', 'the trusted Apache site probe is unavailable', { stateChanged: false })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, status?: number): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(status!) }
    const request = httpRequest({ hostname: '127.0.0.1', port: target.backendPort, path: '/?xpanel_htaccess_check=' + randomUUID(), method: 'GET', agent: false, maxHeaderSize: 32 * 1024,
      headers: { host: target.domainName, 'x-forwarded-proto': 'https', 'cache-control': 'no-cache', connection: 'close' } }, response => { const status = response.statusCode; response.destroy(); finish(status ? null : new Error('missing_probe_status'), status) })
    const timer = setTimeout(() => request.destroy(new Error('site_probe_timeout')), 3000)
    request.once('error', error => finish(error)); request.end()
  })
}
