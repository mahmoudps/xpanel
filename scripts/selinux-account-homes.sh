#!/bin/bash
# SELinux policy of account homes on EL. The installer runs it, and the agent runs it at startup on a host whose
# stamp differs, because an upgrade never reruns the installer. Safe to run again.
# docs/decisions/2026-11-07-el-account-home-contexts.md explains the types.
set -euo pipefail

context() {
  semanage fcontext -a -t "$1" "$2" 2> /dev/null || semanage fcontext -m -t "$1" "$2"
}

# Apache and PHP-FPM cross /home/<user>, which keeps the policy's user_home_dir_t that sshd and Dovecot expect.
setsebool -P httpd_enable_homedirs 1
# Everything PHP may open under its open_basedir. Dot entries keep the policy's types; so do mail (Dovecot manages
# user_home_t), certificates, private settings and backups, which no web process has a reason to reach.
context httpd_sys_rw_content_t '/home/[^/]+/(?!(mail|etc|ssl|backups)(/|$))[^./][^/]*(/.*)?'
# Apache reads the Directory Privacy password files; PHP never changes them.
context httpd_sys_content_t '/home/[^/]+/\.htpasswds(/.*)?'
