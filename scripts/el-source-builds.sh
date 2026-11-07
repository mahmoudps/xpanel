#!/bin/bash
# What no EL repository ships, built from pinned upstream releases. install.sh sources this file; the agent runs it with
# one module name, inside a resource-limited unit, after a distribution update left that module behind.

# Upstream mpm-itk 2.4.7-04 as archived by Debian (orig tarball); the pin is the SHA-256 in Debian's signed source metadata.
EL_MPM_ITK_URL="https://deb.debian.org/debian/pool/main/m/mpm-itk/mpm-itk_2.4.7-04.orig.tar.gz"
EL_MPM_ITK_SHA256="609f83e8995416c5491348e07139f26046a579db20cf8488ebf75d314668efcf"
EL_MPM_ITK_MODULE="/usr/lib64/httpd/modules/mpm_itk.so"

# 00-mpm.conf, which loads the module on prefork, comes from the OS profile configuration (apply_os_configuration).
install_el_mpm_itk() {
  local build
  build="$(mktemp -d)"
  if ! fetch_el_source "$EL_MPM_ITK_URL" "$EL_MPM_ITK_SHA256" "$build" \
    || ! (cd "$build" && ./configure --with-apxs=/usr/bin/apxs > /dev/null && make > /dev/null); then
    rm -rf -- "$build"
    die "Apache mpm-itk could not be fetched, verified or built."
  fi
  install -o root -g root -m 0755 -- "$build/.libs/mpm_itk.so" "$EL_MPM_ITK_MODULE"
  rm -rf -- "$build"
}

# Upstream Webalizer 2.23-08 and AWStats 8.0 as archived by Debian (orig tarballs); each pin is the SHA-256 in Debian's signed source metadata.
# Both stay outside the package database, so their build inputs stay installed: they hold the libraries the build links.
EL_WEBALIZER_URL="https://deb.debian.org/debian/pool/main/w/webalizer/webalizer_2.23.08.orig.tar.gz"
EL_WEBALIZER_SHA256="edaddb5aa41cc4a081a1500e3fa96615d4b41bc12086bcedf9938018ce79ed8d"
EL_WEBALIZER_BINARY="/usr/bin/webalizer"
EL_AWSTATS_URL="https://deb.debian.org/debian/pool/main/a/awstats/awstats_8.0.orig.tar.gz"
EL_AWSTATS_SHA256="3ef76ff96c5398477dd8a11134e266e538a487067f6906a3ac8a38bfd11c11e0"
EL_AWSTATS_DIR="/usr/share/awstats/wwwroot/cgi-bin"

# Nothing is unpacked before its digest matches.
fetch_el_source() {
  curl -fsS --proto =https --max-time 120 -o "$3/source.tar.gz" "$1" \
    && printf '%s  %s\n' "$2" "$3/source.tar.gz" | sha256sum -c --quiet \
    && tar -xzf "$3/source.tar.gz" -C "$3" --strip-components=1 --no-same-owner
}

# DNS lookups and the Berkeley DB they need stay out: the statistics run never resolves names in Webalizer.
# gnu89 is the dialect this source is written in; GCC 14 also needs -fpermissive for its older conversions.
install_el_webalizer() {
  local build output cflags="-O2 -std=gnu89 -fstack-protector-strong -D_FORTIFY_SOURCE=2"
  [[ "$OS_MAJOR" -ge 10 ]] && cflags+=" -fpermissive"
  build="$(mktemp -d)"
  # preserve.c moves its history over itself with memcpy, which corrupts it once the history is full.
  if ! fetch_el_source "$EL_WEBALIZER_URL" "$EL_WEBALIZER_SHA256" "$build" \
    || ! sed -i 's/memcpy(&hist\[0\],/memmove(\&hist[0],/' "$build/preserve.c" \
    || grep -q 'memcpy(&hist\[0\],' "$build/preserve.c" \
    || ! (cd "$build" && CFLAGS="$cflags" ./configure --disable-dns > /dev/null && make webalizer > /dev/null); then
    rm -rf -- "$build"
    die "Webalizer could not be fetched, verified or built."
  fi
  install -o root -g root -m 0755 -- "$build/webalizer" "$EL_WEBALIZER_BINARY"
  rm -rf -- "$build"
  # -V exits 1 by design, so only its output proves the binary loads.
  output="$("$EL_WEBALIZER_BINARY" -V 2> /dev/null || true)"
  [[ "$output" == "Webalizer V2.23-08"* ]] || die "Webalizer was built but does not run."
}

# awstats.pl is Perl, so nothing is compiled. The sed closes CVE-2025-63261, a two-argument open on a configured path.
install_el_awstats() {
  local build
  build="$(mktemp -d)"
  if ! fetch_el_source "$EL_AWSTATS_URL" "$EL_AWSTATS_SHA256" "$build" \
    || ! sed -i 's/open( DNSFILE, "$filetoload" )/open( DNSFILE, "<", "$filetoload" )/' "$build/wwwroot/cgi-bin/awstats.pl" \
    || ! grep -qF 'open( DNSFILE, "<", "$filetoload" )' "$build/wwwroot/cgi-bin/awstats.pl"; then
    rm -rf -- "$build"
    die "AWStats could not be fetched or verified."
  fi
  install -d -o root -g root -m 0755 -- "$(dirname -- "$EL_AWSTATS_DIR")"
  rm -rf -- "$EL_AWSTATS_DIR"
  cp -R -- "$build/wwwroot/cgi-bin" "$EL_AWSTATS_DIR"
  chown -R root:root -- "$EL_AWSTATS_DIR"
  chmod -R u=rwX,go=rX -- "$EL_AWSTATS_DIR"
  chmod 0755 -- "$EL_AWSTATS_DIR/awstats.pl"
  rm -rf -- "$build"
  perl -c "$EL_AWSTATS_DIR/awstats.pl" > /dev/null 2>&1 || die "AWStats was installed but its Perl modules do not load."
}

