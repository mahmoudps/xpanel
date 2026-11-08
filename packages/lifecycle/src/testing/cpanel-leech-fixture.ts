import type { TestEntry } from './tar.ts'

/**
 * Leech Protection as cPanel leaves it in a backup: the condition on its RewriteMap and the redirect rule after the
 * Directory Privacy lines of the folder .htaccess (with the key newer versions add), and .leechprotect-conf beside it.
 */
export const leechEntries = (top = 'cpmove-bob'): TestEntry[] => [
  { name: `${top}/homedir/public_html/members/.htaccess`, content: '\r\nAuthType Basic\r\nAuthName "members"\r\nAuthUserFile "/home/bob/.htpasswds/public_html/members/passwd"\r\nrequire valid-user\r\n'
    + '\r\nRewriteEngine on\r\nRewriteCond ${LeechProtect:/home/bob/public_html/members:%{REMOTE_USER}:%{REMOTE_ADDR}:4:6Krj86erV1EdNDphF8uZfwOmXIXYovUE} leech\r\nRewriteRule .* https://bob.example/shared.html\r\n' },
  { name: `${top}/homedir/public_html/members/.leechprotect-conf`, content: 'email=bob@bob.example\nkill=1\nurl=https://bob.example/shared.html\nnumhits=4\n' },
  // a relative redirect, as cPanel accepts and xPanel does not
  { name: `${top}/homedir/public_html/vip/.htaccess`, content: '\nRewriteEngine on\nRewriteCond ${LeechProtect:/home/bob/public_html/vip:%{REMOTE_USER}:%{REMOTE_ADDR}:3} leech\nRewriteRule .* /\n' },
  { name: `${top}/homedir/public_html/vip/.leechprotect-conf`, content: 'email=\nkill=\nurl=/\nnumhits=3\n' },
  { name: `${top}/homedir/public_html/odd/.htaccess`, content: 'RewriteCond ${LeechProtect:/home/bob/public_html/odd} leech\n' },
]
