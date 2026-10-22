import type { Locale } from '../i18n.ts'
import { escapeHtml, renderStatusBadge, renderThresholdMeter } from '../tokens.ts'

/**
 * Renders the extended xWHM server & reseller administration sections:
 * 1. First-Run Setup Wizard & Hostname / Disk Quota Initializer (`quotacheck -cugm`, `quotaon -vug`, `hostnamectl`)
 * 2. Operational DNS Suite (Zone Templates `standard`/`simple`/`virtualftp`, Batch DKIM/SPF/DMARC Provisioner, Orphan Zone Cleanup, External DNS Cluster / Cloudflare Sync)
 * 3. Complete Backups & Live Transfers (Remote Backup Destinations S3/SFTP/Rsync/Backblaze/FTP, Account Selection & Schedule, Single-File Granular Restore browser, Live Transfer Session progress bar)
 * 4. Fine-Grained Server Settings (Memory & Process Limits, Log Rotation `/etc/logrotate.d/xpanel`, MTA Queue/Smarthost/RBLs/Greylisting, Software/Package Installer, Web Stack Builder for Nginx/Apache/OLS/HTTP3/ModSecurity)
 * 5. Cluster, Branding, Languages & WHMCS (Multi-Node Cluster Peers, Custom Panel Branding, Language Manager Overrides, WHMCS Billing Integration)
 */
