// Browser-like test environments get the client translator that pages install (apps/web/src/i18n.ts):
// `xpT` follows the document language, as it does in a page. Node environments deliberately have no
// `xpT`, so server-rendered code that calls the browser global fails its tests. Importing i18n.ts also
// installs the msgid/msgctxt globals that both server and client code use.
if (typeof document !== 'undefined') {
  const { isLocale, translator } = await import('../apps/web/src/i18n.ts')
  ;(globalThis as unknown as Record<string, unknown>).xpT = (message: string, values?: Readonly<Record<string, string | number>>): string => {
    const lang = document.documentElement.lang
    return translator(isLocale(lang) ? lang : undefined)(message, values)
  }
}

export {}
