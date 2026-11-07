import type { ServerSettings } from '@xpanel/core'
import type { EdgeExtras, EdgeSettings } from './nginx.ts'

export const extras = (s: ServerSettings): EdgeExtras => (s as EdgeSettings).edge ?? {}

export const indent = (lines: string[], n = 1): string[] => lines.map((l) => (l === '' ? l : `${'    '.repeat(n)}${l}`))

export const block = (head: string, body: string[]): string[] => [`${head} {`, ...indent(body), '}']
