'use strict'
// One run of one host task, started by its systemd oneshot as root. The reconciler installs this file and writes the
// spec it reads; steps are argv arrays, so no value passes through a shell. Output, run records and trigger records
// stay in bounded files the agent reads on demand: nothing here keeps running after the task ends.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ID = /^[a-z0-9]{12}$/
const STAMP = /^[0-9]{8}T[0-9]{9}Z\./
const LOG_MAX = 1024 * 1024
const OUTPUT_MAX = 64 * 1024
const RECORDS_MAX = 50
const URL_TIMEOUT_MS = 60_000
const ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', HOME: '/root' }
const PATHS = { tasks: '/etc/xpanel/tasks', logs: '/var/log/xpanel-tasks' }

/** The declared return type is checked on the last output line, which is the value a chained script hands on. */
function returnResult(returns, output) {
  if (returns === 'string') return 'ok'
  const last = output.trim().split('\n').pop().trim()
  return (returns === 'integer' ? /^[+-]?[0-9]+$/ : /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/).test(last) ? 'ok' : 'TYPE_MISMATCH'
}

function triggerFires(trigger, output) {
  const text = output.trim()
  if (trigger.match === 'include') return text.includes(trigger.value)
  if (trigger.match === 'exclude') return !text.includes(trigger.value)
  if (trigger.match === 'equal') return text === trigger.value
  return trigger.match === 'not-equal' && text !== trigger.value
}

/** Newest copies stay; only names this program wrote are candidates. */
function retain(dir, keep) {
  const copies = fs.readdirSync(dir).filter(name => STAMP.test(name)).sort()
  const removed = copies.slice(0, Math.max(0, copies.length - keep))
  for (const name of removed) fs.unlinkSync(path.join(dir, name))
  return removed
}

function appendRecord(file, record) {
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean)
  lines.push(JSON.stringify(record))
  const next = file + '.next'
  fs.writeFileSync(next, lines.slice(-RECORDS_MAX).join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(next, file)
}

function openLog(file) {
  // A long history keeps its newest half, so a chatty task cannot fill the disk between runs.
  if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) {
    const data = fs.readFileSync(file)
    fs.writeFileSync(file, data.subarray(data.length - Math.floor(LOG_MAX / 2)), { mode: 0o600 })
  }
  return fs.openSync(file, 'a', 0o600)
}

function capture(fd) {
  let written = 0, kept = Buffer.alloc(0)
  const write = chunk => {
    if (written < LOG_MAX) { fs.writeSync(fd, written + chunk.length > LOG_MAX ? chunk.subarray(0, LOG_MAX - written) : chunk); written += chunk.length; if (written >= LOG_MAX) fs.writeSync(fd, '\n[output truncated]\n') }
    const joined = Buffer.concat([kept, chunk])
    kept = joined.length > OUTPUT_MAX ? joined.subarray(joined.length - OUTPUT_MAX) : joined
  }
  return { write, output: () => kept.toString('utf8') }
}

function runArgv(argv, write) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { env: ENV, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', write); child.stderr.on('data', write)
    child.on('error', error => { write(Buffer.from(`could not start ${argv[0]}: ${error.code}\n`)); resolve(127) })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}

async function runUrl(url, write) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(URL_TIMEOUT_MS) })
    write(Buffer.from(`HTTP ${response.status}\n`))
    write(Buffer.from((await response.text()).slice(0, OUTPUT_MAX)))
    return response.ok ? 0 : 1
  } catch (error) { write(Buffer.from(`request failed: ${error.name}\n`)); return 1 }
}

const stampOf = date => date.toISOString().replace(/[-:.]/g, '')

async function main(id, options = {}) {
  const paths = options.paths ?? PATHS, now = options.now ?? (() => new Date())
  const sendmail = options.sendmail ?? (text => spawnSync('/usr/sbin/sendmail', ['-i', 'root'], { input: text, timeout: 15_000, env: ENV, stdio: ['pipe', 'ignore', 'ignore'] }))
  const start = options.start ?? (unit => spawnSync('/usr/bin/systemctl', ['start', '--no-block', unit], { timeout: 15_000, env: ENV, stdio: 'ignore' }).status === 0)
  if (!ID.test(id ?? '')) return 2
  const spec = JSON.parse(fs.readFileSync(path.join(paths.tasks, `${id}.json`), 'utf8'))
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const fd = openLog(path.join(paths.logs, `${id}.log`)), startedAt = now(), stamp = stampOf(startedAt), sink = capture(fd)
  sink.write(Buffer.from(`=== ${startedAt.toISOString()} ${spec.name}\n`))
  const body = sink.output().length
  let code = 0
  if (spec.refuse) { sink.write(Buffer.from(`refused: ${spec.refuse}\n`)); code = 1 }
  if (spec.retention) fs.mkdirSync(spec.retention.dir, { recursive: true, mode: 0o700 })
  for (const step of spec.steps) {
    if (code !== 0) break
    code = step.url ? await runUrl(step.url, sink.write) : await runArgv(spec.stamped ? step.argv.map(value => value.replaceAll('{stamp}', stamp)) : step.argv, sink.write)
  }
  const output = sink.output().slice(body)
  let removed = []
  if (spec.retention) {
    // A failed copy never counts toward retention, or a run of failures would push out the good ones.
    if (code !== 0) for (const name of fs.readdirSync(spec.retention.dir)) if (name.startsWith(`${stamp}.`)) fs.unlinkSync(path.join(spec.retention.dir, name))
    if (code === 0) removed = retain(spec.retention.dir, spec.retention.keep)
  }
  const result = code !== 0 ? 'failed' : returnResult(spec.returns, output)
  const fired = []
  if (code === 0) {
    for (const trigger of spec.triggers) {
      const fires = triggerFires(trigger, output), started = fires ? start(trigger.target) : false
      if (fires) fired.push(trigger.id)
      appendRecord(path.join(paths.logs, `${trigger.id}.runs`), { at: now().toISOString(), task: id, fired: fires, started })
    }
  }
  if (result === 'TYPE_MISMATCH') sink.write(Buffer.from(`TYPE_MISMATCH: declared ${spec.returns}\n`))
  sink.write(Buffer.from(`=== exit ${code} result ${result}\n`))
  fs.closeSync(fd)
  appendRecord(path.join(paths.logs, `${id}.runs`), { at: startedAt.toISOString(), endedAt: now().toISOString(), code, result, fired, removed: removed.length })
  if (result !== 'ok' && spec.alert) sendmail(`Subject: xPanel task failed: ${spec.name}\n\nThe task ${spec.name} ended with ${result} (exit ${code}) at ${now().toISOString()}.\n`)
  return result === 'ok' ? 0 : 1
}

if (require.main === module) main(process.argv[2]).then(code => { process.exitCode = code }, () => { process.exitCode = 70 })
module.exports = { main, retain, returnResult, triggerFires }
