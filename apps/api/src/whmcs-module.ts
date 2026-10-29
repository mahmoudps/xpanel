/** Path the WHMCS administrator installs the generated module at, relative to the WHMCS root. */
export const WHMCS_MODULE_PATH = 'modules/servers/xpanel/xpanel.php'
export const WHMCS_MODULE_FILENAME = 'xpanel.php'
/** The one provisioning endpoint every module function calls (apps/api/src/whmcs-integration.ts). */
export const WHMCS_PROVISION_PATH = '/api/integrations/whmcs/provision'

/**
 * WHMCS server module source. It holds no secret: WHMCS supplies the API identifier (server Username)
 * and the API token (server Access Hash) on every call, and TLS verification stays on.
 */
export function renderWhmcsModule(): string {
  return `<?php
/**
 * xPanel provisioning module for WHMCS.
 *
 * Install this file as ${WHMCS_MODULE_PATH} in WHMCS. It holds no secret.
 * WHMCS server settings: Hostname = the xWHM host name, Port = the xWHM port (2087),
 * Secure = on, Username = the xPanel API identifier, Access Hash = the xPanel API token.
 * Product setting: "xPanel package" = a package name mapped to an xPanel plan in xWHM.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

function xpanel_MetaData()
{
    return array(
        'DisplayName' => 'xPanel',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'DefaultSSLPort' => '2087',
        'DefaultNonSSLPort' => '2087',
    );
}

function xpanel_ConfigOptions()
{
    return array(
        'xPanel package' => array(
            'Type' => 'text',
            'Size' => '32',
            'Description' => 'A package name mapped to an xPanel plan on the WHMCS page of xWHM.',
        ),
    );
}

function xpanel_Limit($value, $length)
{
    $value = (string) $value;
    return function_exists('mb_substr') ? mb_substr($value, 0, $length, 'UTF-8') : substr($value, 0, $length);
}

function xpanel_Call(array $params, array $payload)
{
    if (empty($params['serversecure'])) {
        return 'Turn on Secure (HTTPS) for this server in WHMCS. xPanel accepts provisioning calls over HTTPS only.';
    }
    $host = trim((string) $params['serverhostname']);
    if ($host === '') {
        $host = trim((string) $params['serverip']);
    }
    $port = (int) $params['serverport'];
    if ($port <= 0 || $port > 65535) {
        $port = 2087;
    }
    $identifier = trim((string) $params['serverusername']);
    $token = trim((string) $params['serveraccesshash']);
    if ($host === '' || $identifier === '' || $token === '') {
        return 'Set the host name, the xPanel API identifier as Username and the xPanel API token as Access Hash for this server in WHMCS.';
    }
    if (strpos($host, ':') !== false && $host[0] !== '[') {
        $host = '[' . $host . ']';
    }
    $body = json_encode($payload);
    if ($body === false) {
        return 'The request could not be encoded as JSON.';
    }
    $curl = curl_init('https://' . $host . ':' . $port . '${WHMCS_PROVISION_PATH}');
    curl_setopt_array($curl, array(
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 180,
        CURLOPT_HTTPHEADER => array(
            'Content-Type: application/json',
            'Accept: application/json',
            'Authorization: Bearer ' . $token,
            'X-Xpanel-Whmcs-Id: ' . $identifier,
        ),
    ));
    $response = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    $logged = $payload;
    $hidden = array($token);
    if (isset($payload['password'])) {
        $logged['password'] = '********';
        $hidden[] = $payload['password'];
    }
    logModuleCall('xpanel', $payload['action'], $logged, $response === false ? $error : $response, null, $hidden);
    if ($response === false) {
        return 'xPanel could not be reached: ' . $error;
    }
    $decoded = json_decode($response, true);
    if ($status >= 200 && $status < 300 && is_array($decoded) && isset($decoded['ok']) && $decoded['ok'] === true) {
        return 'success';
    }
    if (is_array($decoded) && isset($decoded['detail']) && is_string($decoded['detail'])) {
        return 'xPanel refused the request (HTTP ' . $status . '): ' . $decoded['detail'];
    }
    return 'xPanel returned an unexpected answer (HTTP ' . $status . ').';
}

function xpanel_TestConnection(array $params)
{
    $result = xpanel_Call($params, array('action' => 'test'));
    return $result === 'success' ? array('success' => true, 'error' => '') : array('success' => false, 'error' => $result);
}

function xpanel_CreateAccount(array $params)
{
    $payload = array(
        'action' => 'create',
        'username' => (string) $params['username'],
        'domain' => (string) $params['domain'],
        'package' => trim((string) $params['configoption1']),
        'password' => (string) $params['password'],
    );
    if (!empty($params['clientsdetails']['email'])) {
        $payload['contactEmail'] = (string) $params['clientsdetails']['email'];
    }
    return xpanel_Call($params, $payload);
}

function xpanel_SuspendAccount(array $params)
{
    $payload = array('action' => 'suspend', 'username' => (string) $params['username']);
    if (!empty($params['suspendreason'])) {
        $payload['reason'] = xpanel_Limit($params['suspendreason'], 200);
    }
    return xpanel_Call($params, $payload);
}

function xpanel_UnsuspendAccount(array $params)
{
    return xpanel_Call($params, array('action' => 'unsuspend', 'username' => (string) $params['username']));
}

function xpanel_TerminateAccount(array $params)
{
    return xpanel_Call($params, array('action' => 'terminate', 'username' => (string) $params['username']));
}

function xpanel_ChangePackage(array $params)
{
    return xpanel_Call($params, array(
        'action' => 'change_package',
        'username' => (string) $params['username'],
        'package' => trim((string) $params['configoption1']),
    ));
}
`
}