# Upstream fts-xapian 1.9.3 as archived by Debian (orig tarball); the pin is the SHA-256 in Debian's signed source metadata.
# Debian's package depends on the Dovecot ABI and this build does not, so the agent rebuilds it when dnf rebases Dovecot.
EL_FTS_URL="https://deb.debian.org/debian/pool/main/d/dovecot-fts-xapian/dovecot-fts-xapian_1.9.3.orig.tar.gz"
EL_FTS_SHA256="b2ab1623d45d19f3086e8044957b1572d65659849ccc19bd6b276dac07f98df7"
EL_FTS_MODULE="/usr/lib64/dovecot/lib21_fts_xapian_plugin.so"

# The source ships no configure script. Its settings module is empty on Dovecot 2.3, so only the plugin is installed.
install_el_fts_xapian() {
  local build flags="-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2"
  build="$(mktemp -d)"
  if ! fetch_el_source "$EL_FTS_URL" "$EL_FTS_SHA256" "$build" \
    || ! (cd "$build" && autoreconf -i > /dev/null && CFLAGS="$flags" CXXFLAGS="$flags" ./configure --with-dovecot=/usr/lib64/dovecot > /dev/null && make > /dev/null); then
    rm -rf -- "$build"
    die "The Dovecot search index plugin could not be fetched, verified or built."
  fi
  install -o root -g root -m 0755 -- "$build/src/.libs/lib21_fts_xapian_plugin.so" "$EL_FTS_MODULE"
  rm -rf -- "$build"
}

EL_SOURCE_BUILD_DIR="/var/lib/xpanel/source-builds"
EL_SOURCE_PARTIAL=""

# One file per module holds the package version its build is bound to, which the agent compares with the installed package.
# Webalizer and AWStats bind to no version, so their file is empty and running them is their check.
record_el_source_build() {
  local version=""
  if [[ $# -eq 2 ]]; then
    version="$(rpm -q --qf '%{VERSION}' "$2")"
  fi
  install -d -o root -g root -m 0755 -- "$EL_SOURCE_BUILD_DIR"
  printf '%s\n' "$version" > "$EL_SOURCE_BUILD_DIR/$1"
}

# Headers behind the installed package would build the old ABI and record the new version.
assert_el_headers() {
  [[ "$(rpm -q --qf '%{VERSION}' "$1")" == "$(rpm -q --qf '%{VERSION}' "$1-devel")" ]] || die "$1-devel does not match the installed $1."
}

# Each build lands beside the live file, so a failed fetch, digest or build leaves the host as it was.
rebuild_el_source() {
  local live
  trap 'rm -rf -- "$EL_SOURCE_PARTIAL"' EXIT
  case "${1:-}" in
    mpm-itk)
      assert_el_headers httpd
      live="$EL_MPM_ITK_MODULE"
      EL_MPM_ITK_MODULE="$live.new"
      EL_SOURCE_PARTIAL="$live.new"
      install_el_mpm_itk
      # The itk module is the account isolation model, so Apache keeps the old one unless it accepts the new one.
      ln -f -- "$live" "$live.old"
      mv -f -- "$live.new" "$live"
      if ! httpd -t > /dev/null 2>&1; then
        mv -f -- "$live.old" "$live"
        die "Apache refused the rebuilt mpm-itk; the previous module stays."
      fi
      rm -f -- "$live.old"
      record_el_source_build mpm-itk httpd
      # try-reload-or-restart leaves a stopped unit stopped, and a unit that failed on the old module has to start again.
      if systemctl is-failed --quiet httpd; then
        systemctl restart httpd
      else
        systemctl try-reload-or-restart httpd
      fi
      ;;
    fts-xapian)
      assert_el_headers dovecot
      live="$EL_FTS_MODULE"
      EL_FTS_MODULE="$live.new"
      EL_SOURCE_PARTIAL="$live.new"
      install_el_fts_xapian
      mv -f -- "$live.new" "$live"
      record_el_source_build fts-xapian dovecot
      ;;
    webalizer)
      live="$EL_WEBALIZER_BINARY"
      EL_WEBALIZER_BINARY="$live.new"
      EL_SOURCE_PARTIAL="$live.new"
      install_el_webalizer
      mv -f -- "$live.new" "$live"
      record_el_source_build webalizer
      ;;
    awstats)
      live="$EL_AWSTATS_DIR"
      EL_AWSTATS_DIR="$live.new"
      EL_SOURCE_PARTIAL="$live.new"
      install_el_awstats
      rm -rf -- "$live"
      mv -- "$live.new" "$live"
      record_el_source_build awstats
      ;;
    *)
      die "Unknown source build: ${1:-none}."
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  set -euo pipefail
  die() {
    printf '%s\n' "$*" >&2
    exit 1
  }
  # shellcheck disable=SC1091
  OS_MAJOR="$(. /etc/os-release && printf '%s' "${VERSION_ID%%.*}")"
  rebuild_el_source "${1:-}"
fi
