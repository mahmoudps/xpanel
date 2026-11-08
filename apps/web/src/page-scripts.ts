import { createHash } from 'node:crypto'

// Page code is served from this origin under a content-hash version, so a document needs no inline script
// and its Content-Security-Policy can keep script-src 'self'.

export interface PageScript { readonly path: string; readonly href: string; readonly body: string }

const SCRIPTS = new Map<string, PageScript>()

/** Registers the script served at /assets/<name>.js. Bodies are module constants, so one name has one body. */
export function pageScript(name: string, body: string): PageScript {
  const path = `/assets/${name}.js`
  if (!/^[a-z][a-z0-9-]*$/.test(name) || SCRIPTS.has(path) && SCRIPTS.get(path)!.body !== body) throw new Error('page_script_conflict')
  const script = { path, href: `${path}?v=${createHash('sha256').update(body).digest('hex').slice(0, 16)}`, body }
  SCRIPTS.set(path, script)
  return script
}

/** A synchronous external script keeps the execution order of the inline script it replaces. */
export const pageScriptTag = (script: PageScript, id: string): string => `<script id="${id}" src="${script.href}"></script>`

export const findPageScript = (path: string): PageScript | undefined => SCRIPTS.get(path)

const TAG = /<script id="([a-z0-9-]+)" src="(\/assets\/[a-z0-9-]+\.js)\?v=[0-9a-f]{16}"><\/script>/g

/** The body of each registered page script referenced in an HTML fragment, in document order. */
export const pageScriptBodies = (html: string): string[] => [...html.matchAll(TAG)].flatMap(match => {
  const script = SCRIPTS.get(match[2]!)
  return script ? [script.body] : []
})

/** Fixture and test documents loaded without this origin run the same code inline. Product documents never do. */
export const inlinePageScripts = (html: string): string => html.replace(TAG, (tag, id: string, path: string) => {
  const script = SCRIPTS.get(path)
  return script ? `<script id="${id}">${script.body}</script>` : tag
})
