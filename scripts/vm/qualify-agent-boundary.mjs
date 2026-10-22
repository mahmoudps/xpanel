import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, chown, lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { disposableVmAcknowledgement } from '../test-linux-preflight.mjs'
import { verifySnapshotReceipt } from './verify-source-snapshot.mjs'

const sourceRoot = resolve(import.meta.dirname, '../..')
const argument = name => process.argv.slice(2).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const binaries = ['/usr/bin/systemctl', '/usr/bin/getent', '/usr/sbin/groupadd', '/usr/sbin/groupdel', '/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/runuser', '/usr/bin/chown']
const sourcePaths = ['.node-version', 'apps/agent/src/main.ts', 'apps/agent/src/server.ts', 'apps/api/src/main.ts', 'apps/api/src/cli.ts', 'apps/api/src/server.ts', 'apps/api/src/agent-client.ts', 'apps/api/src/auth.ts', 'packages/core/src/errors.ts', 'packages/db/src/client.ts', 'pnpm-lock.yaml', 'package.json', 'scripts/vm/qualify-agent-boundary.mjs']

export function agentBoundaryPreflight(snapshotHash, receiptPath = null) {
  const reasons = []
  let receipt = null
  if (process.platform !== 'linux') reasons.push('Native Linux is required; no WSL or privilege escalation is started.')
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) reasons.push('Explicit disposable-VM acknowledgement is required.')
  if (!/^[a-f0-9]{64}$/.test(snapshotHash ?? '')) {
    reasons.push('A coordinator supplied --snapshot-sha256=<64 lowercase hex> is required.')
  } else {
    const receiptCheck = verifySnapshotReceipt({
      rootDir: sourceRoot,
      expectedArchiveSha256: snapshotHash,
      receiptPath,
    })
    if (!receiptCheck.ok) {
      reasons.push(...receiptCheck.reasons)
    } else {
      receipt = receiptCheck.receipt
    }
  }
  if (reasons.length) return { status: 'blocked', reasons, receipt }
  if (process.getuid?.() !== 0) reasons.push('The explicitly acknowledged disposable VM requires root.')
  if (!existsSync('/run/systemd/system')) reasons.push('A booted systemd VM is required.')
  for (const path of binaries) if (!existsSync(path)) reasons.push(`Fixture tool is unavailable: ${path}`)
  try {
    const pin = readFileSync(resolve(sourceRoot, '.node-version'), 'utf8').trim()
    if (!/^26\.\d+\.\d+$/.test(pin) || process.version !== `v${pin}`) reasons.push(`The exact project Node pin is required: ${pin}.`)
  } catch { reasons.push('The project .node-version runtime pin is unavailable.') }
  for (const path of [sourceRoot, process.execPath]) if (!/^\/[a-zA-Z0-9_./-]+$/.test(path)) reasons.push('Fixture source and runtime paths must contain only simple absolute path characters.')
  return { status: reasons.length ? 'blocked' : 'available', reasons, receipt }
}

const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
const command = (file, argv, options = {}) => {
  const result = spawnSync(file, argv, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, ...options })
  return { exit_code: result.status, signal: result.signal, error_code: result.error?.code ?? null, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' }
}
const mustRun = (file, argv, options) => {
  const result = command(file, argv, options)
  assert.equal(result.exit_code, 0, `fixture command failed: ${file} ${argv[0] ?? ''}; ${result.stderr}`)
  return result.stdout
}
const entity = (kind, name) => command('/usr/bin/getent', [kind, name])
const waitFor = async (probe, message, milliseconds = 20_000) => {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value } catch {}
    await sleep(100)
  }
  throw new Error(message)
}
const ipc = (socketPath, path, headers = {}) => new Promise((resolveResponse, rejectResponse) => {
  const outgoing = request({ socketPath, path, headers, method: 'GET', timeout: 2_000 }, response => {
    const chunks = []
    let bytes = 0
    response.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) { response.destroy(); rejectResponse(new Error('fixture response exceeded its limit')); return }
      chunks.push(Buffer.from(chunk))
    })
    response.once('end', () => resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
    response.once('error', rejectResponse)
  })
  outgoing.once('error', rejectResponse)
  outgoing.once('timeout', () => outgoing.destroy(new Error('fixture IPC timeout')))
  outgoing.end()
})
const fingerprint = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(sourceRoot, path))).digest('hex') })))
const metadata = async path => {
  const value = await lstat(path)
  return { uid: value.uid, gid: value.gid, mode: (value.mode & 0o7777).toString(8), socket: value.isSocket(), regular: value.isFile(), symlink: value.isSymbolicLink() }
}
const processIdentity = async pid => {
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  return { pid, uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), gid: Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]) }
}

