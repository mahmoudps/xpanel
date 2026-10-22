import type { TestEntry } from './tar.ts'

// Synthetic cpmove archive content, built in memory by the tests (no binary fixtures).
// The PEMs below are throwaway test material for the reserved .example TLD.

const BOB_CERT = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR6gAwIBAgIUCR0hg7oLVHbiAN8YIWZz3E2mmmswCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLYm9iLmV4YW1wbGUwHhcNMjYxMDIxMjMyOTEwWhcNMzYxMDE4
MjMyOTEwWjAWMRQwEgYDVQQDDAtib2IuZXhhbXBsZTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABN5HMsWosI63RWeix0sD19nbGMIypEgVKFXq9nZT/kmaQ0WQY/ER
du0Ge65YUlO7DjDuy5b2v4UDgYg3H5dxXA+jSjBIMCcGA1UdEQQgMB6CC2JvYi5l
eGFtcGxlgg93d3cuYm9iLmV4YW1wbGUwHQYDVR0OBBYEFJ8IH8Jva4t/mb+Hfb31
XO9P2CViMAoGCCqGSM49BAMCA0cAMEQCIGBhcDEl4n6iPC8etCmue3cU8bY2gPkP
LmlGZ+0FIyQ+AiAlJwSHeTOXsIvNKJ9t0qjW3MNiHFSiwqy/W0SY6y7uqA==
-----END CERTIFICATE-----
`

const BOB_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8rHE0PC4IRY4+ADt
Hfv1tOALXPuzQXmWHTgemOIUhXKhRANCAATeRzLFqLCOt0VnosdLA9fZ2xjCMqRI
FShV6vZ2U/5JmkNFkGPxEXbtBnuuWFJTuw4w7suW9r+FA4GINx+XcVwP
-----END PRIVATE KEY-----
`

const VICTIM_CERT = `-----BEGIN CERTIFICATE-----
MIIBhDCCASqgAwIBAgIUbIb7ie+5Q6U4NxPMNndOUPX04nEwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOdmljdGltLmV4YW1wbGUwHhcNMjYxMDIxMjMyOTEwWhcNMzYx
MDE4MjMyOTEwWjAZMRcwFQYDVQQDDA52aWN0aW0uZXhhbXBsZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABP7CY8tWsrqncV/iXolk685WiJCfReBgOJQbdN/UZQ06
E15f6DjndhctOE9Ru30XVRQCC9Qq110L2Dlm+4lE0XijUDBOMC0GA1UdEQQmMCSC
DnZpY3RpbS5leGFtcGxlghJ3d3cudmljdGltLmV4YW1wbGUwHQYDVR0OBBYEFA1l
Rz8xV3ZO7F1Bcj+4lYJjBoxLMAoGCCqGSM49BAMCA0gAMEUCIQDhJXfJgjO2lvbW
6MahttheyRX1nymB2wMuRyOQuyTmYAIgHadFc+iuubRyke3akhfA9mDZdz0QakxQ
gnYB650X774=
-----END CERTIFICATE-----
`

const ZONE = `; cPanel first:11.30.0.0 (update_time):1700000000
$TTL 14400
bob.example.\t86400\tIN\tSOA\tns1.oldhost.example.\troot.oldhost.example.\t( 2026101501 3600 7200 1209600 86400 )
bob.example.\t86400\tIN\tNS\tns1.oldhost.example.
bob.example.\t86400\tIN\tNS\tns2.oldhost.example.
bob.example.\t14400\tIN\tA\t203.0.113.10
www\t14400\tIN\tCNAME\tbob.example.
bob.example.\t14400\tIN\tMX\t0\tbob.example.
bob.example.\t14400\tIN\tTXT\t"v=spf1 +a +mx ~all"
old\tIN\tPTR\tx.bob.example.
`

const MAIN = `---
addon_domains:
  shop.example: shop.bob.example
cp_php_magic_include_path.conf: 0
main_domain: bob.example
parked_domains:
  - bob.net
sub_domains:
  - shop.bob.example
  - blog.bob.example
  - cdn.bob.example
  - '*.bob.example'
`

const ud = (fields: Record<string, string>): string =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`

const GRANTS = `GRANT USAGE ON *.* TO 'bob'@'localhost' IDENTIFIED BY PASSWORD '*AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
GRANT ALL PRIVILEGES ON \`bob\\_%\`.* TO 'bob'@'localhost';
GRANT USAGE ON *.* TO 'bob_wpuser'@'localhost' IDENTIFIED BY PASSWORD '*BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
GRANT ALL PRIVILEGES ON \`bob\\_wp\`.* TO 'bob_wpuser'@'localhost';
GRANT SELECT, INSERT ON \`bob\\_wp\`.* TO 'bob_wpuser'@'203.0.113.99';
GRANT FILE ON *.* TO 'bob_evil'@'localhost';
GRANT SELECT ON \`bob\\_wp\`.\`secrets\` TO 'bob_ro'@'localhost';
GRANT SELECT, SUPER ON \`bob\\_wp\`.* TO 'bob_mixed'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON \`other\\_db\`.* TO 'bob_x'@'localhost';
GRANT ALL PRIVILEGES ON \`legacy\`.* TO 'legacyuser'@'localhost';
`

