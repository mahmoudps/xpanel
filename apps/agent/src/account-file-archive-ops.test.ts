import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error build.mjs is an untyped Node build script
import { ACCOUNT_FILE_HELPER_SOURCE_PATH, COMPILER_FLAGS } from '../../../helpers/account-files/build.mjs'

const COMPILER = '/usr/bin/gcc'
// Unprivileged on purpose: the archive code runs here exactly as it does after the worker drops to the account UID.
const compilable = process.platform === 'linux' && existsSync(COMPILER) && process.getuid?.() !== 0

// Same seam as the move and copy harness, plus the disk quota ceiling the supervisor reads from its context.
const harnessSource = (source: string): string => `#define main xpanel_account_files_main
#include "${source}"
#undef main
int main(int argc, char **argv) {
  static char input[XP_MAX_STDIN_BYTES + 1];
  size_t total = 0;
  if (argc != 4) return 2;
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
  g_archive_quota_bytes = strtoll(argv[3], NULL, 10);
  run_operation(op, home, geteuid(), req, XP_MAX_EDIT_BYTES_CEILING, 0640, 0750, strtoll(argv[2], NULL, 10));
  return 6;
}
`

interface Envelope { ok: boolean; op: string; result?: Record<string, unknown>; error?: { code: string; errnoName: string; reason?: string; message: string } }

const MiB = 1024 * 1024
// bzip2 -9 of "hello world\n", made by an independent encoder (Python's bz2 module).
const HELLO_BZ2 = Buffer.from('QlpoOTFBWSZTWU7s6DYAAAJRgAAQQAAGRJCAIAAxBkxBAaeppYC7lDH4u5IpwoSCd2dBsA==', 'base64')

