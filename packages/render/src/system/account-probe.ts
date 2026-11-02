import { fail, type Account, type HostAction, type RenderedFile } from '@xpanel/core'
import { assertAccountId, assertAccountHome, assertHomeBase, assertUsername } from './validate.ts'

export const ACCOUNT_PROBE_ROUTE = '/.well-known/xpanel-provisioning'
/**
 * How long the canary holds its request waiting for release. The agent verifies the held request with many
 * full authority and host checks, which take seconds on a small host; the agent and nginx budgets derive from this.
 */
export const ACCOUNT_PROBE_HOLD_SECONDS = 45
export const ACCOUNT_PROBE_ASSET_DIR = '/etc/xpanel/account-probe'
export const ACCOUNT_PROBE_ASSET = ACCOUNT_PROBE_ASSET_DIR + '/probe.php'
export const ACCOUNT_PROBE_RUNTIME = '/run/xpanel-account-probe'
export const accountProbePaths = (account: Pick<Account, 'username' | 'uid' | 'home'>) => {
  // Formatting an already-admitted account must preserve its approved custom home base.
  const uid = assertAccountId('uid', account.uid), name = assertUsername(account.username)
  const base = assertHomeBase(account.home.slice(0, account.home.lastIndexOf('/')))
  const { home } = assertAccountHome(account.home, name, [base])
  const runtime = ACCOUNT_PROBE_RUNTIME + '/' + uid, target = home + '/.xpanel-probe'
  return { runtime, target, script: target + '/probe.php', ingress: runtime + '/ingress.sock', callback: runtime + '/callback.sock', callbackInNamespace: target + '/runtime/callback.sock' }
}

/** Immutable source; identity is obtained by Root through kernel credentials, never PHP output. */
export const ACCOUNT_PROBE_PHP = String.raw`<?php
declare(strict_types=1);
function unverified(): void { http_response_code(503); echo "unverified\n"; exit; }
$challenge = $_SERVER['XPANEL_PROBE_CHALLENGE'] ?? '';
$binding = $_SERVER['XPANEL_PROBE_BINDING'] ?? '';
if (!is_string($challenge) || !is_string($binding) || !preg_match('/\A[a-f0-9]{64}\z/D', $challenge) || !preg_match('/\A[a-f0-9]{64}\z/D', $binding)) unverified();
if (($_SERVER['SCRIPT_FILENAME'] ?? '') !== __FILE__ || ($_SERVER['DOCUMENT_ROOT'] ?? '') !== __DIR__) unverified();
// No tenant prepend/append or per-directory configuration is accepted for this request.
if ((string)ini_get('auto_prepend_file') !== '' || (string)ini_get('auto_append_file') !== '' || (string)ini_get('user_ini.filename') !== '' || filter_var(ini_get('opcache.enable'), FILTER_VALIDATE_BOOLEAN)) unverified();
$stream = @stream_socket_client('unix://' . __DIR__ . '/runtime/callback.sock', $errno, $error, 2.0, STREAM_CLIENT_CONNECT);
if (!is_resource($stream)) unverified();
try {
    stream_set_timeout($stream, ${ACCOUNT_PROBE_HOLD_SECONDS});
    $line = json_encode(['schemaVersion' => 1, 'challenge' => $challenge, 'binding' => $binding], JSON_UNESCAPED_SLASHES);
    if (!is_string($line) || strlen($line) > 256) unverified();
    $line .= "\n"; $offset = 0;
    while ($offset < strlen($line)) {
        $written = @fwrite($stream, substr($line, $offset));
        if (!is_int($written) || $written < 1) unverified();
        $offset += $written;
    }
    $prefix = 'XPANEL-PROBE/1 ' . $challenge . "\n";
    http_response_code(200);
    header('Content-Type: text/plain'); header('Cache-Control: no-store');
    header('X-XPanel-Probe-Challenge: ' . $challenge);
    header('Content-Length: ' . (string)(strlen($prefix) + 5));
    echo $prefix; flush();
    $release = @fgets($stream, 16);
    if ($release !== "release\n") exit;
    echo "done\n"; flush();
} finally { fclose($stream); }
`
export const renderAccountProbeAsset = (): RenderedFile => ({ path: ACCOUNT_PROBE_ASSET, content: ACCOUNT_PROBE_PHP, mode: 0o444, owner: 'root', group: 'root' })
export const accountProbeDirectories = (accounts: readonly Pick<Account, 'username' | 'uid' | 'home'>[]): HostAction[] => [
  { kind: 'ensure-dir', path: ACCOUNT_PROBE_ASSET_DIR, mode: 0o755, owner: 'root', group: 'root' },
  { kind: 'ensure-dir', path: ACCOUNT_PROBE_ASSET_DIR + '/runtime', mode: 0o555, owner: 'root', group: 'root' },
  { kind: 'ensure-dir', path: ACCOUNT_PROBE_RUNTIME, mode: 0o711, owner: 'root', group: 'root' },
  ...accounts.map((account): HostAction => ({ kind: 'ensure-dir', path: accountProbePaths(account).runtime, mode: 0o711, owner: 'root', group: 'root' })),
]
export const accountProbeNamespace = (account: Pick<Account, 'username' | 'uid' | 'home'>): string[] => {
  const paths = accountProbePaths(account)
  return [`BindReadOnlyPaths=${ACCOUNT_PROBE_ASSET_DIR}:${paths.target}`, `BindReadOnlyPaths=${paths.runtime}:${paths.target}/runtime`]
}
// The agent admits exactly the seven fastcgi_param values below; nginx would otherwise add every request header as HTTP_*.
export const accountProbeNginxLocation = (account: Pick<Account, 'username' | 'uid' | 'home'>): string[] => [
  `location = ${ACCOUNT_PROBE_ROUTE} {`,
  '    access_log off;', '    gzip off;', '    fastcgi_buffering off;', '    fastcgi_request_buffering off;', '    fastcgi_keep_conn off;',
  '    fastcgi_pass_request_headers off;',
  '    fastcgi_connect_timeout 2s;', `    fastcgi_read_timeout ${ACCOUNT_PROBE_HOLD_SECONDS + 5}s;`, '    fastcgi_send_timeout 5s;',
  '    fastcgi_param REQUEST_METHOD $request_method;', '    fastcgi_param SCRIPT_NAME $uri;',
  '    fastcgi_param REQUEST_URI $request_uri;', '    fastcgi_param SERVER_NAME $server_name;', '    fastcgi_param HTTP_HOST $host;',
  '    fastcgi_param CONTENT_LENGTH $content_length;',
  '    fastcgi_param HTTP_X_XPANEL_PROBE_ADMISSION $http_x_xpanel_probe_admission;',
  `    fastcgi_pass unix:${accountProbePaths(account).ingress};`,
  '}',
]

/** Only the compiler-owned, non-scripted ingress can carry the private admission header. */
export function assertAccountProbeIngress(content: string, account: Pick<Account, 'username' | 'uid' | 'home'>): void {
  const expected = accountProbeNginxLocation(account).map(line => '    ' + line).join('\n')
  // Unknown includes/rewrite/subrequest scripting are unsupported, rather than trusted from file ownership alone.
  if (!content.includes(expected) || content.includes('\\') || /(?:^|[;\r\n{}])\s*(?:include|rewrite|auth_request|mirror|error_page|[A-Za-z_]*by_lua[A-Za-z_]*|js_[A-Za-z_]+|perl)(?=\s|;)/.test(content)) {
    fail('PRECONDITION_FAILED', 'the immutable account probe ingress was not verified', { verificationRequired: true })
  }
}
