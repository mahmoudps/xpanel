import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import {
  RESERVED_USERNAMES,
  assertDbNameOwned,
  dbGrantPattern,
  dbName,
  dbUserName,
  parseServiceLogin,
  serviceLogin,
  validateDomainName,
  validateEmailLocalPart,
  validateUsername,
  validateWildcardName,
} from './naming.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

describe('validateUsername', () => {
  it('accepts lowercase alphanumerics starting with a letter, 1..16 chars', () => {
    expect(validateUsername('a')).toBe('a')
    expect(validateUsername('bob2')).toBe('bob2')
    expect(validateUsername('abcdefghijklmnop')).toBe('abcdefghijklmnop')
  })

  it.each([
    ['', 'empty'],
    ['abcdefghijklmnopq', '17 chars'],
    ['Bob', 'uppercase'],
    ['1bob', 'leading digit'],
    ['bob_x', 'underscore'],
    ['bob-x', 'hyphen'],
    ['bob.x', 'dot'],
    ['bob x', 'space'],
    ['../etc', 'path traversal'],
    ['bob;rm', 'shell metachar'],
    ['bob\n', 'newline'],
    ['bób', 'non-ascii'],
  ])('rejects %j (%s)', (name) => {
    expect(code(() => validateUsername(name))).toBe('VALIDATION')
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 42, {}, ['bob']]) expect(code(() => validateUsername(v))).toBe('VALIDATION')
  })

  it.each(['root', 'admin', 'administrator', 'www', 'nobody', 'mail', 'postfix', 'dovecot', 'mysql', 'mariadb', 'postgres', 'redis', 'nginx', 'apache', 'httpd', 'xpanel', 'ftp', 'sshd', 'bin', 'daemon', 'sys', 'sync', 'games', 'man', 'lp', 'news', 'uucp', 'proxy', 'backup', 'list', 'irc', 'gnats', 'test', 'virtfs', 'all', 'cpanel', 'whm', 'sudo', 'wheel', 'docker', 'shadow', 'disk'])(
    'rejects reserved name %s',
    (name) => {
      expect(code(() => validateUsername(name))).toBe('VALIDATION')
    },
  )

  it('rejects systemd*, test* and xpanel* prefixes', () => {
    expect(code(() => validateUsername('systemdresolve'))).toBe('VALIDATION')
    expect(code(() => validateUsername('testsite'))).toBe('VALIDATION')
    expect(code(() => validateUsername('xpanelapi'))).toBe('VALIDATION')
    expect(validateUsername('mytest')).toBe('mytest')
  })

  it.each(['mem', 'libvirt', 'qemu', 'lpadmin', 'vmail', 'mailnull', 'memcache', 'apt', 'dnf', 'yum', 'rpm', 'dpkg', 'gopher', 'dhcpcd', 'setroubleshoot', 'cups'])(
    'reserves system user/group %s',
    (name) => {
      expect(code(() => validateUsername(name))).toBe('VALIDATION')
    },
  )

  it('reserves names whose "<name>_schema" database would be a MariaDB system schema', () => {
    expect(code(() => validateUsername('information'))).toBe('VALIDATION')
    expect(code(() => validateUsername('performance'))).toBe('VALIDATION')
    expect(validateUsername('perform')).toBe('perform')
  })

  it('reserves the xwhm* and xmail* namespaces like xpanel*', () => {
    expect(code(() => validateUsername('xwhmapi'))).toBe('VALIDATION')
    expect(code(() => validateUsername('xmailer'))).toBe('VALIDATION')
    expect(validateUsername('mailx')).toBe('mailx')
  })

  it('reserves system group names too, since the account group shares the username', () => {
    for (const g of ['sudo', 'wheel', 'adm', 'docker', 'shadow', 'kvm']) expect(RESERVED_USERNAMES.has(g)).toBe(true)
  })
})

