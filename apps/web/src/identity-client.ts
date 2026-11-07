/// <reference lib="dom" />
import { passwordStrength } from '@xpanel/core'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { secKit, SEC_CLIENT_TEMPLATE_HELPERS } from './sec-security-client.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Local alias: serialized bindings must not reference imported names (test transforms rewrite them).
const kitOf = secKit
type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Row = Record<string, unknown>

/** A random password of the given length from letters, digits and symbols, without modulo bias. */
export function generatePassword(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@_~'
  const out: string[] = [], byte = new Uint8Array(1)
  while (out.length < length) { crypto.getRandomValues(byte); if (byte[0]! < 256 - (256 % alphabet.length)) out.push(alphabet[byte[0]! % alphabet.length]!) }
  return out.join('')
}

/** The score of the server's password rule, shown while typing. */
export const passwordScore = passwordStrength

/**
 * Identity workspaces: Change Root Password, wheel/sudo members, own security questions and verified addresses,
 * the verified-address policy, linked external identities and root's identity providers. Text-only painting;
 * every change is confirmed and re-read from the server.
 */
function bindIdentity(askDialog: Ask | undefined): void {
  const PAGES = ['root-password', 'admin-group', 'security-questions', 'security-policy', 'external-identities', 'external-providers']
  document.querySelectorAll<HTMLElement>('[data-sec-workspace]').forEach(root => {
    const page = root.dataset.secPage ?? ''
    if (root.dataset.secBound === 'true' || !PAGES.includes(page)) return
    root.dataset.secBound = 'true'
    const k = kitOf(root, askDialog, displayDateTime), t = k.t
    const refresh = k.q<HTMLButtonElement>('[data-sec-action="refresh"]')
    if (!k.admitted()) { for (const control of k.all<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = true; k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    if (!k.prepareTemplates()) return
    const editors = k.all<HTMLInputElement | HTMLSelectElement>('[data-sec-input]'), buttons = k.all<HTMLButtonElement>('[data-sec-action]:not([data-sec-action="refresh"])')
    let loaded = false
    k.controls.push(() => { if (refresh) refresh.disabled = k.isBusy(); const editable = loaded && !k.isBusy() && k.manageable(); for (const node of [...editors, ...buttons]) node.disabled = !editable })
    const value = (key: string): string => k.input(key)?.value ?? ''
    const clear = (...keys: string[]): void => { for (const key of keys) { const node = k.input(key); if (node) node.value = '' } }
    const object = (item: unknown): item is Row => !!item && typeof item === 'object' && !Array.isArray(item)
    const list = (item: unknown): Row[] => Array.isArray(item) ? item.filter(object) : []
    const text = (item: unknown): string => typeof item === 'string' ? item : ''
    const action = (label: string, accessible: string, run: () => void): HTMLElement => k.group(k.actionButton(label, accessible, run, !k.manageable()))
    const failed = (error: unknown): void => { const kind = k.outcome(error); k.show(kind, k.failure(kind)) }
    // Words a user or administrator typed keep their own direction inside either page direction.
    const typed = (item: unknown): HTMLElement => { const node = document.createElement('bdi'); node.textContent = text(item); return node }
    const options = (key: string, items: [string, string][], placeholder: string): void => {
      const select = k.input<HTMLSelectElement>(key)
      if (!select) return
      select.textContent = ''
      for (const [id, label] of [['', placeholder] as [string, string], ...items]) { const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option) }
    }
    let load: () => Promise<void> = async () => undefined, first: (() => Promise<void>) | null = null
    // The provider outcome travels in the query string once; it is dropped so a reload does not repeat it.
    const dropOutcome = (): void => { const url = new URL(window.location.href); url.searchParams.delete('external'); url.searchParams.delete('reason'); history.replaceState(null, '', url.pathname + url.search) }
    const run = (work: () => Promise<void>): Promise<void> => k.guarded(async () => { try { await work() } catch (error) { failed(error) } })

    if (page === 'root-password') {
      const totp = k.q<HTMLElement>('[data-identity-totp]')
      const meter = (): void => { const next = value('password'); k.field('strength', next ? t('{score} of 100', { score: passwordScore(next) }) : t('Nothing entered')) }
      k.input('password')?.addEventListener('input', meter)
      load = () => k.guarded(async () => {
        k.note('reading', t('Reading…'))
        try {
          const view = await k.send('GET', '/api/server/root-password') as Row
          const capability = object(view.capability) ? view.capability : {}
          const secondFactor = capability.secondFactor === 'required'
          if (totp) totp.hidden = !secondFactor
          meter()
          k.field('second-factor', secondFactor ? t('Required: enter a code from your authenticator') : t('Not enrolled'))
          k.field('host', view.host === 'connected' ? t('Connected') : t('No host agent is connected'), view.host === 'connected' ? 'good' : 'warn')
          loaded = view.host === 'connected'
          k.note(loaded ? 'read' : 'unavailable', loaded ? t('Ready. Nothing has been changed.') : t('The root password cannot be changed without the host agent.'))
        } catch (error) { loaded = false; k.note('failed', k.failure(k.outcome(error))) }
      })
      k.q('[data-sec-action="generate"]')?.addEventListener('click', () => {
        const generated = generatePassword(20)
        for (const key of ['password', 'confirmation']) { const node = k.input(key); if (node) { node.value = generated; if (node instanceof HTMLInputElement) node.type = 'text' } }
        meter()
        k.show('read', t('A new password was generated. Copy it to a safe place before you change the password.'))
      })
      k.q('[data-sec-action="change"]')?.addEventListener('click', () => void run(async () => {
        if (value('password') !== value('confirmation')) { k.show('invalid', t('The new password and its confirmation do not match.')); return }
        if (!await k.confirm({ title: t('Change the root password?'), body: t('SSH and su use the new password at once. Your xWHM sign-in password does not change.'), confirm: t('Change root password') })) return
        const body: Row = { currentPassword: value('current-password'), password: value('password'), confirmation: value('confirmation') }
        if (totp && !totp.hidden) body.totpCode = value('totp').trim()
        try {
          const ack = await k.send('POST', '/api/server/root-password', body) as Row
          if (ack.outcome !== 'applied') throw new Error('unexpected')
          k.show('read', t('The root password was changed and the new shadow entry was read back.'))
        } finally { clear('password', 'confirmation', 'current-password', 'totp'); meter() }
      }))
    }

    if (page === 'admin-group') {
      let names = { group: '' }
      const paint = (observation: Row | null, reason: unknown): void => {
        if (!observation) {
          loaded = false
          k.field('group', null); k.field('observed-at', null); k.rows('members', [], t('Group members have not been read.'), 3)
          k.note('unavailable', reason === 'host_agent_unavailable' ? t('No host agent is connected, so the group cannot be read.') : t('The group could not be read from this server.'))
          return
        }
        names = { group: text(observation.group) }
        const state = observation.state
        loaded = state === 'read'
        k.field('group', state === 'unsupported' ? t('Not available on this distribution') : state === 'group_missing' ? t('The {group} group does not exist', { group: names.group }) : names.group)
        k.field('observed-at', k.when(observation.observedAt))
        k.rows('members', list(observation.members).map(member => [k.technical(text(member.username)), member.account === true ? t('Hosting account') : t('Other system user; managed outside the panel'),
          member.account === true ? action(t('Remove'), t('Remove {user} from {group}', { user: text(member.username), group: names.group }), () => void change('remove', text(member.username))) : document.createTextNode('-')]),
          t('The group has no members.'), 3)
        options('account', list(observation.accounts).filter(item => item.member !== true).map(item => [text(item.username), text(item.username)]), t('Select an account'))
        k.note(loaded ? 'read' : 'unavailable', loaded ? t('Read from this server.') : t('Group changes are unavailable on this server.'))
      }
      load = () => k.guarded(async () => {
        k.note('reading', t('Reading…'))
        try { const view = await k.send('GET', '/api/server/sec/admin-group') as Row; paint(object(view.observation) ? view.observation : null, view.reason) } catch (error) { paint(null, null); k.note('failed', k.failure(k.outcome(error))) }
      })
      const change = (kind: 'add' | 'remove', username: string): Promise<void> => run(async () => {
        if (!username) { k.show('invalid', t('Select an account first.')); return }
        if (!await k.confirm(kind === 'add'
          ? { title: t('Give {user} administrator rights?', { user: username }), body: t('Members of {group} can become root: with su and the root password, and with sudo where the sudoers rule allows it. Grant this only to people you trust with the whole server.', { group: names.group }), confirm: t('Add to {group}', { group: names.group }) }
          : { title: t('Remove {user} from {group}?', { user: username, group: names.group }), body: t('The account keeps its files and services; it loses su and sudo to root.'), confirm: t('Remove') })) return
        const ack = await k.send('POST', '/api/server/sec/admin-group', { action: kind, username }) as Row
        paint(object(ack.observation) ? ack.observation : null, null)
        k.show('read', ack.outcome === 'unchanged' ? t('Nothing changed: the group already had this membership.') : kind === 'add' ? t('{user} was added and the group was read back.', { user: username }) : t('{user} was removed and the group was read back.', { user: username }))
      })
      k.q('[data-sec-action="add"]')?.addEventListener('click', () => void change('add', value('account')))
    }

    if (page === 'security-questions') {
      const paint = (view: Row): void => {
        const policy = object(view.policy) ? view.policy : {}, client = object(view.client) ? view.client : {}, questions = list(view.questions)
        loaded = true
        k.field('policy', policy.verifiedIpSignIn === true ? t('On: sign-in from an unverified address asks these questions') : t('Off: no sign-in asks these questions'), policy.verifiedIpSignIn === true ? 'good' : 'neutral')
        k.field('client', client.address ? (client.verified === true ? t('{address} (verified)', { address: text(client.address) }) : t('{address} (not verified)', { address: text(client.address) })) : t('Not known'))
        k.field('count', questions.length ? t('{count} questions set', { count: questions.length }) : t('No questions set'))
        k.rows('questions', questions.map(item => [String(item.position), typed(item.question)]), t('No security questions are set.'), 2)
        k.rows('addresses', list(view.addresses).map(item => [k.technical(text(item.address)), item.source === 'answered' ? t('Answered from this address') : t('Added by you'), k.when(item.createdAt) ?? '-',
          action(t('Remove'), t('Remove {address}', { address: text(item.address) }), () => void address('remove', text(item.address)))]), t('No verified addresses.'), 4)
        const current = k.q<HTMLButtonElement>('[data-sec-action="add-current"]')
        if (current) current.dataset.address = text(client.address)
        k.note('read', t('Read from this server.'))
      }
      load = () => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(await k.send('GET', '/api/auth/security-questions') as Row) } catch (error) { loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
      const save = (questions: Row[]): Promise<void> => run(async () => {
        try { paint(await k.send('PUT', '/api/auth/security-questions', { currentPassword: value('current-password'), questions }) as Row); k.show('read', questions.length ? t('Your security questions were saved.') : t('Your security questions were removed.')) }
        finally { clear('current-password', ...[1, 2, 3, 4, 5].map(n => 'answer-' + n)) }
      })
      const address = (kind: 'add' | 'remove', entry: string): Promise<void> => run(async () => {
        if (kind === 'remove' && !await k.confirm({ title: t('Remove this verified address?'), body: entry + '\n' + t('The next sign-in from it asks the security questions again.'), confirm: t('Remove') })) return
        paint(await k.send('POST', '/api/auth/security-questions/addresses', { action: kind, address: entry }) as Row)
        if (kind === 'add') clear('address')
        k.show('read', kind === 'add' ? t('{address} was added to your verified addresses.', { address: entry }) : t('{address} was removed.', { address: entry }))
      })
      k.q('[data-sec-action="save"]')?.addEventListener('click', () => {
        const questions = [1, 2, 3, 4, 5].map(n => ({ question: value('question-' + n).trim(), answer: value('answer-' + n) })).filter(item => item.question || item.answer)
        void save(questions)
      })
      k.q('[data-sec-action="clear"]')?.addEventListener('click', () => void (async () => {
        if (!await k.confirm({ title: t('Remove your security questions?'), body: t('Sign-in from an unverified address no longer asks questions for your account.'), confirm: t('Remove questions') })) return
        void save([])
      })())
      k.q('[data-sec-action="add-address"]')?.addEventListener('click', () => void address('add', value('address').trim()))
      k.q<HTMLButtonElement>('[data-sec-action="add-current"]')?.addEventListener('click', event => void address('add', (event.currentTarget as HTMLButtonElement).dataset.address ?? ''))
    }

    if (page === 'security-policy') {
      let revision = ''
      const paint = (view: Row): void => {
        const policy = object(view.policy) ? view.policy : null
        revision = text(view.revision); loaded = view.state !== 'invalid'
        const box = k.input<HTMLInputElement>('verified-ip'); if (box) box.checked = policy?.verifiedIpSignIn === true
        k.field('policy-state', view.state === 'invalid' ? t('The saved policy is damaged; questions are asked until it is saved again') : policy?.verifiedIpSignIn ? t('On') : t('Off'))
        k.field('updated', k.when(view.updatedAt))
        k.note('read', t('Read from this server.'))
      }
      load = () => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(await k.send('GET', '/api/server/sec/security-questions') as Row) } catch (error) { loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
      k.q('[data-sec-action="save"]')?.addEventListener('click', () => void run(async () => {
        const on = k.input<HTMLInputElement>('verified-ip')?.checked === true
        if (!await k.confirm(on ? { title: t('Ask security questions from unverified addresses?'), body: t('Every user who set security questions must answer them when signing in from an address they have not verified. Users with two-factor authentication are not asked.'), confirm: t('Turn on') }
          : { title: t('Stop asking security questions?'), body: t('Saved questions stay; no sign-in asks them until the policy is on again.'), confirm: t('Turn off') })) return
        paint(await k.send('PUT', '/api/server/sec/security-questions', { verifiedIpSignIn: on, expectedRevision: revision }) as Row)
        k.show('read', t('The policy was saved.'))
      }))
      k.q('[data-sec-action="reset-user"]')?.addEventListener('click', () => void run(async () => {
        const user = value('reset-username').trim()
        if (!user) { k.show('invalid', t('Enter a username first.')); return }
        if (!await k.confirm({ title: t('Reset the security questions of {user}?', { user }), body: t('Their saved questions are removed. No sign-in asks them until the user sets new ones.'), confirm: t('Reset questions') })) return
        const ack = await k.send('POST', '/api/server/sec/security-questions/reset', { username: user }) as Row
        clear('reset-username')
        k.show('read', ack.removed === 0 ? t('{user} has no security questions.', { user: text(ack.username) }) : t('The security questions of {user} were removed.', { user: text(ack.username) }))
      }))
    }

    if (page === 'external-identities') {
      const reasons: Record<string, string> = { identity_not_linked: t('That identity is not linked to a user of this panel.'), provider_disabled: t('That provider is not enabled for this panel.'),
        state_invalid: t('The sign-in did not start in this browser or has expired. Start again.'), external_flow_missing: t('The provider sign-in has expired. Start again.'), identity_already_linked: t('That identity is already linked to another user.') }
      const paint = (view: Row): void => {
        loaded = view.available === true
        options('provider', list(view.providers).map(item => [text(item.id), text(item.label)]), t('Select a provider'))
        k.field('availability', view.available === true ? (list(view.providers).length ? t('Available') : t('No provider is enabled for this panel')) : view.reason === 'public_origin_required' ? t('Unavailable: the panel has no public HTTPS address') : t('Unavailable on this panel'))
        k.rows('identities', list(view.identities).map(item => [typed(item.providerLabel || item.providerId), item.label ? k.technical(text(item.label)) : '-', k.when(item.createdAt) ?? '-', k.when(item.lastUsedAt) ?? t('Never'),
          action(t('Unlink'), t('Unlink this identity'), () => void unlink(text(item.id)))]), t('No external identities are linked.'), 5)
        k.note('read', t('Read from this server.'))
      }
      load = () => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(await k.send('GET', '/api/auth/external-identities') as Row) } catch (error) { loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
      const unlink = (id: string): Promise<void> => run(async () => {
        if (!await k.confirm({ title: t('Unlink this identity?'), body: t('You can no longer sign in with it. Your password and two-factor sign-in stay as they are.'), confirm: t('Unlink') })) return
        paint(await k.send('DELETE', '/api/auth/external-identities/' + encodeURIComponent(id)) as Row); k.show('read', t('The identity was unlinked.'))
      })
      k.q('[data-sec-action="link"]')?.addEventListener('click', () => void run(async () => {
        if (!value('provider')) { k.show('invalid', t('Select a provider first.')); return }
        try {
          const started = await k.send('POST', '/api/auth/external-identities/start', { providerId: value('provider'), currentPassword: value('current-password') }) as Row
          const target = text(started.authorizationUrl)
          if (!/^https:\/\//.test(target)) throw new Error('unexpected')
          k.show('reading', t('Opening the provider sign-in…')); window.location.assign(target)
        } finally { clear('current-password') }
      }))
      const query = new URLSearchParams(window.location.search), outcome = query.get('external')
      if (outcome === 'verified') {
        first = () => k.guarded(async () => {
          try { await k.send('POST', '/api/auth/external-identities', {}); k.show('read', t('The identity was linked. You can now sign in with it.')) }
          catch (error) { const details = (error as { details?: Row }).details ?? {}; k.show(k.outcome(error), reasons[text(details.reason)] ?? k.failure(k.outcome(error))) }
        }).then(() => load())
        dropOutcome()
      }
      if (outcome === 'failed') { k.show('refused', reasons[query.get('reason') ?? ''] ?? t('The provider sign-in did not complete. Nothing was linked.')); dropOutcome() }
    }

    if (page === 'external-providers') {
      let view: Row = {}
      const providers = (): Row[] => list(view.providers)
      const fill = (item: Row | null): void => {
        const set = (key: string, next: string): void => { const node = k.input(key); if (node) node.value = next }
        set('provider-id', text(item?.id)); set('provider-label', text(item?.label)); set('provider-issuer', text(item?.issuer)); set('provider-client-id', text(item?.clientId)); set('provider-client-secret', '')
        const entry = object(item?.entryPoints) ? item!.entryPoints as Row : {}
        for (const name of ['xpanel', 'xwhm']) { const box = k.input<HTMLInputElement>('provider-' + name); if (box) box.checked = item ? entry[name] === true : name === 'xpanel' }
        const id = k.input<HTMLInputElement>('provider-id'), issuer = k.input<HTMLInputElement>('provider-issuer')
        if (id) id.readOnly = item !== null; if (issuer) issuer.readOnly = item !== null
      }
      const paint = (next: Row): void => {
        view = next; loaded = next.state !== 'invalid'
        const uris = object(next.redirectUris) ? next.redirectUris : {}
        k.field('redirect-uris', Object.values(uris).map(text).filter(Boolean).join('\n') || t('No public HTTPS address is configured'))
        k.rows('providers', providers().map(item => { const entry = object(item.entryPoints) ? item.entryPoints : {}; return [typed(item.label), k.technical(text(item.issuer)), k.technical(text(item.clientId)),
          [entry.xpanel === true ? 'xPanel' : '', entry.xwhm === true ? 'xWHM' : ''].filter(Boolean).join(', ') || t('Disabled'),
          k.group(k.actionButton(t('Edit'), t('Edit {name}', { name: text(item.label) }), () => fill(item), !k.manageable()), k.actionButton(t('Remove'), t('Remove {name}', { name: text(item.label) }), () => void remove(text(item.id)), !k.manageable()))] }),
          t('No identity providers are configured.'), 5)
        k.rows('links', list(next.identities).map(item => [text(item.principal) || t('Removed user'), text(item.providerId), item.label ? k.technical(text(item.label)) : '-', k.when(item.createdAt) ?? '-', k.when(item.lastUsedAt) ?? t('Never'),
          action(t('Unlink'), t('Unlink this identity'), () => void unlinkAny(text(item.id)))]), t('No identities are linked.'), 6)
        k.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved provider configuration is damaged and needs review.') : t('Read from this server.'))
      }
      load = () => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(await k.send('GET', '/api/server/sec/external-auth') as Row) } catch (error) { loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
      const put = async (next: Row[]): Promise<void> => { paint(await k.send('PUT', '/api/server/sec/external-auth', { expectedRevision: text(view.revision), providers: next }) as Row) }
      const keep = (item: Row): Row => ({ id: item.id, label: item.label, issuer: item.issuer, clientId: item.clientId, entryPoints: item.entryPoints })
      const remove = (id: string): Promise<void> => run(async () => {
        if (!await k.confirm({ title: t('Remove this identity provider?'), body: t('Every identity linked through it is unlinked, and its sign-in button disappears.'), confirm: t('Remove provider') })) return
        await put(providers().filter(item => item.id !== id).map(keep)); fill(null); k.show('read', t('The provider was removed and its links were revoked.'))
      })
      const unlinkAny = (id: string): Promise<void> => run(async () => {
        if (!await k.confirm({ title: t('Unlink this identity?'), body: t('The user can no longer sign in with it.'), confirm: t('Unlink') })) return
        paint(await k.send('DELETE', '/api/server/sec/external-auth/links/' + encodeURIComponent(id)) as Row); k.show('read', t('The identity was unlinked.'))
      })
      k.q('[data-sec-action="save-provider"]')?.addEventListener('click', () => void run(async () => {
        const id = value('provider-id').trim(), secret = value('provider-client-secret')
        const entry = { id, label: value('provider-label').trim(), issuer: value('provider-issuer').trim(), clientId: value('provider-client-id').trim(),
          entryPoints: { xpanel: k.input<HTMLInputElement>('provider-xpanel')?.checked === true, xwhm: k.input<HTMLInputElement>('provider-xwhm')?.checked === true }, ...(secret ? { clientSecret: secret } : {}) }
        const existing = providers().some(item => item.id === id)
        try { await put([...providers().filter(item => item.id !== id).map(keep), entry]); fill(null); k.show('read', existing ? t('The provider was saved.') : t('The provider passed discovery and was added.')) }
        finally { clear('provider-client-secret') }
      }))
      k.q('[data-sec-action="new-provider"]')?.addEventListener('click', () => fill(null))
    }

    refresh?.addEventListener('click', () => void load())
    void (first ?? load)()
  })
}

export const IDENTITY_CLIENT_BINDING = `(()=>{${SEC_CLIENT_TEMPLATE_HELPERS}const displayDateTime=${DISPLAY_DATETIME_BINDING};const kitOf=${secKit.toString()};const generatePassword=${generatePassword.toString()};const passwordScore=${passwordScore.toString()};return ${bindIdentity.toString()};})()`
