import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDetachedOutput, readBoundedFile } from './identity.mjs'

export const readJson = (path, options) => JSON.parse(readBoundedFile(path, options).toString('utf8'))
export function writeDetachedJson(root, path, value, artifact) {
  const output = assertDetachedOutput(root, path, artifact)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return output
}
export const isMain = url => process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url)
export function parseArguments(args, allowed, required) {
  const result = {}
  for (const argument of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument)
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1])) throw new Error('Use unique supported --name=value arguments')
    result[match[1]] = match[2]
  }
  for (const key of required) if (result[key] === undefined) throw new Error(`Missing --${key}`)
  return result
}
export async function runCli(main) {
  try { await main() }
  catch (error) {
    // Do not include input file contents or runtime credentials in command output.
    process.stderr.write(error instanceof SyntaxError
      ? 'Evidence command failed: invalid JSON input.\n'
      : 'Evidence command failed: input validation or file-integrity check failed.\n')
    process.exitCode = 1
  }
}
