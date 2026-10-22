# Contributing to xPanel

Thank you for helping build xPanel. This guide covers how to set up, what a good change looks like, and how it gets merged.

## Before you start

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the system works and [docs/STANDARDS.md](docs/STANDARDS.md) for the rules every change follows.
- For anything larger than a small fix, open an issue first so the approach can be agreed before you write code.
- Security problems are never reported in public issues — see [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node.js 24 and pnpm 10.

```bash
pnpm install
pnpm test        # all unit and integration tests
pnpm typecheck   # TypeScript in every workspace package
```

Packages are TypeScript source run by Node's type stripping. Relative imports end in `.ts`; enums, namespaces and constructor parameter properties are not used.

## What a good change looks like

- **Complete.** xPanel has not launched, so a change replaces old code outright and updates every caller. No compatibility shims, deprecated paths, `TODO`s or dead code.
- **In the right layer.** Domain rules and renderers stay pure; only the agent touches the host, through the host-action contract.
- **One source of truth.** Import types, constants, schemas and validation rules from where they are defined; never copy them.
- **Tested.** New behavior comes with tests next to the code (`*.test.ts`), including invalid input, limits and failure paths.
- **Secure.** Validate input at the boundary and again where it becomes a path, unit name, config line or SQL identifier. Use argv arrays, never shell strings.
- **Light.** Prefer the platform and existing dependencies. A new dependency needs a reason, a permissive license and an active upstream.
- **English.** Code, comments, commits and docs are in English; user-facing text goes through translation catalogs.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(render): add OpenLiteSpeed vhost`, `fix(core): reject wildcard primary domains`.
- Keep pull requests focused. Describe what changed, why, and how it was tested.
- `pnpm test` and `pnpm typecheck` must pass.

## Contributor License Agreement

Before your first pull request can be merged you must agree to the [xPanel Contributor License Agreement](CLA.md). Add this sentence as a comment on your pull request:

> I have read the xPanel Contributor License Agreement and I agree to it.

You only need to do this once. The agreement lets the project keep offering xPanel under the AGPL and under commercial terms; you keep the copyright in your contribution.

## Code of conduct

Everyone taking part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
