import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STYLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'styles')

export function compactDesignCss(rawCss: string): string {
  return rawCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s*{\s*/g, '{')
    .replace(/\s*}\s*/g, '}')
    .replace(/\s*;\s*/g, ';')
    .replace(/;\}/g, '}')
    .replace(/:\s+/g, ':')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function loadStyleFile(filename: string): string {
  return compactDesignCss(readFileSync(resolve(STYLES_DIR, filename), 'utf8'))
}

export const DESIGN_SYSTEM_TOKENS_FILE_CSS = loadStyleFile('tokens.css')
export const DESIGN_SYSTEM_BASE_CSS = loadStyleFile('base.css')
export const DESIGN_SYSTEM_SHELL_CSS = loadStyleFile('shell.css')
export const DESIGN_SYSTEM_OVERLAYS_CSS = loadStyleFile('overlays.css')
export const DESIGN_SYSTEM_COMPONENTS_CSS = loadStyleFile('components.css')
export const DESIGN_SYSTEM_LAYOUTS_CSS = loadStyleFile('layouts.css')

export const DESIGN_SYSTEM_FOUNDATION_CSS = [
  DESIGN_SYSTEM_TOKENS_FILE_CSS,
  DESIGN_SYSTEM_BASE_CSS,
  DESIGN_SYSTEM_SHELL_CSS,
].join('')

function splitTopLevelSelectors(selectors: string): string[] {
  const parts: string[] = []
  let parenDepth = 0
  let bracketDepth = 0
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < selectors.length; i += 1) {
    const ch = selectors[i] ?? ''
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < selectors.length) {
        current += selectors[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') parenDepth += 1
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '[') bracketDepth += 1
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

function scopeSelectorListForV2(selectors: string): string {
  return splitTopLevelSelectors(selectors)
    .map(sel => {
      const trimmed = sel.trim()
      if (!trimmed) return ''
      if (/^(?:from|to|[0-9.]+%)$/.test(trimmed)) return trimmed
      if (/^(?::where\(\[data-ui-theme="v2"\]\)|\[data-ui-theme="v2"\]|\.v2-|#xp-toast-region)/.test(trimmed)) {
        return trimmed
      }
      return `[data-ui-theme="v2"] ${trimmed}`
    })
    .filter(Boolean)
    .join(',')
}

export function scopeDesignCssForV2(compactedCss: string): string {
  let out = ''
  let i = 0
  while (i < compactedCss.length) {
    const brace = compactedCss.indexOf('{', i)
    if (brace === -1) {
      out += compactedCss.slice(i)
      break
    }
    const header = compactedCss.slice(i, brace).trim()
    let depth = 1
    let j = brace + 1
    while (j < compactedCss.length && depth > 0) {
      if (compactedCss[j] === '{') depth++
      else if (compactedCss[j] === '}') depth--
      j++
    }
    const inner = compactedCss.slice(brace + 1, j - 1)
    if (header.startsWith('@media') || header.startsWith('@supports')) {
      out += `${header}{${scopeDesignCssForV2(inner)}}`
    } else if (header.startsWith('@keyframes')) {
      out += `${header}{${inner}}`
    } else {
      out += `${scopeSelectorListForV2(header)}{${inner}}`
    }
    i = j
  }
  return out
}

export const DESIGN_SYSTEM_INTERACTIVE_CSS = scopeDesignCssForV2(
  `${DESIGN_SYSTEM_OVERLAYS_CSS}${DESIGN_SYSTEM_COMPONENTS_CSS}`,
)
