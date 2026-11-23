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
    .replace(/\s*:\s*/g, ':')
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
