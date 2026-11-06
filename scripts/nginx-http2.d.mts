export type NginxHttp2Style = 'listen' | 'directive'
export const NGINX_HTTP2_STYLES: readonly NginxHttp2Style[]
export function nginxHttp2Style(versionOutput: string): NginxHttp2Style | null
