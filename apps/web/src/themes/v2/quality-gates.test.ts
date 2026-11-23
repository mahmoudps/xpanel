import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function walkSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkSourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full)
  }
  return files
}

describe('v2 theme architecture and cleanliness gates', () => {
  it('contains zero HTML style or layout string-replace hacks', () => {
    const violations: string[] = []
    const forbidden = /\.replace\(\s*(?:['"`][^'"`]*(?:style=|<button\b|<input\b|<section\b|<h[1-6]\b|<bdi\b|v2-kpi|<\/p>)|\/[^/]*(?:style=|<button\b|<input\b|<section\b|<h[1-6]\b|<bdi\b|v2-kpi|<\/p>))/
    for (const file of walkSourceFiles(HERE)) {
      const rel = relative(HERE, file).replaceAll('\\', '/')
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (forbidden.test(line)) violations.push(`${rel}:${index + 1}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('places no heading tags inside summary elements and labels every named pre with a landmark role', () => {
    const summaryHeadings: string[] = []
    const unroledPre: string[] = []
    for (const file of walkSourceFiles(HERE)) {
      const rel = relative(HERE, file).replaceAll('\\', '/')
      const source = readFileSync(file, 'utf8')
      if (/<summary\b[^>]*>[^<]*<h[1-6]\b/i.test(source)) summaryHeadings.push(rel)
      for (const match of source.matchAll(/<pre\b[^>]*>/g)) {
        const tag = match[0]
        if ((tag.includes('aria-label') || tag.includes('aria-labelledby')) && !tag.includes('role=')) {
          unroledPre.push(`${rel}: ${tag}`)
        }
      }
    }
    expect(summaryHeadings).toEqual([])
    expect(unroledPre).toEqual([])
  })

  it('enforces prelaunch standard naming with no marketing adjectives or version suffixes on new modules', () => {
    const designSystemFiles = walkSourceFiles(join(HERE, '../../design-system'))
    const newModules = [
      join(HERE, '../../workspace-runtime-client.ts'),
      join(HERE, '../../route-client-chunks.ts'),
      join(HERE, 'workspace-interactions.ts'),
      ...designSystemFiles,
    ]
    const forbiddenName = /(?:^|[_-])(smart|legacy|hero|magic|super|v[0-9]+)(?:$|[_-])/i
    const violations: string[] = []
    for (const file of newModules) {
      const base = file.split(/[\\/]/).pop()!.replace(/\.ts$/, '')
      if (forbiddenName.test(base)) violations.push(`filename:${base}`)
      const source = readFileSync(file, 'utf8')
      if (file.includes('design-system') && /\bstyle="/.test(source)) {
        violations.push(`inlineStyle:${base}`)
      }
      for (const match of source.matchAll(/\bexport\s+(?:const|function|class|type|interface)\s+([A-Za-z0-9_]+)/g)) {
        const symbol = match[1]!
        if (forbiddenName.test(symbol) || /smart|legacy|hero|magic|super/i.test(symbol)) {
          violations.push(`export:${base}:${symbol}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