export function renderWhmExtendedSections(locale: Locale = 'en'): string {
  const isAr = locale === 'ar'

  return `
      <!-- Extended 1: First-Run Setup Wizard & Hostname / Disk Quota Initializer -->
      <section class="xp-card" id="whm-setup-quota-hostname" data-section="setup-wizard-hostname-quotas" aria-labelledby="whm-setup-wizard-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="whm-setup-wizard-heading">${
              isAr
                ? 'معالج الإعداد الأولي وتهيئة اسم المضيف وحصص القرص (Setup Wizard & Quotas)'
                : 'First-Run Setup Wizard, Hostname & Linux Disk Quota Initializer'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'تهيئة الخادم عند التشغيل الأول، وضبط اسم المضيف الكامل (FQDN) عبر hostnamectl، وتفعيل حصص أقراص النواة لـ /home عبر quotacheck وquotaon.'
                : 'Complete initial server provisioning, set the canonical FQDN via hostnamectl, and initialize kernel filesystem quotas on /home using quotacheck -cugm and quotaon -vug.'
            }</p>
          </div>
          ${renderStatusBadge('ok', isAr ? 'الخطوات 5/5 مكتملة' : 'Wizard 5/5 Completed')}
        </div>

        <div class="xp-kpi-grid" style="margin-block-end: var(--xp-space-field);" data-setup-wizard-steps="true">
          <div class="xp-card">
            <div class="xp-card__header">
              <strong>${isAr ? '1. حساب الجذر والمصادقة الثنائية' : '1. Root Operator & TOTP 2FA'}</strong>
              ${renderStatusBadge('ok', 'Argon2id + RFC 6238')}
            </div>
            <p class="xp-prose">${isAr ? 'تم تأمين حساب المشغل الرئيسي بمفاتيح WebAuthn ورمز TOTP.' : 'Root account hardened with Argon2id, TOTP 2FA, and SSH key lock.'}</p>
          </div>

          <div class="xp-card">
            <div class="xp-card__header">
              <strong>${isAr ? '2. اسم المضيف وخوادم الأسماء' : '2. Hostname & Nameservers'}</strong>
              ${renderStatusBadge('ok', 'srv1.xpanel.test')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">ns1.xpanel.test · ns2.xpanel.test</bdi></code></p>
          </div>

          <div class="xp-card">
            <div class="xp-card__header">
              <strong>${isAr ? '3. تحجيم العمال والمكدس' : '3. Stack & Worker Sizing'}</strong>
              ${renderStatusBadge('ok', 'pm = ondemand')}
            </div>
            <p class="xp-prose">${isAr ? 'تم ضبط عمال Nginx وApache mpm-itk وPHP-FPM تلقائياً حسب الذاكرة.' : 'Nginx edge, Apache mpm-itk, and PHP-FPM ondemand workers sized for host RAM.'}</p>
          </div>

          <div class="xp-card">
            <div class="xp-card__header">
              <strong>${isAr ? '4. تهيئة حصص القرص (Filesystem Quotas)' : '4. Filesystem Quota Mount (/home)'}</strong>
              ${renderStatusBadge('ok', 'vfsv1 usrquota+grpquota')}
            </div>
            ${renderThresholdMeter(42, 100, '%')}
          </div>
        </div>

        <div class="xp-golden-grid">
          <!-- Hostname & Resolver Initializer -->
          <form class="xp-card xp-form-group" action="/api/whm/hostname" method="post" data-hostname-initializer-form="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'ضبط اسم المضيف (hostnamectl) والمحلل' : 'Server Hostname (hostnamectl) & Resolver Setup'}</h3>
              ${renderStatusBadge('ok', 'hostnamectl verified')}
            </div>
            <div>
              <label class="xp-label" for="whm-setup-fqdn">${isAr ? 'اسم المضيف المؤهل بالكامل (FQDN)' : 'Canonical Server FQDN'}</label>
              <input id="whm-setup-fqdn" name="hostname" type="text" class="xp-input xp-mono" dir="ltr" value="srv1.xpanel.test" />
            </div>
            <div class="xp-kpi-grid">
              <div>
                <label class="xp-label" for="whm-setup-ns1">${isAr ? 'خادم الأسماء الأساسي (NS1)' : 'Primary Nameserver (NS1)'}</label>
                <input id="whm-setup-ns1" name="ns1" type="text" class="xp-input xp-mono" dir="ltr" value="ns1.xpanel.test" />
              </div>
              <div>
                <label class="xp-label" for="whm-setup-ns2">${isAr ? 'خادم الأسماء الثانوي (NS2)' : 'Secondary Nameserver (NS2)'}</label>
                <input id="whm-setup-ns2" name="ns2" type="text" class="xp-input xp-mono" dir="ltr" value="ns2.xpanel.test" />
              </div>
            </div>
            <pre class="xp-terminal" dir="ltr"><bdi dir="ltr">$ hostnamectl set-hostname srv1.xpanel.test
$ hostname -f
srv1.xpanel.test</bdi></pre>
            <div style="display: flex; gap: 10px;">
              <button type="submit" class="xp-btn xp-btn--primary" data-action="change-hostname">
                ${isAr ? 'تحديث اسم المضيف ومعالج الإعداد' : 'Apply Hostname & Complete Setup Wizard'}
              </button>
            </div>
          </form>

          <!-- Disk Quota Initializer -->
          <div class="xp-card xp-form-group" data-quota-initializer="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'مهيئ حصص الأقراص (quotacheck / quotaon)' : 'Linux Disk Quota Initializer (quotacheck / quotaon)'}</h3>
              ${renderStatusBadge('ok', 'aquota.user + aquota.group')}
            </div>
            <p class="xp-prose">${
              isAr
                ? 'يفحص خيارات التركيب في /etc/fstab (usrjquota=aquota.user,grpjquota=aquota.group,jqfmt=vfsv1) ويبني جداول الحصص بدون إيقاف الخدمات.'
                : 'Verifies /etc/fstab journaled quota mount flags (usrjquota=aquota.user,grpjquota=aquota.group,jqfmt=vfsv1) and builds UID/GID quota indexes.'
            }</p>
            <pre class="xp-terminal" dir="ltr"><bdi dir="ltr">$ mount -o remount,usrjquota=aquota.user,grpjquota=aquota.group,jqfmt=vfsv1 /home
$ quotacheck -cugm /home
$ quotaon -vug /home
/dev/sda1 [/home]: group quotas turned on
/dev/sda1 [/home]: user quotas turned on</bdi></pre>
            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
              <button type="button" class="xp-btn xp-btn--primary" data-action="init-disk-quotas" data-api-url="/api/whm/quotas/init">
                ${isAr ? 'تشغيل quotacheck -cugm وتفعيل الحصص' : 'Run quotacheck -cugm & quotaon -vug'}
              </button>
              <button type="button" class="xp-btn" data-action="complete-setup-wizard" data-api-url="/api/whm/setup-wizard">
                ${isAr ? 'حفظ إعدادات المعالج الأولي' : 'Save First-Run Setup State'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Extended 2: Operational DNS Suite -->
      <section class="xp-card" id="whm-operational-dns" data-section="operational-dns-suite" aria-labelledby="whm-operational-dns-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="whm-operational-dns-heading">${
              isAr
                ? 'منظومة DNS التشغيلية (القوالب، DKIM/SPF/DMARC الجماعي، تنظيف المناطق اليتيمة، والمزامنة)'
                : 'Operational DNS Suite: Zone Templates, Batch DKIM/SPF/DMARC, Orphan Cleanup & Cluster Sync'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'قوالب مناطق PowerDNS القياسية (standard / simple / virtualftp)، التوليد الجماعي لمفاتيح DKIM وسجلات SPF/DMARC لجميع النطاقات، وإزالة المناطق اليتيمة ومزامنة Cloudflare/AXFR.'
                : 'Manage PowerDNS BIND zone templates (standard, simple, virtualftp), batch-provision 2048-bit DKIM + SPF + DMARC across all domains, purge orphan zone files, and synchronize external DNS clusters.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'PowerDNS 4.9 BIND + Cloud Sync')}
        </div>

        <div class="xp-golden-grid">
          <!-- Zone Templates Editor (standard / simple / virtualftp) -->
          <form class="xp-card xp-form-group" action="/api/whm/dns/templates" method="post" data-dns-zone-templates="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'قوالب مناطق DNS (standard / simple / virtualftp)' : 'DNS Zone Templates (standard / simple / virtualftp)'}</h3>
              ${renderStatusBadge('ok', '3 Templates Active')}
            </div>
            <div>
              <label class="xp-label" for="dns-template-preset">${isAr ? 'اختر قالب المنطقة' : 'Zone Template Preset'}</label>
              <select id="dns-template-preset" name="templateName" class="xp-select xp-mono">
                <option value="standard">standard — Full Web + Mail + FTP + CalDAV/CardDAV SRV + CAA</option>
                <option value="simple">simple — Minimal Apex A/AAAA + WWW + MX + TXT</option>
                <option value="virtualftp">virtualftp — Dedicated Virtual FTP &amp; Multi-IPv4/IPv6</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="dns-template-body">${isAr ? 'محتوى قالب BIND (يدعم متغيرات %domain% و%ip% و%ipv6%)' : 'BIND Zone Template Body (%domain%, %ip%, %ipv6%, %ns1%, %ns2%, %ftpip%)'}</label>
              <textarea id="dns-template-body" name="templateBody" rows="6" class="xp-textarea xp-mono" dir="ltr">$TTL 3600
@   IN SOA %ns1%. hostmaster.%domain%. (%serial% 3600 1800 1209600 3600)
@   IN NS  %ns1%.
@   IN NS  %ns2%.
@   IN A   %ip%
@   IN AAAA %ipv6%
www IN CNAME %domain%.
ftp IN A   %ftpip%
mail IN A  %mailip%
@   IN MX  10 mail.%domain%.</textarea>
            </div>
            <button type="submit" class="xp-btn xp-btn--primary" data-action="save-zone-template">
              ${isAr ? 'حفظ قالب المنطقة' : 'Save Zone Template'}
            </button>
          </form>

          <!-- Batch DKIM/SPF/DMARC Provisioner + Orphan Cleanup + External Cluster Sync -->
          <div class="xp-form-group">
            <div class="xp-card" data-batch-dkim-spf-dmarc="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'التوليد الجماعي لـ DKIM / SPF / DMARC لجميع النطاقات' : 'Batch DKIM / SPF / DMARC Provisioner (All Domains)'}</h3>
                ${renderStatusBadge('ok', '44/44 Domains Signed')}
              </div>
              <p class="xp-prose">${
                isAr
                  ? 'يولّد مفاتيح RSA-2048 للمحدد xpanel._domainkey ويضيف سجلات v=spf1 وv=DMARC1 لجميع النطاقات المستضافة دفعة واحدة.'
                  : 'Generates 2048-bit RSA keys (xpanel._domainkey), strict SPF (-all), and DMARC (p=quarantine) TXT records across all hosted zones in one atomic generation.'
              }</p>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-block-end: 12px;">
                ${renderStatusBadge('ok', 'DKIM Selector: xpanel (2048-bit)')}
                ${renderStatusBadge('ok', 'SPF: v=spf1 a mx ip4/ip6 -all')}
                ${renderStatusBadge('ok', 'DMARC: v=DMARC1; p=quarantine')}
              </div>
              <button type="button" class="xp-btn xp-btn--primary" data-action="batch-dkim-spf-dmarc" data-api-url="/api/whm/dns/batch-auth">
                ${isAr ? 'تطبيق DKIM وSPF وDMARC على جميع النطاقات' : 'Provision DKIM, SPF & DMARC for All Domains'}
              </button>
            </div>

            <div class="xp-card" data-orphan-zone-cleanup="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'تنظيف مناطق DNS اليتيمة ومزامنة Cloudflare / AXFR' : 'Orphan Zone Cleanup & External DNS Cluster / Cloudflare Sync'}</h3>
                ${renderStatusBadge('warn', isAr ? 'منطقتان يتيمتان مكتشفتان' : '2 Orphan Zones Detected')}
              </div>
              <p class="xp-prose">
                <code class="xp-mono"><bdi dir="ltr">/var/lib/powerdns/zones/old-test-2025.org.zone, legacy-demo.net.zone</bdi></code>
              </p>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-block-start: 10px;">
                <button type="button" class="xp-btn" data-action="cleanup-orphan-zones" data-api-url="/api/whm/dns/cleanup-orphans">
                  ${isAr ? 'حذف المناطق اليتيمة (Orphan Zone Cleanup)' : 'Purge Orphan Zones'}
                </button>
                <button type="button" class="xp-btn xp-btn--primary" data-action="sync-dns-cluster" data-api-url="/api/whm/dns/cluster-sync">
                  ${isAr ? 'مزامنة عنقود DNS وCloudflare الآن' : 'Sync External DNS Cluster & Cloudflare'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Extended 3: Complete Backups & Live Transfers -->
      <section class="xp-card" id="whm-backups-transfers" data-section="complete-backups-live-transfers" aria-labelledby="whm-backups-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="whm-backups-heading">${
              isAr
                ? 'النسخ الاحتياطي الشامل والاستعادة الجزئية لملف واحد والنقل الحي (Backups & Live Transfers)'
                : 'Complete Remote Backups, Single-File Granular Restore & Live Transfer Sessions'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'وجهات نسخ احتياطي بعيدة (S3 وSFTP وRsync وBackblaze B2 وFTP) مع جدولة الحسابات، واستعادة ملف مفرد من الأرشيف، ومتابعة النقل المباشر.'
                : 'Configure S3, SFTP, Rsync, Backblaze B2, and FTP backup targets, schedule per-account snapshots, restore individual files from archives, and monitor live account transfers.'
            }</p>
          </div>
          ${renderStatusBadge('ok', '5 Remote Targets · Incremental zstd')}
        </div>

        <!-- Remote Backup Destinations Table -->
        <div class="xp-table-wrap" style="margin-block-end: var(--xp-space-card);">
          <table class="xp-table" data-backup-destinations-table="true">
            <thead>
              <tr>
                <th>${isAr ? 'الوجهة' : 'Destination Name'}</th>
                <th>${isAr ? 'البروتوكول' : 'Protocol'}</th>
                <th>${isAr ? 'المسار / نقطة النهاية' : 'Endpoint / Bucket Path'}</th>
                <th>${isAr ? 'الجدولة والاحتفاظ' : 'Schedule & Retention'}</th>
                <th>${isAr ? 'استخدام المساحة' : 'Storage Quota'}</th>
                <th>${isAr ? 'الحالة' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              <tr data-backup-dest="s3">
                <td><strong>AWS S3 Frankfurt Vault</strong></td>
                <td>${renderStatusBadge('ok', 'S3')}</td>
                <td><code class="xp-mono"><bdi dir="ltr">s3://xpanel-prod-backups/eu-central-1/srv1</bdi></code></td>
                <td class="xp-mono xp-tabular">Daily 02:00 UTC · 30 days</td>
                <td>${renderThresholdMeter(142, 500, 'GB')}</td>
                <td>${renderStatusBadge('ok', 'Verified')}</td>
              </tr>
              <tr data-backup-dest="sftp">
                <td><strong>Hetzner StorageBox SFTP</strong></td>
                <td>${renderStatusBadge('ok', 'SFTP')}</td>
                <td><code class="xp-mono"><bdi dir="ltr">u39102@u39102.your-storagebox.de:/backups/srv1</bdi></code></td>
                <td class="xp-mono xp-tabular">Daily 03:00 UTC · 14 days</td>
                <td>${renderThresholdMeter(410, 500, 'GB')}</td>
                <td>${renderStatusBadge('warn', '82% Used')}</td>
              </tr>
              <tr data-backup-dest="rsync">
                <td><strong>Offsite DR Node Rsync</strong></td>
                <td>${renderStatusBadge('ok', 'Rsync')}</td>
                <td><code class="xp-mono"><bdi dir="ltr">rsync://backup@dr1.xpanel.test/srv1-homes</bdi></code></td>
                <td class="xp-mono xp-tabular">Every 6h · 7 snapshots</td>
                <td>${renderThresholdMeter(96, 250, 'GB')}</td>
                <td>${renderStatusBadge('ok', 'Verified')}</td>
              </tr>
              <tr data-backup-dest="backblaze">
                <td><strong>Backblaze B2 Cold Archive</strong></td>
                <td>${renderStatusBadge('ok', 'Backblaze')}</td>
                <td><code class="xp-mono"><bdi dir="ltr">b2://xpanel-archive-vault/monthly</bdi></code></td>
                <td class="xp-mono xp-tabular">Monthly 1st · 12 months</td>
                <td>${renderThresholdMeter(280, 1000, 'GB')}</td>
                <td>${renderStatusBadge('ok', 'Immutable Lock')}</td>
              </tr>
              <tr data-backup-dest="ftp">
                <td><strong>Legacy Datacenter FTP NAS</strong></td>
                <td>${renderStatusBadge('suspended', 'FTP')}</td>
                <td><code class="xp-mono"><bdi dir="ltr">ftps://nas.dc-internal.local:21/xpanel</bdi></code></td>
                <td class="xp-mono xp-tabular">Weekly Sun · 4 weeks</td>
                <td>${renderThresholdMeter(64, 200, 'GB')}</td>
                <td>${renderStatusBadge('ok', 'Explicit FTPS')}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="xp-golden-grid">
          <!-- Single-File Granular Restore Browser & Account Schedule -->
          <div class="xp-card xp-form-group" data-single-file-restore="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'مستعرض الاستعادة الجزئية لملف واحد وجدولة الحسابات' : 'Single-File Granular Restore Browser & Account Selection'}</h3>
              ${renderStatusBadge('ok', 'Granular tar.zst Index')}
            </div>
            <div>
              <label class="xp-label" for="backup-account-select">${isAr ? 'اختر الحساب ونقطة الاستعادة' : 'Account & Snapshot Archive'}</label>
              <select id="backup-account-select" name="snapshotId" class="xp-select xp-mono">
                <option value="alice-2026-10-22">alice (uid 20014) — 2026-10-22T02:00:00Z (S3 + Local, 1.42 GB)</option>
                <option value="omar-2026-10-22">omar (uid 20016) — 2026-10-22T02:00:00Z (SFTP, 890 MB)</option>
                <option value="nour-2026-10-21">nour (uid 20015) — 2026-10-21T02:00:00Z (S3, 310 MB)</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="granular-restore-path">${isAr ? 'مسار الملف أو المجلد المراد استعادته داخل الحساب' : 'Target File or Directory Path Inside Snapshot'}</label>
              <input id="granular-restore-path" name="restorePath" type="text" class="xp-input xp-mono" dir="ltr" value="/home/alice/public_html/wp-config.php" />
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center;">
              <label style="display: inline-flex; align-items: center; gap: 6px;">
                <input type="checkbox" name="scheduleAllActive" checked />
                <span>${isAr ? 'تضمين جميع الحسابات النشطة (41 حساباً) في النسخ اليومي' : 'Include all 41 active accounts in daily 02:00 UTC schedule'}</span>
              </label>
              <button type="button" class="xp-btn xp-btn--primary" data-action="restore-single-file" data-api-url="/api/whm/backups/restore-file">
                ${isAr ? 'استعادة الملف المحدد فقط' : 'Restore Selected File Only'}
              </button>
            </div>
          </div>

          <!-- Live Transfer Session Progress Bar -->
          <div class="xp-card xp-form-group" data-section="live-transfer-session">
            <div class="xp-card__header">
              <h3>${isAr ? 'جلسة النقل المباشر بين الخوادم (Live Transfer Session)' : 'Live Transfer Session Progress (SSH Stream & cpmove)'}</h3>
              ${renderStatusBadge('reconciling', 'Transfer #tx-884 Running')}
            </div>
            <p class="xp-prose">
              <bdi dir="ltr" class="xp-mono">Source: legacy-cpanel.host.example:2087 → Target: srv1.xpanel.test (uid 20022 · xpanel-20022.slice)</bdi>
            </p>
            <div>
              <div class="xp-label" style="margin-block-end: 6px;">${isAr ? 'تقدم نقل الحسابات والبيانات (3 من 4 حسابات مكتملة)' : 'Live Stream Progress (3 of 4 accounts migrated · 76%)'}</div>
              ${renderThresholdMeter(76, 100, '%')}
            </div>
            <pre class="xp-terminal" dir="ltr"><bdi dir="ltr">[14:04:10] ✔ Account karim-store.com: home rsync + MariaDB dump imported
[14:04:42] ✔ Account rania-media.org: PowerDNS zone + 14 Dovecot maildirs verified
[14:05:01] ↻ Account ziad-agency.net: streaming /home/ziad/public_html (412 / 540 MB)...</bdi></pre>
          </div>
        </div>
      </section>

      <!-- Extended 4: Fine-Grained Server Settings & Web Stack Builder -->
      <section class="xp-card" id="whm-fine-server-settings" data-section="fine-grained-server-settings" aria-labelledby="whm-fine-settings-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="whm-fine-settings-heading">${
              isAr
                ? 'إعدادات الخادم الدقيقة وباني مكدس الويب (Server Settings, MTA, Logrotate & Web Stack Builder)'
                : 'Fine-Grained Server Settings: Memory/Process Limits, Logrotate, MTA Queue/RBLs & Web Stack Builder'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'ضبط حدود الذاكرة والعمليات، وتدوير السجلات (/etc/logrotate.d/xpanel)، وإدارة طابور Postfix وSmarthost وRBLs وGreylisting، ومثبت الحزم، وباني مكدس Nginx/Apache/OLS/HTTP3/ModSecurity.'
                : 'Control host memory & process ceilings, /etc/logrotate.d/xpanel retention, Postfix MTA queue/Smarthost/RBLs/Greylisting, package installer, and Web Stack Builder (Nginx, Apache, OpenLiteSpeed, HTTP/3, ModSecurity).'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'Nginx + Apache mpm-itk + HTTP/3 + ModSecurity CRS')}
        </div>

        <div class="xp-kpi-grid" style="margin-block-end: var(--xp-space-card);">
          <!-- Memory & Process Limits -->
          <div class="xp-card" data-server-memory-process-limits="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'حدود الذاكرة والعمليات الافتراضية' : 'Memory & Process Limits (cgroup v2)'}</strong>
              ${renderStatusBadge('ok', 'Enforced')}
            </div>
            <div class="xp-mono xp-tabular" style="font-size: 0.85rem; margin-block-end: 8px;">
              <bdi dir="ltr">Default MemoryMax: 1024 MB · TasksMax: 128 · PHP-FPM ondemand idle: 10s</bdi>
            </div>
            ${renderThresholdMeter(64, 128, 'PIDs')}
          </div>

          <!-- Log Rotation -->
          <div class="xp-card" data-server-logrotate="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'تدوير السجلات (Log Rotation)' : 'Log Rotation (/etc/logrotate.d/xpanel)'}</strong>
              ${renderStatusBadge('ok', 'daily · rotate 14 · zstd')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">/var/log/xpanel/*.log /var/log/nginx/domains/*.log (compress zstd, maxsize 50M)</bdi></code></p>
          </div>

          <!-- MTA Queue / Smarthost / RBLs / Greylisting -->
          <div class="xp-card" data-server-mta-controls="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'طابور البريد MTA وSmarthost وRBLs وGreylisting' : 'MTA Queue, Smarthost, RBLs & Greylisting'}</strong>
              ${renderStatusBadge('ok', 'Queue: 2 deferred · RBLs Active')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">Smarthost: direct · RBLs: zen.spamhaus.org, bl.spamcop.net · Greylisting: 300s</bdi></code></p>
          </div>

          <!-- Software / Package Installer -->
          <div class="xp-card" data-server-package-installer="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'مثبت البرمجيات وحزم PHP' : 'Software & Package Installer'}</strong>
              ${renderStatusBadge('ok', 'PHP 8.1 / 8.2 / 8.3 / 8.4')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">opcache · redis · imagick · intl · pgsql · zip · gd · mbstring · bcmath</bdi></code></p>
          </div>
        </div>

        <!-- Web Stack Builder (Nginx / Apache / OLS / HTTP3 / ModSecurity) -->
        <form class="xp-card xp-form-group" action="/api/whm/server/stack-builder" method="post" data-web-stack-builder="true">
          <div class="xp-card__header">
            <h3>${isAr ? 'باني مكدس الويب وجدار حماية التطبيقات (Web Stack Builder)' : 'Declarative Web Stack Builder (Nginx / Apache / OLS / HTTP3 / ModSecurity)'}</h3>
            ${renderStatusBadge('ok', 'QUIC HTTP/3 + OWASP CRS 4.x')}
          </div>
          <div class="xp-kpi-grid">
            <div>
              <label class="xp-label" for="stack-topology">${isAr ? 'طوبولوجيا خادم الويب' : 'Web Server Topology'}</label>
              <select id="stack-topology" name="topology" class="xp-select xp-mono">
                <option value="nginx+apache" selected>Nginx TLS 1.3 Edge + Apache 2.4 mpm-itk Loopback</option>
                <option value="nginx-only">Nginx Standalone + PHP-FPM Per-UID Pools</option>
                <option value="ols">OpenLiteSpeed (OLS) + LSPHP Per-UID SuEXEC</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="stack-http3">${isAr ? 'دعم بروتوكول HTTP/3 (QUIC)' : 'HTTP/3 (QUIC UDP :443) & 0-RTT'}</label>
              <select id="stack-http3" name="http3" class="xp-select xp-mono">
                <option value="enabled" selected>Enabled (listen 443 quic reuseport + Alt-Svc h3=":443")</option>
                <option value="disabled">Disabled (HTTP/2 TLS 1.3 only)</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="stack-modsecurity">${isAr ? 'جدار الحماية ModSecurity WAF' : 'ModSecurity v3 WAF & OWASP CRS'}</label>
              <select id="stack-modsecurity" name="modsecurity" class="xp-select xp-mono">
                <option value="enforcement" selected>SecRuleEngine On (OWASP CRS 4.8 Anomaly Scoring)</option>
                <option value="detection">DetectionOnly (Audit Log without blocking)</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="stack-smarthost">${isAr ? 'مضيف ترحيل البريد الصادر (Postfix Smarthost)' : 'Outbound MTA Smarthost / RBL Policy'}</label>
              <input id="stack-smarthost" name="smarthost" type="text" class="xp-input xp-mono" dir="ltr" value="direct (zen.spamhaus.org + Greylisting enabled)" />
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button type="submit" class="xp-btn xp-btn--primary" data-action="apply-stack-builder">
              ${isAr ? 'بناء وفحص وتطبيق مكدس الويب' : 'Build, Test & Apply Web Stack Generation'}
            </button>
          </div>
        </form>
      </section>

      <!-- Extended 5: Cluster, Branding, Languages & WHMCS -->
      <section class="xp-card" id="whm-cluster-branding-whmcs" data-section="cluster-branding-languages-whmcs" aria-labelledby="whm-cluster-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="whm-cluster-heading">${
              isAr
                ? 'عنقود الخوادم المتعددة والعلامة التجارية وإدارة اللغات وتكامل الفوترة WHMCS'
                : 'Multi-Node Cluster Peers, Custom Branding, Language Manager & WHMCS Billing Integration'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'ربط عقد DNS والويب المتعددة، وتخصيص شعار وألوان اللوحة للموزعين، وتعديل ترجمات العربية والإنجليزية، وربط وحدة WHMCS التلقائية.'
                : 'Synchronize multi-node DNS/web cluster peers over mTLS, customize white-label panel branding, override EN/AR locale strings, and connect WHMCS billing provisioning.'
            }</p>
          </div>
          ${renderStatusBadge('ok', '3 Cluster Peers · WHMCS Connected')}
        </div>

        <div class="xp-golden-grid">
          <!-- Multi-Node Cluster Peers Table -->
          <div class="xp-card" data-cluster-peers-panel="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'عقد العنقود المتعددة (Multi-Node Cluster Peers)' : 'Multi-Node Cluster Peers (mTLS State Sync)'}</h3>
              ${renderStatusBadge('ok', '3/3 Peers Online')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'العقدة' : 'Node Hostname'}</th>
                    <th>${isAr ? 'الدور' : 'Cluster Role'}</th>
                    <th>${isAr ? 'الجيل / زمن الاستجابة' : 'Gen / RTT'}</th>
                    <th>${isAr ? 'الحالة' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-cluster-peer="srv1.xpanel.test">
                    <td class="xp-mono"><bdi dir="ltr">srv1.xpanel.test (10.0.0.12)</bdi></td>
                    <td>${renderStatusBadge('ok', 'Primary All-in-One')}</td>
                    <td class="xp-mono xp-tabular">Gen #142 · 0.2 ms</td>
                    <td>${renderStatusBadge('ok', 'Leader')}</td>
                  </tr>
                  <tr data-cluster-peer="ns2.xpanel.test">
                    <td class="xp-mono"><bdi dir="ltr">ns2.xpanel.test (10.0.0.52)</bdi></td>
                    <td>${renderStatusBadge('ok', 'DNS Secondary')}</td>
                    <td class="xp-mono xp-tabular">Gen #142 · 4.8 ms</td>
                    <td>${renderStatusBadge('ok', 'Synced')}</td>
                  </tr>
                  <tr data-cluster-peer="mta2.xpanel.test">
                    <td class="xp-mono"><bdi dir="ltr">mta2.xpanel.test (10.0.0.65)</bdi></td>
                    <td>${renderStatusBadge('ok', 'Backup MX Relay')}</td>
                    <td class="xp-mono xp-tabular">Gen #142 · 6.1 ms</td>
                    <td>${renderStatusBadge('ok', 'Synced')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Custom Panel Branding, Language Overrides & WHMCS Integration -->
          <div class="xp-form-group">
            <form class="xp-card xp-form-group" action="/api/whm/branding" method="post" data-branding-language-form="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'العلامة التجارية المخصصة وإدارة اللغات (EN / AR)' : 'Custom Panel Branding & Language Manager Overrides'}</h3>
                ${renderStatusBadge('ok', 'White-Label + BCP 47')}
              </div>
              <div class="xp-kpi-grid">
                <div>
                  <label class="xp-label" for="brand-company-name">${isAr ? 'اسم العلامة التجارية' : 'Brand / Company Name'}</label>
                  <input id="brand-company-name" name="brandName" type="text" class="xp-input" value="xPanel Cloud Hosting" />
                </div>
                <div>
                  <label class="xp-label" for="brand-locale-override">${isAr ? 'تخصيص مصطلحات اللغة (en / ar)' : 'Language Override Key (en / ar)'}</label>
                  <input id="brand-locale-override" name="localeOverride" type="text" class="xp-input xp-mono" dir="ltr" value="app.title = xPanel Enterprise Cloud" />
                </div>
              </div>
              <button type="submit" class="xp-btn" data-action="save-branding">
                ${isAr ? 'حفظ العلامة التجارية واللغات' : 'Save Branding & Locale Overrides'}
              </button>
            </form>

            <div class="xp-card" data-whmcs-integration="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'تكامل الفوترة التلقائي مع WHMCS' : 'WHMCS Billing & Auto-Provisioning Integration'}</h3>
                ${renderStatusBadge('ok', 'WHMCS Webhook Active')}
              </div>
              <p class="xp-prose">
                <code class="xp-mono"><bdi dir="ltr">POST /api/whm/whmcs · Actions: CreateAccount, SuspendAccount, UnsuspendAccount, TerminateAccount, ChangePackage</bdi></code>
              </p>
              <div style="margin-block-start: 10px;">
                <button type="button" class="xp-btn xp-btn--primary" data-action="test-whmcs-webhook" data-api-url="/api/whm/whmcs/test">
                  ${isAr ? 'اختبار اتصال WHMCS' : 'Verify WHMCS Module Connection'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
  `.trim()
}

