/** Hidden fragments owned by the V2 mailbox presentation. */
export function v2MailClientTemplates(kind: string): string {
  const template = (name: string, body: string): string => `<template data-xp-template="${name}">${body}</template>`
  const button = (name: string): string => template(name, '<button type="button" class="v2-btn" data-xp-slot="label"></button>')
  const empty = (name: string, columns: number): string => template(name, `<tr><td colspan="${columns}" data-xp-slot="message"></td></tr>`)
  switch (kind) {
    case 'attachments': return template('mail-attachment-row', '<li><a class="v2-btn v2-mail-attachments__download" data-xp-slot="link" target="_blank" rel="noopener noreferrer" data-attachment-download><span class="v2-mail-attachments__badge" data-xp-slot="badge" aria-hidden="true"></span><span class="v2-mail-attachments__file"><span><bdi dir="auto" data-xp-slot="name"></bdi></span><span class="v2-mail-attachments__size"><bdi dir="ltr" data-xp-slot="size"></bdi></span></span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg></a></li>')
    case 'compose-attachments': return template('mail-compose-attachment-row', '<li><span><span><bdi dir="auto" data-xp-slot="name"></bdi></span><span><bdi dir="ltr" data-xp-slot="size"></bdi></span></span><button type="button" class="v2-btn" data-xp-slot="remove"></button></li>') + button('mail-compose-attachment-dismiss')
    case 'search': return template('mail-search-row', '<li><button type="button" class="v2-btn v2-mail-search__result" data-xp-slot="open"><strong dir="auto" data-xp-slot="subject"></strong><bdi dir="auto" data-xp-slot="sender"></bdi><bdi dir="ltr" data-xp-slot="date"></bdi><span dir="auto" data-xp-slot="preview"></span></button></li>')
    case 'forwarders': return template('mail-forwarder-row', '<tr><td><bdi dir="ltr" data-xp-slot="address"></bdi></td><td><button type="button" class="v2-btn" data-xp-slot="remove"></button></td></tr>') + empty('mail-forwarder-empty', 2)
    case 'identities': return template('mail-identity-card', '<article class="v2-mail-identities__row"><header><strong data-xp-slot="name"></strong><span class="v2-muted" data-xp-slot="badge"></span></header><dl data-xp-slot="facts"></dl><div class="v2-mail-identities__actions" data-xp-slot="actions"></div></article>') + template('mail-identity-fact', '<div class="v2-mail-identities__datum"><dt data-xp-slot="label"></dt><dd><bdi data-xp-slot="value" dir="ltr"></bdi></dd></div>') + button('mail-identity-action') + template('mail-identity-empty', '<p class="v2-muted" data-xp-slot="message"></p>')
    case 'contacts': return template('mail-contact-row', '<tr><td><button type="button" class="v2-btn" data-xp-slot="select"></button></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="email"></bdi></td><td data-xp-slot="organization"></td><td data-xp-slot="access"></td></tr>') + empty('mail-contact-empty', 4)
    case 'contact-tools': return template('mail-contact-share', '<li><span><bdi dir="ltr" class="v2-mono" data-xp-slot="address"></bdi><span data-xp-slot="permission"></span></span><button type="button" class="v2-btn" data-xp-slot="remove"></button></li>') + template('mail-contact-share-empty', '<li data-xp-slot="message"></li>')
    case 'calendar-settings': return template('mail-calendar-share', '<li><span><bdi dir="ltr" data-xp-slot="address"></bdi><span data-xp-slot="permission"></span></span><button type="button" class="v2-btn" data-xp-slot="remove"></button></li>') + template('mail-calendar-share-empty', '<li data-xp-slot="message"></li>')
    case 'folders': return template('mail-folder-admin-row', '<tr><td><div class="v2-mail-folders__name" data-xp-slot="tree"><strong><bdi dir="auto" data-xp-slot="name"></bdi></strong><span class="v2-muted" data-xp-slot="system" hidden></span><span class="v2-muted" data-xp-slot="raw" hidden></span></div></td><td><bdi dir="ltr" data-xp-slot="messages"></bdi></td><td><bdi dir="ltr" data-xp-slot="unseen"></bdi></td><td><input type="checkbox" data-xp-slot="subscription" data-mail-folders-subscribe><span data-xp-slot="unknown" hidden></span></td><td><span data-xp-slot="protected" hidden></span><div class="v2-mail-folders__row-actions" data-xp-slot="actions"></div></td></tr>') + button('mail-folder-admin-action') + empty('mail-folder-admin-empty', 5)
    case 'mailing-lists': return template('mail-membership-row', '<tr><td><bdi dir="ltr" data-xp-slot="address"></bdi></td><td data-xp-slot="name"></td><td data-xp-slot="observed"></td><td data-xp-slot="subscription"></td><td data-xp-slot="posting"></td><td data-xp-slot="membership"></td><td><button type="button" class="v2-btn" data-xp-slot="action"></button></td></tr>') + empty('mail-membership-empty', 7)
    case 'preferences': return template('mail-preferences-technical', '<bdi dir="ltr" class="v2-mono"></bdi>')
    case 'vacation': return template('mail-vacation-technical', '<bdi dir="ltr" class="v2-mono"></bdi>')
    case 'folder-workspace': return template('mail-folder-filter-empty', '<p class="v2-mail-filter-empty" data-mail-filter-empty role="status"></p>') + template('mail-folder-move-menu', '<ul class="v2-mail-move-menu" id="move-list" data-mail-move="true"></ul>') + template('mail-folder-move-choice', '<li><button type="button" data-mail-action="move" data-xp-slot="label"></button></li>') + template('mail-folder-attachment-info', '<li><button type="button" class="v2-btn" disabled data-xp-slot="button"><span data-xp-slot="badge" aria-hidden="true"></span><span><bdi dir="auto" data-xp-slot="name"></bdi><bdi dir="ltr" data-xp-slot="size"></bdi></span></button></li>')
    case 'track': return template('mail-track-row', '<tr><td><bdi dir="ltr" data-xp-slot="time"></bdi></td><td data-xp-slot="direction"></td><td data-xp-slot="counterpart"></td><td data-xp-slot="status"></td><td><bdi dir="ltr" data-xp-slot="dsn"></bdi></td><td><button type="button" class="v2-btn" data-xp-slot="view"></button></td></tr>') + empty('mail-track-empty', 6)
    case 'calendar-view': return [
      ['calview-row', '<div class="v2-mail-calview__row" role="row"></div>'], ['calview-head', '<div class="v2-mail-calview__head" role="columnheader"></div>'], ['calview-day', '<div class="v2-mail-calview__day" role="gridcell"></div>'],
      ['calview-week', '<div class="v2-mail-calview__week"></div>'], ['calview-gutter', '<div class="v2-mail-calview__gutter"></div>'], ['calview-timeline', '<div class="v2-mail-calview__timeline"></div>'], ['calview-chip', '<button type="button" class="v2-mail-calview__chip"></button>'],
      ['calview-long', '<span class="v2-mail-calview__long"></span>'], ['calview-short', '<span class="v2-mail-calview__short"></span>'], ['calview-more', '<span class="v2-mail-calview__more"></span>'], ['calview-swatch', '<span class="v2-mail-calview__swatch"></span>'], ['calview-help', '<span class="v2-muted"></span>'], ['calview-empty', '<li class="v2-muted"></li>'], ['calview-notes', '<dd class="v2-mail-calview__notes"></dd>'], ['calview-date', '<bdi dir="ltr" class="v2-mail-calview__date"></bdi>'],
    ].map(([name, body]) => template(name!, body!)).join('')
    default: throw new Error('unknown_mail_client_template_kind')
  }
}

