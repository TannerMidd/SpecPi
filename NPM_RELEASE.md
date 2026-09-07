# npm release

Publishing, tags, deprecation, ownership changes and GitHub Releases require explicit human approval. Publication is a post-merge operation: never publish from an unmerged commit. npm versions are immutable.

## Prepare

1. Choose an unused version; update `package.json`, dated `CHANGELOG.md` entry, README and site. Preserve historical changelog entries.
2. Chat has an independent version: if changed, align `vscode/package.json`, its changelog, guides and VSIX filenames. Run its check, render, isolated VSIX and package scripts. The VSIX is not in the npm tarball; building does not authorize Marketplace publication.
3. Validate:

   ```sh
   npm install --ignore-scripts --omit=peer --no-package-lock
   npm run check
   npm run check:pi-package
   npm publish --dry-run --ignore-scripts --provenance=false
   npm pack --dry-run --json
   git diff --check
   ```

   Browser changes also require their opt-in browser gates. Installer/Pi lifecycle tests must use disposable state, never a live profile. Local dry runs disable provenance because they lack GitHub OIDC.
4. Review the diff, exact package manifest and artifact; obtain fresh read-only review for lifecycle, permissions and packaging changes.
5. After approval, merge to `main`, then create the matching `v<version>` tag and GitHub Release. Approve the protected `npm` environment promptly: Pages may already advertise the version. If publication cannot complete, revert the release merge and use a new version for the next attempt.

## Protected publication

`.github/workflows/npm-publish.yml` builds one immutable, checksummed candidate; validates that same tarball on Ubuntu, Windows and macOS; then publishes through approved GitHub OIDC with provenance. Stable releases use `latest`, prereleases `next`. Runs are serialized, existing versions are rejected and the candidate must advance its dist-tag. Registry readback must match version, integrity, dist-tag and attestation.

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
