# npm Release Runbook

This runbook is for SpecPi maintainers. Publishing, changing dist-tags, deprecating versions, and changing package ownership are remote operations and require an explicit human decision.

## One-time npm setup

1. Sign in to the intended npm owner account and enable two-factor authentication and recovery access.
2. Confirm that the unscoped `specpi` name is available immediately before the first release.
3. Create a protected GitHub environment named `npm` with required reviewer approval.
4. Configure npm trusted publishing for `TannerMidd/SpecPi` and `.github/workflows/npm-publish.yml`.
5. Do not configure a long-lived `NPM_TOKEN` when trusted publishing is available.

If npm requires an initial interactive publication before a trusted publisher can be attached, validate the release artifact through every gate below, publish that exact tarball once with 2FA after explicit approval, and then configure trusted publishing before any later release.

## Prepare a release

1. Select a version that has never appeared on npm. npm versions are immutable.
2. Update `package.json`, `CHANGELOG.md`, `README.md`, `site/index.html`, and `site/wiki/index.html` to the same version.
3. For a stable release, add a dated changelog heading. Use a prerelease version when the package should not receive the `latest` dist-tag.
4. Install the pinned development tools without lifecycle scripts or peers:

   ```bash
   npm install --ignore-scripts --omit=peer --no-package-lock
   ```

5. Run the complete repository and package gates:

   ```bash
   npm run check
   npm run check:pi-package
   npm publish --dry-run --ignore-scripts
   git diff --check
   ```

6. Inspect the final diff and the JSON file manifest emitted by `npm pack --dry-run --json`.
7. Obtain fresh read-only review of package metadata, installer behavior, workflow permissions, and the packed artifact.
8. Commit the reviewed release, create the matching `v<version>` tag, and create a GitHub Release only after explicit approval.

## Automated publication

Publishing the GitHub Release starts `.github/workflows/npm-publish.yml`.

All three jobs pin npm 11.19.1, above npm's 11.5.1 trusted-publishing minimum, on Node.js 22.19.0 and GitHub-hosted runners.

The build job checks tag, package version, changelog entry, and registry immutability, then creates and checksums one tarball before installing repository development tools. It stores that immutable candidate for seven days.

The validation job runs as an Ubuntu, Windows, and macOS matrix. Every runner downloads and verifies the same candidate, exercises that exact tarball through the npm and native Pi package lifecycles, and runs an npm publish dry-run; Ubuntu also runs the full repository checks.

The publish job requires approval in the `npm` environment. Publication runs are serialized, and every candidate must advance its existing dist-tag. The job downloads and verifies the same immutable candidate, publishes through GitHub OIDC with npm provenance, uses `next` for prereleases and `latest` for stable versions, and reads the registry back until version, integrity, dist-tag, and attestation state match.

## Registry smoke check

After publication, install from the registry into disposable state rather than reusing the local tarball:

```bash
npm install --global specpi@<version>
specpi plan
```

Then complete one isolated install, doctor, and uninstall lifecycle before announcing the release. Verify the npm package page, README images, license, repository links, provenance, and dist-tag.

## Update and uninstall contract

Updating the npm CLI and managed SpecPi state are separate operations:

```bash
npm install --global specpi@latest
specpi update
specpi doctor
```

Remove managed resources before removing the CLI:

```bash
specpi uninstall
npm uninstall --global specpi
```

Private wishlist, journal, experiment, and patch state survives managed uninstall unless explicitly removed.

## Failure policy

Before publication, stop and fix any failed gate without changing npm.

After publication, never attempt to replace a version with different bytes. Verify the defect from the registry artifact, deprecate the affected version when warranted, publish a corrected patch after all gates pass, and change a dist-tag only through an explicit reviewed operation. Use unpublish only when npm policy, legal requirements, or credential exposure makes it necessary.

If a publishing credential is exposed, revoke it, stop active workflows, inspect npm ownership and dist-tag history, follow the private security-reporting process, and rotate related credentials before resuming.
