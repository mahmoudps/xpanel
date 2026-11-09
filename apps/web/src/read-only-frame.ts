/// <reference lib="dom" />
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/**
 * Controllers that read inside read-only frames. A read-only frame is a closed page or section: these controllers run
 * their GET reads and paint the saved or default values into disabled controls, and every write goes through
 * frameRequest. Their server roots carry the read flag below as "true" in read-only documents too.
 */
export const FRAME_READER_CLIENTS: Readonly<Record<string, string | readonly string[]>> = Object.freeze({
  'data-sec-can-read': 'sec-security-client.ts', 'data-server-ops-can-read': 'whm-server-ops-client.ts', 'data-ctr-can-read': 'ctr-client.ts',
  'data-cluster-can-read': 'node-cluster-client.ts', 'data-shares-can-read': 'ops-file-sharing-client.ts', 'data-int-can-read': 'ops-integrations-client.ts',
  'data-nodes-can-read': 'ops-nodes-client.ts', 'data-dns-tools-can-read': 'whm-dns-tools-client.ts', 'data-jobs-can-read': 'whm-jobs-client.ts',
  'data-mail-queue-can-read': 'whm-mail-queue-client.ts', 'data-mailbox-maintenance-can-read': 'whm-mailbox-maintenance-client.ts',
  'data-security-tools-can-read': 'whm-security-tools-client.ts', 'data-service-detail-can-read': 'whm-service-detail-client.ts',
  'data-sm-can-read': 'whm-service-manager-client.ts', 'data-sc-can-read': 'whm-software-center-client.ts',
  'data-health-can-read': 'whm-account-health-client.ts', 'data-backup-files-can-read': 'whm-backup-files-client.ts', 'data-ch-can-read': 'whm-configuration-health-client.ts',
  'data-ftp-log-can-read': 'whm-ftp-log-client.ts', 'data-mail-log-can-read': 'whm-mail-log-client.ts', 'data-mail-quality-can-read': 'whm-mail-quality-client.ts',
  'data-mail-server-can-read': 'whm-mail-server-client.ts', 'data-monitoring-can-read': 'whm-monitoring-client.ts', 'data-php-can-read': 'whm-php-client.ts',
  'data-repair-can-read': 'whm-repair-client.ts', 'data-server-health-can-read': 'whm-server-health-client.ts', 'data-server-observation-can-read': 'whm-server-observation-client.ts',
  'data-support-can-read': 'whm-support-client.ts', 'data-updates-can-read': 'whm-updates-client.ts', 'data-web-can-read': 'whm-web-server-client.ts',
  'data-mailx-can-read': 'mailx-whm-client.ts', 'data-restore-more-can-read': 'acct-restore-client.ts', 'data-composer-can-read': 'whm-composer-client.ts',
  'data-host-can-read': 'approved-host-services-client.ts', 'data-sign-in-can-read': 'sign-in-policy-client.ts', 'data-tweak-can-read': 'whm-tweak-settings-client.ts',
  'data-svc-can-read': 'svc-panels-client.ts', 'data-log-tools-can-read': 'whm-log-tools-client.ts', 'data-registered-apps-can-read': 'whm-extend-client.ts',
  'data-metering-can-read': 'whm-metering-client.ts', 'data-raw-logs-can-read': 'whm-metering-client.ts', 'data-quotas-can-read': 'whm-metering-client.ts',
  'data-gitweb-can-read': 'account-gitweb-client.ts', 'data-mail-card-can-read': 'mail-cards-client.ts', 'data-attachment-can-read': 'mail-attachments-client.ts',
  'data-devices-can-read': 'mail-connect-devices-client.ts', 'data-track-can-read': 'mail-track-delivery-client.ts',
  // Read flags split from a shared manage flag (frameAccess).
  'data-spam-can-read': 'mail-spam-client.ts',
  'data-boxtrapper-can-read': 'boxtrapper-client.ts', 'data-calendar-can-read': 'mail-calendar-client.ts', 'data-moderation-can-read': 'list-moderation-client.ts',
  'data-list-admin-can-read': 'list-moderation-client.ts', 'data-groups-can-read': 'mail-contact-groups-client.ts', 'data-contacts-can-read': 'mail-contacts-workspace-client.ts',
  'data-compose-identities-can-read': 'mail-compose-identities-client.ts', 'data-vacation-can-read': 'mail-vacation-workspace-client.ts', 'data-identities-can-read': 'mail-identities-client.ts',
  'data-usage-can-read': 'mail-disk-usage-client.ts', 'data-folders-can-read': 'mail-folders-client.ts', 'data-forwarders-can-read': 'mail-mailbox-forwarders-client.ts',
  'data-mail-preferences-can-read': 'mail-mailbox-preferences-client.ts', 'data-wd-can-read': 'account-web-directives-client.ts', 'data-enh-can-read': 'acct-enhancements-client.ts',
  'data-runtime-can-read': 'account-runtime-client.ts', 'data-site-can-read': 'account-site-settings-client.ts', 'data-filter-can-read': 'account-filters-client.ts',
  'data-spam-settings-can-read': 'account-spam-client.ts', 'data-sw-apps-can-read': 'sw-applications-client.ts', 'data-team-can-read': 'acct-team-client.ts',
  'data-sitepub-can-read': 'account-site-publisher-client.ts', 'data-git-can-read': 'account-git-client.ts', 'data-site-instances-can-read': 'site-software-instances-client.ts',
  'data-forwarder-can-read': 'account-forwarders-client.ts', 'data-autoresponder-can-read': 'account-forwarders-client.ts', 'data-default-can-read': 'account-forwarders-client.ts',
  'data-host-tool-can-read': 'whm-host-tools-client.ts', 'data-backup-can-read': 'whm-backups-client.ts', 'data-backup-destinations-can-read': 'whm-backup-destinations-client.ts',
  'data-ssl-store-can-read': 'ssl-store-client.ts', 'data-network-can-read': 'whm-network-client.ts', 'data-web-directives-can-read': 'whm-web-directives-client.ts',
  'data-ssl-can-read': 'whm-ssl-client.ts', 'data-ssl-install-can-read': 'whm-ssl-install-client.ts', 'data-branding-can-read': 'whm-panel-branding-client.ts',
  'data-developer-can-read': 'whm-developer-client.ts', 'data-mailx-collections-can-read': 'mailx-collections-client.ts', 'data-transfer-can-read': 'whm-transfer-client.ts',
  // A shared read flag lists every client that reads through it; each one goes through the gate.
  'data-db-can-read': ['whm-databases-client.ts', 'db-engines-client.ts'], 'data-can-read': ['whm-database-tuning-client.ts', 'whm-traffic-client.ts'],
  'data-sw-can-read': ['sw-addon-services-client.ts', 'sw-app-projects-client.ts', 'sw-containers-client.ts', 'sw-deployments-client.ts', 'sw-optimize-client.ts'],
})
export const FRAME_READERS: readonly string[] = Object.freeze(Object.keys(FRAME_READER_CLIENTS))

