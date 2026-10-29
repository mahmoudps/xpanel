/** Reviewed host facts for WAF, flood protection and the DNS cluster. One fixed argv; every other fact is a stat or bounded read of a fixed path. */
export const SEC_NFT = '/usr/sbin/nft'
// nft(8): -j/--json prints the ruleset in the libnftables-json(5) schema; only our own table is listed.
export const SEC_NFT_LIST_ARGV = [SEC_NFT, '--json', 'list', 'table', 'inet', 'xpanel'] as const
export type SecFamily = 'debian' | 'rhel'

/** Distribution package file locations: libnginx-mod-http-modsecurity / libapache2-mod-security2 / modsecurity-crs (Debian), nginx-mod-modsecurity / mod_security / mod_security_crs (EL). */
export const SEC_MODSEC_PATHS: Readonly<Record<SecFamily, { nginxModule: string; apacheModule: string; engineConf: readonly string[]; crsDirs: readonly string[] }>> = {
  debian: {
    nginxModule: '/usr/lib/nginx/modules/ngx_http_modsecurity_module.so',
    apacheModule: '/usr/lib/apache2/modules/mod_security2.so',
    engineConf: ['/etc/modsecurity/modsecurity.conf', '/etc/nginx/modsec/modsecurity.conf'],
    crsDirs: ['/usr/share/modsecurity-crs'],
  },
  rhel: {
    nginxModule: '/usr/lib64/nginx/modules/ngx_http_modsecurity_module.so',
    apacheModule: '/usr/lib64/httpd/modules/mod_security2.so',
    engineConf: ['/etc/httpd/conf.d/mod_security.conf', '/etc/nginx/modsecurity.conf'],
    crsDirs: ['/usr/share/mod_modsecurity_crs', '/usr/share/modsecurity-crs'],
  },
}
/** CRS 3 and 4 ship this file; its header names the release ("Core Rule Set ver.3.3.4" / "OWASP CRS ver.4.0.0"). */
export const SEC_CRS_HEADER_FILE = 'rules/REQUEST-901-INITIALIZATION.conf'
export const SEC_PDNS_CONF: Readonly<Record<SecFamily, string>> = { debian: '/etc/powerdns/pdns.conf', rhel: '/etc/pdns/pdns.conf' }

const same = (argv: readonly unknown[], expected: readonly string[]): boolean => Array.isArray(argv) && argv.length === expected.length && expected.every((value, index) => value === argv[index])
/** Executor admission: the single read-only ruleset listing. */
export const isSecHostCommand = (argv: readonly unknown[]): boolean => same(argv, SEC_NFT_LIST_ARGV)