describe('validateDomainName', () => {
  it('normalizes case and one trailing dot', () => {
    expect(validateDomainName('Example.COM')).toBe('example.com')
    expect(validateDomainName('example.com.')).toBe('example.com')
    expect(validateDomainName('a.b.c.example.co.uk')).toBe('a.b.c.example.co.uk')
  })

  it('converts IDN to punycode and validates punycode labels', () => {
    expect(validateDomainName('münchen.de')).toBe('xn--mnchen-3ya.de')
    expect(validateDomainName('xn--mnchen-3ya.de')).toBe('xn--mnchen-3ya.de')
    expect(validateDomainName('例え.テスト')).toBe('xn--r8jz45g.xn--zckzah')
    expect(code(() => validateDomainName('xn--zz.com'))).toBe('VALIDATION')
    expect(code(() => validateDomainName('xn--.com'))).toBe('VALIDATION')
  })

  it.each([
    ['', 'empty'],
    ['localhost', 'single label'],
    ['example', 'single label'],
    ['example..com', 'empty label'],
    ['.example.com', 'leading dot'],
    ['example.com..', 'two trailing dots'],
    ['*.example.com', 'wildcard'],
    ['ex*ample.com', 'star'],
    ['-example.com', 'leading hyphen'],
    ['example-.com', 'trailing hyphen'],
    ['ab--cd.com', 'reserved hyphen position'],
    ['exa_mple.com', 'underscore'],
    ['ex%41mple.com', 'percent escape'],
    ['example.com/x', 'slash'],
    ['user@example.com', 'at sign'],
    ['example.com:80', 'port'],
    ['exa mple.com', 'space'],
    ['example.com\n', 'newline'],
    ['example.com;reboot', 'semicolon'],
    ['"example.com"', 'quotes'],
    ['127.0.0.1', 'IPv4'],
    ['10.0.0.1.', 'IPv4 with dot'],
    ['0x7f.1', 'hex IP'],
    ['[::1]', 'IPv6'],
    ['::1', 'IPv6 bare'],
    ['１２７.０.０.１', 'full-width IP'],
    ['example.123', 'numeric TLD'],
    ['example.0x7f', 'hex TLD that WHATWG parses as IPv4'],
    ['example.a1', 'digit in TLD'],
    ['example.c', 'single-letter TLD'],
    ['example.xn--', 'bare xn-- TLD'],
  ])('rejects %j (%s)', (name) => {
    expect(code(() => validateDomainName(name))).toBe('VALIDATION')
  })

  it('accepts IDNs in many scripts, NFC-equivalent input and IDNA dot separators', () => {
    expect(validateDomainName('MÜNCHEN.DE')).toBe('xn--mnchen-3ya.de')
    expect(validateDomainName('faß.de')).toBe('xn--fa-hia.de')
    expect(validateDomainName('مثال.إختبار')).toBe('xn--mgbh0fb.xn--kgbechtv')
    expect(validateDomainName('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai')
    expect(validateDomainName('中国.中國')).toBe('xn--fiqs8s.xn--fiqz9s')
    expect(validateDomainName('e\u0301xample.com')).toBe(validateDomainName('éxample.com'))
    expect(validateDomainName('a\u3002b.com')).toBe('a.b.com')
    expect(validateDomainName('xn--mnchen-3ya.münchen.de')).toBe('xn--mnchen-3ya.xn--mnchen-3ya.de')
  })

  it.each([
    ['ex\u00adample.com', 'soft hyphen'],
    ['exa\u200bmple.com', 'zero-width space'],
    ['exa\u200dmple.com', 'zero-width joiner'],
    ['ⓐ.com', 'circled letter folded to "a"'],
    ['ＥＸＡＭＰＬＥ.com', 'full-width letters'],
    ['ﬁle.com', 'ligature folded to "fi"'],
  ])('refuses %j (%s) instead of storing the name IDNA would rewrite it to', (name) => {
    expect(code(() => validateDomainName(name))).toBe('VALIDATION')
  })

  it.each(['x.localhost', 'localhost.localdomain', 'printer.local', 'abc.onion', '1.0.0.127.in-addr.arpa', 'a.invalid', 'LOCALHOST.localhost.'])(
    'refuses the special-use name %j',
    (name) => {
      expect(code(() => validateDomainName(name))).toBe('VALIDATION')
    },
  )

  it('enforces label and total length limits', () => {
    const l63 = 'a'.repeat(63)
    expect(validateDomainName(`${l63}.com`)).toBe(`${l63}.com`)
    expect(code(() => validateDomainName(`${'a'.repeat(64)}.com`))).toBe('VALIDATION')
    // 4*63 + 3 dots = 255 > 253
    const long = [l63, l63, l63, l63].join('.')
    expect(code(() => validateDomainName(long))).toBe('VALIDATION')
    // exactly 253
    const exact = [l63, l63, l63, 'a'.repeat(61)].join('.')
    expect(exact.length).toBe(253)
    expect(validateDomainName(exact)).toBe(exact)
    expect(validateDomainName(`${exact}.`)).toBe(exact)
    expect(code(() => validateDomainName('a'.repeat(5000)))).toBe('VALIDATION')
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['a.com']]) expect(code(() => validateDomainName(v))).toBe('VALIDATION')
  })
})

