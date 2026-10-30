import { xpTemplate } from '../../../html.ts'

function rowTemplate(name: 'file-row' | 'trash-row'): string {
  return xpTemplate(name, '<tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="name"></bdi></td><td data-xp-slot="kind"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="size"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="mode"></bdi></td><td><time dir="ltr" class="v2-mono v2-file-time" data-xp-slot="modified"></time></td><td data-xp-slot="actions"></td></tr>')
}

/** Core clones these nodes and fills their text slots after validating an authorized API response. */
export function fileWorkspaceTemplates(): string {
  return [
    rowTemplate('file-row'),
    xpTemplate('file-action', '<button type="button" class="v2-btn" data-xp-slot="label"></button>'),
    xpTemplate('file-empty-row', '<tr><td colspan="6" data-xp-slot="message"></td></tr>'),
    rowTemplate('trash-row'),
    xpTemplate('trash-action', '<button type="button" class="v2-btn" data-xp-slot="label"></button>'),
    xpTemplate('trash-purge-action', '<button type="button" class="v2-btn v2-file-purge" data-xp-slot="label"></button>'),
  ].join('')
}