interface TarEntry { name: string; data?: string | Buffer; type?: string; mode?: number }
const tarHeader = (name: string, size: number, type: string, mode: number): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii')
  header.write('0001750\0', 108, 'ascii')
  header.write('0001750\0', 116, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('14707440000\0', 136, 'ascii')
  header.fill(' ', 148, 156)
  header.write(type, 156, 'ascii')
  header.write('ustar\u000000', 257, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return header
}
const tar = (entries: TarEntry[]): Buffer => Buffer.concat([...entries.flatMap(({ name, data = '', type = '0', mode = 0o644 }) => {
  const body = Buffer.from(data)
  return [tarHeader(name, body.length, type, mode), body, Buffer.alloc((512 - body.length % 512) % 512)]
}), Buffer.alloc(1024)])

interface ZipEntry { name: string; data?: string | Buffer; mode?: number; flags?: number; declared?: number; offsetOf?: number }
const zip = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [], central: Buffer[] = [], offsets: number[] = []
  let offset = 0
  for (const entry of entries) {
    const raw = Buffer.from(entry.data ?? ''), body = deflateRawSync(raw), name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 30, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(entry.flags ?? 0, 8)
    record.writeUInt16LE(8, 10); record.writeUInt32LE(crc32(raw), 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(entry.declared ?? raw.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE((entry.mode ?? 0o100644) * 0x10000, 38)
    offsets.push(offset)
    record.writeUInt32LE(entry.offsetOf === undefined ? offset : offsets[entry.offsetOf]!, 42)
    central.push(record, name)
    if (entry.offsetOf === undefined) { locals.push(local, name, body); offset += 30 + name.length + body.length }
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

describe.runIf(compilable)('account file helper compress and extract', { tags: ['feature'] }, () => {
  let scratch = '', home = '', outside = '', harness = '', withoutZstd = ''

  const run = (request: Record<string, unknown>, options: { maxEntries?: number; quotaBytes?: number; binary?: string } = {}): Envelope => {
    const result = spawnSync(options.binary ?? harness, [home, String(options.maxEntries ?? 10_000), String(options.quotaBytes ?? 0)], { input: JSON.stringify(request), encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
    const envelope = JSON.parse(result.stdout) as Envelope
    expect(envelope).toMatchObject({ op: request.op })
    return envelope
  }
  const refused = (request: Record<string, unknown>, code: string, options?: Parameters<typeof run>[1]): Envelope['error'] => {
    const envelope = run(request, options)
    expect(envelope.ok, JSON.stringify(envelope)).toBe(false)
    expect(envelope.error?.code).toBe(code)
    return envelope.error
  }
  const names = async (directory: string): Promise<string[]> => (await readdir(directory)).sort()
  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o7777
  const put = (name: string, bytes: Buffer): Promise<void> => writeFile(join(home, name), bytes)
  const extract = (path: string, destination: string) => ({ op: 'extract', path, destination })

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'xpanel-helper-archive-'))
    const source = join(scratch, 'harness.c')
    harness = join(scratch, 'harness')
    withoutZstd = join(scratch, 'harness-without-zstd')
    await writeFile(source, harnessSource(ACCOUNT_FILE_HELPER_SOURCE_PATH))
    // The renamed production main loses the implicit return that only main gets.
    execFileSync(COMPILER, [...COMPILER_FLAGS, '-Wno-return-type', source, '-o', harness], { stdio: 'pipe', timeout: 60_000 })
    execFileSync(COMPILER, [...COMPILER_FLAGS, '-Wno-return-type', '-DXP_ZSTD_SONAME="libxpanel-absent-zstd.so.1"', source, '-o', withoutZstd], { stdio: 'pipe', timeout: 60_000 })
  })
  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }) })
  beforeEach(async () => {
    await rm(join(scratch, 'home'), { recursive: true, force: true })
    await rm(join(scratch, 'outside'), { recursive: true, force: true })
    home = join(scratch, 'home')
    outside = join(scratch, 'outside')
    await mkdir(join(home, 'site', 'theme', 'css'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(home, 'site', 'index.php'), '<?php echo 1;')
    await chmod(join(home, 'site', 'index.php'), 0o644)
    await writeFile(join(home, 'site', 'theme', 'style.css'), 'body{}'.repeat(4000))
    await writeFile(join(home, 'site', 'theme', 'css', 'a-very-long-file-name-'.repeat(6) + '.css'), 'a{}')
    await chmod(join(home, 'site', 'theme', 'style.css'), 0o600)
  })

  const expectSiteCopy = async (root: string): Promise<void> => {
    expect(await names(join(root, 'site'))).toEqual(['index.php', 'theme'])
    expect(await readFile(join(root, 'site', 'index.php'), 'utf8')).toBe('<?php echo 1;')
    expect(await readFile(join(root, 'site', 'theme', 'style.css'), 'utf8')).toBe('body{}'.repeat(4000))
    expect(await readFile(join(root, 'site', 'theme', 'css', 'a-very-long-file-name-'.repeat(6) + '.css'), 'utf8')).toBe('a{}')
    expect(await modeOf(join(root, 'site', 'index.php'))).toBe(0o640)
    expect(await modeOf(join(root, 'site', 'theme', 'style.css'))).toBe(0o600)
  }

  it.each(['site.zip', 'site.tar', 'site.tar.gz', 'site.tgz', 'site.tar.bz2', 'site.tar.zst'])('compresses a folder to %s and extracts it back unchanged', async archive => {
    expect(run({ op: 'compress', path: 'site', destination: archive })).toMatchObject({ ok: true, result: { name: archive, path: archive, kind: 'file', mode: 0o640 } })
    expect(await modeOf(join(home, archive))).toBe(0o640)
    expect(run(extract(archive, 'restored'))).toMatchObject({ ok: true, result: { destination: 'restored', entries: 6, bytes: 13 + 24_000 + 3 } })
    expect(await modeOf(join(home, 'restored'))).toBe(0o750)
    await expectSiteCopy(join(home, 'restored'))
    expect((await names(home)).filter(name => name.startsWith('.xpanel-tmp-'))).toEqual([])
  })

  it.runIf(existsSync('/usr/bin/tar'))('writes tar archives that GNU tar reads, and reads GNU tar archives with long names', async () => {
    expect(run({ op: 'compress', path: 'site', destination: 'site.tar.gz' }).ok).toBe(true)
    const listed = execFileSync('/usr/bin/tar', ['-tzf', join(home, 'site.tar.gz')], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(listed).toEqual(['site/', 'site/index.php', 'site/theme/', 'site/theme/css/', 'site/theme/css/' + 'a-very-long-file-name-'.repeat(6) + '.css', 'site/theme/style.css'])
    execFileSync('/usr/bin/tar', ['-C', home, '-czf', join(home, 'gnu.tar.gz'), './site'])
    expect(run(extract('gnu.tar.gz', 'from-gnu'))).toMatchObject({ ok: true, result: { destination: 'from-gnu' } })
    await expectSiteCopy(join(home, 'from-gnu'))
  })

  it('extracts a zip into the folder that holds it and into the home folder, never replacing an item', async () => {
    await put('pack.zip', zip([{ name: 'docs/', mode: 0o40755 }, { name: 'docs/readme.txt', data: 'hello' }, { name: 'top.txt', data: 'top' }]))
    expect(run(extract('pack.zip', ''))).toMatchObject({ ok: true, result: { destination: '', entries: 3, bytes: 8 } })
    expect(await readFile(join(home, 'docs', 'readme.txt'), 'utf8')).toBe('hello')
    expect(await modeOf(join(home, 'docs'))).toBe(0o750)
    await writeFile(join(home, 'site', 'top.txt'), 'keep')
    await put('site/pack.zip', await readFile(join(home, 'pack.zip')))
    refused(extract('site/pack.zip', 'site'), 'CONFLICT')
    expect(await readFile(join(home, 'site', 'top.txt'), 'utf8')).toBe('keep')
    expect(await names(join(home, 'site'))).toEqual(['index.php', 'pack.zip', 'theme', 'top.txt'])
  })

  it('decompresses single .gz, .bz2 and .zst files beside their names', async () => {
    await put('dump.sql.gz', gzipSync('select 1;\n'))
    await put('hello.txt.bz2', HELLO_BZ2)
    await put('notes.md.zst', zstdCompressSync('# notes\n'))
    expect(run(extract('dump.sql.gz', ''))).toMatchObject({ ok: true, result: { entries: 1, bytes: 10 } })
    expect(run(extract('hello.txt.bz2', ''))).toMatchObject({ ok: true, result: { entries: 1, bytes: 12 } })
    expect(run(extract('notes.md.zst', ''))).toMatchObject({ ok: true, result: { entries: 1, bytes: 8 } })
    expect(await readFile(join(home, 'dump.sql'), 'utf8')).toBe('select 1;\n')
    expect(await readFile(join(home, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(await readFile(join(home, 'notes.md'), 'utf8')).toBe('# notes\n')
  })

  it.each([
    ['tar', '../escape.txt'], ['tar', 'a/../../escape.txt'], ['tar', '/etc/escape.txt'], ['tar', 'a//b.txt'], ['tar', 'a\\..\\b.txt'], ['tar', '.trash/x'],
    ['zip', '../escape.txt'], ['zip', '/abs.txt'], ['zip', 'C:/windows.txt'], ['zip', '.xpanel-tmp-1-2/x'],
  ])('refuses a %s entry named %j and leaves nothing behind', async (format, name) => {
    await put('evil.' + format, format === 'tar' ? tar([{ name: 'ok.txt', data: 'fine' }, { name, data: 'pwned' }]) : zip([{ name: 'ok.txt', data: 'fine' }, { name, data: 'pwned' }]))
    refused(extract('evil.' + format, 'out'), 'FORBIDDEN')
    expect(await names(home)).toEqual(['evil.' + format, 'site'])
    expect(await names(outside)).toEqual([])
  })

  it.each([
    ['symbolic link', tar([{ name: 'link', type: '2' }])], ['hard link', tar([{ name: 'hard', type: '1' }])],
    ['character device', tar([{ name: 'tty', type: '3' }])], ['FIFO', tar([{ name: 'pipe', type: '6' }])],
    ['zip symbolic link', zip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }])], ['zip FIFO', zip([{ name: 'pipe', mode: 0o10644 }])],
  ])('refuses an archive holding a %s', async (_kind, archive) => {
    await put('special.bin', archive)
    refused(extract('special.bin', 'out'), 'FORBIDDEN')
    expect(await names(home)).toEqual(['site', 'special.bin'])
  })

  it('strips setuid, setgid, sticky and execute bits from extracted entries', async () => {
    await put('modes.tar', tar([{ name: 'bin/', type: '5', mode: 0o7777 }, { name: 'bin/tool', data: '#!/bin/sh', mode: 0o6755 }, { name: 'ro.txt', data: 'r', mode: 0o400 }]))
    expect(run(extract('modes.tar', 'out')).ok).toBe(true)
    expect(await modeOf(join(home, 'out', 'bin', 'tool'))).toBe(0o640)
    expect(await modeOf(join(home, 'out', 'bin'))).toBe(0o750)
    expect(await modeOf(join(home, 'out', 'ro.txt'))).toBe(0o600)
  })

  it('refuses entry-count, size, quota and ratio bombs before or while extracting, and cleans its staging folder', async () => {
    await put('many.tar', tar(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))))
    refused(extract('many.tar', 'out'), 'LIMIT_EXCEEDED', { maxEntries: 4 })
    await put('big.tar', tar([{ name: 'big.bin', data: Buffer.alloc(2 * MiB) }]))
    refused(extract('big.tar', 'out'), 'LIMIT_EXCEEDED', { quotaBytes: MiB })
    await put('declared.zip', zip([{ name: 'bomb.bin', data: 'x', declared: 2048 * MiB }]))
    refused(extract('declared.zip', 'out'), 'LIMIT_EXCEEDED')
    await put('ratio.tar.gz', gzipSync(tar([{ name: 'zeros.bin', data: Buffer.alloc(40 * MiB) }])))
    const ratio = refused(extract('ratio.tar.gz', 'out'), 'LIMIT_EXCEEDED')
    expect(ratio?.message).toMatch(/ratio/)
    await put('ratio.gz', gzipSync(Buffer.alloc(40 * MiB)))
    refused(extract('ratio.gz', ''), 'LIMIT_EXCEEDED')
    expect(await names(home)).toEqual(['big.tar', 'declared.zip', 'many.tar', 'ratio.gz', 'ratio.tar.gz', 'site'])
  })

  it('refuses overlapping, encrypted, duplicate, truncated and unknown archives', async () => {
    await put('overlap.zip', zip([{ name: 'a.txt', data: 'same bytes' }, { name: 'b.txt', data: 'same bytes', offsetOf: 0 }]))
    refused(extract('overlap.zip', 'out'), 'VALIDATION')
    await put('locked.zip', zip([{ name: 'a.txt', data: 'secret', flags: 1 }]))
    refused(extract('locked.zip', 'out'), 'VALIDATION')
    await put('twice.tar', tar([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]))
    refused(extract('twice.tar', 'out'), 'CONFLICT')
    const whole = tar([{ name: 'a.txt', data: Buffer.alloc(4096, 1) }])
    await put('cut.tar', whole.subarray(0, 1024))
    refused(extract('cut.tar', 'out'), 'VALIDATION')
    await put('cut.tar.gz', gzipSync(whole).subarray(0, 40))
    refused(extract('cut.tar.gz', 'out'), 'VALIDATION')
    await put('plain.txt', Buffer.from('not an archive'.repeat(100)))
    refused(extract('plain.txt', 'out'), 'VALIDATION')
    expect((await names(home)).filter(name => name === 'out' || name.startsWith('.xpanel-tmp-'))).toEqual([])
  })

  it('extracts only a regular, single-link archive owned by the account and never through a link', async () => {
    await put('pack.tar', tar([{ name: 'a.txt', data: 'a' }]))
    await symlink(join(home, 'pack.tar'), join(home, 'link.tar'))
    await link(join(home, 'pack.tar'), join(home, 'hard.tar'))
    await symlink(outside, join(home, 'escape'))
    refused(extract('link.tar', 'out'), 'FORBIDDEN')
    refused(extract('hard.tar', 'out'), 'FORBIDDEN')
    refused(extract('site', 'out'), 'FORBIDDEN')
    refused(extract('pack.tar', 'escape/out'), 'FORBIDDEN')
    refused(extract('pack.tar', '../outside'), 'FORBIDDEN')
    expect(await names(outside)).toEqual([])
  })

  it('refuses compress requests that would replace, mislabel, follow links or exceed the ceilings', async () => {
    await writeFile(join(home, 'taken.zip'), 'keep')
    refused({ op: 'compress', path: 'site', destination: 'taken.zip' }, 'CONFLICT')
    expect(await readFile(join(home, 'taken.zip'), 'utf8')).toBe('keep')
    refused({ op: 'compress', path: 'site', destination: 'site.rar' }, 'VALIDATION')
    refused({ op: 'compress', path: 'site', destination: 'site/inside.zip' }, 'VALIDATION')
    refused({ op: 'compress', path: 'site', destination: '../site.zip' }, 'FORBIDDEN')
    refused({ op: 'compress', path: 'site', destination: 'site.zip' }, 'LIMIT_EXCEEDED', { maxEntries: 3 })
    refused({ op: 'compress', path: 'site', destination: 'site.zip' }, 'LIMIT_EXCEEDED', { quotaBytes: 1024 })
    await symlink('/etc/passwd', join(home, 'site', 'theme', 'passwd'))
    refused({ op: 'compress', path: 'site', destination: 'site.tar.gz' }, 'FORBIDDEN')
    expect(await names(home)).toEqual(['site', 'taken.zip'])
  })

  it('reports a missing codec library with a stable reason instead of writing anything', async () => {
    const error = refused({ op: 'compress', path: 'site', destination: 'site.tar.zst' }, 'PRECONDITION_FAILED', { binary: withoutZstd })
    expect(error?.reason).toBe('archive_format_unavailable')
    await put('notes.md.zst', zstdCompressSync('# notes\n'))
    expect(refused(extract('notes.md.zst', ''), 'PRECONDITION_FAILED', { binary: withoutZstd })?.reason).toBe('archive_format_unavailable')
    expect(run({ op: 'compress', path: 'site', destination: 'site.tar.gz' }, { binary: withoutZstd }).ok).toBe(true)
    expect(await names(home)).toEqual(['notes.md.zst', 'site', 'site.tar.gz'])
  })
})