/**
 * The one write gate for frame readers: an unsafe method is refused while the controller root is detached or sits in a
 * read-only frame, checked on every call. Serialized into client bindings with toString(), so it stays self-contained.
 */
export function frameRequest(root: Element): Transport | undefined {
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  if (typeof request !== 'function') return undefined
  const frame = (): boolean => root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null
  // Every control under a frame reader stays disabled in a read-only frame, whatever the controller sets after its read.
  // Local view toggles (aria-pressed, tabs) only change what is shown, so they stay usable.
  const freeze = (): void => { if (frame()) for (const control of root.querySelectorAll<HTMLInputElement>('input,select,textarea,button:not([aria-pressed]):not([role="tab"])')) if (!control.disabled) control.disabled = true }
  if (typeof MutationObserver === 'function' && root.getAttribute('data-frame-reader') !== 'bound') {
    root.setAttribute('data-frame-reader', 'bound')
    new MutationObserver(freeze).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] })
    freeze()
  }
  return (...args) => {
    const method = args[0], safe = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD'
    if (!safe && (!root.isConnected || root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null))
      return Promise.reject(Object.assign(new Error('read_only_frame'), { code: 'READ_ONLY_FRAME', details: { stateChanged: false } }))
    return request(...args)
  }
}

/**
 * Admission of a frame reader whose reads and writes once shared one manage flag. It reads while its read flag (or its
 * manage flag) is open; it writes only with its manage flag, outside every read-only frame. Serialized like frameRequest.
 */
export function frameAccess(root: Element, readFlag: string, manageFlag: string): { readonly request: Transport | undefined; readable(): boolean; writable(): boolean } {
  const request = frameRequest(root)
  const readable = (): boolean => root.isConnected && typeof request === 'function' && (root.getAttribute(readFlag) === 'true' || root.getAttribute(manageFlag) === 'true')
  const writable = (): boolean => readable() && root.getAttribute(manageFlag) === 'true'
    && root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') === null
  return { request, readable, writable }
}

/** Wraps a serialized client binding so its controllers can call frameRequest and frameAccess. */
export const withFrameRequest = (binding: string): string => `(()=>{${frameRequest.toString()};${frameAccess.toString()};return (${binding})})()`

/** A read-only frame shown to an authorized administrator opens only the frame readers' read flags; controls stay as rendered, disabled. */
export const openFrameReads = (html: string): string =>
  html.replace(/\s(data-(?:[a-z-]+-)?can-read)="false"/g, (match, name: string) => FRAME_READERS.includes(name) ? ` ${name}="true"` : match)
