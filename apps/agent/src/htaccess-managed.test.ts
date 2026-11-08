import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { inspectHtaccess } from './htaccess-policy.ts'
import { WEB_DIRECTIVE_FEATURES, mergeWebDirective, parseManagedHtaccess, parseWebDirectiveModel, readWebDirective, renderWebDirectiveBody, webDirectivePolicyAllows, type WebDirectiveFeature, type WebDirectiveModels } from './htaccess-managed.ts'

const context = { domainName: 'example.test' }
const fields = (run: () => unknown): { field: string; code: string }[] => {
  try { run() } catch (error) { if (isXpanelError(error) && error.code === 'VALIDATION') return error.detail.fields as { field: string; code: string }[] ; throw error }
  throw new Error('expected a field refusal')
}
const samples: { [F in WebDirectiveFeature]: WebDirectiveModels[F] } = {
  'error-pages': { entries: [{ code: 404, path: '/errors/404.html' }, { code: 500, path: '/errors/500.html' }] },
  indexes: { listing: 'disabled' },
  'mime-types': { entries: [{ type: 'text/markdown', extensions: ['.md', '.markdown'] }] },
  hotlink: { enabled: true, allowedHosts: ['example.test', 'www.example.test'], extensions: ['jpg', 'png'], allowEmptyReferrer: true, redirectUrl: null },
  handlers: { entries: [{ handler: 'cgi-script', extensions: ['.pl', '.cgi'] }, { handler: 'server-parsed', extensions: ['.shtml'] }, { handler: 'type-map', extensions: ['.var'] }] },
  redirects: { entries: [{ status: 301, path: '/old/page', target: 'https://example.org/new' }, { status: 302, path: '/old', target: 'https://example.org/' }] },
}
const unmanaged = '# keep me\r\n<IfModule mod_rewrite.c>\r\nRewriteEngine On\r\nRewriteRule ^index\\.php$ - [L]\r\n</IfModule>\r\n\r\n# BEGIN WordPress\r\n# END WordPress'