/**
 * Renders the extended xPanel customer hosting sections:
 * 1. Deep Mail Suite (Domain Forwarders, GNU Mailman Mailing Lists, Global & User Sieve Filters, CSV Address Importer, Delivery Tracking / Track Delivery, CalDAV/CardDAV Client Config)
 * 2. Extended File & Web Isolation (Directory Privacy `.htpasswd`, Hotlink Protection, Web Disk WebDAV, Git Version Control & Push-to-Deploy with atomic release rollback, Custom Error Pages `400..500`, Redirects, IP Blocker)
 * 3. Databases Beyond MariaDB & Private Cache (PostgreSQL Databases & Users, Remote MySQL/Postgres Access Hosts, Database Check/Repair/Optimize, MongoDB, Private Per-Account Redis & Memcached on Unix sockets)
 * 4. Containers, 1-Click App Store, Staging & Legacy Analytics (Rootless Docker Containers in `xpanel-<uid>.slice`, 1-Click App Installer for WordPress/Laravel/Drupal/Ghost/Nextcloud with Staging Clone & Push-to-Live, AWStats & Webalizer Traffic Reports)
 */
export function renderPanelExtendedSections(locale: Locale = 'en'): string {
  const isAr = locale === 'ar'

  return `
      <!-- Extended Panel 1: Deep Mail Suite -->
      <section class="xp-card" id="xpanel-deep-mail-suite" data-section="deep-mail-suite" aria-labelledby="xpanel-deep-mail-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xpanel-deep-mail-heading">${
              isAr
                ? 'منظومة البريد المتقدمة (محولات النطاق، قوائم Mailman، مرشحات Sieve، استيراد CSV، تتبع التسليم، وCalDAV/CardDAV)'
                : 'Deep Mail Suite: Domain Forwarders, GNU Mailman Lists, Sieve Filters, CSV Importer, Track Delivery & CalDAV/CardDAV'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'إدارة التحويل الشامل بين النطاقات، قوائم البريد GNU Mailman، مرشحات Sieve الشاملة، استيراد العناوين من ملفات CSV، سجل تتبع تسليم الرسائل، وإعدادات المزامنة CalDAV/CardDAV.'
                : 'Configure domain-wide forwarders, GNU Mailman mailing lists, global & user Pigeonhole Sieve scripts, bulk CSV mailbox/forwarder imports, live SMTP/LMTP delivery tracking, and CalDAV/CardDAV client auto-discovery.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'Postfix + Dovecot + Mailman + DAV')}
        </div>

        <div class="xp-kpi-grid" style="margin-block-end: var(--xp-space-card);">
          <!-- Domain Forwarders -->
          <div class="xp-card" data-domain-forwarders="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'محولات النطاق الكاملة (Domain Forwarders)' : 'Domain Forwarders'}</strong>
              ${renderStatusBadge('ok', '2 Active Maps')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">@alice-blog.net → @alice-shop.com<br/>@alice.store → @alice-shop.com</bdi></code></p>
          </div>

          <!-- GNU Mailman Mailing Lists -->
          <div class="xp-card" data-mailman-lists="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'قوائم البريد (GNU Mailman)' : 'GNU Mailman Mailing Lists'}</strong>
              ${renderStatusBadge('ok', '2 Lists · 1,420 Subscribers')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">announce@alice-shop.com (1,180)<br/>vip@alice-shop.com (240)</bdi></code></p>
          </div>

          <!-- Global & User Sieve Filters -->
          <div class="xp-card" data-global-user-sieve="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'مرشحات Sieve الشاملة وللمستخدمين' : 'Global & User Sieve Filters'}</strong>
              ${renderStatusBadge('ok', 'sievec Compiled')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">/home/alice/mail/.dovecot.sieve (Global Spam + Billing Router)</bdi></code></p>
          </div>

          <!-- CalDAV / CardDAV Client Config -->
          <div class="xp-card" data-caldav-carddav-config="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'إعدادات CalDAV / CardDAV' : 'CalDAV / CardDAV Client Config'}</strong>
              ${renderStatusBadge('ok', 'TLS :2080 Auto-Discovery')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">https://alice-shop.com:2080/.well-known/caldav &amp; /carddav</bdi></code></p>
          </div>
        </div>

        <div class="xp-golden-grid">
          <!-- Delivery Tracking / Track Delivery Table -->
          <div class="xp-card" data-delivery-tracking="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'تتبع تسليم الرسائل (Track Delivery / Postfix Log)' : 'Delivery Tracking (Track Delivery — Outbound & Inbound)'}</h3>
              ${renderStatusBadge('ok', '99.8% Delivered')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'الوقت' : 'Timestamp'}</th>
                    <th>${isAr ? 'المرسل ← المستلم' : 'Sender → Recipient'}</th>
                    <th>${isAr ? 'استجابة خادم البريد / IP' : 'Remote MX Response & Bound IP'}</th>
                    <th>${isAr ? 'الحالة' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="xp-mono xp-tabular">14:04:18Z</td>
                    <td class="xp-mono"><bdi dir="ltr">orders@alice-shop.com → recipient-1@example.net</bdi></td>
                    <td class="xp-mono"><bdi dir="ltr">250 2.0.0 OK (10.0.0.21 · TLSv1.3)</bdi></td>
                    <td>${renderStatusBadge('ok', 'Delivered')}</td>
                  </tr>
                  <tr>
                    <td class="xp-mono xp-tabular">14:01:05Z</td>
                    <td class="xp-mono"><bdi dir="ltr">announce@alice-shop.com → recipient-2@example.net</bdi></td>
                    <td class="xp-mono"><bdi dir="ltr">250 2.6.0 Queued mail for delivery (10.0.0.21)</bdi></td>
                    <td>${renderStatusBadge('ok', 'Delivered')}</td>
                  </tr>
                  <tr>
                    <td class="xp-mono xp-tabular">13:55:40Z</td>
                    <td class="xp-mono"><bdi dir="ltr">spam-bot@bad-host.invalid → info@alice-shop.com</bdi></td>
                    <td class="xp-mono"><bdi dir="ltr">554 5.7.1 Rejected by RBL zen.spamhaus.org</bdi></td>
                    <td>${renderStatusBadge('critical', 'Rejected')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- CSV Address Importer -->
          <form class="xp-card xp-form-group" action="/api/xpanel/mail/import-csv" method="post" data-csv-mail-importer="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'مستورد الحسابات والمحولات عبر CSV' : 'Bulk CSV Mailbox & Forwarder Importer'}</h3>
              ${renderStatusBadge('ok', 'Dry-Run Validator')}
            </div>
            <div>
              <label class="xp-label" for="csv-mail-payload">${isAr ? 'بيانات CSV (email,password,quota_mb)' : 'CSV Payload (email,password,quota_mb)'}</label>
              <textarea id="csv-mail-payload" name="csvData" rows="4" class="xp-textarea xp-mono" dir="ltr">support@alice-shop.com,StrongPass#2026,2048
billing@alice-shop.com,BillingPass#2026,2048
returns@alice-shop.com,ReturnsPass#2026,1024</textarea>
            </div>
            <button type="submit" class="xp-btn xp-btn--primary" data-action="import-mail-csv">
              ${isAr ? 'فحص واستيراد عناوين CSV' : 'Validate & Import CSV Mailboxes'}
            </button>
          </form>
        </div>
      </section>

      <!-- Extended Panel 2: Extended File & Web Isolation -->
      <section class="xp-card" id="xpanel-extended-web-isolation" data-section="extended-file-web-isolation" aria-labelledby="xpanel-web-isolation-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xpanel-web-isolation-heading">${
              isAr
                ? 'العزل المتقدم للملفات والويب (خصوصية المجلدات، منع السرقة، WebDAV، التحكم بالإصدارات Git، صفحات الخطأ، التحويلات، وحظر IP)'
                : 'Extended File & Web Isolation: Directory Privacy, Hotlink Protection, Web Disk, Git Push-to-Deploy, Error Pages, Redirects & IP Blocker'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'حماية المجلدات بكلمة مرور (.htpasswd)، وحماية الروابط الساخنة، وقرص الويب WebDAV، ونشر Git الذري مع التراجع الفوري، وصفحات الخطأ 400..500، والتحويلات، وحظر عناوين IP.'
                : 'Protect directories with .htpasswd auth_basic, block hotlinking, mount WebDAV Web Disk, deploy via Git with atomic symlink release rollback, and configure custom 400..500 error pages, redirects, and IP blocks.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'Jailed Web Isolation Active')}
        </div>

        <div class="xp-kpi-grid" style="margin-block-end: var(--xp-space-card);">
          <!-- Directory Privacy (.htpasswd) -->
          <div class="xp-card" data-directory-privacy="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'خصوصية المجلدات (.htpasswd)' : 'Directory Privacy (.htpasswd)'}</strong>
              ${renderStatusBadge('ok', '2 Protected Dirs')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">/home/alice/public_html/staging-admin (Argon2/bcrypt auth_basic)</bdi></code></p>
          </div>

          <!-- Hotlink Protection -->
          <div class="xp-card" data-hotlink-protection="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'حماية الروابط الساخنة (Hotlink Protection)' : 'Hotlink Protection'}</strong>
              ${renderStatusBadge('ok', 'Active')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">Protected: jpg,jpeg,png,webp,gif,mp4,pdf · Allow: alice-shop.com, alice-blog.net</bdi></code></p>
          </div>

          <!-- Web Disk (WebDAV) -->
          <div class="xp-card" data-web-disk-webdav="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'قرص الويب (Web Disk / WebDAV)' : 'Web Disk (WebDAV over TLS)'}</strong>
              ${renderStatusBadge('ok', 'Port :2078 Chrooted')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">https://alice-shop.com:2078/home/alice (0640/0750 enforced)</bdi></code></p>
          </div>

          <!-- Custom Error Pages, Redirects & IP Blocker -->
          <div class="xp-card" data-error-pages-redirects-ipblocker="true">
            <div class="xp-card__header">
              <strong>${isAr ? 'صفحات الخطأ 400..500 والتحويلات وحظر IP' : 'Error Pages (400..500), Redirects & IP Blocker'}</strong>
              ${renderStatusBadge('ok', 'userdata synced')}
            </div>
            <p class="xp-prose"><code class="xp-mono"><bdi dir="ltr">Errors: 400, 401, 403, 404, 500, 503 · Redirects: 4 (301/302) · Blocked CIDRs: 198.51.100.99/32</bdi></code></p>
          </div>
        </div>

        <!-- Git Version Control & Push-to-Deploy with Atomic Release Rollback -->
        <div class="xp-card" data-git-deploy-panel="true">
          <div class="xp-card__header">
            <div>
              <h3>${isAr ? 'إدارة الإصدارات Git والنشر التلقائي الذري والتراجع الفوري' : 'Git Version Control & Push-to-Deploy with Atomic Release Rollback'}</h3>
              <p class="xp-prose">
                <bdi dir="ltr" class="xp-mono">Repo: ssh://alice@alice-shop.com/~/repos/shop.git · Branch: main → /home/alice/releases/20261022-140500 (symlinked to /home/alice/public_html)</bdi>
              </p>
            </div>
            ${renderStatusBadge('ok', 'Release #24 Active (sha: 8f91c2a)')}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table xp-table--compact">
              <thead>
                <tr>
                  <th>${isAr ? 'الإصدار' : 'Release'}</th>
                  <th>Commit</th>
                  <th>${isAr ? 'المسار الذري' : 'Atomic Release Directory'}</th>
                  <th>${isAr ? 'الحالة' : 'Status'}</th>
                  <th>${isAr ? 'الإجراء' : 'Action'}</th>
                </tr>
              </thead>
              <tbody>
                <tr data-git-release="20261022-140500">
                  <td class="xp-mono xp-tabular"><strong>#24</strong></td>
                  <td class="xp-mono"><bdi dir="ltr">8f91c2a — Optimize checkout OPcache preload</bdi></td>
                  <td><code class="xp-mono"><bdi dir="ltr">/home/alice/releases/20261022-140500</bdi></code></td>
                  <td>${renderStatusBadge('ok', 'Current symlink')}</td>
                  <td>
                    <button type="button" class="xp-btn" data-action="git-deploy-now" data-api-url="/api/xpanel/git/deploy">
                      ${isAr ? 'نشر الآن' : 'Deploy HEAD'}
                    </button>
                  </td>
                </tr>
                <tr data-git-release="20261021-183000">
                  <td class="xp-mono xp-tabular"><strong>#23</strong></td>
                  <td class="xp-mono"><bdi dir="ltr">4d12b09 — Add Arabic RTL invoice PDF template</bdi></td>
                  <td><code class="xp-mono"><bdi dir="ltr">/home/alice/releases/20261021-183000</bdi></code></td>
                  <td>${renderStatusBadge('suspended', 'Previous release')}</td>
                  <td>
                    <button type="button" class="xp-btn" data-action="git-rollback-release" data-release="20261021-183000" data-api-url="/api/xpanel/git/rollback">
                      ${isAr ? 'التراجع الذري إلى #23' : 'Atomic Rollback to #23'}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- Extended Panel 3: Databases Beyond MariaDB & Private Cache -->
      <section class="xp-card" id="xpanel-extended-databases-cache" data-section="databases-beyond-mariadb-cache" aria-labelledby="xpanel-ext-db-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xpanel-ext-db-heading">${
              isAr
                ? 'قواعد البيانات المتقدمة (PostgreSQL وMongoDB والمضيفون البعيدون وفحص/إصلاح الجداول) والتخزين المؤقت الخاص (Redis / Memcached)'
                : 'Databases Beyond MariaDB (PostgreSQL, MongoDB, Remote Hosts, Check/Repair/Optimize) & Private Unix-Socket Cache (Redis & Memcached)'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'إدارة قواعد بيانات PostgreSQL وMongoDB، وتفويض عناوين الاتصال عن بُعد، وفحص وإصلاح وتحسين الجداول، وتشغيل Redis وMemcached بمقابس Unix معزولة داخل شريحة الحساب.'
                : 'Manage PostgreSQL 16 and MongoDB 7 databases, authorize remote SQL access hosts, run check/repair/optimize diagnostics, and operate private per-account Redis & Memcached instances on Unix sockets inside xpanel-20014.slice.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'MariaDB + PostgreSQL + MongoDB + Private Redis/Memcached')}
        </div>

        <div class="xp-golden-grid">
          <!-- PostgreSQL, MongoDB & Check/Repair/Optimize Table -->
          <div class="xp-card" data-multi-engine-databases="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'قواعد بيانات PostgreSQL وMongoDB وفحص/إصلاح/تحسين الجداول' : 'PostgreSQL, MongoDB & Database Check / Repair / Optimize'}</h3>
              ${renderStatusBadge('ok', 'SCRAM-SHA-256 Isolated')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'قاعدة البيانات والمستخدم' : 'Database & Role'}</th>
                    <th>${isAr ? 'المحرك' : 'Engine'}</th>
                    <th>${isAr ? 'الحجم' : 'Size'}</th>
                    <th>${isAr ? 'الحالة' : 'Health'}</th>
                    <th>${isAr ? 'الصيانة (Check / Repair / Optimize)' : 'Maintenance Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-ext-db="alice_analytics">
                    <td class="xp-mono"><bdi dir="ltr">alice_analytics (user: alice_pg)</bdi></td>
                    <td>${renderStatusBadge('ok', 'PostgreSQL 16')}</td>
                    <td class="xp-mono xp-tabular">412 MB</td>
                    <td>${renderStatusBadge('ok', 'Healthy')}</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="db-check" data-db="alice_analytics">Check</button>
                      <button type="button" class="xp-btn" data-action="db-optimize" data-db="alice_analytics">VACUUM ANALYZE</button>
                    </td>
                  </tr>
                  <tr data-ext-db="alice_shop">
                    <td class="xp-mono"><bdi dir="ltr">alice_shop (user: alice_sql)</bdi></td>
                    <td>${renderStatusBadge('ok', 'MariaDB 10.11')}</td>
                    <td class="xp-mono xp-tabular">284 MB</td>
                    <td>${renderStatusBadge('ok', 'InnoDB OK')}</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="db-check" data-db="alice_shop">Check</button>
                      <button type="button" class="xp-btn" data-action="db-repair" data-db="alice_shop">Repair</button>
                      <button type="button" class="xp-btn" data-action="db-optimize" data-db="alice_shop">Optimize</button>
                    </td>
                  </tr>
                  <tr data-ext-db="alice_catalog">
                    <td class="xp-mono"><bdi dir="ltr">alice_catalog (user: alice_mongo)</bdi></td>
                    <td>${renderStatusBadge('ok', 'MongoDB 7.0')}</td>
                    <td class="xp-mono xp-tabular">196 MB</td>
                    <td>${renderStatusBadge('ok', 'WiredTiger OK')}</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="db-optimize" data-db="alice_catalog">Compact</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Remote SQL Access Hosts + Private Unix-Socket Redis & Memcached -->
          <div class="xp-form-group">
            <div class="xp-card" data-remote-sql-hosts="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'مضيفو الوصول عن بُعد (Remote MySQL / Postgres Access Hosts)' : 'Remote MySQL & PostgreSQL Access Hosts'}</h3>
                ${renderStatusBadge('ok', 'TLS Required')}
              </div>
              <p class="xp-prose">
                <code class="xp-mono"><bdi dir="ltr">Allowlisted CIDRs: 203.0.113.50/32 (BI Analytics Worker), 198.51.100.14/32 (ERP Sync)</bdi></code>
              </p>
            </div>

            <div class="xp-card" data-private-unix-cache="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'خوادم Redis وMemcached الخاصة عبر مقابس Unix' : 'Private Per-Account Redis & Memcached (Unix Sockets)'}</h3>
                ${renderStatusBadge('ok', 'xpanel-20014.slice · 0660')}
              </div>
              <p class="xp-prose">
                <code class="xp-mono"><bdi dir="ltr">Redis 7.2: /home/alice/.run/redis.sock (maxmemory 128mb)<br/>Memcached: /home/alice/.run/memcached.sock (64mb)</bdi></code>
              </p>
              ${renderThresholdMeter(54, 128, 'MB')}
              <div style="margin-block-start: 10px; display: flex; gap: 8px;">
                <button type="button" class="xp-btn" data-action="flush-private-cache" data-api-url="/api/xpanel/cache/flush">
                  ${isAr ? 'إفراغ ذاكرة Redis / Memcached' : 'Flush Private Redis & Memcached'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Extended Panel 4: Containers, 1-Click App Store, Staging & Legacy Analytics -->
      <section class="xp-card" id="xpanel-containers-apps-analytics" data-section="containers-appstore-staging-analytics" aria-labelledby="xpanel-containers-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xpanel-containers-heading">${
              isAr
                ? 'الحاويات المعزولة ومتجر التطبيقات بنقرة واحدة مع بيئة التجربة (Staging) وتقارير AWStats / Webalizer'
                : 'Rootless Containers in xpanel-<uid>.slice, 1-Click App Installer (Staging Clone & Push-to-Live) & AWStats / Webalizer'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'تشغيل حاويات Docker/Podman بدون صلاحيات الجذر داخل شريحة الحساب، وتثبيت WordPress وLaravel وDrupal وGhost وNextcloud مع نسخ بيئة التجربة والنشر المباشر، واستعراض تقارير AWStats وWebalizer.'
                : 'Run rootless Docker/Podman containers confined to xpanel-20014.slice, install WordPress, Laravel, Drupal, Ghost, or Nextcloud with one-click Staging Clone & Push-to-Live, and inspect AWStats & Webalizer reports.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'Rootless Slice Containers + 5 Apps')}
        </div>

        <div class="xp-golden-grid">
          <!-- 1-Click App Installer + Staging Clone & Push-to-Live -->
          <div class="xp-card" data-one-click-app-store="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'مثبت التطبيقات بنقرة واحدة وبيئة التجربة (WordPress / Laravel / Drupal / Ghost / Nextcloud)' : '1-Click App Store & Staging Clone / Push-to-Live'}</h3>
              ${renderStatusBadge('ok', 'WordPress · Laravel · Drupal · Ghost · Nextcloud')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'التطبيق والنطاق' : 'Application & Domain'}</th>
                    <th>${isAr ? 'البيئة' : 'Environment'}</th>
                    <th>${isAr ? 'الإصدار' : 'Version'}</th>
                    <th>${isAr ? 'إجراءات Staging والنشر' : 'Staging Clone & Push-to-Live'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-installed-app="wordpress-live">
                    <td><strong>WordPress</strong> — <code class="xp-mono"><bdi dir="ltr">alice-shop.com</bdi></code></td>
                    <td>${renderStatusBadge('ok', 'Production')}</td>
                    <td class="xp-mono">6.7.1 (PHP 8.3)</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="app-clone-staging" data-app="wordpress" data-api-url="/api/xpanel/apps/staging-clone">
                        ${isAr ? 'نسخ إلى Staging' : 'Clone to Staging'}
                      </button>
                    </td>
                  </tr>
                  <tr data-installed-app="wordpress-staging">
                    <td><strong>WordPress Staging</strong> — <code class="xp-mono"><bdi dir="ltr">staging.alice-shop.com</bdi></code></td>
                    <td>${renderStatusBadge('warn', 'Staging Clone')}</td>
                    <td class="xp-mono">6.7.1 (PHP 8.3)</td>
                    <td>
                      <button type="button" class="xp-btn xp-btn--primary" data-action="app-push-to-live" data-app="wordpress" data-api-url="/api/xpanel/apps/push-to-live">
                        ${isAr ? 'دفع إلى الإنتاج (Push-to-Live)' : 'Push-to-Live'}
                      </button>
                    </td>
                  </tr>
                  <tr data-installed-app="laravel-crm">
                    <td><strong>Laravel</strong> / <strong>Drupal</strong> / <strong>Ghost</strong> / <strong>Nextcloud</strong></td>
                    <td>${renderStatusBadge('ok', '1-Click Ready')}</td>
                    <td class="xp-mono">Latest LTS</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="install-one-click-app" data-api-url="/api/xpanel/apps/install">
                        ${isAr ? 'تثبيت بنقرة واحدة' : '1-Click Install'}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Rootless Containers in xpanel-<uid>.slice + AWStats & Webalizer -->
          <div class="xp-form-group">
            <div class="xp-card" data-rootless-containers="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'حاويات Docker بدون جذر في xpanel-20014.slice' : 'Rootless Docker Containers (xpanel-20014.slice)'}</h3>
                ${renderStatusBadge('ok', '2 Containers Running')}
              </div>
              <p class="xp-prose">
                <code class="xp-mono"><bdi dir="ltr">1. meilisearch:v1.11 → 127.0.0.1:7700 (180 MB)<br/>2. ghost:5-alpine → 127.0.0.1:2368 (140 MB)</bdi></code>
              </p>
              ${renderThresholdMeter(320, 1024, 'MB')}
            </div>

            <div class="xp-card" data-awstats-webalizer="true">
              <div class="xp-card__header">
                <h3>${isAr ? 'تقارير الزيارات الكلاسيكية (AWStats & Webalizer)' : 'AWStats & Webalizer Traffic Reports'}</h3>
                ${renderStatusBadge('ok', 'Updated Hourly')}
              </div>
              <p class="xp-prose">
                ${isAr ? 'إحصائيات شهرية ويومية مفصلة للمتصفحات وعناكب البحث والكلمات المفتاحية واستهلاك النطاق.' : 'Historical monthly & daily breakdowns for unique visitors, crawlers, HTTP status codes, and file-type bandwidth.'}
              </p>
              <div style="display: flex; gap: 8px; margin-block-start: 8px;">
                <a href="/analytics/awstats" class="xp-btn" data-nav-route="/analytics/awstats">AWStats (alice-shop.com)</a>
                <a href="/analytics/webalizer" class="xp-btn" data-nav-route="/analytics/webalizer">Webalizer Charts</a>
              </div>
            </div>
          </div>
        </div>
      </section>
  `.trim()
}

