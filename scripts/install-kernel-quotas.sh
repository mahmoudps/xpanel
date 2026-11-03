#!/usr/bin/env bash
# Sourced by the installer only for an explicitly selected historical Ubuntu snapshot.
# A snapshot supplies one matching missing modules package. dpkg never resolves or downloads other packages.
kernel_quota_image_binding() {
  local release="$1" image="linux-image-$1" row state name version architecture boot="/boot/vmlinuz-$1" image_sha
  row="$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}' "$image")"
  IFS=$'\t' read -r state name version architecture <<< "$row"
  [[ "$state" == 'ii ' && "$name" == "$image" && "$architecture" == amd64
    && "$version" =~ ^[0-9][A-Za-z0-9.+:~_-]{0,127}$ ]] || die "The exact kernel image must be healthy, configured and amd64."
  [[ -f "$boot" && ! -L "$boot" && "$(dpkg-query -S -- "$boot")" == "$image: $boot" ]] || die "The bootable image is not owned by its expected package."
  assert_root_file "$boot"
  image_sha="$(sha256sum -- "$boot")" || die "The bootable image digest could not be read."
  image_sha="${image_sha%% *}"
  [[ "$image_sha" =~ ^[a-f0-9]{64}$ ]] || die "The bootable image digest is invalid."
  printf '%s\n%s\n' "$version" "$image_sha"
}

