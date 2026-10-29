/**
 * ICU MessageFormat subset: text, `{name}`, `{n, plural, …}` (`=N`, CLDR categories, `offset:`, `#`),
 * `{key, select, …}` and apostrophe quoting. Plural categories come from Intl.PluralRules.
 *
 * `{name}` inserts the value as given: callers format numbers, sizes and dates with the shared ASCII
 * formatters first. `#` uses Intl.NumberFormat with Latin digits.
 *
 * parseMessage and compileMessage reference nothing outside themselves except each other, because
 * client bindings serialize them with Function.prototype.toString.
 */

export type MessageNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'arg'; readonly name: string }
  | { readonly kind: 'pound' }
  | { readonly kind: 'plural'; readonly name: string; readonly offset: number; readonly options: Readonly<Record<string, readonly MessageNode[]>> }
  | { readonly kind: 'select'; readonly name: string; readonly options: Readonly<Record<string, readonly MessageNode[]>> }

export type MessageValues = Readonly<Record<string, string | number>>

export function parseMessage(source: string): MessageNode[] {
  let index = 0
  const fail = (reason: string): never => { throw new Error(`Invalid message at ${index}: ${reason} in "${source}"`) }
  const space = () => { while (/\s/.test(source[index] ?? '')) index++ }
  const expect = (char: string) => { space(); if (source[index] !== char) fail(`expected ${char}`); index++ }
  const word = (): string => {
    space()
    const match = /^[^\s,{}]+/.exec(source.slice(index))
    if (!match) return fail('expected a name')
    index += match[0].length
    return match[0]
  }
  const quoted = (inPlural: boolean): string => {
    const next = source[index + 1]
    if (next === "'") { index += 2; return "'" }
    if (next !== '{' && next !== '}' && !(inPlural && next === '#')) { index++; return "'" }
    let value = ''
    index++
    while (index < source.length) {
      if (source[index] === "'") {
        if (source[index + 1] === "'") { value += "'"; index += 2; continue }
        index++
        return value
      }
      value += source[index++]
    }
    return value
  }
  const nodes = (nested: boolean, inPlural: boolean): MessageNode[] => {
    const out: MessageNode[] = []
    let text = ''
    const flush = () => { if (text) { out.push({ kind: 'text', value: text }); text = '' } }
    while (index < source.length) {
      const char = source[index]!
      if (char === '}') { if (!nested) fail('unbalanced }'); break }
      if (char === '{') { flush(); out.push(argument()); continue }
      if (char === '#' && inPlural) { flush(); out.push({ kind: 'pound' }); index++; continue }
      if (char === "'") { text += quoted(inPlural); continue }
      text += char
      index++
    }
    flush()
    return out
  }
  const argument = (): MessageNode => {
    expect('{')
    const name = word()
    space()
    if (source[index] === '}') { index++; return { kind: 'arg', name } }
    expect(',')
    const type = word()
    if (type !== 'plural' && type !== 'select') fail(`unsupported type ${type}`)
    expect(',')
    let offset = 0
    const options: Record<string, MessageNode[]> = {}
    for (;;) {
      space()
      if (index >= source.length) fail('unterminated argument')
      if (source[index] === '}') { index++; break }
      const key = word()
      if (type === 'plural' && key.startsWith('offset:')) { offset = Number(key.slice(7)); continue }
      expect('{')
      options[key] = nodes(true, type === 'plural')
      expect('}')
    }
    if (!options.other) fail(`${type} needs an other option`)
    return type === 'plural' ? { kind: 'plural', name, offset, options } : { kind: 'select', name, options }
  }
  const result = nodes(false, false)
  if (index < source.length) fail('unexpected }')
  return result
}

/** Compiles a message once; the returned function renders it for a set of values. */
export function compileMessage(source: string, locale: string): (values?: MessageValues) => string {
  if (!/[{}']/.test(source)) return () => source
  const tree = parseMessage(source)
  let numbers: Intl.NumberFormat | undefined
  let plurals: Intl.PluralRules | undefined
  const render = (list: readonly MessageNode[], values: MessageValues, count: number | undefined): string => {
    let out = ''
    for (const node of list) {
      if (node.kind === 'text') out += node.value
      else if (node.kind === 'pound') out += count === undefined ? '#' : (numbers ??= new Intl.NumberFormat(locale, { numberingSystem: 'latn', maximumFractionDigits: 20 })).format(count)
      else if (node.kind === 'arg') out += node.name in values ? String(values[node.name]) : `{${node.name}}`
      else if (node.kind === 'select') out += render(node.options[String(values[node.name] ?? 'other')] ?? node.options.other!, values, count)
      else {
        const raw = Number(values[node.name])
        if (!Number.isFinite(raw)) { out += render(node.options.other!, values, count); continue }
        const adjusted = raw - node.offset
        const branch = node.options['=' + raw] ?? node.options[(plurals ??= new Intl.PluralRules(locale)).select(adjusted)] ?? node.options.other!
        out += render(branch, values, adjusted)
      }
    }
    return out
  }
  return (values = {}) => render(tree, values, undefined)
}

/** Argument names a message uses, for placeholder parity checks between catalogs. */
export function messageArguments(source: string): Set<string> {
  const names = new Set<string>()
  const walk = (list: readonly MessageNode[]) => {
    for (const node of list) {
      if (node.kind === 'arg') names.add(node.name)
      else if (node.kind === 'plural' || node.kind === 'select') { names.add(node.name); Object.values(node.options).forEach(walk) }
    }
  }
  walk(parseMessage(source))
  return names
}

/** Quotes text so it reads literally as a message (for messages built from literal source text). */
export const escapeMessageText = (text: string): string =>
  /[{}]|''/.test(text) ? text.replace(/'/g, "''").replace(/[{}]+/g, run => `'${run}'`) : text
