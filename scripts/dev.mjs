import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../apps/api/src/main.ts', import.meta.url))

export function parseDevArguments(argv) {
  let watch = false
  let appOnly = false
  const appArgs = []
  for (const argument of argv) {
    if (!appOnly && argument === '--watch') watch = true
    else {
      appArgs.push(argument)
      if (argument === '--') appOnly = true
    }
  }
  return { watch, appArgs }
}

export function developmentSpawnSpec(argv = [], options = {}) {
  const { watch, appArgs } = parseDevArguments(argv)
  return {
    command: options.execPath ?? process.execPath,
    args: [...(watch ? ['--watch'] : []), options.entry ?? entry, ...appArgs],
    options: {
      stdio: 'inherit',
      env: { ...(options.env ?? process.env), NODE_ENV: 'development' },
      windowsHide: true,
      shell: false,
    },
  }
}

export function runDevelopment(argv = process.argv.slice(2)) {
  const spec = developmentSpawnSpec(argv)
  const child = spawn(spec.command, spec.args, spec.options)
  child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
  child.once('exit', (code, signal) => {
    if (signal && process.platform !== 'win32') process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  return child
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDevelopment()
