import { describe, expect, it } from 'vitest'
import {
  decideHtaccessRollback,
  htaccessBackupName,
  htaccessRollbackAction,
  planHtaccessSave,
  translatePhpDirectives,
} from './htaccess.ts'
import { codeOf } from './testkit.ts'

const at = '2026-10-22T01:34:05.123Z'

describe('planHtaccessSave', () => {
  it('backs up the previous file under a .ht-prefixed timestamped name', () => {
    const p = planHtaccessSave('RewriteEngine On\n', 'RewriteEngine Off\n', at)
    expect(p.changed).toBe(true)
    expect(p.backup).toEqual({ name: '.htaccess.xpanel-20261022T013405Z.bak', content: 'RewriteEngine On\n' })
    expect(p.write).toEqual({ name: '.htaccess', content: 'RewriteEngine Off\n' })
    expect(p.previous).toBe('RewriteEngine On\n')
    expect(htaccessBackupName(at).startsWith('.ht')).toBe(true)
  })

  it('needs no backup for a new file or an unchanged one', () => {
    expect(planHtaccessSave(null, 'x\n', at).backup).toBeNull()
    const same = planHtaccessSave('x\n', 'x\n', at)
    expect(same.changed).toBe(false)
    expect(same.backup).toBeNull()
  })

  it('warns about directives the handlers ignore or reject', () => {
    const p = planHtaccessSave(null, 'php_value memory_limit 256M\nAddHandler application/x-httpd-ea-php81 .php\nsuPHP_ConfigPath /home/a\n', at)
    expect(p.warnings).toHaveLength(3)
  })

  it('rejects oversized, binary and non-string content and bad timestamps', () => {
    expect(codeOf(() => planHtaccessSave(null, 'a'.repeat(1024 * 1024 + 1), at))).toBe('VALIDATION')
    expect(codeOf(() => planHtaccessSave(null, 'a\u0000b', at))).toBe('VALIDATION')
    expect(codeOf(() => planHtaccessSave(null, 42 as unknown as string, at))).toBe('VALIDATION')
    expect(codeOf(() => planHtaccessSave(null, 'x', 'not a date'))).toBe('VALIDATION')
    expect(codeOf(() => planHtaccessSave(null, 'a'.repeat(1024 * 1024), at))).toBeNull()
  })
})

describe('decideHtaccessRollback', () => {
  it('restores when the probe returns 500', () => {
    expect(decideHtaccessRollback(500).restore).toBe(true)
    expect(decideHtaccessRollback({ status: 500 }, 200).restore).toBe(true)
  })

  it('keeps the file for other answers or no answer', () => {
    for (const s of [200, 301, 403, 404, 502, 503]) expect(decideHtaccessRollback(s).restore).toBe(false)
    expect(decideHtaccessRollback(null).restore).toBe(false)
    expect(decideHtaccessRollback({ status: null }).restore).toBe(false)
  })

  it('does not blame the file when the site was already failing', () => {
    expect(decideHtaccessRollback(500, 500).restore).toBe(false)
    expect(decideHtaccessRollback(500, { status: 500 }).restore).toBe(false)
  })

  it('rejects impossible statuses', () => {
    expect(codeOf(() => decideHtaccessRollback(42))).toBe('VALIDATION')
    expect(codeOf(() => decideHtaccessRollback(500.5))).toBe('VALIDATION')
  })

  it('restores the previous content or deletes a file that did not exist', () => {
    expect(htaccessRollbackAction(planHtaccessSave('old\n', 'new\n', at))).toEqual({ kind: 'write', name: '.htaccess', content: 'old\n' })
    expect(htaccessRollbackAction(planHtaccessSave(null, 'new\n', at))).toEqual({ kind: 'delete', name: '.htaccess' })
  })
})

describe('translatePhpDirectives', () => {
  it('moves php_value/php_flag to .user.ini and keeps everything else', () => {
    const src = [
      'RewriteEngine On',
      'php_value upload_max_filesize 64M',
      'php_flag display_errors off',
      'PHP_VALUE memory_limit "256M"',
      'RewriteRule ^old$ /new [R=301,L]',
      '',
    ].join('\n')
    const t = translatePhpDirectives(src)
    expect(t.userIni).toEqual({ upload_max_filesize: '64M', display_errors: 'Off', memory_limit: '256M' })
    expect(t.moved).toEqual(['upload_max_filesize', 'display_errors', 'memory_limit'])
    expect(t.cleanedHtaccess).toBe('RewriteEngine On\nRewriteRule ^old$ /new [R=301,L]\n')
    expect(t.dropped).toEqual([])
  })

  it('lets the last occurrence win, as Apache does', () => {
    const t = translatePhpDirectives('php_value memory_limit 128M\nphp_value memory_limit 512M\n')
    expect(t.userIni).toEqual({ memory_limit: '512M' })
  })

  it('removes container sections left empty', () => {
    const src = ['<IfModule php7_module>', '   php_value max_execution_time 120', '</IfModule>', '<IfModule mod_rewrite.c>', 'RewriteEngine On', '</IfModule>'].join('\n')
    const t = translatePhpDirectives(src)
    expect(t.cleanedHtaccess).toBe('<IfModule mod_rewrite.c>\nRewriteEngine On\n</IfModule>')
    expect(t.userIni).toEqual({ max_execution_time: '120' })
  })

  it('handles CRLF and continuation lines', () => {
    const t = translatePhpDirectives('Options -Indexes\r\nphp_value max_input_vars \\\r\n"5000"\r\nRewriteEngine On\r\n')
    expect(t.userIni).toEqual({ max_input_vars: '5000' })
    expect(t.cleanedHtaccess).toBe('Options -Indexes\r\nRewriteEngine On\r\n')
  })

  it('drops admin directives, server-owned and unknown keys, unsafe values and cPanel/suPHP handler lines', () => {
    const src = [
      'php_admin_value open_basedir /',
      'php_value open_basedir none',
      'php_value auto_prepend_file /home/alice/waf.php',
      'php_value memory_limit "1$(id)"',
      'php_flag display_errors maybe',
      'AddHandler application/x-httpd-ea-php74___lsphp .php .php7 .phtml',
      'AddType application/x-httpd-php .html',
      'suPHP_ConfigPath /home/alice/public_html',
      'php_value include_path ".:/home/alice/lib"',
      'php_value mbstring.func_overload 2',
      'php_flag allow_url_fopen off',
      'DirectoryIndex index.php',
    ].join('\n')
    const t = translatePhpDirectives(src)
    expect(t.userIni).toEqual({})
    expect(t.dropped.map((d) => d.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(t.dropped.find((d) => d.line === 11)?.reason).toContain('PHP startup')
    expect(t.cleanedHtaccess).toBe('DirectoryIndex index.php')
  })

  it('canonicalizes moved values with the panel rule', () => {
    const t = translatePhpDirectives('php_value memory_limit 256m\nphp_flag display_errors 1\nphp_value error_reporting "E_ALL&~E_NOTICE"\n')
    expect(t.userIni).toEqual({ memory_limit: '256M', display_errors: 'On', error_reporting: 'E_ALL & ~E_NOTICE' })
  })

  it('leaves unrelated php mentions alone', () => {
    const src = 'SetEnv php_value x\n# php_value memory_limit 1G\nRewriteRule \\.php$ - [L]'
    const t = translatePhpDirectives(src)
    expect(t.cleanedHtaccess).toBe(src)
    expect(t.userIni).toEqual({})
  })
})
