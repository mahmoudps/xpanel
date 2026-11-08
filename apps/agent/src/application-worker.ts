import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { fail, isAccountHome } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { ApplicationTarget } from './application-install.ts'

/**
 * Account file work of a site application: one short process as the account, inside its jail. Every path is opened relative
 * to a held directory descriptor with O_NOFOLLOW, so a link the site planted cannot redirect a write.
 *
 * ~/.xpanel-apps/instances/<key>.json  the installed record: a summary line (read by the panel), then the file lists.
 * ~/.xpanel-apps/journal/<key>/        one transaction: journal.json, pre/<n> preimages, applied.json, next.json.
 *
 * The rename of next.json over the record is the commit point. Until then recover restores the preimages, and a file that
 * is neither its preimage nor what this transaction wrote is someone else's data: recovery stops and keeps the journal.
 */
export const APPLICATION_WORKER_SCRIPT = String.raw`
import errno, hashlib, json, os, stat, sys

STORE = '.xpanel-apps'
CHUNK = 1 << 20
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
# The panel writes these into a new document root, so they do not make it occupied.
HOUSEKEEPING = {'.well-known', 'cgi-bin', '.user.ini'}


class Refused(Exception):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def beneath(base, path, create=False):
    fd = os.dup(base)
    try:
        for part in path.split('/') if path else []:
            try:
                step = os.open(part, DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                os.mkdir(part, 0o755, dir_fd=fd)
                step = os.open(part, DIRECTORY, dir_fd=fd)
                os.fchmod(step, 0o755)
            os.close(fd)
            fd = step
    except BaseException:
        os.close(fd)
        raise
    return fd


def split(path):
    head, _, name = path.rpartition('/')
    return head, name


def read_bytes(parent, name):
    if parent is None:
        return None
    try:
        fd = os.open(name, REGULAR, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refused('application_path_conflict')
        chunks = []
        while True:
            chunk = os.read(fd, CHUNK)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def measure(parent, name):
    if parent is None:
        return None
    try:
        fd = os.open(name, REGULAR, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Refused('application_path_conflict')
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, CHUNK)
            if not chunk:
                return {'sha256': digest.hexdigest(), 'bytes': info.st_size, 'mode': stat.S_IMODE(info.st_mode)}
            digest.update(chunk)
    finally:
        os.close(fd)


def measure_path(root, path):
    head, name = split(path)
    parent = beneath(root, head) if root is not None else None
    try:
        return measure(parent, name)
    finally:
        if parent is not None:
            os.close(parent)


def durable(parent, name, data):
    temporary = name + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)


def plain(parent, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def remove_tree(parent, name):
    try:
        fd = os.open(name, DIRECTORY, dir_fd=parent)
    except FileNotFoundError:
        return
    except OSError as error:
        if error.errno != errno.ENOTDIR and error.errno != errno.ELOOP:
            raise
        os.unlink(name, dir_fd=parent)
        return
    try:
        for entry in os.listdir(fd):
            remove_tree(fd, entry)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)


def ensure(home, name):
    store = beneath(home, STORE, True)
    os.fchmod(store, 0o700)
    return beneath(store, name, True)


def journal_of(home, key):
    store = beneath(home, STORE)
    if store is None:
        return None, None
    journals = beneath(store, 'journal')
    journal = beneath(journals, key) if journals is not None else None
    return journals, journal


def record_bytes(home, key):
    store = beneath(home, STORE)
    instances = beneath(store, 'instances') if store is not None else None
    return read_bytes(instances, key + '.json')


def parsed(raw):
    if not raw:
        return None
    summary, _, detail = raw.partition(b'\n')
    return {**json.loads(summary), **json.loads(detail)}


def tops(manifest):
    names = set()
    if manifest:
        rows = list(manifest['files']) + (manifest['previous']['files'] if manifest.get('previous') else [])
        names = {row['path'].split('/')[0] for row in rows}
        if manifest.get('config'):
            names.add(manifest['config'].split('/')[0])
    return names


def observe(home, request):
    key, active = request['key'], request.get('active')
    raw = record_bytes(home, key)
    blocked = False
    _, journal = journal_of(home, key)
    if journal is not None:
        info = read_bytes(journal, 'journal.json')
        blocked = info is None or json.loads(info)['transactionId'] != active
        if not blocked:
            staged = read_bytes(journal, 'next.json')
            raw = raw if staged is None else staged
    manifest = parsed(raw)
    root = beneath(home, request['root'])
    names = sorted(name for name in os.listdir(root) if not name.startswith('.xpanel-tmp-')) if root is not None else []
    digests, clean = [], True
    for row in (manifest['files'] if manifest else []):
        try:
            found = measure_path(root, row['path'])
        except (Refused, OSError):
            found = None
        digests.append(found['sha256'] if found else '')
        clean = clean and digests[-1] == row['sha256']
    unmanaged = [name for name in names if name not in tops(manifest)]
    unmanaged_revision = sha('\0'.join(unmanaged).encode())
    installation = None
    if manifest:
        installation = {name: manifest[name] for name in ('appId', 'version', 'artifactSha256', 'files', 'previous', 'database', 'config')}
    return {
        'revision': sha(json.dumps([key, sha(raw or b''), digests, unmanaged_revision, blocked]).encode()),
        'unmanagedRevision': unmanaged_revision,
        'empty': manifest is None and set(unmanaged) <= HOUSEKEEPING,
        'managedClean': clean,
        'recoveryRequired': blocked,
        'installation': installation,
    }


def snapshot(home, request):
    key = request['key']
    journals = ensure(home, 'journal')
    try:
        os.mkdir(key, 0o700, dir_fd=journals)
    except FileExistsError:
        raise Refused('application_transaction_active')
    try:
        journal = beneath(journals, key)
        os.mkdir('pre', 0o700, dir_fd=journal)
        pre = beneath(journal, 'pre')
        root = beneath(home, request['root'])
        rows = []
        fresh = set(request['fresh'])
        for index, path in enumerate(request['paths']):
            head, name = split(path)
            parent = beneath(root, head) if root is not None else None
            data = read_bytes(parent, name)
            row = {'path': path}
            if data is not None:
                if path in fresh:
                    raise Refused('application_path_conflict')
                plain(pre, str(index), data)
                row.update(index=index, sha256=sha(data), mode=stat.S_IMODE(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode))
            if parent is not None:
                os.close(parent)
            rows.append(row)
        # One sync, not one fsync per file: 3300 fsyncs took 30 s and the account lease is held meanwhile.
        os.sync()
        durable(journal, 'journal.json', json.dumps({
            'transactionId': request['transactionId'], 'beforeRevision': request['beforeRevision'],
            'next': request['next'], 'database': request['database'], 'files': rows,
        }).encode())
        os.fsync(journals)
    except BaseException:
        remove_tree(journals, key)
        raise
    return {'durable': True}


def owned_journal(home, request):
    _, journal = journal_of(home, request['key'])
    if journal is None:
        raise Refused('application_transaction_missing')
    info = read_bytes(journal, 'journal.json')
    if info is None or json.loads(info)['transactionId'] != request['transactionId']:
        raise Refused('application_transaction_mismatch')
    return journal, json.loads(info)


def planned_directories(home, root, paths):
    parts = root.split('/')
    wanted = {'/'.join(parts[:index]) for index in range(1, len(parts) + 1)}
    for path in paths:
        heads = path.split('/')[:-1]
        wanted.update(root + '/' + '/'.join(heads[:index]) for index in range(1, len(heads) + 1))
    missing = []
    for directory in sorted(wanted, key=lambda item: (item.count('/'), item)):
        fd = beneath(home, directory)
        if fd is None:
            missing.append(directory)
        else:
            os.close(fd)
    return missing


def temporary_name(transaction, index):
    return '.xpanel-tmp-' + transaction + '-' + str(index)


def apply(home, request):
    journal, _ = owned_journal(home, request)
    transaction, writes = request['transactionId'], request['write']
    made = planned_directories(home, request['root'], [row['path'] for row in writes])
    durable(journal, 'applied.json', json.dumps({'writes': {row['path']: row['sha256'] for row in writes}, 'made': made}).encode())
    root = beneath(home, request['root'], True)
    for index, row in enumerate(writes):
        head, name = split(row['path'])
        parent = beneath(root, head, True)
        temporary = temporary_name(transaction, index)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        digest, left = hashlib.sha256(), row['bytes']
        try:
            while left:
                chunk = sys.stdin.buffer.read(min(left, CHUNK))
                if not chunk:
                    raise Refused('application_payload_truncated')
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
                left -= len(chunk)
            if digest.hexdigest() != row['sha256']:
                raise Refused('application_payload_digest')
            os.fchmod(fd, int(row['mode'], 8))
        finally:
            os.close(fd)
        os.close(parent)
    # Everything is on disk before the first visible change, so a full quota changes nothing the site can see.
    os.sync()
    for index, row in enumerate(writes):
        head, name = split(row['path'])
        parent = beneath(root, head)
        os.replace(temporary_name(transaction, index), name, src_dir_fd=parent, dst_dir_fd=parent)
        if index + 1 == len(writes) or split(writes[index + 1]['path'])[0] != head:
            os.fsync(parent)
        os.close(parent)
    for path in request['remove']:
        head, name = split(path)
        parent = beneath(root, head)
        if parent is not None:
            try:
                os.unlink(name, dir_fd=parent)
            except FileNotFoundError:
                pass
            os.close(parent)
    prune(root, sorted({split(path)[0] for path in request['remove'] if '/' in path}, key=len, reverse=True))
    durable(journal, 'next.json', request['manifest'].encode())
    return {'applied': True}


def prune(root, directories):
    for directory in directories:
        walked = directory
        while walked:
            head, name = split(walked)
            parent = beneath(root, head)
            if parent is None:
                break
            try:
                os.rmdir(name, dir_fd=parent)
            except OSError:
                os.close(parent)
                break
            os.close(parent)
            walked = head


def commit(home, request):
    journal, _ = owned_journal(home, request)
    key = request['key']
    staged = read_bytes(journal, 'next.json')
    if staged is None:
        raise Refused('application_transaction_unapplied')
    instances = ensure(home, 'instances')
    if staged:
        os.replace('next.json', key + '.json', src_dir_fd=journal, dst_dir_fd=instances)
    else:
        try:
            os.unlink(key + '.json', dir_fd=instances)
        except FileNotFoundError:
            pass
    os.fsync(instances)
    journals, _ = journal_of(home, key)
    remove_tree(journals, key)
    return {'committed': True}


def sweep(root, rows, transaction):
    for head in {split(row['path'])[0] for row in rows}:
        parent = beneath(root, head) if root is not None else None
        if parent is None:
            continue
        for name in os.listdir(parent):
            if name.startswith('.xpanel-tmp-' + transaction + '-'):
                os.unlink(name, dir_fd=parent)
        os.close(parent)


def recover(home, request):
    key = request['key']
    journals, journal = journal_of(home, key)
    if journal is None:
        return {'state': 'none'}
    raw = read_bytes(journal, 'journal.json')
    if raw is None:
        remove_tree(journals, key)
        return {'state': 'none'}
    info = json.loads(raw)
    if info['transactionId'] != request['transactionId']:
        raise Refused('application_transaction_mismatch')
    result = {'beforeRevision': info['beforeRevision'], 'database': info['database']}
    if sha(record_bytes(home, key) or b'') == info['next']:
        remove_tree(journals, key)
        return {'state': 'committed', **result}
    root = beneath(home, request['root'])
    applied = read_bytes(journal, 'applied.json')
    if applied is None:
        remove_tree(journals, key)
        return {'state': 'not_started', **result}
    applied = json.loads(applied)
    sweep(root, info['files'], request['transactionId'])
    pending = []
    for row in info['files']:
        found = measure_path(root, row['path'])
        current = found['sha256'] if found else None
        if current == row.get('sha256'):
            continue
        if current is not None and current != applied['writes'].get(row['path']):
            return {'state': 'unknown', **result}
        pending.append(row)
    pre = beneath(journal, 'pre')
    root = beneath(home, request['root'], True) if pending else root
    for row in pending:
        head, name = split(row['path'])
        if 'index' not in row:
            parent = beneath(root, head)
            os.unlink(name, dir_fd=parent)
            os.close(parent)
            continue
        parent = beneath(root, head, True)
        data = read_bytes(pre, str(row['index']))
        if sha(data) != row['sha256']:
            return {'state': 'unknown', **result}
        temporary = temporary_name(request['transactionId'], row['index'])
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fchmod(fd, row['mode'])
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        os.close(parent)
    for directory in reversed(applied['made']):
        head, name = split(directory)
        parent = beneath(home, head)
        if parent is not None:
            try:
                os.rmdir(name, dir_fd=parent)
            except OSError:
                pass
            os.close(parent)
    root = beneath(home, request['root'])
    for row in info['files']:
        found = measure_path(root, row['path'])
        if (found['sha256'] if found else None) != row.get('sha256'):
            return {'state': 'unknown', **result}
    remove_tree(journals, key)
    return {'state': 'restored', **result}


def pending(home, request):
    key = request['key']
    journals, journal = journal_of(home, key)
    raw = read_bytes(journal, 'journal.json') if journal is not None else None
    if raw is None:
        # A snapshot that stopped before its journal changed nothing.
        if journal is not None:
            remove_tree(journals, key)
        return {'transactions': []}
    info = json.loads(raw)
    committed = sha(record_bytes(home, key) or b'') == info['next']
    expected = observe(home, {**request, 'active': info['transactionId']})['revision'] if committed else None
    return {'transactions': [{'transactionId': info['transactionId'], 'beforeRevision': info['beforeRevision'], 'expectedCommittedRevision': expected}]}


def main():
    request = json.loads(sys.stdin.buffer.readline())
    home = os.open('.', DIRECTORY)
    operations = {'observe': observe, 'snapshot': snapshot, 'apply': apply, 'commit': commit, 'recover': recover, 'pending': pending}
    print(json.dumps({'ok': True, 'result': operations[request['op']](home, request)}))


try:
    main()
except Refused as refusal:
    print(json.dumps({'ok': False, 'reason': str(refusal)}))
    sys.exit(1)
except OSError as error:
    full = error.errno in (errno.EDQUOT, errno.ENOSPC)
    conflict = error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR)
    print(json.dumps({'ok': False, 'reason': 'application_disk_full' if full else 'application_path_conflict' if conflict else 'application_worker_failed'}))
    sys.exit(1)
`

