import type { Certificate, DomainForward, OsProfile, PanelTlsPolicy, RenderedFile } from '@xpanel/core'
import { validateDomainForwards, validatePanelTlsPolicy } from '@xpanel/core'
import { certPaths, XP_PATHS } from './paths.ts'
import { nginxQuote } from './quote.ts'

/** cPanel Domain Forwarding: each forward owns one pool address, so the 301 needs no hosted site for the domain. A certificate adds the same 301 on 443. */
export const domainForwardsFile = (forwards: readonly DomainForward[], os: OsProfile, certificates: readonly Pick<Certificate, 'id' | 'accountId' | 'names'>[] = []): RenderedFile => ({
  path: `${os.paths.nginxVhostDir}/001-xpanel-domain-forwards.conf`,
  content: `# Managed by xPanel: WHM Domain Forwarding\n${validateDomainForwards(forwards).map(forward => {
    const target = nginxQuote(forward.url, 'forward target'), certificate = certificates.find(item => item.accountId === null && item.names.includes(forward.domain))
    const files = certificate ? certPaths(certificate.id) : null
    return `server {
    listen ${forward.ip}:80;
    server_name ${forward.domain};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {
        alias ${XP_PATHS.acmeDir}/;
        default_type text/plain;
    }
    location / {
        return 301 ${target};
    }
}
${files ? `server {
    listen ${forward.ip}:443 ssl;
    server_name ${forward.domain};
    ssl_certificate ${files.cert};
    ssl_certificate_key ${files.key};
    access_log off;
    return 301 ${target};
}
` : ''}`
  }).join('')}`,
  mode: 0o644, owner: 'root', group: 'root',
})

export const PANEL_TLS_POLICY_PATH = '/etc/nginx/xpanel-management/tls-policy.conf'
/** scripts/management-tls.mjs writes the default with this marker and leaves a saved policy in place. */
export const panelTlsPolicyFile = (policy: PanelTlsPolicy): RenderedFile => {
  const { protocols, ciphers } = validatePanelTlsPolicy(policy)
  return { path: PANEL_TLS_POLICY_PATH, content: `# Managed by xPanel management TLS lifecycle v1.\nssl_protocols ${protocols.join(' ')};\nssl_ciphers ${ciphers};\nssl_prefer_server_ciphers on;\n`, mode: 0o644, owner: 'root', group: 'root' }
}