/** Trusted renderer hooks identify the controller that owns this specific fragment. */
export function v2MailClientTemplatesForHooks(hooks?: object): string {
  if (!hooks) return ''
  const kinds: readonly (readonly [string, string])[] = [
    ['data-mail-preferences', 'preferences'], ['data-mail-forwarders', 'forwarders'], ['data-mail-identities', 'identities'],
    ['data-mail-folders', 'folders'], ['data-mail-search-workspace', 'search'], ['data-mail-mailing-lists', 'mailing-lists'],
    ['data-mail-track-delivery', 'track'], ['data-mail-calendar', 'calendar-settings'], ['data-mail-calendar-view', 'calendar-view'],
    ['data-mail-contacts-tools', 'contact-tools'], ['data-mail-vacation', 'vacation'],
  ]
  return kinds.filter(([hook]) => Object.hasOwn(hooks, hook)).map(([, kind]) => v2MailClientTemplates(kind)).join('')
}

export const V2_MAIL_DYNAMIC_CSS = `.v2-mail-reading-fragment{display:contents}
.v2-mail-attachment-row,.v2-mail-compose-attachments li{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);min-inline-size:0}
.v2-mail-attachments__download{display:flex;gap:var(--space-2);max-inline-size:100%;text-align:start;white-space:normal;padding:var(--space-1) 12px}
.v2-mail-attachments__badge{display:grid;place-items:center;flex:none;inline-size:34px;block-size:34px;border-radius:8px;background:var(--subtle);font:600 10px var(--font-mono)}
.v2-mail-attachments__file{display:grid;gap:var(--space-1);min-inline-size:0;flex:1;overflow-wrap:anywhere;text-align:start}
.v2-mail-attachments__size{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
.v2-mail-compose-attachments li>span{display:grid;gap:var(--space-1);flex:1;min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-compose-attachments li>span>span{display:block}
.v2-mail-identities__row{display:grid;gap:var(--space-3);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-mail-identities__row>header,.v2-mail-identities__actions,.v2-mail-folders__row-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-identities__row>header{justify-content:space-between}
.v2-mail-identities__row dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2)}
.v2-mail-identities__datum{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-mail-identities__datum dt{font-size:12px;color:var(--muted)}
.v2-mail-identities__datum :is(dd,bdi){min-inline-size:0;overflow-wrap:anywhere;max-inline-size:100%;white-space:normal}
.v2-mail-folders__name{display:grid;gap:var(--space-1);padding-inline-start:calc(var(--mail-folder-depth,0)*16px)}
.v2-mail-search__result{display:grid;gap:var(--space-1);inline-size:100%;padding:var(--space-2);white-space:normal;text-align:start;justify-items:start;overflow-wrap:anywhere}
.v2-mail-search__result>[data-xp-slot=preview]{font-weight:400;color:var(--muted)}
.v2-mail-filter-empty{margin:0;padding:var(--space-4) var(--v2-panel-padding);font-size:14px;line-height:1.75;text-align:center}
.v2-mail-move{position:relative}
.v2-mail-move-menu{position:absolute;inset-block-start:50px;inset-inline-start:0;z-index:2;list-style:none;margin:0;padding:var(--space-1);min-inline-size:200px;max-inline-size:calc(100vw - 48px);border-radius:var(--radius-control);border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow);display:flex;flex-direction:column;gap:2px}
.v2-mail-move-menu button{inline-size:100%;min-block-size:44px;padding:0 12px;border:none;background:transparent;font:inherit;text-align:start;color:var(--text)}
.v2-mail-move-menu button:hover{background:var(--subtle)}
[data-ui-theme="v2"] [data-mail-calendar-view] [data-calview-grid]{display:flex;flex-direction:column;min-inline-size:640px}
.v2-mail-calview__row{display:grid;grid-template-columns:36px repeat(7,minmax(0,1fr))}
.v2-mail-calview__head{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-1);font-size:12px;font-weight:600;background:var(--subtle);border-inline-start:1px solid var(--line);min-inline-size:0}
.v2-mail-calview__short{display:none}
.v2-mail-calview__day{display:flex;flex-direction:column;gap:4px;min-block-size:128px;padding:var(--space-1);border-block-start:1px solid var(--line);border-inline-start:1px solid var(--line);min-inline-size:0;outline-offset:-2px}
.v2-mail-calview__day[data-outside=true]{background:var(--sunken);color:var(--muted)}
.v2-mail-calview__day[aria-current=date]{background:var(--accent-soft)}
.v2-mail-calview__day[aria-selected=true]{box-shadow:inset 0 0 0 2px var(--focus)}
.v2-mail-calview__date{font-size:12px;font-variant-numeric:tabular-nums}
.v2-mail-calview__week,.v2-mail-calview__gutter{background:var(--subtle);padding:var(--space-1) 4px;font-size:10px;color:var(--muted);text-align:center}
.v2-mail-calview__chip{display:flex;align-items:start;gap:4px;border:1px solid var(--line);border-inline-start:3px solid var(--calview-chip,var(--accent));border-radius:4px;background:var(--surface);color:var(--text);padding:4px;min-inline-size:0;font-size:11px;line-height:1.4;text-align:start;overflow-wrap:anywhere;cursor:pointer}
.v2-mail-calview__chip>span:last-child{min-inline-size:0;overflow:hidden;text-overflow:ellipsis}
.v2-mail-calview__more{font-size:11px;color:var(--muted)}
.v2-mail-calview__swatch{inline-size:12px;block-size:12px;flex:none;border-radius:3px;background:var(--calview-chip,var(--accent))}
.v2-mail-calview__notes{white-space:pre-wrap;overflow-wrap:anywhere}
[data-ui-theme="v2"] [data-calview-grid]:is([data-mode=week],[data-mode=day]) .v2-mail-calview__row{grid-template-columns:48px repeat(var(--calview-days,7),minmax(0,1fr))}
[data-ui-theme="v2"] [data-calview-grid]:is([data-mode=week],[data-mode=day]) .v2-mail-calview__day{padding:0}
[data-ui-theme="v2"] [data-calview-grid]:is([data-mode=week],[data-mode=day]) .v2-mail-calview__gutter{display:grid;grid-template-rows:repeat(24,40px);padding:0 4px}
.v2-mail-calview__timeline{position:relative;block-size:960px;inline-size:100%;background:repeating-linear-gradient(to bottom,transparent 0,transparent 39px,var(--line) 39px,var(--line) 40px)}
.v2-mail-calview__timeline>.v2-mail-calview__chip{position:absolute;inset-block-start:var(--calview-top);block-size:var(--calview-height);inset-inline-start:var(--calview-start);inline-size:var(--calview-width);overflow:hidden;min-block-size:12px}
@media(max-width:600px){.v2-mail-calview__long{display:none}.v2-mail-calview__short{display:inline}.v2-mail-identities__row dl{grid-template-columns:minmax(0,1fr)}}
`
