/** The native dialog preserves browser focus containment while keeping all presentation in V2. */
export const V2_PROMPT_TEMPLATE = `<template data-xp-template="prompt-dialog"><dialog class="v2-prompt" data-xp-prompt aria-labelledby="v2-prompt-title" aria-describedby="v2-prompt-body"><form method="dialog" data-xp-slot="form"><div class="v2-prompt__head"><h2 id="v2-prompt-title" data-xp-prompt-title data-xp-slot="title"></h2><p id="v2-prompt-body" data-xp-prompt-body data-xp-slot="body"></p></div><div class="v2-field v2-prompt__field" data-xp-prompt-field data-xp-slot="field"><label for="v2-prompt-input" data-xp-prompt-label data-xp-slot="label"></label><input id="v2-prompt-input" data-xp-prompt-input data-xp-slot="input" autocomplete="off"></div><div class="v2-prompt__foot"><button type="button" class="v2-btn" value="cancel" data-xp-prompt-cancel data-xp-slot="cancel"></button><button type="submit" class="v2-btn v2-btn--primary" value="confirm" data-xp-prompt-confirm data-xp-slot="confirm"></button></div></form></dialog></template>`

export const V2_PROMPT_CSS = `.v2-prompt{position:fixed;inset:0;margin:auto;inline-size:min(520px,calc(100% - 32px));max-block-size:calc(100dvh - 32px);padding:var(--v2-panel-padding);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text);box-shadow:var(--v2-elev);overflow:auto}
.v2-prompt:not([open]){display:none}
.v2-prompt::backdrop{background:var(--scrim);backdrop-filter:blur(2px)}
.v2-prompt>form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-prompt__head{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;padding-block-end:var(--space-1);border-block-end:1px solid var(--line);overflow-wrap:anywhere}
.v2-prompt__head>h2{font-size:18px}
.v2-prompt__head>p{line-height:1.6;color:var(--muted)}
.v2-prompt__head code{padding:2px 6px;border-radius:var(--radius-chip);background:var(--subtle);color:var(--text)}
.v2-prompt__foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--space-2);padding-block-start:var(--space-1);border-block-start:1px solid var(--line)}
.v2-prompt[data-prompt-tone="danger"] [data-xp-prompt-confirm]{background:var(--bad);border-color:var(--bad);color:var(--surface)}`
