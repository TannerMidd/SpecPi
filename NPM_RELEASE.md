# npm release

This guide covers the root `specpi` package. Browser QA has an independent [release process](packages/browser-qa/NPM_RELEASE.md), `browser-qa-v*` tags and `browser-qa-publish.yml` workflow. Package-only releases do not invoke the root publisher.

Publishing, tags, deprecation, ownership changes and GitHub Releases require explicit human approval. Publication is a post-merge operation: never publish from an unmerged commit. npm versions are immutable.

## Prepare

1. Choose an unused version; update `package.json`, the dated `CHANGELOG.md` entry, README, and the website. Check Chat's version and VSIX download links. Preserve historical changelog entries.
2. Validate:

    ```sh
    npm install --ignore-scripts --omit=peer --no-package-lock
    npm run check
    npm run check:pi-package
    npm run check:base
    npm run check:site
    npm publish --dry-run --ignore-scripts --provenance=false
    npm pack --dry-run --json
    git diff --check
    ```

    Installer/Pi lifecycle tests must use disposable state, never a live profile. `check:base` requires network access and verifies the real six-package base with isolated home/configuration paths. Review all default version changes, upstream lifecycle scripts, compatibility, and notices in `THIRD_PARTY.md`. Local dry runs disable provenance because they lack GitHub OIDC.

3. Review the diff, exact package manifest and artifact; obtain fresh read-only review for lifecycle, permissions and packaging changes.
4. After approval and passing PR checks, merge to `main`, then create the matching `v<version>` tag at the merge commit. Build Chat's VSIX with `npm --prefix vscode run package` and attach it to the GitHub Release. Publish the release to start the npm workflow and approve the protected `npm` environment if it requests review. Verify the website deployment and download links. If publication cannot complete, revert the release merge and use a new version for the next attempt.

## Protected publication

`.github/workflows/npm-publish.yml` builds one immutable, checksummed candidate; validates that same tarball on Ubuntu, Windows and macOS; then publishes through approved GitHub OIDC with provenance. Stable releases use `latest`, prereleases `next`. Runs are serialized, existing versions are rejected and the candidate must advance its dist-tag. Registry readback must match version, integrity, dist-tag and attestation.

Registry processing can take several minutes after npm accepts a publication. The workflow polls for up to five minutes. If that readback times out, inspect the registry and verify the published artifact before taking further action; do not rerun publication for a version that already exists.

After publication, install the registry artifact into disposable state and exercise plan/install/doctor/uninstall. Check package-page links/images, license, provenance and dist-tag before announcing.

## First publication only

Enable npm 2FA/recovery, create a reviewer-protected GitHub `npm` environment and configure trusted publishing for `TannerMidd/SpecPi`, `.github/workflows/npm-publish.yml`. Do not add a long-lived npm token when OIDC is available.

If npm requires an initial interactive publication before attaching the trusted publisher, run every gate above, then publish the exact reviewed tarball with 2FA:

```sh
npm publish --ignore-scripts --access public --provenance=false ./specpi-<version>.tgz
```

This one bootstrap exception lacks GitHub provenance. Verify registry bytes/metadata immediately and configure trusted publishing before subsequent releases. Do not publish a GitHub Release for that same bootstrap version: the workflow rejects existing versions. Keep its reviewed source tag.

## Recovery

Stop before publication if any gate fails. After publication, never replace a version's bytes: verify the registry defect, deprecate when warranted, and ship a checked patch through an explicitly approved operation. Unpublish only when npm policy, legal requirements or credential exposure warrants it.

For exposed credentials, revoke them, stop workflows, inspect ownership/dist-tag history, use the [private reporting channel](SECURITY.md), and rotate related credentials before resuming.
