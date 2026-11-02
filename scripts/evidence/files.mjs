import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function assertRegularPath(path, root) {
  const absolute = resolve(path)
  const boundary = root === undefined ? undefined : realpathSync(root)
  if (boundary !== undefined) {
    const inside = relative(boundary, absolute)
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error('Evidence file escapes its declared directory')
  }
  let current = absolute
  while (true) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('Evidence paths may not contain symbolic links')
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  if (!lstatSync(absolute).isFile()) throw new Error('Evidence input must be a regular file')
  if (boundary !== undefined && realpathSync(absolute) !== absolute) throw new Error('Evidence input real path changed')
  return absolute
}

export function readBoundedFile(path, { root, maxBytes = 4 * 1024 * 1024, minBytes = 1 } = {}) {
  const absolute = assertRegularPath(path, root)
  const before = lstatSync(absolute)
  if (before.size < minBytes || before.size > maxBytes) throw new Error('Evidence file size is outside the allowed bounds')
  const bytes = readFileSync(absolute)
  const after = lstatSync(absolute)
  if (bytes.length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('Evidence file changed while reading')
  return bytes
}
