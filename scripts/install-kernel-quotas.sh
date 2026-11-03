#!/usr/bin/env bash
# Sourced by the installer only for an explicitly selected historical Ubuntu snapshot.
# The snapshot supplies the exact kernel package. New required dependencies use the signed normal Ubuntu suites.
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

kernel_quota_apt() {
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C LC_ALL=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
    APT_CONFIG="$temporary/apt.conf" "$@"
}

kernel_quota_absent_row() {
  # dpkg-query emits both tabs even when the version and architecture fields are empty.
  local prefix=$'un \t'"$1"$'\t\t'
  [[ "$2" == "$prefix" || "$2" == "${prefix}all" || "$2" == "${prefix}amd64" ]]
}

# Choose only missing, direct, unambiguous requirements of the authenticated target.
# The closed transaction simulation and the locked hook enforce the actual complete plan.
kernel_quota_missing_dependencies() {
  local fields required pre_required term name relation wanted row state installed_name installed_version installed_arch i must_be_configured
  local -a terms=() pre_terms=()
  local syntax='^[[:space:]]*([a-z0-9][a-z0-9.+-]{0,126})([[:space:]]*\((<<|<=|=|>=|>>)[[:space:]]+([0-9][A-Za-z0-9.+:~_-]{0,126})\))?[[:space:]]*$'
  pre_required="$(dpkg-deb -f "$payload" Pre-Depends)" || die "The authenticated pre-dependencies could not be read."
  required="$(dpkg-deb -f "$payload" Depends)" || die "The authenticated dependencies could not be read."
  fields="${pre_required}${pre_required:+${required:+,}}${required}"
  [[ -n "$fields" ]] || return 0
  [[ ${#fields} -le 8192 && "$fields" != *$'\n'* && "$fields" != *, ]] || die "Unsupported kernel dependency metadata."
  IFS=, read -ra terms <<< "$fields"
  if [[ -n "$pre_required" ]]; then IFS=, read -ra pre_terms <<< "$pre_required"; fi
  (( ${#terms[@]} <= 32 )) || die "The kernel package has too many direct dependencies."
  for i in "${!terms[@]}"; do
    term="${terms[i]}"
    must_be_configured=0
    if (( reunpack && i < ${#pre_terms[@]} )); then must_be_configured=1; fi
    # Choices are never authority to introduce a new package. APT may satisfy an alternative from installed state.
    if [[ "$term" == *'|'* ]]; then
      (( ! must_be_configured )) || die "Cannot prove an alternative Pre-Depends before re-unpacking."
      continue
    fi
    [[ "$term" =~ $syntax ]] || die "Unsupported kernel dependency relationship."
    name="${BASH_REMATCH[1]}" relation="${BASH_REMATCH[3]:-}" wanted="${BASH_REMATCH[4]:-}"
    [[ "$name" != "$package" ]] || die "The kernel package cannot depend on itself."
    if row="$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}' "$name" 2>/dev/null)"; then
      [[ "$row" != *$'\n'* ]] || die "Ambiguous installed kernel dependency."
      IFS=$'\t' read -r state installed_name installed_version installed_arch <<< "$row"
      if [[ "$state" == 'ii ' && "$installed_name" == "$name" && ( "$installed_arch" == all || "$installed_arch" == amd64 ) ]]; then
        [[ -z "$relation" ]] || dpkg --compare-versions "$installed_version" "$relation" "$wanted" || die "An installed dependency would need a version change."
        continue
      fi
      kernel_quota_absent_row "$name" "$row" || die "A dependency has existing or partial package state."
    else
      [[ $? == 1 && -z "$row" ]] || die "A dependency's installed state could not be observed."
    fi
    (( ! must_be_configured )) || die "All Pre-Depends must already be configured before re-unpacking."
    [[ -z "${dependency_seen[$name]:-}" ]] || die "Repeated missing dependency requires a separate review."
    (( ${#missing[@]} < 7 )) || die "The kernel package requires too many new dependencies."
    dependency_seen[$name]=1
    missing+=("$name")
  done
}

install_kernel_quota_snapshot_package() (
  # Temporary directories are traversable by _apt; create control files privately before granting read access.
  umask 077
  export LANG=C LC_ALL=C
  local release="$1" package="linux-modules-extra-$1" version architecture temporary downloaded image_binding image_sha metadata_sha metadata_bytes payload module filename module_root audit sandbox_uid
  local mode=fresh target_row target_audit reunpack=0 receipt
  local -a reinstall=(--reinstall)
  [[ "$OS_ID" == ubuntu && "$OS_CODENAME" =~ ^(jammy|noble)$ ]] || die "Kernel snapshots require a supported Ubuntu archive suite."
  [[ "$release" =~ ^[0-9][A-Za-z0-9.+_-]{0,95}$ ]] || die "Invalid bootable kernel release."
  [[ "$KERNEL_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ && "$KERNEL_SNAPSHOT" > 20230301T000000Z && "$KERNEL_SNAPSHOT" < "$(date -u +%Y%m%dT%H%M%SZ)" ]] || die "Select a valid past Ubuntu kernel snapshot."
  [[ "$(date -u -d "${KERNEL_SNAPSHOT:0:4}-${KERNEL_SNAPSHOT:4:2}-${KERNEL_SNAPSHOT:6:2} ${KERNEL_SNAPSHOT:9:2}:${KERNEL_SNAPSHOT:11:2}:${KERNEL_SNAPSHOT:13:2}" +%Y%m%dT%H%M%SZ)" == "$KERNEL_SNAPSHOT" ]] || die "Invalid Ubuntu kernel snapshot timestamp."
  architecture="$(dpkg --print-architecture)"
  [[ "$architecture" == amd64 ]] || die "Historical kernel module recovery currently supports amd64 only."
  sandbox_uid="$(id -u _apt)" || die "The APT sandbox principal is unavailable."
  [[ "$sandbox_uid" =~ ^[1-9][0-9]*$ ]] || die "The APT sandbox must have a distinct unprivileged UID."
  [[ "${RESUME_PREPARED:-0}" == 0 || "${RESUME_PREPARED:-0}" == 1 ]] || die "Unknown installer admission mode."
  if [[ "${RESUME_PREPARED:-0}" == 1 ]]; then mode=resume; fi
  image_binding="$(kernel_quota_image_binding "$release")"
  version="${image_binding%%$'\n'*}"
  image_sha="${image_binding##*$'\n'}"
  audit="$(dpkg --audit)" || die "Existing dpkg health could not be observed."
  if target_row="$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}' "$package" 2>/dev/null)"; then
    [[ "$target_row" != *$'\n'* ]] || die "Ambiguous target package state."
    if kernel_quota_absent_row "$package" "$target_row"; then
      [[ -z "$audit" ]] || die "Resolve existing dpkg attention before kernel preparation."
    else
      [[ "$mode" == resume && "$target_row" == $'iU \t'"$package"$'\t'"$version"$'\t'"$architecture" ]] || die "Only the exact unpacked modules package may resume."
      target_audit="$(dpkg --audit "$package")" || die "The unpacked modules package could not be audited."
      [[ -n "$target_audit" && "$audit" == "$target_audit" ]] || die "Unrelated dpkg attention requires separate recovery."
      reunpack=1
      reinstall=()
    fi
  else
    [[ $? == 1 && -z "$target_row" && -z "$audit" ]] || die "Module package state or dpkg health is unavailable."
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
  local -a missing=() sealed=("$payload") selectors=("$package=$version") normal_options=() transaction_options=()
  local -A dependency_seen=()
  local dep candidate dep_arch normal_fields expected_identity hook total_bytes="$metadata_bytes"
  printf '%s\t%s\t%s\t%s\t%s\n' "$package" "$version" "$architecture" "$metadata_sha" "$metadata_bytes" > "$temporary/package-set.tsv"
  kernel_quota_missing_dependencies
  if (( ${#missing[@]} )); then
    mkdir -m 0755 "$temporary/normal-lists"
    mkdir -m 0700 "$temporary/normal-lists/partial"
    chown _apt:root "$temporary/normal-lists/partial"
    cat > "$temporary/normal.sources" <<EOF
Types: deb
URIs: https://archive.ubuntu.com/ubuntu
Suites: ${OS_CODENAME} ${OS_CODENAME}-updates
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: ${OS_CODENAME}-security
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
    chmod 0644 "$temporary/normal.sources"
    normal_options=("${snapshot_options[@]}" -o "Dir::Etc::sourcelist=$temporary/normal.sources" -o "Dir::State::lists=$temporary/normal-lists"
      -o "Dir::Cache::pkgcache=" -o "Dir::Cache::srcpkgcache=" -o Acquire::Check-Valid-Until=true)
    kernel_quota_apt apt-get "${normal_options[@]}" update
    for dep in "${missing[@]}"; do
      candidate="$(kernel_quota_apt apt-cache "${normal_options[@]}" policy "$dep" | awk '$1=="Candidate:" {print $2}')" || die "Dependency candidate lookup failed."
      [[ "$candidate" =~ ^[0-9][A-Za-z0-9.+:~_-]{0,126}$ ]] || die "No unique normal Ubuntu dependency candidate."
      normal_fields="$temporary/metadata-$dep.txt"
      kernel_quota_apt apt-cache "${normal_options[@]}" show "$dep=$candidate" > "$normal_fields"
      metadata_sha="$(awk '/^SHA256: / { print $2 }' "$normal_fields" | sort -u)"
      metadata_bytes="$(awk '/^Size: / { print $2 }' "$normal_fields" | sort -u)"
      dep_arch="$(awk '/^Architecture: / { print $2 }' "$normal_fields" | sort -u)"
      [[ "$metadata_sha" =~ ^[a-f0-9]{64}$ && "$metadata_bytes" =~ ^[1-9][0-9]{0,9}$ && "$metadata_bytes" -le 536870912 && ( "$dep_arch" == all || "$dep_arch" == amd64 ) ]] || die "The normal signed dependency metadata is ambiguous or incomplete."
      total_bytes=$((total_bytes + metadata_bytes))
      (( total_bytes <= 805306368 )) || die "The signed dependency set exceeds the kernel package size bound."
      (cd -- "$temporary/download" && kernel_quota_apt apt-get "${normal_options[@]}" download "$dep=$candidate")
      shopt -s nullglob
      matches=("$temporary/download/${dep}_"*.deb)
      shopt -u nullglob
      [[ ${#matches[@]} == 1 ]] || die "The normal repository did not supply one matching dependency."
      filename="$temporary/dependency-$dep.deb"
      "$NODE_BIN" "$SCRIPT_DIR/install-kernel-package.mjs" "${matches[0]}" "$filename" "$metadata_sha" "$metadata_bytes"
      expected_identity="$dep"$'\n'"$candidate"$'\n'"$dep_arch"
      downloaded="$(dpkg-deb --show --showformat='${Package}\n${Version}\n${Architecture}\n' -- "$filename")"
      [[ "$downloaded" == "$expected_identity" ]] || die "The sealed dependency identity differs from its normal repository."
      printf '%s\t%s\t%s\t%s\t%s\n' "$dep" "$candidate" "$dep_arch" "$metadata_sha" "$metadata_bytes" >> "$temporary/package-set.tsv"
      sealed+=("$filename")
      selectors+=("$dep=$candidate")
    done
  fi
  # No repository, hooks or caches from the host or snapshot may introduce another action into this transaction.
  mkdir -m 0755 "$temporary/transaction-lists"
  transaction_options=("${snapshot_options[@]}" -o Dir::Etc::sourcelist=/dev/null -o "Dir::State::lists=$temporary/transaction-lists"
    -o "Dir::Cache::pkgcache=" -o "Dir::Cache::srcpkgcache=")
  # APT processes local archives separately. Exact named operands keep a partially configured target visible to its dependency check.
  # APT configures an unpacked same-version target. The locked hook first re-unpacks its authenticated archive.
  kernel_quota_apt apt-get "${transaction_options[@]}" -s -qq --no-remove --no-install-recommends "${reinstall[@]}" install "${sealed[@]}" "${selectors[@]}" > "$temporary/simulation.txt"
  "$NODE_BIN" "$SCRIPT_DIR/install-kernel-package.mjs" --plan "$temporary" "$package" "$version" "$image_sha" "$mode"
  # Use a fixed single executable as the APT v3 hook identity. Bash quoting handles the trusted installer/runtime paths.
  hook="$temporary/plan-hook"
  printf '#!/bin/bash\nexec %q %q --apply-plan %q %q %q %q %q\n' "$NODE_BIN" "$SCRIPT_DIR/install-kernel-package.mjs" "$temporary" "$package" "$version" "$image_sha" "$mode" > "$hook"
  chmod 0500 "$hook"
  kernel_quota_apt apt-get "${transaction_options[@]}" -o "DPkg::Pre-Install-Pkgs::=$hook" \
    -o "DPkg::Tools::Options::${hook}::Version=3" -o "DPkg::Tools::Options::${hook}::InfoFD=0" \
    -y --no-remove --no-install-recommends "${reinstall[@]}" install "${sealed[@]}" "${selectors[@]}"
  if (( reunpack )); then
    for receipt in target-reunpack-intent.json target-reunpack-result.json; do
      [[ -s "$temporary/$receipt" && ! -L "$temporary/$receipt" ]] || die "The authenticated target re-unpack was not confirmed."
      assert_root_file "$temporary/$receipt"
    done
  fi
  [[ -s "$temporary/apply-plan.json" && ! -L "$temporary/apply-plan.json" ]] || die "The locked APT plan was not observed."
  assert_root_file "$temporary/apply-plan.json"
  kernel_quota_apt apt-get "${transaction_options[@]}" check
  local name configured_version configured_arch digest bytes row
  while IFS=$'\t' read -r name configured_version configured_arch digest bytes; do
    row="$(dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}' "$name")" || die "An admitted package could not be read after installation."
    [[ "$row" == $'ii \t'"$name"$'\t'"$configured_version"$'\t'"$configured_arch" ]] || die "An admitted package did not reach its exact configured identity."
  done < "$temporary/package-set.tsv"
  [[ "$(kernel_quota_image_binding "$release")" == "$image_binding" ]] || die "The installed kernel image changed during package installation."
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