/**
 * Renders the extended xMail Webmail & Collaboration sections:
 * 1. Full-Text Mailbox Search (search bar + filter chips for folder, sender, date, attachment)
 * 2. Multiple Identities & Rich Signatures (HTML/Plaintext signature editor per identity)
 * 3. Inbound Sieve Filter Rules Builder (condition + action rule builder & table)
 * 4. Shared Calendars (`CalDAV`) & Contacts (`CardDAV`) (calendar sharing ACL modal/panel with `read` / `read-write` permissions and address book contacts list)
 */
export function renderMailExtendedSections(locale: Locale = 'en'): string {
  const isAr = locale === 'ar'

  return `
      <!-- Extended xMail 1: Full-Text Mailbox Search (Dovecot FTS + Filter Chips) -->
      <section class="xp-card" id="xmail-fulltext-search" data-section="mail-fulltext-search" aria-labelledby="xmail-search-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xmail-search-heading">${
              isAr
                ? 'البحث النصي الكامل في البريد والمرفقات (Full-Text Mailbox Search)'
                : 'Full-Text Mailbox Search (Dovecot FTS) & Filter Chips'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'بحث فوري في نصوص الرسائل والعناوين والمرفقات مع شرائح تصفية حسب المجلد والمرسل والتاريخ والمرفقات.'
                : 'Search across message bodies, headers, and attachment filenames with instant filter chips for folder, sender, date range, and attachments.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'Dovecot FTS Indexed')}
        </div>

        <form class="xp-form-group" action="/api/mail/search" method="get" data-mail-search-form="true">
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <label class="xp-sr-only" for="xmail-fts-query">${isAr ? 'ابحث في جميع الرسائل' : 'Search all messages'}</label>
            <input
              id="xmail-fts-query"
              name="q"
              type="search"
              class="xp-input xp-mono"
              style="flex: 1 1 320px;"
              placeholder="${isAr ? 'ابحث في الموضوع، المحتوى، المرسل، أو اسم المرفق...' : 'Search subject, body, sender, or attachment (e.g. from:stripe.com has:attachment)...'}"
              value="from:stripe.com payout"
            />
            <button type="submit" class="xp-btn xp-btn--primary" data-action="run-mail-search">
              ${isAr ? 'بحث في البريد' : 'Search Mailbox'}
            </button>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;" role="group" aria-label="Search filter chips" data-mail-filter-chips="true">
            <span class="xp-label">${isAr ? 'مرشحات سريعة:' : 'Filter chips:'}</span>
            <button type="button" class="xp-btn" data-filter-chip="folder" data-filter-value="INBOX">${renderStatusBadge('ok', 'folder: INBOX')}</button>
            <button type="button" class="xp-btn" data-filter-chip="sender" data-filter-value="stripe.com">${renderStatusBadge('ok', 'sender: stripe.com')}</button>
            <button type="button" class="xp-btn" data-filter-chip="date" data-filter-value="7d">${renderStatusBadge('ok', 'date: last 7 days')}</button>
            <button type="button" class="xp-btn" data-filter-chip="attachment" data-filter-value="has:attachment">${renderStatusBadge('warn', 'attachment: has:attachment')}</button>
          </div>
        </form>
      </section>

      <!-- Extended xMail 2: Multiple Identities & Rich Signatures + Inbound Sieve Rules Builder -->
      <div class="xp-golden-grid" id="xmail-identities-sieve-builder">
        <!-- Multiple Identities & Rich Signatures (HTML / Plaintext) -->
        <section class="xp-card" data-section="mail-identities-signatures" aria-labelledby="xmail-identities-heading">
          <div class="xp-card__header">
            <div>
              <h2 id="xmail-identities-heading">${
                isAr
                  ? 'الهويات المتعددة والتوقيعات الغنية (HTML / نص عادي)'
                  : 'Multiple Sender Identities & Rich HTML / Plaintext Signatures'
              }</h2>
              <p class="xp-prose">${
                isAr
                  ? 'إدارة هويات المرسل والاسم المعروض وعنوان الرد مع محرر توقيع HTML أو نص عادي لكل هوية.'
                  : 'Manage sender identities, display names, Reply-To headers, and per-identity HTML or Plaintext signatures.'
              }</p>
            </div>
            ${renderStatusBadge('ok', '3 Identities Configured')}
          </div>

          <form class="xp-form-group" action="/api/mail/identities" method="post" data-mail-identity-form="true">
            <div class="xp-kpi-grid">
              <div>
                <label class="xp-label" for="identity-select">${isAr ? 'هوية المرسل' : 'Sender Identity'}</label>
                <select id="identity-select" name="identityEmail" class="xp-select xp-mono">
                  <option value="info@alice-shop.com" selected>Alice Shop Support &lt;info@alice-shop.com&gt; (Default)</option>
                  <option value="sales@alice-shop.com">Alice Shop Sales &lt;sales@alice-shop.com&gt;</option>
                  <option value="billing@alice-shop.com">Alice Shop Billing &lt;billing@alice-shop.com&gt;</option>
                </select>
              </div>
              <div>
                <label class="xp-label" for="signature-format">${isAr ? 'تنسيق التوقيع' : 'Signature Format'}</label>
                <select id="signature-format" name="format" class="xp-select">
                  <option value="html" selected>Rich HTML Signature</option>
                  <option value="plaintext">Plaintext Signature</option>
                </select>
              </div>
            </div>
            <div>
              <label class="xp-label" for="signature-editor">${isAr ? 'محرر التوقيع (HTML / Plaintext)' : 'Signature Content (HTML / Plaintext)'}</label>
              <textarea id="signature-editor" name="signature" rows="4" class="xp-textarea xp-mono" dir="ltr">&lt;strong&gt;Alice Shop Operations&lt;/strong&gt;&lt;br/&gt;
Orders &amp; Merchant Support · https://alice-shop.com&lt;br/&gt;
PGP Fingerprint: 4F92 881C E012 994A</textarea>
            </div>
            <button type="submit" class="xp-btn xp-btn--primary" data-action="save-mail-signature">
              ${isAr ? 'حفظ الهوية والتوقيع' : 'Save Identity & Signature'}
            </button>
          </form>
        </section>

        <!-- Inbound Sieve Filter Rules Builder -->
        <section class="xp-card" data-section="inbound-sieve-builder" aria-labelledby="xmail-sieve-builder-heading">
          <div class="xp-card__header">
            <h2 id="xmail-sieve-builder-heading">${
              isAr
                ? 'منشئ قواعد تصفية الرسائل الواردة (Inbound Sieve Rules Builder)'
                : 'Inbound Sieve Filter Rules Builder (Condition + Action)'
            }</h2>
            ${renderStatusBadge('ok', 'Pigeonhole Sieve')}
          </div>

          <form class="xp-form-group" action="/api/mail/sieve/rules" method="post" data-sieve-builder-form="true">
            <div>
              <label class="xp-label" for="sieve-rule-name">${isAr ? 'اسم القاعدة' : 'Rule Name'}</label>
              <input id="sieve-rule-name" name="ruleName" type="text" class="xp-input" value="Move VIP Invoices to Billing" />
            </div>
            <div class="xp-kpi-grid">
              <div>
                <label class="xp-label" for="sieve-condition-field">${isAr ? 'الشرط (Condition)' : 'Condition Match'}</label>
                <select id="sieve-condition-field" name="condition" class="xp-select xp-mono">
                  <option value="header :contains &quot;Subject&quot; &quot;Invoice&quot;">Subject contains "Invoice"</option>
                  <option value="address :domain :is &quot;from&quot; &quot;stripe.com&quot;">From domain is "stripe.com"</option>
                  <option value="header :contains &quot;X-Spam-Flag&quot; &quot;YES&quot;">X-Spam-Flag contains "YES"</option>
                  <option value="size :over 5M">Message size over 5 MB</option>
                </select>
              </div>
              <div>
                <label class="xp-label" for="sieve-action-field">${isAr ? 'الإجراء (Action)' : 'Rule Action'}</label>
                <select id="sieve-action-field" name="action" class="xp-select xp-mono">
                  <option value="fileinto &quot;Billing&quot;; stop;">File into folder "Billing" &amp; stop</option>
                  <option value="fileinto &quot;Spam Quarantine&quot;; stop;">Move to "Spam Quarantine"</option>
                  <option value="redirect &quot;accounting@alice-shop.com&quot;; keep;">Forward copy to accounting@alice-shop.com</option>
                  <option value="addflag &quot;\\Seen&quot;;">Mark as Read (\\Seen)</option>
                </select>
              </div>
            </div>
            <button type="submit" class="xp-btn xp-btn--primary" data-action="add-sieve-rule">
              ${isAr ? 'إضافة وتفعيل قاعدة Sieve' : 'Add & Compile Sieve Rule'}
            </button>
          </form>
        </section>
      </div>

      <!-- Extended xMail 3: Shared Calendars (CalDAV) & Contacts (CardDAV) -->
      <section class="xp-card" id="xmail-caldav-carddav" data-section="shared-calendars-contacts" aria-labelledby="xmail-dav-heading">
        <div class="xp-card__header">
          <div>
            <h2 id="xmail-dav-heading">${
              isAr
                ? 'التقاويم المشتركة (CalDAV) ودفتر العناوين (CardDAV) وصلاحيات المشاركة (ACL)'
                : 'Shared Calendars (CalDAV ACL Modal) & Address Book Contacts (CardDAV)'
            }</h2>
            <p class="xp-prose">${
              isAr
                ? 'مشاركة التقاويم بصلاحيات القراءة فقط (read) أو القراءة والكتابة (read-write)، وإدارة جهات اتصال CardDAV المتزامنة.'
                : 'Share CalDAV calendars with granular read or read-write ACL permissions and manage CardDAV vCard 4.0 address book contacts.'
            }</p>
          </div>
          ${renderStatusBadge('ok', 'CalDAV + CardDAV Sync Active')}
        </div>

        <div class="xp-golden-grid">
          <!-- Calendar Sharing ACL Modal / Panel -->
          <div class="xp-card" role="region" aria-label="Calendar sharing ACL permissions" data-calendar-acl-modal="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'صلاحيات مشاركة التقويم (CalDAV ACL: read / read-write)' : 'Calendar Sharing ACL Permissions (read / read-write)'}</h3>
              ${renderStatusBadge('ok', 'Calendar: Operations Schedule')}
            </div>
            <div class="xp-table-wrap" style="margin-block-end: var(--xp-space-field);">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'المستخدم / المستفيد' : 'Principal / Grantee'}</th>
                    <th>${isAr ? 'مستوى الصلاحية (ACL)' : 'ACL Permission'}</th>
                    <th>${isAr ? 'رابط CalDAV' : 'CalDAV Collection URI'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-cal-acl-principal="sales@alice-shop.com">
                    <td class="xp-mono"><bdi dir="ltr">sales@alice-shop.com</bdi></td>
                    <td>${renderStatusBadge('ok', 'read-write')}</td>
                    <td><code class="xp-mono"><bdi dir="ltr">/dav/calendars/info@alice-shop.com/ops/</bdi></code></td>
                  </tr>
                  <tr data-cal-acl-principal="omar@omar-clinic.net">
                    <td class="xp-mono"><bdi dir="ltr">omar@omar-clinic.net</bdi></td>
                    <td>${renderStatusBadge('warn', 'read')}</td>
                    <td><code class="xp-mono"><bdi dir="ltr">/dav/calendars/info@alice-shop.com/ops/</bdi></code></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <form class="xp-form-group" action="/api/mail/calendars/acl" method="post" data-calendar-acl-form="true">
              <div class="xp-kpi-grid">
                <div>
                  <label class="xp-label" for="cal-acl-grantee">${isAr ? 'البريد الإلكتروني للمشارك' : 'Share With Mailbox'}</label>
                  <input id="cal-acl-grantee" name="grantee" type="email" class="xp-input xp-mono" dir="ltr" value="deploy@alice-shop.com" />
                </div>
                <div>
                  <label class="xp-label" for="cal-acl-permission">${isAr ? 'الصلاحية (read / read-write)' : 'Permission Level'}</label>
                  <select id="cal-acl-permission" name="permission" class="xp-select xp-mono">
                    <option value="read">read (View free/busy &amp; events)</option>
                    <option value="read-write" selected>read-write (Create, edit &amp; invite)</option>
                  </select>
                </div>
              </div>
              <button type="submit" class="xp-btn xp-btn--primary" data-action="save-calendar-acl">
                ${isAr ? 'منح صلاحية مشاركة التقويم' : 'Grant Calendar ACL Permission'}
              </button>
            </form>
          </div>

          <!-- CardDAV Address Book Contacts List -->
          <div class="xp-card" data-carddav-contacts-list="true">
            <div class="xp-card__header">
              <h3>${isAr ? 'دفتر عناوين جهات الاتصال (CardDAV Contacts)' : 'Address Book Contacts List (CardDAV vCard 4.0)'}</h3>
              ${renderStatusBadge('ok', '3 Contacts Synced')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table xp-table--compact">
                <thead>
                  <tr>
                    <th>${isAr ? 'الاسم والمؤسسة' : 'Full Name & Organization'}</th>
                    <th>${isAr ? 'البريد الإلكتروني' : 'Email'}</th>
                    <th>${isAr ? 'الحالة' : 'Sync'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-contact-email="omar@omar-clinic.net">
                    <td><strong>Dr. Omar Al-Mansoor</strong><br/><span style="font-size: 0.8rem; color: var(--xp-text-muted);">Omar Clinic Network</span></td>
                    <td class="xp-mono"><bdi dir="ltr">omar@omar-clinic.net</bdi></td>
                    <td>${renderStatusBadge('ok', 'vCard 4.0')}</td>
                  </tr>
                  <tr data-contact-email="rania@rania-media.org">
                    <td><strong>Rania Haddad</strong><br/><span style="font-size: 0.8rem; color: var(--xp-text-muted);">Rania Media Studio</span></td>
                    <td class="xp-mono"><bdi dir="ltr">rania@rania-media.org</bdi></td>
                    <td>${renderStatusBadge('ok', 'vCard 4.0')}</td>
                  </tr>
                  <tr data-contact-email="settlements@stripe.com">
                    <td><strong>Stripe Merchant Payouts</strong><br/><span style="font-size: 0.8rem; color: var(--xp-text-muted);">Stripe Payments Europe</span></td>
                    <td class="xp-mono"><bdi dir="ltr">settlements@stripe.com</bdi></td>
                    <td>${renderStatusBadge('ok', 'vCard 4.0')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
  `.trim()
}