/** The unit ends itself before the coordinator's stage deadline, so a resolved call means no write can still be running. */
export const buildApplicationWorkerCommand = (target: Pick<ApplicationTarget, 'username' | 'uid' | 'gid' | 'home'>, seconds: number): string[] => {
  const skeleton = system.buildJailedFileOpArgv(target, ['/usr/bin/id'])
  return [...skeleton.slice(0, skeleton.lastIndexOf('--')), '--property', `RuntimeMaxSec=${seconds}s`, '--property', 'TimeoutStopSec=5s', '--property', 'MemoryMax=128M', '--property', 'TasksMax=4',
    '--', system.RUNTIME_BINARIES.python, '-I', '-c', APPLICATION_WORKER_SCRIPT]
}

export type ApplicationWorkerRun = (target: ApplicationTarget, request: Readonly<Record<string, unknown>>, payload: readonly Uint8Array[], seconds: number) => Promise<Record<string, unknown>>
const MAX_REPLY_BYTES = 8 * 1024 * 1024
interface WorkerReply { ok?: unknown; result?: unknown; reason?: unknown }

/** Sends the request line and the payload on standard input, so a secret or a file never reaches an argument list. */
export function runApplicationWorker(argv: readonly string[], cwd: string | undefined, request: Readonly<Record<string, unknown>>, payload: readonly Uint8Array[], seconds: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], ...(cwd ? { cwd } : {}) })
    const chunks: Buffer[] = []
    let bytes = 0
    const stuck = setTimeout(() => child.kill('SIGKILL'), (seconds + 10) * 1000)
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= MAX_REPLY_BYTES) chunks.push(chunk) })
    child.stdin!.on('error', () => undefined)
    child.on('error', () => { clearTimeout(stuck); reject(new Error('application_worker_unavailable')) })
    child.on('close', () => {
      clearTimeout(stuck)
      let reply: WorkerReply | null = null
      try { reply = bytes <= MAX_REPLY_BYTES ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerReply : null } catch { reply = null }
      if (reply?.ok === true && reply.result && typeof reply.result === 'object') return resolve(reply.result as Record<string, unknown>)
      try { fail('PRECONDITION_FAILED', 'the application files could not be changed or read', { stateChanged: false, reason: typeof reply?.reason === 'string' ? reply.reason : 'application_worker_failed' }) } catch (error) { reject(error) }
    })
    void (async () => {
      const stdin = child.stdin!
      const send = async (data: Uint8Array | string): Promise<void> => { if (!stdin.writable) return; if (!stdin.write(data)) await new Promise<void>(done => { stdin.once('drain', done); stdin.once('close', done) }) }
      await send(JSON.stringify(request) + '\n')
      for (const chunk of payload) await send(chunk)
      stdin.end()
    })()
  })
}

/** Only construct this adapter on a native Linux host. */
export function createNativeApplicationWorkerRun(): ApplicationWorkerRun {
  return async (target, request, payload, seconds) => {
    const info = await lstat(target.home).catch(() => null)
    if (!isAccountHome(target.home, target.username) || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== target.uid || info.gid !== target.gid || await realpath(target.home) !== target.home) return fail('PRECONDITION_FAILED', 'the account home identity could not be verified', { stateChanged: false })
    return runApplicationWorker(buildApplicationWorkerCommand(target, seconds), undefined, request, payload, seconds)
  }
}
