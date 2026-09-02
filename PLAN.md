# SpecPi npm Publishing Plan

## Objective

Publish SpecPi as a public npm package that distributes the existing installer CLI and packaged Pi resources without weakening SpecPi's confirmation, rollback, privacy, or validation guarantees.

The canonical npm installation path will be:

```bash
npm install --global specpi
specpi plan
specpi install
specpi doctor
```

Publishing is a remote, irreversible release action. This plan prepares and validates the package, but the first `npm publish` requires a separate explicit human instruction.

## Implementation status

The release-preparation implementation targets `0.10.0` and is complete in this branch. Publication remains a post-merge human release operation because npm versions are immutable and the protected workflow must run from the reviewed release tag.

Implemented evidence:

- `package.json` declares `specpi@0.10.0`, complete optional Pi host peers, public provenance metadata, an executable `specpi` bin, and an exact public file allow-list.
- `scripts/check-package.mjs` builds the real tarball in temporary state, checks its exact 55-file manifest and metadata, installs it offline without host peers, invokes the npm shim, and runs packed plan/install/doctor/update/uninstall and rollback checks.
- `scripts/check-pi-package.mjs` installs the tarball with pinned Pi 0.84.4, loads its extensions, skills, and themes through Pi's package loader, preserves an authentication canary, and verifies the limited browser-runtime error.
- CI runs packed lifecycle checks on Ubuntu, Windows, and macOS; the release workflow uses Node.js 22.19.0 and pinned npm 11.19.1.
- `.github/workflows/npm-publish.yml` validates and checksums one artifact, requires the protected `npm` environment, publishes through OIDC with provenance, and verifies registry version, integrity, dist-tag, and attestation metadata.
- npm installation, source-audited installation, explicit update/uninstall, limited native Pi mode, security boundaries, and maintainer release steps are documented.
- The public registry returned `E404` for `specpi` during implementation, suggesting the name is available but not reserving it.

## Distribution contract

### Supported full installation

The npm package is primarily an installer CLI. A full installation requires running the SpecPi lifecycle after npm installs the command:

```bash
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

This route retains the existing plan, confirmation, backup, atomic write, rollback, checksum, and doctor behavior.

### One-shot evaluation

Document a version-pinned `npx` route for evaluating the plan without permanently installing the CLI:

```bash
npx --package specpi@<version> specpi plan
```

Do not present `npx ... install` as the primary route until packed-artifact lifecycle tests prove its update and uninstall ergonomics.

### Native Pi package installation

`pi install npm:specpi` can discover the packaged extensions, skills, and themes, but it does not run SpecPi's installer lifecycle. It therefore does not guarantee installation of:

- managed global instructions;
- browser runtime dependencies and Chromium;
- supporting third-party Pi packages;
- optional tools;
- shell integration;
- installer manifests, backups, and managed-file ownership.

For the first npm release, document native Pi installation as a limited resource-only mode, not as equivalent to the full SpecPi installation. Do not claim full parity until it has its own explicit contract and tests.

## Release principles

- Preserve `plan` as non-mutating.
- Preserve confirmation unless the user explicitly supplies `--yes`.
- Keep the npm package free of `preinstall`, `install`, and `postinstall` mutation scripts.
- Do not download Pi, Chromium, optional tools, or supporting packages merely because npm unpacked SpecPi.
- Publish only reviewed files from the explicit package allow-list.
- Test the exact tarball that will be published.
- Pin the released version; never republish changed bytes under an existing version.
- Use npm provenance and a protected publishing environment when supported.
- Never place npm tokens in the repository, package, logs, or ordinary CI artifacts.
- Treat npm publication, deprecation, ownership changes, and dist-tag changes as explicit remote operations.

## Phase 1 — Finalize package identity and installation behavior

- [ ] Confirm the unscoped `specpi` name while authenticated with the intended npm owner.
- [x] Confirm and validate the author, public support URL, repository URL, and homepage metadata.
- [x] Select `0.10.0` as the first npm-ready version. Do not publish the changed current tree as `0.9.0`.
- [x] Record npm 11.19.1 and Node.js 22.19.0 for release validation.
- [ ] Confirm that global installation creates the expected `specpi` executable on Windows, Linux, and macOS-compatible npm layouts.
- [ ] Confirm that invoking `specpi` from an npm installation resolves all bundled source files relative to the package root.
- [x] Verify that npm unpacking alone performs no SpecPi host mutation and runs no install lifecycle script.

Acceptance:

- The package identity is available and controlled by the intended owner.
- The selected version has never been published.
- Installing the package alone changes only npm-managed package state.
- `specpi --help` or the default help output runs from a temporary global npm prefix on Windows and Linux.

## Phase 2 — Correct package metadata and contents

- [x] Add every imported Pi core module to `peerDependencies` using Pi's documented `"*"` range:
  - `@earendil-works/pi-ai`;
  - `@earendil-works/pi-coding-agent`;
  - `@earendil-works/pi-tui`;
  - `typebox`.
- [x] Mark host-provided Pi peers optional so npm does not install them before SpecPi's explicit installer confirmation.
- [x] Prove the chosen peer configuration both under npm CLI installation and under Pi package loading.
- [x] Add `site/logo.svg` to the package file allow-list.
- [ ] Ensure every README asset renders on both GitHub and npm.
- [x] Add explicit public access and provenance publishing metadata.
- [x] Pin the publishing npm version in release automation without imposing it on contributors through `packageManager`.
- [x] Keep development dependencies out of the production artifact.
- [x] Confirm that `browser-runtime/package.json` and its lockfile remain included without including its installed `node_modules`.
- [x] Confirm that tests, private design files, Git metadata, local state, caches, logs, and browser artifacts are excluded.
- [x] Review and enforce the packed file list against an exact allow-list.

Acceptance:

- All runtime imports are represented by the documented host-peer contract or an explicit bundled dependency.
- npm installation does not auto-install an uncontrolled Pi version before `specpi install` asks for confirmation.
- The npm README has no broken images or repository-relative links.
- The tarball contains only the reviewed runtime, documentation, license, and public asset files.

## Phase 3 — Add deterministic package validation

Add a focused package test that creates and examines the real tarball rather than validating only source files.

- [x] Run `npm pack --json` in a clean temporary output directory.
- [x] Parse the reported tarball metadata and fail on unexpected warnings.
- [x] Assert required files are present, including:
  - `package.json`;
  - `scripts/specpi.mjs`, `scripts/lib.mjs`, and `scripts/lock.mjs`;
  - all installer-managed extension files;
  - capability registry and validators;
  - skills and themes;
  - templates and shell source;
  - browser-runtime manifests;
  - README assets;
  - security, third-party, changelog, license, and README documents.
- [x] Assert forbidden files are absent, including:
  - `.git/**` and `.github/**` unless deliberately required;
  - `tests/**`;
  - `design/**`;
  - root and browser-runtime `node_modules/**`;
  - temporary state, logs, screenshots, and package tarballs.
- [x] Verify the bin target exists, is executable on POSIX, and produces the npm platform shim.
- [x] Verify the package name, version, license, engines, repository, and public access metadata from the packed `package.json`.
- [x] Verify the packed README references assets included in the artifact.
- [x] Build and remove validation artifacts entirely in temporary state.

Acceptance:

- The checked tarball file list is bounded and deterministic.
- Missing runtime files and newly included unintended files fail CI.
- Package validation creates no tracked diff and leaves no tarball in the repository root.

## Phase 4 — Exercise the packed installer lifecycle

Use a fresh temporary npm prefix and `PI_CODING_AGENT_DIR`. Never run package integration tests against the live Pi directory.

### CLI installation smoke

- [x] Install the generated tarball into a temporary global npm prefix.
- [x] Invoke the installed executable through the platform-specific npm bin path.
- [x] Verify help output reports the packed version.
- [x] Verify `plan` is non-mutating.
- [x] Verify unknown arguments fail clearly.
- [x] Verify the Node.js engine floor is represented and documented.

### Isolated lifecycle smoke

- [x] Reuse the existing fake Pi and isolated lifecycle patterns.
- [x] Run packed `plan`, `install`, `doctor`, `update`, and `uninstall` against isolated state.
- [x] Prove the packed installer can find every source resource it copies.
- [x] Prove packed update rollback restores configuration and managed files byte-for-byte after injected failure.
- [x] Prove uninstall preserves private wishlist, journal, experiment, and patch state according to the current contract.
- [x] Use isolated agent state, skip shell integration, and preserve an authentication canary during Pi loading.

### Pi resource smoke

- [x] Load the tarball through isolated pinned Pi 0.84.4.
- [x] Verify extension, skill, and theme discovery from the packed layout.
- [x] Verify host-provided peer imports resolve without bundling a second Pi runtime.
- [x] Verify limited native Pi mode gives an actionable `specpi update` error for the absent browser runtime.

Platforms:

- [ ] Ubuntu CI.
- [ ] Windows CI, including the npm `.cmd` launcher.
- [ ] Perform a macOS smoke before general availability if no macOS CI job is added.

Acceptance:

- The exact tarball completes the supported lifecycle in isolated state on Windows and Linux.
- Package-root path assumptions work after npm renames and nests the installation directory.
- Native Pi resource loading matches its documented limited-mode contract.

## Phase 5 — Documentation and update semantics

- [x] Make npm installation the primary README and site path for `0.10.0`.
- [x] Retain source-checkout installation as a documented development or audit path.
- [x] Document the difference between installing the npm CLI and running `specpi install`.
- [x] Document limited `pi install npm:specpi` behavior and avoid implying full lifecycle parity.
- [x] Document update as two explicit steps:

```bash
npm install --global specpi@latest
specpi update
specpi doctor
```

- [x] Document uninstall behavior separately for managed SpecPi state and the npm CLI:

```bash
specpi uninstall
npm uninstall --global specpi
```

- [x] Explain which private state survives uninstall.
- [x] Document version-pinned installation for reproducibility.
- [x] Update the wiki, security model, security policy, third-party inventory, and changelog for the distribution contract.
- [ ] Add npm package and provenance links after the first successful publication.
- [x] Ensure all displayed versions and clone tags match `0.10.0`.

Acceptance:

- A new user can distinguish npm package installation, SpecPi host installation, updates, and uninstall.
- Documentation does not claim that npm or Pi package installation silently performs confirmed SpecPi mutations.
- Version references are consistent across package metadata, CLI output, README, site, wiki, and changelog.

## Phase 6 — Secure publishing automation

Create a dedicated release workflow; never publish from ordinary push or pull-request workflows.

Recommended trigger:

- a manually approved GitHub Release or version tag matching `v<package.version>`;
- protected GitHub environment named `npm`;
- npm trusted publishing through GitHub OIDC when available.

Workflow gates:

- [x] Check out the exact release tag.
- [x] Install pinned release npm and repository development tools with lifecycle scripts disabled and peers omitted.
- [x] Run `npm run check`.
- [x] Run packed-artifact, packed lifecycle, and native Pi package smoke tests.
- [x] Assert the Git tag exactly equals `v${package.version}`.
- [x] Assert the changelog contains the same version.
- [x] Assert the version is not already present on npm.
- [x] Build one tarball and preserve its filename, SHA-512 integrity, and file manifest in workflow output.
- [x] Run `npm publish --dry-run` against that artifact.
- [x] Require the protected `npm` environment before the publish job.
- [x] Publish the already-validated artifact with public access and provenance.
- [x] Read the registry back and verify name, version, dist-tag, integrity, and provenance.
- [x] Route prereleases to `next` and stable versions to `latest`.

Credential model:

- Prefer npm trusted publishing and short-lived OIDC credentials.
- If npm requires an interactive first publication before trusted publishing can be configured, perform that one publication manually with 2FA after all gates pass.
- Never use a broad personal access token when a package-scoped automation credential or trusted publisher is available.
- Never expose credentials to pull-request jobs, forked workflows, install scripts, or package tests.

Acceptance:

- Only an approved release ref can publish.
- CI validates the same bytes it sends to npm.
- The published package carries verifiable provenance where npm supports it.
- No persistent npm credential is committed or included in artifacts.

## Phase 7 — First release procedure

### Preparation

- [ ] Start from a clean working tree and reviewed release commit.
- [ ] Confirm all CI and packed-artifact jobs pass.
- [ ] Inspect `npm pack --dry-run --json` and the final tarball manifest manually.
- [ ] Inspect the final diff with special attention to scripts, package metadata, peer resolution, and release workflow permissions.
- [ ] Obtain fresh read-only review of the installer and publishing changes.
- [ ] Confirm the npm owner account has 2FA and recovery access.
- [ ] Confirm the package name and target version are still available.

### Release

- [x] Update versioned documentation and changelog for `0.10.0`.
- [ ] Create the explicit release commit and matching tag only when requested.
- [ ] Run the protected publish workflow or explicitly approved manual publish.
- [ ] Verify the npm package page, README rendering, provenance, license, repository links, and `latest` dist-tag.
- [ ] Install the registry version into a fresh temporary prefix rather than reusing the local tarball.
- [ ] Run `specpi plan` from the registry installation.
- [ ] Complete one disposable isolated install/doctor/uninstall smoke from the registry version.

### Announcement readiness

- [ ] Publish installation commands only after registry verification passes.
- [x] Link installation guidance to the security policy and versioned source tag.
- [x] State that Pi extensions run with user permissions and should be reviewed before installation.
- [x] State the limited contract of direct `pi install npm:specpi`.

## Failure and rollback policy

npm versions are immutable. Do not attempt to replace a broken version with different bytes.

If validation fails before publication:

- stop the release;
- leave npm unchanged;
- fix the issue and select a new release candidate.

If a defective version is published:

- verify the defect from the registry artifact;
- deprecate the affected version with a concise actionable message when warranted;
- publish a corrected patch version after the full gates pass;
- move `latest` only through an explicit reviewed dist-tag operation;
- document security-impacting defects through the security policy;
- use npm unpublish only when policy, legal, or credential exposure requirements make it necessary.

If a credential is exposed:

- revoke it immediately;
- stop active publishing workflows;
- inspect npm ownership and dist-tag history;
- follow the private security-reporting process;
- rotate related credentials before resuming.

## Test matrix

### Package shape

- Required files included.
- Private and development files excluded.
- Bin mode executable.
- README assets resolvable.
- No lifecycle mutation scripts.
- No bundled Pi runtime.
- No unreviewed production dependency.

### npm behavior

- Temporary global install on Linux.
- Temporary global install on Windows.
- No peer auto-install before SpecPi confirmation.
- Help and plan run from npm's installed location.
- Unsupported Node version produces an actionable npm engine warning or refusal.

### SpecPi lifecycle

- Plan remains non-mutating.
- Install requires confirmation without `--yes`.
- Managed files install from the tarball.
- Doctor validates installed checksums and capability validators.
- Update preserves unrelated configuration and private state.
- Injected failure rolls back.
- Uninstall removes managed state while preserving documented private evidence.

### Release safety

- Wrong tag/version fails.
- Existing npm version fails.
- Dirty or unexpected package contents fail.
- Pull requests cannot publish.
- Prereleases do not receive `latest` automatically.
- Registry integrity matches the validated artifact.

## Definition of done

- `specpi` is published publicly under the intended npm owner at a new immutable version.
- `npm install --global specpi` installs only the CLI package and performs no SpecPi host mutation by itself.
- The installed CLI completes `plan`, `install`, `doctor`, `update`, and `uninstall` from the packed layout in isolated Windows and Linux tests.
- The package contains every required runtime file and no tests, private state, credentials, caches, or unintended artifacts.
- Pi core imports follow the documented peer dependency contract without installing an uncontrolled duplicate runtime.
- README and wiki instructions accurately distinguish npm, full SpecPi lifecycle, and limited native Pi package installation.
- The release is version/tag/changelog consistent, provenance-backed where supported, and reproducible from the reviewed tag.
- Full repository checks, packed-artifact tests, registry smoke checks, final diff inspection, and fresh read-only review pass.
- No commit, tag, GitHub Release, npm publish, dist-tag change, deprecation, or announcement occurs without explicit human authorization.

## Explicit non-goals

- Automatically publishing on every push to `main`.
- Running SpecPi installation from an npm lifecycle script.
- Silently installing Pi, Chromium, optional tools, or supporting packages during npm unpacking.
- Claiming full installer parity for `pi install npm:specpi` in the first release.
- Bundling Pi core packages inside the SpecPi tarball.
- Adding a self-updating executable that mutates npm global state.
- Repurposing or overwriting the existing `0.9.0` version.
- Publishing, tagging, releasing, or changing npm ownership as part of plan implementation without separate approval.