export async function qualifyAgentBoundary(snapshotHash) {
  const preflight = agentBoundaryPreflight(snapshotHash)
  if (preflight.status === 'blocked') return { schema_version: 1, scope: 'S03 Linux process and service-credential boundary primitives', status: 'blocked', preflight }
  const startedAt = new Date().toISOString()
  const before = await fingerprint()
  const prefix = `xpqb${randomBytes(4).toString('hex')}`
  const apiUser = `${prefix}a`
  const outsiderUser = `${prefix}o`
  const failedLoginUsername = `${prefix}z`
  const ipcGroup = `${prefix}i`
  const base = `/var/lib/${prefix}`
  const runtime = `/run/${prefix}`
  const socketPath = `${runtime}/agent.sock`
  const dbPath = `${base}/data/control.db`
  const stateDir = `${base}/data/state`
  const tokenFile = `${base}/etc/agent.token`
  const serverSecretFile = `${base}/etc/server.secret`
  const probeFile = `${base}/probe.mjs`
  const probeConfig = `${base}/probe.json`
  const agentUnit = `${prefix}-agent.service`
  const apiUnit = `${prefix}-api.service`
  const unitPaths = [agentUnit, apiUnit].map(name => `/run/systemd/system/${name}`)
  const mailboxPaths = [apiUser, outsiderUser].map(name => `/var/mail/${name}`)
  const token = randomBytes(32).toString('hex')
  const serverSecret = randomBytes(32).toString('hex')
  const password = randomBytes(32).toString('hex')
  const apiToken = `xp_${randomBytes(32).toString('hex')}`
  const secrets = [token, serverSecret, password, apiToken]
  const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), String(text))
  const observations = []
  const cleanupErrors = []
  const groups = []
  const users = []
  const units = []
  let baseCreated = false
  let database
  let apiGid
  let apiUid
  let ipcGid
  let rootPrincipal
  let userPrincipal
  let domainId
  let port
  let fatal = null
  let serviceDiagnostics = []
  const check = async (id, description, run, required = false) => {
    try {
      const details = await run()
      observations.push({ id, description, status: 'passed', details: details ?? null })
      return details
    } catch (error) {
      observations.push({ id, description, status: 'failed', error: redact(error instanceof Error ? error.message : error) })
      if (required) throw error
      return null
    }
  }
  const pidOf = unit => Number(mustRun('/usr/bin/systemctl', ['show', unit, '--property=MainPID', '--value']))
  const agentReady = async () => {
    const pid = pidOf(agentUnit)
    if (!pid) return false
    // Readiness requires final boundary metadata; L03 asserts it independently.
    const [socket, parent] = await Promise.all([metadata(socketPath), metadata(runtime)])
    if (!socket.socket || socket.uid !== 0 || socket.gid !== ipcGid || socket.mode !== '660') return false
    if (parent.uid !== 0 || parent.gid !== ipcGid || parent.mode !== '750') return false
    const response = await ipc(socketPath, '/health', { 'x-xpanel-agent-token': token })
    return response.status === 200 ? pid : false
  }
  const apiRequest = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/analytics/websites/${domainId}`, {
      headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(5_000),
    })
    await response.arrayBuffer()
    return response.status
  }

  try {
    for (const name of [apiUser, outsiderUser, ipcGroup]) {
      assert.equal(entity('passwd', name).exit_code, 2, 'fixture username already exists')
      assert.equal(entity('group', name).exit_code, 2, 'fixture group already exists')
    }
    for (const path of [base, runtime, ...unitPaths, ...mailboxPaths]) assert.equal(existsSync(path), false, `fixture path already exists: ${path}`)
    for (const name of [apiUser, outsiderUser, ipcGroup]) {
      mustRun('/usr/sbin/groupadd', ['--system', name])
      const gid = Number(entity('group', name).stdout.split(':')[2])
      groups.push({ name, gid })
    }
    apiGid = groups.find(group => group.name === apiUser).gid
    ipcGid = groups.find(group => group.name === ipcGroup).gid
    for (const [name, supplementary] of [[apiUser, ipcGroup], [outsiderUser, null]]) {
      mustRun('/usr/sbin/useradd', ['--system', '--no-create-home', '--no-log-init', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--gid', name, ...(supplementary ? ['--groups', supplementary] : []), name])
      const uid = Number(entity('passwd', name).stdout.split(':')[2])
      users.push({ name, uid })
    }
    apiUid = users.find(user => user.name === apiUser).uid
    await mkdir(base, { mode: 0o755 })
    baseCreated = true
    await mkdir(`${base}/etc`, { mode: 0o750 })
    await chown(`${base}/etc`, 0, apiGid)
    await mkdir(`${base}/data`, { mode: 0o2770 })
    await chown(`${base}/data`, 0, apiGid)
    await chmod(`${base}/data`, 0o2770)
    await mkdir(stateDir, { mode: 0o770 })
    await chmod(stateDir, 0o770)
    await chown(stateDir, apiUid, apiGid)
    for (const [path, value] of [[tokenFile, token], [serverSecretFile, serverSecret]]) {
      await writeFile(path, `${value}\n`, { mode: 0o640, flag: 'wx' })
      await chown(path, 0, apiGid)
      await chmod(path, 0o640)
    }
    const dbModule = await import(pathToFileURL(resolve(sourceRoot, 'packages/db/src/index.ts')).href)
    const { StateStore } = await import(pathToFileURL(resolve(sourceRoot, 'packages/state/src/index.ts')).href)
    const auth = await import(pathToFileURL(resolve(sourceRoot, 'apps/api/src/auth.ts')).href)
    const seed = dbModule.createDb(dbPath)
    try {
      await dbModule.migrate(seed.runner)
      const hash = await auth.hashPasswordArgon2id(password)
      rootPrincipal = await dbModule.createRootPrincipal(seed.db, { username: 'root', passwordHash: hash, forcePasswordChange: false })
      await dbModule.setTotpSecret(seed.db, rootPrincipal.id, auth.sealTotpSecret(auth.generateTotpSecret(), serverSecret))
      const store = new StateStore(stateDir)
      const featureList = await store.createFeatureList({ name: 'Boundary qualification', ownerId: null, disabled: [] })
      const plan = await store.createPlan({
        name: 'Boundary qualification', ownerId: null, featureListId: featureList.id,
        resources: { diskMb: 128, bandwidthMbMonth: 1024, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 25 },
        caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 0, ftpAccounts: 0, databases: 0, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 16,
      })
      const account = await store.createAccount({
        username: `${prefix}t`, passwordHash: hash, primaryDomain: `${prefix}.example.test`, planId: plan.id, ownerId: null,
        contactEmail: 'qualification@example.test', ipv4: '192.0.2.42', shell: 'none',
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 10, processIdleTimeoutSec: 10 }, ini: {} },
      })
      domainId = (await store.listDomains({ accountId: account.id }))[0].id
      userPrincipal = await dbModule.createUserPrincipal(seed.db, { username: account.username, passwordHash: hash, accountId: account.id })
      await dbModule.createApiToken(seed.db, { principalId: rootPrincipal.id, name: 'Temporary boundary qualification', tokenHash: auth.sha256Hex(apiToken), scopes: ['*'], allowedIps: ['127.0.0.1'], expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    } finally { await seed.close() }
    await chown(dbPath, 0, apiGid)
    await chmod(dbPath, 0o660)
    // State is written by this fixture, not reconciled onto the host. Make it readable to the real API process.
    mustRun('/usr/bin/chown', ['-R', `${apiUid}:${apiGid}`, stateDir])

    const allocator = createServer()
    await new Promise((resolveListen, rejectListen) => { allocator.once('error', rejectListen); allocator.listen(0, '127.0.0.1', resolveListen) })
    port = allocator.address().port
    await new Promise(resolveClose => allocator.close(resolveClose))
    const sharedEnvironment = [
      `Environment=XPANEL_DB_PATH=${dbPath}`, `Environment=XPANEL_STATE_DIR=${stateDir}`,
      `Environment=XPANEL_AGENT_SOCKET=${socketPath}`, `Environment=XPANEL_AGENT_TOKEN_FILE=${tokenFile}`,
      `Environment=XPANEL_SERVER_SECRET_FILE=${serverSecretFile}`, `Environment=XPANEL_AGENT_GID=${ipcGid}`,
    ].join('\n')
    // Systemd sets RuntimeDirectory ownership again for the main executable.
    // Its primary IPC group owns runtime; setgid data keeps SQLite files in the API group.
    const agentService = `[Unit]\nDescription=Temporary xPanel boundary qualification agent\n[Service]\nType=simple\nUser=root\nGroup=${ipcGroup}\nSupplementaryGroups=${apiUser}\nUMask=0007\nWorkingDirectory=${sourceRoot}\nRuntimeDirectory=${prefix}\nRuntimeDirectoryMode=0750\nRuntimeDirectoryPreserve=no\n${sharedEnvironment}\nExecStart=${process.execPath} ${sourceRoot}/apps/agent/src/main.ts\nRestart=on-failure\nRestartSec=1\nTimeoutStopSec=10\n`
    const apiService = `[Unit]\nDescription=Temporary xPanel boundary qualification API\n[Service]\nType=simple\nUser=${apiUser}\nGroup=${apiUser}\nSupplementaryGroups=${ipcGroup}\nUMask=0007\nWorkingDirectory=${sourceRoot}\n${sharedEnvironment}\nEnvironment=XPANEL_HOST=127.0.0.1\nEnvironment=XPANEL_PORT=${port}\nExecStart=${process.execPath} ${sourceRoot}/apps/api/src/main.ts\nRestart=no\nTimeoutStopSec=10\n`
    for (const [index, content] of [agentService, apiService].entries()) {
      await writeFile(unitPaths[index], content, { mode: 0o644, flag: 'wx' })
      units.push(index === 0 ? agentUnit : apiUnit)
    }
    mustRun('/usr/bin/systemctl', ['daemon-reload'])
    const environment = { ...process.env, XPANEL_DB_PATH: dbPath, XPANEL_STATE_DIR: stateDir, XPANEL_AGENT_SOCKET: socketPath, XPANEL_AGENT_TOKEN_FILE: tokenFile, XPANEL_SERVER_SECRET_FILE: serverSecretFile, XPANEL_PORT: String(port) }
    await check('S03-L01', 'The API entrypoint rejects an operating-system root process before serving', () => {
      const result = command(process.execPath, [resolve(sourceRoot, 'apps/api/src/main.ts')], { env: environment, timeout: 5_000 })
      assert.notEqual(result.exit_code, 0)
      assert.equal(result.error_code, null)
      assert.match(result.stderr, /unprivileged Linux service/)
      return { exit_code: result.exit_code, root_rejected: true }
    })
    await check('S03-L21', 'A nonroot init-root entrypoint is rejected before opening its writable fixture DB or reading a password', () => {
      const target = `${base}/data/nonroot-bootstrap.db`
      const result = command('/usr/sbin/runuser', ['--user', apiUser, '--', process.execPath, resolve(sourceRoot, 'apps/api/src/main.ts'), 'init-root', '--password-stdin'], {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', XPANEL_DB_PATH: target, XPANEL_STATE_DIR: stateDir }, timeout: 5_000,
      })
      assert.notEqual(result.exit_code, 0)
      assert.equal(result.error_code, null)
      assert.match(result.stderr, /operating-system root/)
      assert.equal(existsSync(target), false)
      return { exit_code: result.exit_code, root_required: true, database_not_created: true }
    })
    await check('S03-L22', 'Root initializes a separate DB through stdin with forced password change and no credential output', async () => {
      const target = `${base}/data/root-bootstrap.db`
      const result = command(process.execPath, [resolve(sourceRoot, 'apps/api/src/main.ts'), 'init-root', '--password-stdin'], {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', XPANEL_DB_PATH: target, XPANEL_STATE_DIR: stateDir }, input: `${password}\n`, timeout: 15_000,
      })
      assert.equal(result.exit_code, 0)
      const output = `${result.stdout}\n${result.stderr}`
      assert.equal(output.includes(password), false)
      assert.equal(/\$argon2id\$/.test(output), false)
      const bootstrap = dbModule.createDb(target)
      try {
        const principal = await dbModule.findPrincipalByUsername(bootstrap.db, 'root')
        assert.ok(principal)
        assert.equal(principal.forcePasswordChange, true)
        assert.equal(await auth.verifyPasswordArgon2id(password, principal.passwordHash), true)
        assert.equal(output.includes(principal.passwordHash), false)
      } finally { await bootstrap.close() }
      return { exit_code: result.exit_code, forced_password_change: true, supplied_password_verified: true, no_password_or_hash_in_output: true, separate_fixture_database: true }
    })
    mustRun('/usr/bin/systemctl', ['start', agentUnit])
    const agentPid = await waitFor(agentReady, 'The real agent entrypoint did not become ready')
    await check('S03-L02', 'The real agent entrypoint runs as UID 0 in its own process', async () => {
      const identity = await processIdentity(agentPid)
      assert.equal(identity.uid, 0)
      assert.equal(identity.gid, ipcGid)
      assert.ok((await readFile(`/proc/${agentPid}/cmdline`, 'utf8')).includes('/apps/agent/src/main.ts'))
      return identity
    }, true)
    await check('S03-L03', 'The socket has root ownership, a dedicated API group and mode 0660', async () => {
      const socket = await metadata(socketPath)
      const parent = await metadata(runtime)
      assert.equal(socket.socket, true); assert.equal(socket.uid, 0); assert.equal(socket.gid, ipcGid); assert.equal(socket.mode, '660')
      assert.equal(parent.uid, 0); assert.equal(parent.gid, ipcGid); assert.equal(parent.mode, '750')
      return { socket, parent }
    }, true)
    await check('S03-L04', 'Both service secrets are protected root-owned regular files', async () => {
      const values = await Promise.all([tokenFile, serverSecretFile].map(metadata))
      for (const value of values) { assert.equal(value.uid, 0); assert.equal(value.gid, apiGid); assert.equal(value.mode, '640'); assert.equal(value.regular, true); assert.equal(value.symlink, false) }
      return { agent_credential: values[0], server_secret: values[1] }
    })

    await writeFile(probeConfig, JSON.stringify({ sourceRoot, socketPath, tokenFile, serverSecretFile }), { mode: 0o644, flag: 'wx' })
    const probeSource = `import { readFile } from 'node:fs/promises';\nimport { createConnection } from 'node:net';\nimport { pathToFileURL } from 'node:url';\nconst config=JSON.parse(await readFile(process.argv[3],'utf8'));\nlet result={uid:process.getuid(),gid:process.getgid()};\nif(process.argv[2]==='authorized'){\n const {loadAgentCredentialFile}=await import(pathToFileURL(config.sourceRoot+'/apps/agent/src/server.ts').href);\n const {createAgentClient}=await import(pathToFileURL(config.sourceRoot+'/apps/api/src/agent-client.ts').href);\n const token=await loadAgentCredentialFile(config.tokenFile);\n const client=createAgentClient({socketPath:config.socketPath,token,timeoutMs:2000});\n try {const response=await client.fetch(new Request('http://agent.local/health'));result.health_status=response.status;await response.arrayBuffer();}finally{client.close();}\n}else{\n for(const [label,path] of [['agent_credential',config.tokenFile],['server_secret',config.serverSecretFile]]){try{await readFile(path);result[label+'_read']='UNEXPECTED_SUCCESS';}catch(error){result[label+'_read']=error.code;}}\n result.socket_connect=await new Promise(resolve=>{const socket=createConnection(config.socketPath);socket.once('connect',()=>{socket.destroy();resolve('UNEXPECTED_SUCCESS');});socket.once('error',error=>resolve(error.code));socket.setTimeout(2000,()=>{socket.destroy();resolve('TIMEOUT');});});\n}\nprocess.stdout.write(JSON.stringify(result)+'\\n');\n`
    await writeFile(probeFile, probeSource, { mode: 0o644, flag: 'wx' })
    const runProbe = (username, mode) => JSON.parse(mustRun('/usr/sbin/runuser', ['--user', username, '--', process.execPath, probeFile, mode, probeConfig], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } }))
    await check('S03-L05', 'A real unprivileged process loads its protected credential and uses the IPC client', () => {
      const result = runProbe(apiUser, 'authorized')
      assert.equal(result.uid, apiUid); assert.notEqual(result.uid, 0); assert.equal(result.health_status, 200)
      return result
    }, true)
    const denied = runProbe(outsiderUser, 'unauthorized')
    await check('S03-L06', 'An unauthorized UID cannot connect through the protected socket path', () => { assert.equal(denied.socket_connect, 'EACCES'); return { uid: denied.uid, socket_connect: denied.socket_connect } })
    await check('S03-L07', 'An unauthorized UID cannot read the agent service credential', () => { assert.equal(denied.agent_credential_read, 'EACCES'); return { uid: denied.uid, error_code: denied.agent_credential_read } })
    await check('S03-L08', 'An unauthorized UID cannot read the API server secret', () => { assert.equal(denied.server_secret_read, 'EACCES'); return { uid: denied.uid, error_code: denied.server_secret_read } })
    for (const [id, description, headers, status] of [
      ['S03-L09', 'Missing service credential is rejected', {}, 401],
      ['S03-L10', 'Wrong service credential is rejected', { 'x-xpanel-agent-token': randomBytes(32).toString('hex') }, 401],
      ['S03-L11', 'Forged root role alone does not authenticate a request', { 'x-xpanel-role': 'root', 'x-xpanel-actor': 'root' }, 401],
    ]) await check(id, description, async () => { const response = await ipc(socketPath, '/health', headers); assert.equal(response.status, status); return { http_status: response.status } })
    await check('S03-L12', 'A valid service credential with an unknown human principal cannot gain root authority', async () => {
      const response = await ipc(socketPath, '/analytics/io', { 'x-xpanel-agent-token': token, 'x-xpanel-principal-id': randomUUID(), 'x-xpanel-role': 'root' })
      assert.equal(response.status, 401); return { http_status: response.status }
    })
    await check('S03-L13', 'Forged role and actor headers cannot elevate a persisted account principal', async () => {
      const response = await ipc(socketPath, '/analytics/io', { 'x-xpanel-agent-token': token, 'x-xpanel-principal-id': userPrincipal.id, 'x-xpanel-role': 'root', 'x-xpanel-actor': 'root' })
      assert.equal(response.status, 403); return { http_status: response.status }
    })

    mustRun('/usr/bin/systemctl', ['start', apiUnit])
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) })).status === 200, 'The real nonroot API entrypoint did not become ready')
    const apiPid = pidOf(apiUnit)
    await check('S03-L14', 'The real API entrypoint runs as the dedicated nonroot UID', async () => {
      const identity = await processIdentity(apiPid)
      assert.equal(identity.uid, apiUid); assert.notEqual(identity.uid, 0)
      assert.ok((await readFile(`/proc/${apiPid}/cmdline`, 'utf8')).includes('/apps/api/src/main.ts'))
      return identity
    }, true)
    await check('S03-L15', 'An authenticated API read traverses the real socket client into the root agent', async () => {
      const status = await apiRequest(); assert.equal(status, 200); return { http_status: status, operation: 'website analytics read; no host reconciliation' }
    }, true)
    database = dbModule.createDb(dbPath)
    await check('S03-L16', 'The root agent and nonroot API share a real WAL database with a persisted failed API login', async () => {
      const journal = database.sqlite.prepare('PRAGMA journal_mode').get()
      assert.equal(journal.journal_mode, 'wal')
      const beforeLogin = database.sqlite.prepare('SELECT COUNT(*) AS total FROM login_attempts WHERE username = ?').get(failedLoginUsername)
      assert.equal(beforeLogin.total, 0)
      const rejected = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: failedLoginUsername, password }), signal: AbortSignal.timeout(5_000),
      })
      await rejected.arrayBuffer()
      assert.equal(rejected.status, 401)
      const row = database.sqlite.prepare('SELECT COUNT(*) AS total FROM login_attempts WHERE username = ? AND success = 0').get(failedLoginUsername)
      assert.equal(row.total, 1)
      const files = await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(metadata))
      for (const value of files) { assert.equal(value.gid, apiGid); assert.equal(value.mode, '660') }
      const dataDirectory = await metadata(`${base}/data`)
      assert.equal(dataDirectory.gid, apiGid); assert.equal(dataDirectory.mode, '2770')
      return {
        journal_mode: journal.journal_mode, api_pid: apiPid, api_uid: apiUid,
        rejected_login_http_status: rejected.status, unique_fixture_username: failedLoginUsername,
        failed_login_rows_before: beforeLogin.total, persisted_failed_login_rows: row.total,
        database_files: files, data_directory: dataDirectory,
        oracle_correction: 'API token last_used_at is not currently updated by authentication. Its null value is not evidence of a WAL or availability failure; this fixture instead observes a real failed API login write.',
      }
    })
    mustRun('/usr/bin/systemctl', ['stop', agentUnit])
    await check('S03-L17', 'Stopping the agent removes the runtime socket under the systemd contract', async () => {
      assert.equal(existsSync(socketPath), false); assert.equal(existsSync(runtime), false)
      return { socket_removed: true, runtime_directory_removed: true }
    })
    await check('S03-L18', 'Agent downtime returns HTTP 503 through the real API and never falls back to a host executor', async () => {
      const status = await apiRequest(); assert.equal(status, 503)
      return { http_status: status, api_pid_unchanged: pidOf(apiUnit) === apiPid, agent_pid: pidOf(agentUnit) }
    })
    mustRun('/usr/bin/systemctl', ['start', agentUnit])
    const restartedPid = await waitFor(agentReady, 'The agent did not restart after a clean systemd stop')
    await check('S03-L19', 'A clean agent restart creates a fresh socket and restores IPC access', async () => {
      assert.notEqual(restartedPid, agentPid); assert.equal(await apiRequest(), 200)
      return { previous_pid: agentPid, current_pid: restartedPid, http_status: 200 }
    })
    mustRun('/usr/bin/systemctl', ['kill', '--kill-whom=main', '--signal=KILL', agentUnit])
    const recoveredPid = await waitFor(async () => { const current = await agentReady(); return current && current !== restartedPid ? current : false }, 'Systemd did not recover the agent after SIGKILL', 30_000)
    await check('S03-L20', 'Systemd removes the stale socket and restarts a SIGKILLed agent', async () => {
      assert.notEqual(recoveredPid, restartedPid); assert.equal(await apiRequest(), 200)
      const socket = await metadata(socketPath); assert.equal(socket.uid, 0); assert.equal(socket.gid, ipcGid); assert.equal(socket.mode, '660')
      return { previous_pid: restartedPid, recovered_pid: recoveredPid, socket, http_status: 200, runtime_directory_preserve: 'no' }
    })
  } catch (error) {
    fatal = redact(error instanceof Error ? error.message : error)
    const errorCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR'
    const inspectMetadata = async path => metadata(path).catch(error => ({ error_code: errorCode(error) }))
    serviceDiagnostics = await Promise.all(units.map(async unit => {
      const properties = command('/usr/bin/systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID,NRestarts,User,Group,RuntimeDirectory,RuntimeDirectoryMode,RuntimeDirectoryPreserve']).stdout
      if (unit !== agentUnit) return { unit, properties }
      const pid = Number(/^MainPID=(\d+)$/m.exec(properties)?.[1] ?? 0)
      const [socket, parent, identity, health] = await Promise.all([
        inspectMetadata(socketPath), inspectMetadata(runtime),
        pid > 0 ? processIdentity(pid).catch(error => ({ pid, error_code: errorCode(error) })) : Promise.resolve({ pid }),
        ipc(socketPath, '/health', { 'x-xpanel-agent-token': token }).then(response => ({ http_status: response.status })).catch(error => ({ error_code: errorCode(error) })),
      ])
      return {
        unit, properties,
        boundary: {
          expected: { socket: { uid: 0, gid: ipcGid, mode: '660' }, parent: { uid: 0, gid: ipcGid, mode: '750' } },
          observed: { socket, parent }, process: identity, authenticated_health: health,
        },
      }
    }))
  } finally {
    if (database) await database.close().catch(error => cleanupErrors.push(redact(error.message)))
    for (const unit of [...units].reverse()) {
      const stopped = command('/usr/bin/systemctl', ['stop', unit])
      if (stopped.exit_code !== 0) cleanupErrors.push(`Could not stop owned fixture unit: ${unit}`)
      command('/usr/bin/systemctl', ['reset-failed', unit])
    }
    for (const unit of units) {
      const path = `/run/systemd/system/${unit}`
      try { await unlink(path) } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(redact(error.message)) }
    }
    if (units.length) command('/usr/bin/systemctl', ['daemon-reload'])
    for (const user of [...users].reverse()) {
      const current = entity('passwd', user.name)
      if (current.exit_code === 2) continue
      if (Number(current.stdout.split(':')[2]) !== user.uid) { cleanupErrors.push(`Refusing to delete a replaced fixture UID: ${user.name}`); continue }
      const removed = command('/usr/sbin/userdel', [user.name])
      if (removed.exit_code !== 0) cleanupErrors.push(`Could not remove owned fixture user: ${user.name}`)
    }
    for (const group of [...groups].reverse()) {
      const current = entity('group', group.name)
      if (current.exit_code === 2) continue
      if (Number(current.stdout.split(':')[2]) !== group.gid) { cleanupErrors.push(`Refusing to delete a replaced fixture GID: ${group.name}`); continue }
      const removed = command('/usr/sbin/groupdel', [group.name])
      if (removed.exit_code !== 0) cleanupErrors.push(`Could not remove owned fixture group: ${group.name}`)
    }
    for (const user of users) {
      const path = `/var/mail/${user.name}`
      try {
        const value = await lstat(path)
        assert.equal(value.isFile() && !value.isSymbolicLink() && [0, user.uid].includes(value.uid), true, 'owned fixture mailbox cleanup path changed')
        await unlink(path)
      } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(redact(error.message)) }
    }
    for (const path of [baseCreated ? base : null, units.length ? runtime : null].filter(Boolean)) {
      try {
        const value = await lstat(path)
        assert.equal(value.isDirectory() && !value.isSymbolicLink() && value.uid === 0, true, 'owned fixture cleanup path changed')
        assert.ok(path === base || path === runtime)
        await rm(path, { recursive: true })
      } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(redact(error.message)) }
    }
  }
  const after = await fingerprint()
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  const leftovers = {
    users: users.filter(user => entity('passwd', user.name).exit_code !== 2).map(user => user.name),
    groups: groups.filter(group => entity('group', group.name).exit_code !== 2).map(group => group.name),
    paths: [base, runtime, ...unitPaths, ...mailboxPaths].filter(path => existsSync(path)),
  }
  const cleanup = { ok: cleanupErrors.length === 0 && Object.values(leftovers).every(list => list.length === 0), errors: cleanupErrors, leftovers }
  const passed = fatal === null && observations.length === 22 && observations.every(value => value.status === 'passed') && unchanged && cleanup.ok
  const report = {
    schema_version: 1, scope: 'S03 root agent / nonroot API, protected credential/socket, real IPC, SQLite WAL and systemd restart primitives. No SO_PEERCRED matcher, installer or workload-isolation claim.',
    status: passed ? 'passed' : 'failed', started_at: startedAt, finished_at: new Date().toISOString(), snapshot_archive_sha256: snapshotHash,
    snapshot_source_sha256: preflight.receipt?.source_sha256 ?? null,
    snapshot_receipt_sha256: preflight.receipt?.receipt_sha256 ?? null,
    snapshot_hash_supplied_by: 'external coordinator', archive_hash_verified_in_fixture: Boolean(preflight.receipt),
    environment: { node: process.version, platform: process.platform, uid: process.getuid(), kernel: command('/usr/bin/uname', ['-srvmo']).stdout, systemd: command('/usr/bin/systemctl', ['--version']).stdout.split('\n')[0], virtualization: command('/usr/bin/systemd-detect-virt', []).stdout, os_release: await readFile('/etc/os-release', 'utf8') },
    preflight, fixture: { prefix, api_uid: apiUid, api_gid: apiGid, socket_gid: ipcGid, isolated_paths: [base, runtime], temporary_units: units },
    source_before: before, source_after: after, source_unchanged: unchanged, observations,
    counts: { total: observations.length, passed: observations.filter(value => value.status === 'passed').length, failed: observations.filter(value => value.status === 'failed').length },
    fatal_error: fatal, service_diagnostics: serviceDiagnostics, cleanup,
    limits: ['No kernel peer UID matching is implemented or claimed.', 'Permission denial is observed through the root-owned directory/socket and credential files.', 'No production installer, SSH/firewall configuration, customer workload or host reconciliation is run.', 'CLI init-root is an A10 primitive and does not prove production installer bootstrap.', 'Temporary database/account state is fixture metadata and does not create a hosted workload.'],
  }
  const serialized = JSON.stringify(report)
  assert.equal(secrets.some(secret => serialized.includes(secret)), false, 'qualification artifact contains a generated secret')
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await qualifyAgentBoundary(argument('--snapshot-sha256'))
  const output = argument('--output')
  if (output && report.status !== 'blocked') {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 })
  }
  process.stdout.write(`${JSON.stringify(output && report.status !== 'blocked' ? { status: report.status, counts: report.counts, cleanup: report.cleanup, source_unchanged: report.source_unchanged, evidence: resolve(output) } : report)}\n`)
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1
}
