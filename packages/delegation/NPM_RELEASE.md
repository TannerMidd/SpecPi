# Delegation releases

This package is released independently from the root `specpi` package. Publishing, merging, tags and releases require human authorization. Never publish an unmerged commit or reuse a published version.

1. Update this package's version and lockfile, release notes and install examples. Check the npm name/version is available.
2. Run `npm ci --ignore-scripts --omit=peer` and `npm run check` here. The `delegation` CI matrix must pass on Linux, Windows and macOS. Obtain fresh read-only review for dependency, packaging or security changes.
3. Merge the reviewed PR to `main`. Tag the merge commit `delegation-v<version>`.
4. Publish a GitHub Release for that tag to invoke `.github/workflows/delegation-publish.yml`. Do not mark a package-only release as the repository's latest SpecPi release. The workflow builds one checksummed artifact, validates those exact bytes on all three systems, and publishes through the protected `npm` environment using OIDC and provenance.
5. Verify registry version, integrity, dist-tag and provenance. Install the registry artifact in disposable state and run Pi registration before integrating the pin into SpecPi.

## First publication

Configure npm trusted publishing for `TannerMidd/SpecPi`, workflow `delegation-publish.yml`, environment `npm`. The GitHub environment must allow `delegation-v*` tags and retain its required reviewer.

If npm requires an initial interactive publication, prepare the exact reviewed tarball after merge with `npm pack --ignore-scripts --json --pack-destination <candidate-dir>`, then run `npm run check:package -- --artifact <absolute-tarball>`. All PR platform checks must already have passed. Authenticate interactively and publish that tarball with `npm publish --ignore-scripts --access public --provenance=false <tarball>`. This one bootstrap publication lacks GitHub provenance. Verify its registry integrity and configure trusted publishing immediately afterward. Keep the source tag, but do not publish a GitHub Release for the same bootstrap version: the workflow deliberately refuses existing versions.

## Recovery

Stop on failed gates. If a registry readback times out, inspect the published version before retrying anything; npm versions are immutable. Fix defects in a new version. Do not unpublish, deprecate or alter ownership without explicit approval. Package-only tags are ignored by the root SpecPi publishing workflow.
