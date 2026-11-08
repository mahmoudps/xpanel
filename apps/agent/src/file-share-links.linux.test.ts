import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openShareFile } from './file-share-links.ts'

const uid = process.getuid!()
let root = '', home = ''
const read = async (file: string, owner = uid): Promise<string> => { const opened = await openShareFile(home, file, owner); try { return (await opened.handle.readFile()).toString() } finally { await opened.handle.close() } }
const refused = (file: string, owner = uid) => expect(read(file, owner), file).rejects.toMatchObject({ code: 'NOT_FOUND' })

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'share-links-')); home = join(root, 'home')
  await mkdir(join(home, 'public_html/docs'), { recursive: true }); await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside/secret.txt'), 'secret')
  await writeFile(join(home, 'public_html/docs/report.txt'), 'report')
  await symlink(join(root, 'outside/secret.txt'), join(home, 'public_html/link.txt'))
  await symlink(join(root, 'outside'), join(home, 'public_html/linkdir'))
  await symlink('docs/report.txt', join(home, 'public_html/inner.txt'))
  await link(join(root, 'outside/secret.txt'), join(home, 'public_html/hard.txt'))
  execFileSync('mkfifo', [join(home, 'public_html/pipe')])
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('share file walk on a real filesystem', () => {
  it('opens the regular file the link names and identifies it', async () => {
    expect(await read('public_html/docs/report.txt')).toBe('report')
    const opened = await openShareFile(home, 'public_html/docs/report.txt', uid)
    await opened.handle.close()
    expect(opened).toMatchObject({ sizeBytes: 6, fileId: expect.stringMatching(/^[0-9]+:[0-9]+$/) })
  })
  it('refuses a symlink out of the account as the last component', async () => { await refused('public_html/link.txt') })
  it('refuses a symlink out of the account as a directory', async () => { await refused('public_html/linkdir/secret.txt') })
  it('refuses a symlink even when it stays inside the home', async () => { await refused('public_html/inner.txt') })
  it('refuses a hard link to a file outside the home', async () => { await refused('public_html/hard.txt') })
  it('refuses traversal in every spelling', async () => { for (const file of ['../outside/secret.txt', 'public_html/../../outside/secret.txt', '/etc/passwd', 'public_html//docs/report.txt', 'public_html/./docs/report.txt', '']) await refused(file) })
  it('refuses a directory, a FIFO and a missing file without blocking', async () => { for (const file of ['public_html/docs', 'public_html/pipe', 'public_html/none.txt']) await refused(file) })
  it('refuses a file the account does not own', async () => { await refused('public_html/docs/report.txt', uid + 1) })
})