install_kernel_quota_snapshot_package() (
  # Temporary directories are traversable by _apt; create control files privately before granting read access.
  umask 077
  local release="$1" package="linux-modules-extra-$1" version status architecture temporary downloaded image_binding metadata_sha metadata_bytes payload module filename module_root audit sandbox_uid
  [[ "$OS_ID" == ubuntu && "$OS_CODENAME" =~ ^(jammy|noble)$ ]] || die "Kernel snapshots require a supported Ubuntu archive suite."
  [[ "$release" =~ ^[0-9][A-Za-z0-9.+_-]{0,95}$ ]] || die "Invalid bootable kernel release."
  [[ "$KERNEL_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ && "$KERNEL_SNAPSHOT" > 20230301T000000Z && "$KERNEL_SNAPSHOT" < "$(date -u +%Y%m%dT%H%M%SZ)" ]] || die "Select a valid past Ubuntu kernel snapshot."
  [[ "$(date -u -d "${KERNEL_SNAPSHOT:0:4}-${KERNEL_SNAPSHOT:4:2}-${KERNEL_SNAPSHOT:6:2} ${KERNEL_SNAPSHOT:9:2}:${KERNEL_SNAPSHOT:11:2}:${KERNEL_SNAPSHOT:13:2}" +%Y%m%dT%H%M%SZ)" == "$KERNEL_SNAPSHOT" ]] || die "Invalid Ubuntu kernel snapshot timestamp."
  architecture="$(dpkg --print-architecture)"
  [[ "$architecture" == amd64 ]] || die "Historical kernel module recovery currently supports amd64 only."
  sandbox_uid="$(id -u _apt)" || die "The APT sandbox principal is unavailable."
  [[ "$sandbox_uid" =~ ^[1-9][0-9]*$ ]] || die "The APT sandbox must have a distinct unprivileged UID."
  audit="$(dpkg --audit)" || die "Existing dpkg health could not be observed."
  [[ -z "$audit" ]] || die "Resolve existing dpkg attention before kernel preparation."
  image_binding="$(kernel_quota_image_binding "$release")"
  version="${image_binding%%$'\n'*}"
  if status="$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null)"; then
    [[ "$status" == 'un ' ]] || die "An existing or partial modules package requires explicit recovery."
  else
    [[ $? == 1 && -z "$status" ]] || die "Module package state is unavailable."
  fi
  assert_root_file /usr/share/keyrings/ubuntu-archive-keyring.gpg
  if [[ ! -e /var/lib/xpanel-kernel-inputs && ! -L /var/lib/xpanel-kernel-inputs ]]; then
    install -d -o root -g root -m 0711 /var/lib/xpanel-kernel-inputs
  fi
  assert_root_owned_path /var/lib/xpanel-kernel-inputs
  [[ -d /var/lib/xpanel-kernel-inputs && "$(stat -c %a /var/lib/xpanel-kernel-inputs)" =~ ^(711|755)$ ]] || die "The kernel input directory must permit sandbox traversal without writes."
  temporary="$(mktemp -d /var/lib/xpanel-kernel-inputs/snapshot.XXXXXXXX)"
  chmod 0711 "$temporary"
  mkdir "$temporary/lists" "$temporary/archives" "$temporary/download" "$temporary/parts"
  chmod 0755 "$temporary/lists" "$temporary/archives" "$temporary/parts"
  mkdir "$temporary/lists/partial" "$temporary/archives/partial"
  chown _apt:root "$temporary/download" "$temporary/lists/partial" "$temporary/archives/partial"
  chmod 0700 "$temporary/download" "$temporary/lists/partial" "$temporary/archives/partial"
  : > "$temporary/empty.conf"
  cat > "$temporary/apt.conf" <<EOF
Dir::Etc::main "$temporary/empty.conf";
Dir::Etc::parts "$temporary/parts";
Dir::Cache::pkgcache "$temporary/pkgcache.bin";
Dir::Cache::srcpkgcache "$temporary/srcpkgcache.bin";
EOF
  cat > "$temporary/ubuntu.sources" <<EOF
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/$KERNEL_SNAPSHOT
Suites: ${OS_CODENAME}-updates
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF
  chmod 0644 "$temporary/apt.conf" "$temporary/ubuntu.sources" "$temporary/empty.conf"
  local snapshot_options=(
    -o "Dir::Etc::main=/dev/null" -o "Dir::Etc::parts=-"
    -o "Dir::Etc::sourcelist=$temporary/ubuntu.sources" -o "Dir::Etc::sourceparts=-"
    -o "Dir::Etc::preferences=/dev/null" -o "Dir::Etc::preferencesparts=-"
    -o "Dir::State::lists=$temporary/lists" -o "Dir::Cache::archives=$temporary/archives"
    -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false
    -o APT::Get::AllowUnauthenticated=false
    -o APT::Update::Error-Mode=any -o APT::Sandbox::User=_apt
  )
  # Historical validity dates are selected explicitly above; archive signatures and index/package hashes are still verified by APT.
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C APT_CONFIG="$temporary/apt.conf" apt-get "${snapshot_options[@]}" update
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C APT_CONFIG="$temporary/apt.conf" apt-cache "${snapshot_options[@]}" show "$package=$version" > "$temporary/package.txt"
  metadata_sha="$(awk '/^SHA256: / { print $2 }' "$temporary/package.txt" | sort -u)"
  metadata_bytes="$(awk '/^Size: / { print $2 }' "$temporary/package.txt" | sort -u)"
  [[ "$metadata_sha" =~ ^[a-f0-9]{64}$ && "$metadata_bytes" =~ ^[1-9][0-9]{0,9}$ && "$metadata_bytes" -le 536870912 ]] || die "The signed snapshot has no unique bounded package digest."
  (cd -- "$temporary/download" && env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C APT_CONFIG="$temporary/apt.conf" apt-get "${snapshot_options[@]}" download "$package=$version")
  local matches=()
  shopt -s nullglob
  matches=("$temporary/download/"*.deb)
  shopt -u nullglob
  [[ ${#matches[@]} == 1 && -f "${matches[0]}" && ! -L "${matches[0]}" ]] || die "The snapshot did not supply exactly one kernel module package."
  [[ "$(stat -c %h -- "${matches[0]}")" == 1 ]] || die "The downloaded package has unexpected hard links."
  payload="$temporary/authenticated.deb"
  assert_root_file "$SCRIPT_DIR/install-kernel-package.mjs"
  "$NODE_BIN" "$SCRIPT_DIR/install-kernel-package.mjs" "${matches[0]}" "$payload" "$metadata_sha" "$metadata_bytes"
  downloaded="$(dpkg-deb --show --showformat='${Package}\n${Version}\n${Architecture}\n' -- "$payload")"
  [[ "$downloaded" == "$package"$'\n'"$version"$'\n'"$architecture" ]] || die "The downloaded module package differs from the installed kernel image."
  [[ "$(kernel_quota_image_binding "$release")" == "$image_binding" ]] || die "The installed kernel image changed during package acquisition."
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
    dpkg --install -- "$payload"
  [[ "$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}' "$package")" == 'ii '$'\t'"$package"$'\t'"$version"$'\t'"$architecture" ]] || die "The matching kernel modules are not healthy and configured."
  audit="$(dpkg --audit)" || die "Resulting dpkg health could not be observed."
  [[ -z "$audit" ]] || die "The resulting dpkg state requires recovery."
  kernel_lacks_quota_format "$release" && die "The installed package did not supply both quota formats."
  module_root="$(realpath -e -- "/lib/modules/$release")"
  for module in quota_v2 quota_tree; do
    filename="$(modinfo -k "$release" -F filename "$module")"
    if [[ "$filename" != '(builtin)' ]]; then
      filename="$(realpath -e -- "$filename")"
      [[ "$filename" == "$module_root/"* && -f "$filename" ]] || die "Quota module resolution escaped its kernel tree."
      assert_root_file "$filename"
    fi
  done
  if [[ "$(uname -r)" == "$release" ]]; then modprobe quota_tree; modprobe quota_v2; fi
  printf 'Kernel snapshot inputs retained at %s\n' "$temporary"
)