describe('xPanel-managed .htaccess blocks', () => {
  it('inserts, replaces and removes blocks while preserving every unmanaged byte and line ending', () => {
    for (const feature of WEB_DIRECTIVE_FEATURES) {
      const inserted = mergeWebDirective(unmanaged, feature, samples[feature], context)
      expect(inserted.endsWith(unmanaged)).toBe(true)
      expect(inserted.slice(0, -unmanaged.length)).toBe(['# BEGIN xPanel ' + feature, ...renderWebDirectiveBody(feature, samples[feature]), '# END xPanel ' + feature].join('\r\n') + '\r\n')
      expect(readWebDirective(parseManagedHtaccess(inserted), feature, context)).toMatchObject({ managed: true, model: samples[feature] })
      expect(mergeWebDirective(inserted, feature, samples[feature], context)).toBe(inserted)
      const empty = { 'error-pages': { entries: [] }, indexes: { listing: 'inherit' }, 'mime-types': { entries: [] }, hotlink: { ...samples.hotlink, enabled: false }, handlers: { entries: [] }, redirects: { entries: [] } }[feature] as WebDirectiveModels[typeof feature]
      expect(mergeWebDirective(inserted, feature, empty, context)).toBe(unmanaged)
    }
    const middle = 'A\n# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\nB'
    expect(mergeWebDirective(middle, 'indexes', { listing: 'enabled' }, context)).toBe('A\n# BEGIN xPanel indexes\nOptions +Indexes\n# END xPanel indexes\nB')
    expect(mergeWebDirective(middle, 'indexes', { listing: 'inherit' }, context)).toBe('A\nB')
    const atEnd = 'A\r# BEGIN xPanel indexes\rOptions -Indexes\r# END xPanel indexes'
    expect(mergeWebDirective(atEnd, 'indexes', { listing: 'enabled' }, context)).toBe('A\r# BEGIN xPanel indexes\rOptions +Indexes\r# END xPanel indexes')
    expect(mergeWebDirective('', 'indexes', { listing: 'disabled' }, context)).toBe('# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n')
    expect(mergeWebDirective('', 'indexes', { listing: 'inherit' }, context)).toBe('')
  })
  it('refuses malformed, duplicated, nested, unbalanced, scoped or hand-edited markers', () => {
    const cases: [string, string][] = [
      ['# BEGIN xPanel unknown\n# END xPanel unknown\n', 'marker_malformed'], ['#BEGIN xPanel indexes\n', 'marker_malformed'], ['# BEGIN xPanel indexes \n', 'marker_malformed'],
      ['# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n', 'marker_duplicate'],
      ['# BEGIN xPanel indexes\n# BEGIN xPanel redirects\n', 'marker_nested'], ['# END xPanel indexes\n', 'marker_unbalanced'], ['# BEGIN xPanel indexes\nOptions -Indexes\n', 'marker_unbalanced'],
      ['# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel redirects\n', 'marker_unbalanced'],
      ['<IfModule mod_dir.c>\n# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n</IfModule>\n', 'marker_scope'],
      ['Header set X-Test a \\\n# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n', 'marker_scope'],
    ]
    for (const [content, code] of cases) {
      expect(parseManagedHtaccess(content).conflict?.code, content).toBe(code)
      expect(() => mergeWebDirective(content, 'error-pages', samples['error-pages'], context)).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    }
    for (const edited of ['# BEGIN xPanel indexes\nOptions -Indexes +FollowSymLinks\n# END xPanel indexes\n', '# BEGIN xPanel indexes\n# END xPanel indexes\n', '# BEGIN xPanel error-pages\nErrorDocument 404 /a/../b.html\n# END xPanel error-pages\n',
      '# BEGIN xPanel redirects\nRedirect 302 /a https://example.org/\nRedirect 301 /a/b https://example.org/\n# END xPanel redirects\n', '# BEGIN xPanel indexes\noptions -Indexes\n# END xPanel indexes\n']) {
      const feature = /xPanel ([a-z-]+)/.exec(edited)![1] as WebDirectiveFeature
      expect(readWebDirective(parseManagedHtaccess(edited), feature, context).conflict?.code, edited).toBe('block_modified')
      expect(() => mergeWebDirective(edited, feature, samples[feature], context)).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
      // Unrelated features stay editable; the modified block's bytes are untouched.
      expect(mergeWebDirective(edited, feature === 'mime-types' ? 'hotlink' : 'mime-types', samples['mime-types'] as never, context).endsWith(edited)).toBe(feature !== 'mime-types')
    }
  })
  it('detects disabled rewriting that would change managed semantics', () => {
    expect(readWebDirective(parseManagedHtaccess('# a\nRewriteEngine off\n'), 'hotlink', context).conflict).toEqual({ code: 'rewrite_disabled', line: 2 })
    expect(readWebDirective(parseManagedHtaccess('RewriteEngine Off\n'), 'redirects', context).conflict).toBeNull()
  })
  it('keeps the account policy as the availability authority', () => {
    for (const feature of WEB_DIRECTIVE_FEATURES) {
      const content = mergeWebDirective('', feature, samples[feature], context)
      expect(inspectHtaccess(content).valid, feature).toBe(true)
      expect(webDirectivePolicyAllows(feature), feature).toBe(true)
    }
    // The handlers exception holds only inside its block and only for reviewed lines.
    expect(renderWebDirectiveBody('handlers', samples.handlers)).toEqual(['Options +ExecCGI', 'Options +IncludesNOEXEC', 'AddHandler cgi-script .pl .cgi', 'AddHandler server-parsed .shtml', 'AddHandler type-map .var'])
    expect(inspectHtaccess('AddHandler cgi-script .pl\n').issues.map(issue => issue.code)).toEqual(['directive'])
    expect(inspectHtaccess('Options +ExecCGI\n').issues.map(issue => issue.code)).toEqual(['options'])
    for (const line of ['AddHandler server-status .x', 'AddHandler cgi-script .php', 'AddHandler cgi-script .pl .phtml', 'Options +Includes', 'Options +ExecCGI +FollowSymLinks', 'SetHandler cgi-script', 'AddHandler cgi-script'])
      expect(inspectHtaccess('# BEGIN xPanel handlers\n' + line + '\n# END xPanel handlers\n').issues.map(issue => issue.code), line).toEqual(['apache_handlers'])
    expect(inspectHtaccess(mergeWebDirective('', 'hotlink', { ...samples.hotlink, allowEmptyReferrer: false, redirectUrl: 'https://example.org/blocked.txt' }, context)).valid).toBe(true)
  })
  it('accepts canonical grammar and normalizes only safe spellings', () => {
    expect(parseWebDirectiveModel('mime-types', { entries: [{ type: 'Text/X-Markdown', extensions: ['MD', '.mkd'] }] }, context)).toEqual({ entries: [{ type: 'text/x-markdown', extensions: ['.md', '.mkd'] }] })
    expect(parseWebDirectiveModel('handlers', { entries: [{ handler: 'server-parsed', extensions: ['HTML', '.shtml'] }, { handler: 'cgi-script', extensions: ['.PL'] }] }, context)).toEqual({ entries: [{ handler: 'cgi-script', extensions: ['.pl'] }, { handler: 'server-parsed', extensions: ['.html', '.shtml'] }] })
    expect(parseWebDirectiveModel('redirects', { entries: [{ status: 302, path: '/', target: 'https://Example.org' }, { status: 301, path: '/shop/', target: 'http://example.org/a%20b?x=1' }] }, context).entries.map(entry => entry.path + ' ' + entry.target)).toEqual(['/shop/ http://example.org/a%20b?x=1', '/ https://example.org/'])
    expect(parseWebDirectiveModel('hotlink', { enabled: true, allowedHosts: ['Example.test'], extensions: ['.JPG'], allowEmptyReferrer: false, redirectUrl: 'https://cdn.example.org/denied.html' }, context)).toEqual({ enabled: true, allowedHosts: ['example.test'], extensions: ['jpg'], allowEmptyReferrer: false, redirectUrl: 'https://cdn.example.org/denied.html' })
    expect(parseWebDirectiveModel('error-pages', { entries: [{ code: 503, path: '/e/503.html' }, { code: 400, path: '/e/400.html' }] }, context).entries.map(entry => entry.code)).toEqual([400, 503])
  })
  it('refuses injection, smuggling and unsafe values field by field', () => {
    const smuggled = ['/a\nRewriteRule ^ http://evil/ [P]', '/a "b"', "/a'b", '/a<b', '/${HOME}', '/a b', '/a/../b', '/a\\b', '/a?b', '/a%2e', 'relative.html', '//host/x', '/a\u202Eb']
    for (const path of smuggled) {
      expect(fields(() => parseWebDirectiveModel('error-pages', { entries: [{ code: 404, path }] }, context)), path).toEqual([{ field: 'entries.0.path', code: 'path' }])
      expect(fields(() => parseWebDirectiveModel('redirects', { entries: [{ status: 301, path, target: 'https://example.org/' }] }, context)), path).toContainEqual({ field: 'entries.0.path', code: 'path' })
    }
    expect(fields(() => parseWebDirectiveModel('error-pages', { entries: [{ code: 418, path: '/x.html' }, { code: 404, path: '/x.html' }, { code: 404, path: '/y.html' }, { code: 404, path: '/z.html', extra: 1 }] }, context)))
      .toEqual([{ field: 'entries.0.code', code: 'code' }, { field: 'entries.2.code', code: 'duplicate' }, { field: 'entries.3', code: 'type' }])
    expect(fields(() => parseWebDirectiveModel('error-pages', { entries: [], path: '/etc/passwd' }, context))).toEqual([{ field: 'model', code: 'type' }])
    expect(fields(() => parseWebDirectiveModel('indexes', { listing: 'Options +ExecCGI' }, context))).toEqual([{ field: 'listing', code: 'listing' }])
    expect(fields(() => parseWebDirectiveModel('mime-types', { entries: [{ type: 'application/x-httpd-php', extensions: ['.txt'] }, { type: 'text/plain\nAddHandler cgi-script', extensions: ['.a'] }, { type: 'text/plain', extensions: ['.php7', '.ok', 'a b', '.ok'] }, { type: 'nope/plain', extensions: [] }] }, context)))
      .toEqual([{ field: 'entries.0.type', code: 'executable_type' }, { field: 'entries.1.type', code: 'mime_type' }, { field: 'entries.2.extensions.0', code: 'executable_extension' }, { field: 'entries.2.extensions.2', code: 'extension' }, { field: 'entries.2.extensions.3', code: 'duplicate' }, { field: 'entries.3.type', code: 'mime_type' }, { field: 'entries.3.extensions', code: 'required' }])
    // cPanel refuses custom handler names (INVALID_HANDLER); the status handlers expose every tenant and two modules are not loaded.
    expect(fields(() => parseWebDirectiveModel('handlers', { entries: [{ handler: 'my-handler', extensions: ['.x'] }, { handler: 'server-status', extensions: ['.y'] }, { handler: 'server-info', extensions: ['.z'] }, { handler: 'send-as-is', extensions: ['.asis'] }, { handler: 'imap-file', extensions: ['.map'] }, { handler: 'cgi-script\nSetHandler x', extensions: ['.q'] }] }, context)))
      .toEqual([{ field: 'entries.0.handler', code: 'handler' }, { field: 'entries.1.handler', code: 'handler_not_permitted' }, { field: 'entries.2.handler', code: 'handler_not_permitted' }, { field: 'entries.3.handler', code: 'handler_unavailable' }, { field: 'entries.4.handler', code: 'handler_unavailable' }, { field: 'entries.5.handler', code: 'handler' }])
    expect(fields(() => parseWebDirectiveModel('handlers', { entries: [{ handler: 'cgi-script', extensions: ['.php', '.PHTML', '.htaccess', 'pl', 'a b', '.pl'] }, { handler: 'default-handler', extensions: [] }] }, context)))
      .toEqual([{ field: 'entries.0.extensions.0', code: 'system_extension' }, { field: 'entries.0.extensions.1', code: 'system_extension' }, { field: 'entries.0.extensions.2', code: 'system_extension' }, { field: 'entries.0.extensions.4', code: 'extension' }, { field: 'entries.0.extensions.5', code: 'duplicate' }, { field: 'entries.1.extensions', code: 'required' }])
    expect(fields(() => parseWebDirectiveModel('handlers', { entries: [{ handler: 'cgi-script', extensions: ['.pl'] }, { handler: 'cgi-script', extensions: ['.cgi'] }, { handler: 'type-map', extensions: ['.PL'] }] }, context)))
      .toEqual([{ field: 'entries.1.handler', code: 'duplicate' }, { field: 'entries.2.extensions.0', code: 'duplicate' }])
    expect(fields(() => parseWebDirectiveModel('handlers', { entries: Array.from({ length: 51 }, () => ({ handler: 'default-handler', extensions: ['.a'] })) }, context))).toEqual([{ field: 'entries', code: 'too_many' }])
    for (const target of ['javascript:alert(1)', 'ftp://example.org/', 'https://user:pw@example.org/', 'https://example.org/$1', "https://example.org/a'b", 'https://example.org/a"b', 'https://example.org/(x)', 'https://[::1]/', 'https://localhost/', 'https://example.org/%zz', 'https://example.org/<x>'])
      expect(fields(() => parseWebDirectiveModel('redirects', { entries: [{ status: 301, path: '/a', target }] }, context)), target).toEqual([{ field: 'entries.0.target', code: 'url' }])
    expect(fields(() => parseWebDirectiveModel('redirects', { entries: [{ status: 307, path: '/a', target: 'https://example.test/a/b' }, { status: 301, path: '/', target: 'https://www.example.test/x' }, { status: 301, path: '/a', target: 'https://example.test/ab' }, { status: 301, path: '/a', target: 'https://example.org/' }] }, context)))
      .toEqual([{ field: 'entries.0.status', code: 'status' }, { field: 'entries.0.target', code: 'redirect_loop' }, { field: 'entries.1.target', code: 'redirect_loop' }, { field: 'entries.3.path', code: 'duplicate' }])
    expect(fields(() => parseWebDirectiveModel('hotlink', { enabled: true, allowedHosts: [], extensions: ['png', 'p ng', 'png'], allowEmptyReferrer: 'yes', redirectUrl: 'https://example.org/x.png' }, context)))
      .toEqual([{ field: 'allowEmptyReferrer', code: 'type' }, { field: 'extensions.1', code: 'extension' }, { field: 'extensions.2', code: 'duplicate' }, { field: 'allowedHosts', code: 'required' }, { field: 'redirectUrl', code: 'redirect_loop' }])
    expect(fields(() => parseWebDirectiveModel('hotlink', { enabled: true, allowedHosts: ['example.test\nRewriteRule ^ - [P]', '*.example.test'], extensions: ['png'], allowEmptyReferrer: true, redirectUrl: 'https://example.org/%251' }, context)))
      .toEqual([{ field: 'allowedHosts.0', code: 'host' }, { field: 'allowedHosts.1', code: 'host' }, { field: 'redirectUrl', code: 'url' }])
  })
})