describe('validateWildcardName', () => {
  it('accepts one leftmost star over a valid domain', () => {
    expect(validateWildcardName('*.Example.com')).toBe('*.example.com')
    expect(validateWildcardName('*.sub.example.com.')).toBe('*.sub.example.com')
  })

  it.each(['*', '*.com', 'a.*.example.com', '*.*.example.com', '**.example.com', 'example.com', '*example.com', '*.127.0.0.1', '*.'])(
    'rejects %j',
    (name) => {
      expect(code(() => validateWildcardName(name))).toBe('VALIDATION')
    },
  )
})

describe('database names', () => {
  it('builds prefixed names', () => {
    expect(dbName('bob', 'wp')).toBe('bob_wp')
    expect(dbName('bob', 'wp_2024')).toBe('bob_wp_2024')
    expect(dbName('bob', '1st')).toBe('bob_1st')
  })

  it('enforces the 64 character limit of the escaped GRANT pattern (each "_" counts twice)', () => {
    expect(dbName('bob', 'x'.repeat(59))).toHaveLength(63)
    expect(dbGrantPattern(dbName('bob', 'x'.repeat(59)))).toHaveLength(64)
    expect(code(() => dbName('bob', 'x'.repeat(60)))).toBe('VALIDATION')
    // 'bob_' + 'a_' * 19 + 'xx' is 44 characters with 20 underscores: exactly 64 once escaped
    const atLimit = dbName('bob', `${'a_'.repeat(19)}xx`)
    expect(atLimit).toHaveLength(44)
    expect(dbGrantPattern(atLimit)).toHaveLength(64)
    expect(code(() => dbName('bob', `${'a_'.repeat(19)}xxx`))).toBe('VALIDATION')
    expect(code(() => dbName('bob', `${'a_'.repeat(20)}x`))).toBe('VALIDATION')
    expect(code(() => dbName('bob', 'x'.repeat(100_000)))).toBe('VALIDATION')
  })

  it('can never produce a MariaDB system schema name', () => {
    expect(code(() => dbName('information', 'schema'))).toBe('VALIDATION')
    expect(code(() => dbName('performance', 'schema'))).toBe('VALIDATION')
    expect(code(() => assertDbNameOwned('performance', 'performance_schema'))).toBe('VALIDATION')
    expect(code(() => dbGrantPattern('performance_schema'))).toBe('VALIDATION')
    expect(code(() => dbGrantPattern('information_schema'))).toBe('VALIDATION')
  })

  it('dbGrantPattern refuses names whose prefix is not a valid account username', () => {
    for (const n of ['root_x', 'mysql_x', 'testsite_db', 'xpanel_state']) expect(code(() => dbGrantPattern(n))).toBe('VALIDATION')
    expect(code(() => dbGrantPattern(`bob_${'x'.repeat(60)}`))).toBe('VALIDATION')
  })

  it.each(['', 'WP', 'wp-site', 'wp site', '_wp', 'wp`; DROP DATABASE x; --', 'wp/../x', 'wp%', 'wp.x'])('rejects suffix %j', (suffix) => {
    expect(code(() => dbName('bob', suffix))).toBe('VALIDATION')
  })

  it('validates the username part', () => {
    expect(code(() => dbName('root', 'x'))).toBe('VALIDATION')
    expect(code(() => dbName('Bob', 'x'))).toBe('VALIDATION')
  })

  it('limits database user names to 32 characters', () => {
    expect(dbUserName('bob', 'x'.repeat(28))).toHaveLength(32)
    expect(code(() => dbUserName('bob', 'x'.repeat(29)))).toBe('VALIDATION')
  })

  it('checks ownership of full names', () => {
    expect(assertDbNameOwned('bob', 'bob_wp')).toBe('bob_wp')
    expect(code(() => assertDbNameOwned('bob', 'alice_wp'))).toBe('VALIDATION')
    expect(code(() => assertDbNameOwned('bob', 'bobx_wp'))).toBe('VALIDATION')
    expect(code(() => assertDbNameOwned('bob', 'bob_'))).toBe('VALIDATION')
  })

  it('escapes GRANT wildcards', () => {
    expect(dbGrantPattern('bob_wp')).toBe('bob\\_wp')
    expect(dbGrantPattern('bob_wp_2024')).toBe('bob\\_wp\\_2024')
  })

  it.each(['a%b', 'bob_wp`.* TO x; DROP USER y; --', 'bob_wp\\', 'bob', 'Bob_wp', '_wp', 'bob__', `bob_${'x'.repeat(61)}`, 'bob_w p'])(
    'dbGrantPattern refuses %j instead of quoting it into SQL',
    (name) => {
      expect(code(() => dbGrantPattern(name))).toBe('VALIDATION')
    },
  )

  it('dbGrantPattern refuses non-strings', () => {
    for (const v of [undefined, null, 42, ['bob_wp']]) expect(code(() => dbGrantPattern(v))).toBe('VALIDATION')
  })
})

