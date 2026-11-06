import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error build.mjs is an untyped Node build script
import { ACCOUNT_FILE_HELPER_SOURCE_PATH, COMPILER_FLAGS, buildAccountFileHelper } from '../../../helpers/account-files/build.mjs'

const COMPILER = '/usr/bin/gcc'
// Unprivileged on purpose: the refusal cases rely on ordinary permission checks.
const compilable = process.platform === 'linux' && existsSync(COMPILER) && process.getuid?.() !== 0

// Runs the helper's own operation code as the current unprivileged user; the root supervisor, cgroup and privilege drop stay covered by the native suite.
const harnessSource = (source: string): string => `#define main xpanel_account_files_main
#include "${source}"
#undef main
int main(int argc, char **argv) {
  static char input[XP_MAX_STDIN_BYTES + 1];
  size_t total = 0;
  if (argc != 3) return 2;
  for (;;) {
    ssize_t n = read(STDIN_FILENO, input + total, XP_MAX_STDIN_BYTES - total);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 || total + (size_t)n >= XP_MAX_STDIN_BYTES) return 3;
    if (n == 0) break;
    total += (size_t)n;
  }
  JsonParser parser = {.src = input, .len = total, .pos = 0};
  JsonVal *req = jp_parse_value(&parser, 0);
  const char *op = NULL;
  if (!req || req->kind != JV_OBJECT || !jv_get_str(req, "op", &op, NULL) || strlen(op) >= sizeof(g_worker.op)) return 4;
  snprintf(g_worker.op, sizeof(g_worker.op), "%s", op);
  int home = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (home < 0) return 5;
  run_operation(op, home, geteuid(), req, XP_MAX_EDIT_BYTES_CEILING, 0640, 0750, strtoll(argv[2], NULL, 10));
  return 6;
}
`

interface Envelope { protocolVersion: number; ok: boolean; op: string; result?: Record<string, unknown>; error?: { code: string; errnoName: string } }

