// Hands install.sh the post-package part of the packages/os install bundle for this host.
// Usage: install-os-configuration.mjs <empty-output-dir> <os-release-file> <apache-mpm> <php-version> <mail> <dns> <ftp> <mariadb> <modsecurity>
// Each file's content is written to <dir>/file-<n>; each exec argv to <dir>/exec-<n> as NUL-terminated
// arguments. Stdout lists the steps in plan order, one per line, tab separated:
//   file <n> <path> <octal mode> <group>  |  exec <n> <creates path or ->  |  systemd <verb> <unit>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installConfiguration, profileFor } from '../packages/os/src/index.ts'

const [outputDir, osReleasePath, apacheMpm, php, ...flags] = process.argv.slice(2)
if (!outputDir || readdirSync(outputDir).length !== 0 || flags.length !== 5 || !flags.every(flag => flag === '0' || flag === '1')) {
  process.stderr.write('install-os-configuration: expected an empty output directory, an os-release file, the MPM, the PHP version and five 0/1 service flags\n')
  process.exit(2)
}
const [withMail, withDns, withFtp, withMariaDb, withModSecurity] = flags.map(flag => flag === '1')
const { actions, files } = installConfiguration(profileFor(readFileSync(osReleasePath, 'utf8')), {
  engine: 'apache', apacheMpm, phpVersions: [php], withMail, withDns, withFtp, withMariaDb, withModSecurity,
})
const lines = []
files.forEach((file, n) => {
  if (file.owner !== 'root') throw new Error(`install-os-configuration: ${file.path} must be owned by root`)
  writeFileSync(join(outputDir, `file-${n}`), file.content, { flag: 'wx', mode: 0o600 })
  lines.push(['file', n, file.path, file.mode.toString(8).padStart(4, '0'), file.group].join('\t'))
})
actions.forEach((action, n) => {
  if (action.kind === 'exec') {
    writeFileSync(join(outputDir, `exec-${n}`), action.argv.map(arg => `${arg}\0`).join(''), { flag: 'wx', mode: 0o600 })
    lines.push(['exec', n, action.creates ?? '-'].join('\t'))
  } else if (action.kind === 'systemd') lines.push(['systemd', action.verb, action.unit].join('\t'))
  else throw new Error(`install-os-configuration: unsupported action ${action.kind}`)
})
process.stdout.write(lines.map(line => `${line}\n`).join(''))