describe('email local parts and service logins', () => {
  it('lowercases and accepts the safe subset', () => {
    expect(validateEmailLocalPart('John.Doe')).toBe('john.doe')
    expect(validateEmailLocalPart('info_2-x')).toBe('info_2-x')
    expect(validateEmailLocalPart('a')).toBe('a')
    expect(validateEmailLocalPart('x'.repeat(64))).toHaveLength(64)
  })

  it.each(['', '.john', 'john.', 'jo..hn', '-john', '_john', 'jo hn', 'jo+hn', 'jo"hn', 'jo@hn', 'jo/hn', 'jo\nhn', 'jo:hn', 'jöhn', 'x'.repeat(65), '../../etc', 'Kate', 'ｊohn'])(
    'rejects local part %j',
    (local) => {
      expect(code(() => validateEmailLocalPart(local))).toBe('VALIDATION')
    },
  )

  it('builds and parses logins', () => {
    expect(serviceLogin('Info', 'Example.com')).toBe('info@example.com')
    expect(parseServiceLogin('info@example.com')).toEqual({ local: 'info', domain: 'example.com' })
    expect(code(() => serviceLogin('info', 'localhost'))).toBe('VALIDATION')
    expect(code(() => parseServiceLogin('a@b@example.com'))).toBe('VALIDATION')
    expect(code(() => parseServiceLogin('@example.com'))).toBe('VALIDATION')
    expect(code(() => parseServiceLogin('info'))).toBe('VALIDATION')
  })

  it('caps the whole address at 254 characters', () => {
    const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(57)].join('.')
    expect(domain.length).toBe(249)
    expect(serviceLogin('abcd', domain)).toHaveLength(254)
    expect(code(() => serviceLogin('abcde', domain))).toBe('VALIDATION')
  })
})
