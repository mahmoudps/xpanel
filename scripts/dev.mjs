import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../apps/api/src/main.ts', import.meta.url))
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
  windowsHide: true,
})
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.once('exit', (code, signal) => {
  if (signal && process.platform !== 'win32') process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