export const cpmoveEntries = (top = 'cpmove-bob'): TestEntry[] => [
  { name: `${top}/`, type: 'directory' },
  { name: `${top}/version`, content: 'pkgacct version: 10\n' },
  { name: `${top}/cp/bob`, content: 'USER=bob\nPLAN=gold\nDNS=bob.example\nDNS1=shop.example\nCONTACTEMAIL=bob@gmail.com\nIP=203.0.113.10\nMAXADDON=5\nMAXPARK=unlimited\nMAXSUB=10\nMAXPOP=unlimited\nMAXSQL=3\nBWLIMIT=10737418240\nFEATURELIST=default\nBAD KEY=x\n' },
  { name: `${top}/quota`, content: '5000\n' },
  { name: `${top}/shadow`, content: '$6$rounds=5000$ACCOUNTHASH$xyz\n' },
  { name: `${top}/userdata/main`, content: MAIN },
  { name: `${top}/userdata/main.cache`, content: '{"cache":1}' },
  { name: `${top}/userdata/bob.example`, content: ud({ documentroot: '/home/bob/public_html', homedir: '/home/bob', serveralias: 'www.bob.example mail.bob.example', servername: 'bob.example', phpversion: 'ea-php81' }) },
  { name: `${top}/userdata/shop.bob.example`, content: ud({ documentroot: '/home/bob/shop.example', homedir: '/home/bob', serveralias: 'shop.example www.shop.example', servername: 'shop.bob.example', phpversion: 'ea-php74' }) },
  { name: `${top}/userdata/blog.bob.example`, content: ud({ documentroot: '/home/bob/public_html/blog', homedir: '/home/bob' }) },
  { name: `${top}/userdata/cdn.bob.example`, content: ud({ documentroot: '/var/www/html', homedir: '/home/bob' }) },
  { name: `${top}/userdata/evil.example`, content: ud({ documentroot: '/etc' }) },
  { name: `${top}/dnszones/bob.example.db`, content: ZONE },
  { name: `${top}/dnszones/victim.example.db`, content: 'victim.example. IN A 198.51.100.1\n' },
  { name: `${top}/mysql/`, type: 'directory' },
  { name: `${top}/mysql/bob_wp.sql`, content: 'CREATE TABLE wp_posts (id int);\nINSERT INTO wp_posts VALUES (1);\n' },
  { name: `${top}/mysql/bob_wp.create`, content: 'CREATE DATABASE `bob_wp`;\n' },
  { name: `${top}/mysql/legacy.sql`, content: 'CREATE TABLE t (id int);\n' },
  { name: `${top}/mysql/bad;name.sql`, content: 'x' },
  { name: `${top}/mysql.sql`, content: GRANTS },
  { name: `${top}/va/bob.example`, content: 'info@bob.example: bob@gmail.com, team@bob.example\nsales@bob.example: "|/home/bob/bin/process.pl"\nboss@bob.example: bob\n*: :fail: No Such User Here\n' },
  { name: `${top}/va/shop.example`, content: 'orders@shop.example: /home/bob/orders.mbox\n*: owner@shop.example\n' },
  { name: `${top}/vf/bob.example`, content: '# Exim filter\nif $header_subject contains "spam" then save "/dev/null" endif\n' },
  { name: `${top}/sslcerts/bob_example.crt`, content: BOB_CERT },
  { name: `${top}/sslcerts/victim_example.crt`, content: VICTIM_CERT },
  { name: `${top}/sslkeys/bob_example.key`, content: BOB_KEY },
  { name: `${top}/cron/bob`, content: '* * * * * /home/bob/x.sh\n' },
  { name: `${top}/psql/`, type: 'directory' },
  { name: `${top}/domainkeys/private/bob.example`, content: 'DKIM PRIVATE' },
  { name: `${top}/logs/bob.example-ssl_log.offset`, content: '1' },
  { name: `${top}/frobnicator/x`, content: '1' },
  { name: `${top}/homedir/`, type: 'directory' },
  { name: `${top}/homedir/public_html/`, type: 'directory' },
  { name: `${top}/homedir/public_html/index.php`, content: '<?php echo "bob";' },
  { name: `${top}/homedir/public_html/blog/index.html`, content: '<h1>blog</h1>' },
  { name: `${top}/homedir/www`, type: 'symlink', linkname: 'public_html' },
  { name: `${top}/homedir/access-logs`, type: 'symlink', linkname: '/usr/local/apache/domlogs/bob' },
  { name: `${top}/homedir/escape`, type: 'symlink', linkname: '../../../../etc/shadow' },
  { name: `${top}/homedir/.my.cnf`, content: '[client]\npassword="MYSQLSECRET"\n' },
  { name: `${top}/homedir/.cpanel/`, type: 'directory' },
  { name: `${top}/homedir/.cpanel/datastore/x`, content: 'cache' },
  { name: `${top}/homedir/etc/bob.example/passwd`, content: 'info:x:1001:1001::/home/bob/mail/bob.example/info:/home/bob\nsupport:x:1001:1001::/home/bob/mail/bob.example/support:/home/bob\nBad..Name:x:1:1::/x:/y\n' },
  { name: `${top}/homedir/etc/bob.example/shadow`, content: 'info:$6$MAILBOXSECRET$abc:19000::::::\n' },
  { name: `${top}/homedir/etc/bob.example/quota`, content: 'info:52428800\nsupport:0\n' },
  { name: `${top}/homedir/etc/victim.example/passwd`, content: 'ceo:x:1:1::/x:/y\n' },
  { name: `${top}/homedir/mail/bob.example/info/cur/1700000000.M1.host:2,S`, content: 'Subject: hi\n\nhello' },
  { name: `${top}/homedir/mail/bob.example/ghost/new/1`, content: 'Subject: orphan' },
  { name: `${top}/homedir/hard`, type: 'link', linkname: `${top}/homedir/public_html/index.php` },
  { name: `${top}/homedir/dev`, type: 'character-device' },
]
