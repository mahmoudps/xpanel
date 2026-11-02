import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const outputs = new Set(['node_modules', '.pnpm-store', '.tools', 'dist', 'coverage', '.secrets', '.vite', 'playwright-report', 'test-results', '.artifacts'])
// Exact public synthetic test data; neither its path nor its directory is sufficient.
const syntheticKeys = new Map([
  ['packages/lifecycle/src/testing/cpanel-fixture.ts', {
    blobSha256: 'd5f784567ef4e1925746dc2ae252a88f4b719599a628d1379b50f7ddd9835897',
    rule: 'parseable-pem-private-key', asymmetricKeyType: 'ec',
    blockSha256: '8b7f571cac756355e4077c522a707d344c6dae8464da5c0d2216125296f17dca',
    spkiSha256: '61fbef0b179ec578455cdd75732bb74672c4571e1694c48881a23164be927013',
  }],
])
const digest = value => createHash('sha256').update(value).digest('hex')
const unavailable = () => { throw new Error('Unable to inspect the Git index') }

function git(cwd, args, input) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, input, windowsHide: true, shell: false, maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) unavailable()
  return result.stdout
}

function prohibited(path, mode) {
  const pieces = path.split('/'), name = pieces.at(-1)
  return (mode === '160000' ? pieces : pieces.slice(0, -1)).some(piece => outputs.has(piece))
    || name.endsWith('.log') || name.endsWith('.tsbuildinfo')
    || ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example')
    || path === 'deploy/.data' || path.startsWith('deploy/.data/')
}

function encodedBody(text) {
  const compact = text.replace(/\s/g, '')
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4) return null
  const bytes = Buffer.from(compact, 'base64')
  return bytes.toString('base64') === compact ? bytes : null
}

function sequence(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x30) return false
  const first = bytes[1]
  if (first < 0x80) return bytes.length === first + 2 && first > 0
  const count = first & 0x7f
  if (count < 1 || count > 4 || bytes.length < count + 2) return false
  let length = 0
  for (let index = 0; index < count; index++) length = length * 256 + bytes[index + 2]
  return length > 0 && bytes.length === length + count + 2
}

const finding = (key, bytes, rule) => ({
  rule, asymmetricKeyType: key.asymmetricKeyType, blockSha256: digest(bytes),
  spkiSha256: digest(createPublicKey(key).export({ type: 'spki', format: 'der' })),
})

function privateKeys(bytes) {
  if (bytes[0] === 0x30) {
    for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
      try { return [finding(createPrivateKey({ key: bytes, format: 'der', type }), bytes, 'parseable-der-private-key')] } catch {}
    }
  }
  if (!bytes.includes(Buffer.from('-----BEGIN '))) return []
  const found = [], text = bytes.toString('utf8')
  for (const match of text.matchAll(/-----BEGIN ((?:RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g)) {
    const block = match[0].replaceAll('\\r', '\r').replaceAll('\\n', '\n')
    try { found.push(finding(createPrivateKey(block), Buffer.from(match[0]), 'parseable-pem-private-key')); continue } catch {}
    const body = match[2].replaceAll('\\r', '\r').replaceAll('\\n', '\n'), decoded = encodedBody(body)
    // Encrypted and OpenSSH containers do not require a password to be rejected.
    const protectedContainer = decoded && ((match[1] === 'ENCRYPTED PRIVATE KEY' && sequence(decoded))
      || (match[1] === 'OPENSSH PRIVATE KEY' && decoded.length > 32 && decoded.subarray(0, 15).equals(Buffer.from('openssh-key-v1\0'))))
    const legacy = /^\s*Proc-Type:\s*4,ENCRYPTED\r?\nDEK-Info:\s*[A-Z0-9-]+,[A-Fa-f0-9]+\r?\n\s*([\s\S]+)$/.exec(body)
    if (protectedContainer || (legacy && encodedBody(legacy[1]))) found.push({ rule: 'private-key-container', blockSha256: digest(Buffer.from(match[0])) })
  }
  return found
}

export function checkPublicOutputs(cwd = process.cwd()) {
  const snapshot = git(cwd, ['ls-files', '--stage', '-z'])
  const entries = snapshot.toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t'), header = record.slice(0, tab).split(' ')
    if (tab < 0 || header.length !== 3 || !/^[0-7]{6}$/.test(header[0])
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(header[1]) || header[2] !== '0') unavailable()
    return { mode: header[0], oid: header[1], path: record.slice(tab + 1) }
  })
  const ids = [...new Set(entries.filter(entry => entry.mode !== '160000').map(entry => entry.oid))]
  const data = ids.length ? git(cwd, ['cat-file', '--batch'], ids.join('\n') + '\n') : Buffer.alloc(0)
  const blobs = new Map()
  let offset = 0
  for (const oid of ids) {
    const end = data.indexOf(10, offset)
    if (end < 0) unavailable()
    const fields = data.subarray(offset, end).toString('ascii').split(' '), size = Number(fields[2])
    if (fields.length !== 3 || fields[0] !== oid || fields[1] !== 'blob'
      || !/^[0-9]+$/.test(fields[2]) || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= data.length) unavailable()
    const bytes = data.subarray(end + 1, end + size + 1)
    if (data[end + size + 1] !== 10) unavailable()
    blobs.set(oid, { keys: privateKeys(bytes), sha256: digest(bytes) })
    offset = end + size + 2
  }
  if (offset !== data.length || !snapshot.equals(git(cwd, ['ls-files', '--stage', '-z']))) unavailable()
  const result = { trackedPaths: entries.length, prohibitedPaths: 0, privateKeyFiles: 0, adjudicatedKeyFiles: 0, rejectedKeyFiles: 0 }
  for (const entry of entries) {
    if (prohibited(entry.path, entry.mode)) result.prohibitedPaths++
    const blob = blobs.get(entry.oid)
    if (!blob?.keys.length) continue
    result.privateKeyFiles++
    const allowed = syntheticKeys.get(entry.path), key = blob.keys[0]
    if (allowed && blob.sha256 === allowed.blobSha256 && blob.keys.length === 1
      && key.rule === allowed.rule && key.asymmetricKeyType === allowed.asymmetricKeyType
      && key.blockSha256 === allowed.blockSha256 && key.spkiSha256 === allowed.spkiSha256) result.adjudicatedKeyFiles++
    else result.rejectedKeyFiles++
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkPublicOutputs(), passed = result.prohibitedPaths === 0 && result.rejectedKeyFiles === 0
    console.log('Public output check ' + (passed ? 'passed: ' : 'failed: ') + JSON.stringify(result))
    process.exitCode = passed ? 0 : 1
  } catch {
    console.error('Public output check failed: unable to inspect indexed data.')
    process.exitCode = 1
  }
}