describe.runIf(compilable)('account file helper move and copy operations', { tags: ['feature'] }, () => {
  let scratch = '', home = '', outside = '', harness = '', production = ''

  const run = (request: Record<string, unknown>, maxEntries = 10_000): Envelope => {
    const result = spawnSync(harness, [home, String(maxEntries)], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 })
    expect(result.status, result.stderr).toBe(0)
    const envelope = JSON.parse(result.stdout) as Envelope
    expect(envelope).toMatchObject({ protocolVersion: 2, op: request.op })
    return envelope
  }
  const refused = (request: Record<string, unknown>, code: string, errnoName?: string, maxEntries?: number): void => {
    const envelope = run(request, maxEntries)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toMatchObject({ code, ...(errnoName ? { errnoName } : {}) })
  }
  const names = async (directory: string): Promise<string[]> => (await readdir(directory)).sort()
  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'xpanel-helper-ops-'))
    const source = join(scratch, 'harness.c')
    harness = join(scratch, 'harness')
    await writeFile(source, harnessSource(ACCOUNT_FILE_HELPER_SOURCE_PATH))
    // The renamed production main loses the implicit return that only main gets.
    execFileSync(COMPILER, [...COMPILER_FLAGS, '-Wno-return-type', source, '-o', harness], { stdio: 'pipe', timeout: 60_000 })
    production = buildAccountFileHelper({ outputPath: join(scratch, 'bin', 'xpanel-account-files'), chownRoot: false }).binaryPath
  })
  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }) })
  beforeEach(async () => {
    await rm(join(scratch, 'home'), { recursive: true, force: true })
    await rm(join(scratch, 'outside'), { recursive: true, force: true })
    home = join(scratch, 'home')
    outside = join(scratch, 'outside')
    await mkdir(join(home, 'public_html', 'theme', 'css'), { recursive: true })
    await mkdir(join(home, 'archive'))
    await mkdir(outside)
    await writeFile(join(home, 'public_html', 'index.php'), '<?php echo 1;')
    await chmod(join(home, 'public_html', 'index.php'), 0o644)
    await writeFile(join(home, 'public_html', 'theme', 'style.css'), 'body{}')
    await writeFile(join(home, 'public_html', 'theme', 'css', 'site.css'), 'a{}')
    await chmod(join(home, 'public_html', 'theme'), 0o755)
  })

  it('keeps the production supervisor root-only after the dispatch seam', () => {
    const request = { protocolVersion: 2, context: { username: 'alice', uid: 29101, gid: 29101, homeRoot: home }, request: { op: 'move', path: 'a', destination: 'b' } }
    const result = spawnSync(production, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 })
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, op: 'move', error: { code: 'PRECONDITION_FAILED', errnoName: 'EPERM' } })
  })

  it('renames in place and moves across folders, keeping bytes and the entry own mode', async () => {
    expect(run({ op: 'move', path: 'public_html/index.php', destination: 'public_html/home.php' })).toMatchObject({
      ok: true, result: { name: 'home.php', path: 'public_html/home.php', kind: 'file', sizeBytes: 13, mode: 0o644 } })
    expect(run({ op: 'move', path: 'public_html/theme', destination: 'archive/theme-old' })).toMatchObject({
      ok: true, result: { name: 'theme-old', path: 'archive/theme-old', kind: 'directory', sizeBytes: 0, mode: 0o755 } })
    expect(await readFile(join(home, 'public_html', 'home.php'), 'utf8')).toBe('<?php echo 1;')
    expect(await readFile(join(home, 'archive', 'theme-old', 'css', 'site.css'), 'utf8')).toBe('a{}')
    expect(await names(join(home, 'public_html'))).toEqual(['home.php'])
  })

  it('never replaces an existing destination', async () => {
    await writeFile(join(home, 'archive', 'index.php'), 'keep')
    refused({ op: 'move', path: 'public_html/index.php', destination: 'archive/index.php' }, 'CONFLICT', 'EEXIST')
    expect(await readFile(join(home, 'archive', 'index.php'), 'utf8')).toBe('keep')
    expect(await readFile(join(home, 'public_html', 'index.php'), 'utf8')).toBe('<?php echo 1;')
  })

  it.each([
    ['../outside/x', 'FORBIDDEN'], ['/etc/x', 'FORBIDDEN'], ['public_html/../../outside/x', 'FORBIDDEN'], ['.trash/x', 'FORBIDDEN'],
    ['public_html/theme', 'VALIDATION'], ['public_html/theme/css/inner', 'VALIDATION'], ['a//b', 'FORBIDDEN'], ['', 'VALIDATION'],
  ])('refuses destination %j for both operations without writing', async (destination, code) => {
    for (const op of ['move', 'copy']) refused({ op, path: 'public_html/theme', destination }, code)
    expect(await names(outside)).toEqual([])
    expect(await names(join(home, 'public_html'))).toEqual(['index.php', 'theme'])
  })

  it('refuses symlink escapes in the destination parent and symlinked or hardlinked sources', async () => {
    await symlink(outside, join(home, 'escape'))
    await symlink(join(outside, 'secret'), join(home, 'public_html', 'link'))
    await writeFile(join(outside, 'secret'), 'outside')
    await link(join(home, 'public_html', 'index.php'), join(home, 'archive', 'hard.php'))
    for (const op of ['move', 'copy']) {
      refused({ op, path: 'public_html/theme', destination: 'escape/theme' }, 'FORBIDDEN', 'ELOOP')
      refused({ op, path: 'escape/secret', destination: 'archive/secret' }, 'FORBIDDEN', 'ELOOP')
      refused({ op, path: 'public_html/link', destination: 'archive/link' }, 'FORBIDDEN', 'ELOOP')
      refused({ op, path: 'archive/hard.php', destination: 'archive/other.php' }, 'FORBIDDEN', 'EMLINK')
    }
    expect(await names(outside)).toEqual(['secret'])
    expect(await names(join(home, 'archive'))).toEqual(['hard.php'])
  })

  it('copies a file and a tree within the permission ceilings and leaves the source untouched', async () => {
    await chmod(join(home, 'public_html', 'theme', 'style.css'), 0o600)
    await chmod(join(home, 'public_html', 'theme', 'css', 'site.css'), 0o400)
    expect(run({ op: 'copy', path: 'public_html/index.php', destination: 'archive/index.php' })).toMatchObject({
      ok: true, result: { path: 'archive/index.php', kind: 'file', sizeBytes: 13, mode: 0o640 } })
    expect(run({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' })).toMatchObject({
      ok: true, result: { path: 'archive/theme', kind: 'directory', sizeBytes: 0, mode: 0o750 } })
    expect(await readFile(join(home, 'archive', 'index.php'), 'utf8')).toBe('<?php echo 1;')
    expect(await readFile(join(home, 'archive', 'theme', 'style.css'), 'utf8')).toBe('body{}')
    expect(await modeOf(join(home, 'archive', 'theme', 'style.css'))).toBe(0o600)
    expect(await modeOf(join(home, 'archive', 'theme', 'css', 'site.css'))).toBe(0o400)
    expect(await modeOf(join(home, 'public_html', 'index.php'))).toBe(0o644)
    expect(await names(join(home, 'archive'))).toEqual(['index.php', 'theme'])
    expect(await names(join(home, 'public_html', 'theme'))).toEqual(['css', 'style.css'])
  })

  it('refuses an existing destination, a symlink inside the tree and an oversize tree before writing anything', async () => {
    await mkdir(join(home, 'archive', 'theme'))
    refused({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' }, 'CONFLICT', 'EEXIST')
    await rm(join(home, 'archive', 'theme'), { recursive: true })
    await symlink('/etc/passwd', join(home, 'public_html', 'theme', 'css', 'passwd'))
    refused({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' }, 'FORBIDDEN', 'ELOOP')
    await rm(join(home, 'public_html', 'theme', 'css', 'passwd'))
    refused({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' }, 'LIMIT_EXCEEDED', undefined, 3)
    await truncate(join(home, 'public_html', 'theme', 'style.css'), 128 * 1024 * 1024 + 1)
    refused({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' }, 'LIMIT_EXCEEDED')
    expect(await names(join(home, 'archive'))).toEqual([])
  })

  it('cleans its staging tree when the copy fails after writing started', async () => {
    // Metadata passes the scan; the unreadable file fails only once the staging tree exists.
    await chmod(join(home, 'public_html', 'theme', 'css', 'site.css'), 0o000)
    refused({ op: 'copy', path: 'public_html/theme', destination: 'archive/theme' }, 'FORBIDDEN', 'EACCES')
    expect(await names(join(home, 'archive'))).toEqual([])
    await expect(lstat(join(home, 'archive', 'theme'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
