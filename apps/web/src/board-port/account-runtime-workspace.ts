import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

type Kind = 'apps' | 'containers' | 'cache'
const STYLE = '<style>[data-runtime-workspace] pre{margin:0;max-block-size:320px;overflow:auto;padding:12px;border:1px solid var(--xp-border);border-radius:8px;font-family:var(--xp-font-mono);font-size:var(--xp-type-label);white-space:pre-wrap;overflow-wrap:anywhere}[data-runtime-workspace] [role=tablist]{display:flex;flex-wrap:wrap;gap:8px;border-block-end:1px solid var(--xp-border)}[data-runtime-workspace] [role=tab][aria-selected=true]{border-block-end:2px solid var(--xp-accent)}[data-runtime-workspace] bdi[dir=ltr]{font-family:var(--xp-font-mono)}@media(min-width:768px){:is([data-runtime-workspace=containers],[data-runtime-workspace=cache]) .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>'

/** Shared frame of the account runtime pages; account-runtime-client.ts binds every control inside it. */
function frame(kind: Kind, lang: Locale, canManage: boolean, body: string): string {
  return `<div class="xp-acct-tool" data-runtime-workspace="${kind}" data-runtime-can-manage="${canManage}" lang="${lang}" dir="${localeDirection(lang)}">${ACCOUNT_TOOL_STYLE}${STYLE}${body}</div>`
}
const status = (text: string): string => `<p data-runtime-status role="status" data-state="unread">${text}</p>`
const table = (heads: string[], key: string, empty: string): string => `<div class="xp-acct-tool__table"><table><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody data-runtime-${key}><tr><td colspan="${heads.length}">${empty}</td></tr></tbody></table></div>`
const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-field"><label class="xp-label" for="${id}">${label}</label>${control}${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
const textInput = (id: string, key: string, extra = ''): string => `<input id="${id}" class="xp-input" data-runtime-input="${key}" dir="ltr" autocomplete="off" disabled${extra}>`
const button = (key: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-runtime-action="${key}" disabled>${label}</button>`
const envEditor = (heads: string[], empty: string, add: string): string => `${table(heads, 'env', empty)}<div class="xp-acct-tool__actions">${button('env-add', add)}</div>`

/** /software/apps: Node.js, Python and Ruby apps of the account, below the signed-catalog section. */
export function renderRuntimeAppsSection(input: { lang: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const fact = (kind: string, label: string): string => `<div><dt>${label}</dt><dd data-runtime-version="${kind}">${t('Not read')}</dd></div>`
  return frame('apps', input.lang, input.canManage, `<section class="xp-acct-tool__card" aria-labelledby="runtime-apps-heading"><h2 id="runtime-apps-heading">${t('Node.js, Python and Ruby applications')}</h2>
    <p>${t('Apps that sit in your home directory, run as your account inside its slice and are served on a domain path behind Nginx. Nothing listens on a network port.')}</p>
    <dl class="xp-acct-tool__facts">${fact('node', 'Node.js')}${fact('python', t('Python (WSGI)'))}${fact('ruby', t('Ruby (Rack)'))}</dl>
    ${status(t('Applications have not been read.'))}
    ${table([t('Application'), t('Runtime'), t('Served at'), t('State'), t('Health'), t('Actions')], 'apps', t('No application has been read.'))}
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-runtime-refresh${input.canManage ? '' : ' disabled'}>${t('Read applications')}</button>${button('app-new', t('Create application'), true)}</div>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="runtime-setup-heading" data-runtime-setup hidden><h2 id="runtime-setup-heading">${t('Application setup')}</h2>
    <div role="tablist" aria-label="${t('Application setup')}">${[['settings', t('Settings')], ['variables', t('Variables')], ['deploy', t('Deployment')], ['logs', t('Logs')]].map(([key, label], i) => `<button type="button" role="tab" class="xp-btn xp-btn--ghost" id="runtime-tab-${key}" aria-controls="runtime-panel-${key}" aria-selected="${i === 0}" data-runtime-tab="${key}">${label}</button>`).join('')}</div>
    <div role="tabpanel" id="runtime-panel-settings" aria-labelledby="runtime-tab-settings" data-runtime-panel="settings"><div class="xp-acct-tool__fields">
      ${field('runtime-kind', t('Runtime'), `<select id="runtime-kind" class="xp-select" data-runtime-input="runtime" disabled><option value="node">Node.js</option><option value="python">${t('Python (WSGI)')}</option><option value="ruby">${t('Ruby (Rack)')}</option></select>`)}
      ${field('runtime-name', t('Application name'), textInput('runtime-name', 'name', ' maxlength="32"'), t('Lowercase letters, digits and inner dashes.'))}
      ${field('runtime-root', t('Application root'), textInput('runtime-root', 'root', ' maxlength="512"'), t('A folder inside your home directory, for example apps/shop.'))}
      ${field('runtime-startup', t('Startup file'), textInput('runtime-startup', 'startup', ' maxlength="255"'), t('Node.js: the file that listens on PORT. Python: a file that defines application. Ruby: config.ru with puma in the Gemfile.'))}
      ${field('runtime-domain', t('Domain'), '<select id="runtime-domain" class="xp-select" data-runtime-input="domain" disabled></select>')}
      ${field('runtime-path', t('URL path'), textInput('runtime-path', 'path', ' maxlength="255" value="/"'), t('/ serves the whole site; a path such as /api serves only that path.'))}
    </div><p class="xp-help">${t('The app runs as your account and counts toward your plan limits. A new application is saved stopped: install its dependencies, then start it.')}</p>
    <div class="xp-acct-tool__actions">${button('app-save', t('Save changes'), true)}</div></div>
    <div role="tabpanel" id="runtime-panel-variables" aria-labelledby="runtime-tab-variables" data-runtime-panel="variables" hidden><p>${t('Passed to the application process when it starts. Save the application to apply them.')}</p>${envEditor([t('Name'), t('Value'), t('Actions')], t('No variables.'), t('Add variable'))}</div>
    <div role="tabpanel" id="runtime-panel-deploy" aria-labelledby="runtime-tab-deploy" data-runtime-panel="deploy" hidden><p>${t('Installed in the application root as your account with the runtime’s own tool: npm install, pip install -r requirements.txt into .venv, or bundle install.')}</p>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Last dependency install')}</dt><dd data-runtime-deps>${t('Not read')}</dd></div></dl>
      <div data-runtime-preflight role="status"><p>${t('Readiness has not been checked.')}</p></div>
      <div class="xp-acct-tool__actions">${button('app-deps', t('Install dependencies'))}</div></div>
    <div role="tabpanel" id="runtime-panel-logs" aria-labelledby="runtime-tab-logs" data-runtime-panel="logs" hidden><div class="xp-acct-tool__actions">${button('app-log', t('Read application log'))}${button('deps-log', t('Read install log'))}</div>
      <pre data-runtime-log dir="ltr">${t('No log has been read.')}</pre></div>
  </section>`)
}

/** /software/containers: rootless Podman containers of the account. */
export function renderAccountContainersWorkspace(input: { lang: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const stat = (key: string, label: string): string => `<div><dt>${label}</dt><dd data-runtime-stat="${key}">${t('Not read')}</dd></div>`
  return frame('containers', input.lang, input.canManage, `<section class="xp-acct-tool__card" aria-labelledby="runtime-ctr-heading"><h2 id="runtime-ctr-heading">${t('Containers')}</h2>
    <p>${t('Rootless Podman containers that run as your account inside its slice, with your plan’s memory, CPU and process limits. No port is published, so no other account can reach them.')}</p>
    <dl class="xp-acct-tool__facts">${stat('engine', t('Engine'))}${stat('count', t('Containers'))}${stat('memory', t('Memory'))}${stat('limits', t('Plan limits'))}${stat('cleanup', t('Image cleanup'))}</dl>
    ${status(t('Containers have not been read.'))}
    ${table([t('Container'), t('Image'), t('State'), t('Running since (UTC)'), t('Ports'), t('Actions')], 'containers', t('No containers have been read.'))}
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-runtime-refresh${input.canManage ? '' : ' disabled'}>${t('Read containers')}</button>${button('ctr-prune', t('Reclaim image space'))}</div>
    <p class="xp-help">${t('Images count toward your disk quota. Removing a container removes its image when no other container uses it; Reclaim image space removes every image no running container uses, and a stopped container pulls its image again when it starts.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="runtime-run-heading"><h2 id="runtime-run-heading">${t('Run container')}</h2>
    <div class="xp-acct-tool__fields">${field('runtime-ctr-name', t('Container name'), textInput('runtime-ctr-name', 'name', ' maxlength="32"'))}
      ${field('runtime-ctr-image', t('Image'), textInput('runtime-ctr-image', 'image', ' maxlength="255" placeholder="docker.io/library/redis:7"'), t('From docker.io, quay.io or ghcr.io, with a tag or digest.'))}</div>
    ${envEditor([t('Name'), t('Value'), t('Actions')], t('No variables.'), t('Add variable'))}
    <div class="xp-acct-tool__actions">${button('ctr-run', t('Run container'), true)}</div>
    <p class="xp-help">${t('Compose stacks, one-click container apps and publishing a container on a domain are unavailable. Nothing else is created here.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="runtime-ctr-log-heading"><h2 id="runtime-ctr-log-heading">${t('Container log')}</h2><pre data-runtime-log dir="ltr">${t('No log has been read.')}</pre></section>`)
}

/** /software/cache: the account's private Redis and Memcached. */
export function renderAccountCacheWorkspace(input: { lang: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const stat = (key: string, label: string): string => `<div><dt>${label}</dt><dd data-runtime-stat="${key}">${t('Not read')}</dd></div>`
  return frame('cache', input.lang, input.canManage, `<section class="xp-acct-tool__card" aria-labelledby="runtime-cache-heading"><h2 id="runtime-cache-heading">${t('Redis & Memcached')}</h2>
    <p>${t('A private cache for your account on a socket in your home directory. It runs as your account, keeps nothing on disk and no other account can connect to it.')}</p>
    <dl class="xp-acct-tool__facts">${stat('redis', 'Redis')}${stat('memcached', 'Memcached')}${stat('memory', t('Memory used'))}${stat('cap', t('Plan cache limit'))}</dl>
    ${status(t('Cache services have not been read.'))}
    ${table([t('Service'), t('Status'), t('Version'), t('Connection'), t('Memory limit'), t('Actions')], 'cache', t('No cache service has been read.'))}
    <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-runtime-refresh${input.canManage ? '' : ' disabled'}>${t('Read cache services')}</button></div>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="runtime-cache-settings"><h2 id="runtime-cache-settings">${t('Cache settings')}</h2>
    <div class="xp-acct-tool__fields">${field('runtime-cache-service', t('Service'), '<select id="runtime-cache-service" class="xp-select" data-runtime-input="service" disabled><option value="redis">Redis</option><option value="memcached">Memcached</option></select>')}
      ${field('runtime-cache-memory', t('Memory limit (MB)'), textInput('runtime-cache-memory', 'memory', ' type="number" min="8" step="1"'))}
      ${field('runtime-cache-socket', t('Connection'), '<input id="runtime-cache-socket" class="xp-input" data-runtime-input="socket" dir="ltr" readonly>', t('Point your application at this unix socket.'))}</div>
    <div class="xp-acct-tool__actions">${button('cache-flush', t('Flush cache'))}${button('cache-save', t('Save settings'), true)}</div>
    <p class="xp-help">${t('Flushing restarts the service empty. Server-wide Redis and Memcached are run by your server administrator; this page does not connect to them.')}</p>
  </section>
  <section class="xp-acct-tool__card" aria-labelledby="runtime-cache-log-heading"><h2 id="runtime-cache-log-heading">${t('Service log')}</h2><pre data-runtime-log dir="ltr">${t('No log has been read.')}</pre></section>`)
}
