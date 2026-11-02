# Release publisher and source provenance

`buildReleaseArtifact` supports two independent trust layers. The inner `release-manifest.json` retains its existing HMAC-SHA256 representation. An optional publisher signs the completed compressed archive using Ed25519 and writes a sibling manifest accepted by native lifecycle verification.

## Producer

Use an explicit `package.json` version or the `version` option. No implicit release version is selected. Publisher signing requires a clean identifiable Git checkout, a stable `X.Y.Z` version, a separate archive HMAC key and an Ed25519 private key. Private signing material stays outside the source and output directories; key generation and distribution are separate operator responsibilities.

The library option is `publisher: { keyId, privateKey }`. CLI file options are:

```text
node scripts/package-release.mjs --out=/protected/build-output --version=X.Y.Z \
  --hmac-key-file=/protected/archive-hmac --hmac-key-id=archive-anchor \
  --publisher-key-file=/protected/publisher-private-key --publisher-key-id=publisher-anchor
```

Keys are read from bounded regular files without printing their contents. On Unix the files must belong to the current build identity and have no group/other permissions. Windows ACL review remains the operator's responsibility. Key values never belong in command-line arguments. A publisher build requires a new staging directory and creates archive, sidecar and provenance outputs exclusively; failed/partial outputs are retained for inspection rather than replaced.

The sidecar replaces the archive suffix `.tar.gz` with `.manifest.json`. Its exact fields are `version`, `schemaVersion`, `sha256`, `bytes`, `keyId`, `signature`. The canonical signed UTF-8 payload is:

```text
xpanel-release-v1:<version>:<control-db-schema>:<archive-sha256>:<unpacked-file-bytes>
```

`bytes` is the HMAC inventory's total unpacked file bytes, not compressed archive size. Signatures are hex Ed25519. The existing archive basename is compatible; it does not need renaming.

## Provenance

`source-provenance.json` is a member of the authenticated archive inventory. It records a separately named release-input digest and, for identifiable repository builds, the common `xpanel-executable-inputs-v1` qualification identity. Archive input files are captured once, staged from those captured bytes and checked again after the build. Full executable source identity is compared before and after building. Exported fixtures record unknown Git identity explicitly and cannot produce publisher-signed releases.

A repository build also emits `<archive-base>.provenance.json` with kind `xpanel-artifact-provenance`, the common source identity, and the actual compressed artifact hash/size. This detached document is an input to `scripts/evidence/target.mjs`. It has no self-authenticating authority: an operator must verify the producer, archive HMAC, publisher sidecar and source binding, then supply its independently trusted SHA256 pin. A caller-provided self-hash is insufficient. Do not confuse the release-input fingerprint with the executable-source fingerprint.

## Remaining native gates

Producing these outputs does not install or activate them. Provisioning publisher public keys and archive trust, actual dependency verification, the versioned release layout, a genuine installation ownership receipt, hosted UID observations, upgrade recovery and per-distribution acceptance remain separate gates. No manifest here reports an install-ready or qualified native host. Existing host trust and daemon backends must be preserved until a reviewed migration qualifies their replacements.
