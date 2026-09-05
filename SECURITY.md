# Security Policy

This policy explains which SpecPi releases receive security fixes, how to report a vulnerability, and the security responsibilities shared by SpecPi and its users. For architecture, trust boundaries, and component limitations, see [SECURITY_MODEL.md](SECURITY_MODEL.md). Exact third-party versions and licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).

## Supported versions

SpecPi provides security fixes for the latest tagged release only. Older releases are unsupported unless a published security advisory says otherwise. Before reporting, check whether the latest release already corrects the behavior; reports affecting the supported release remain welcome.

| Release | Security support |
| --- | --- |
| Latest tagged release | Supported |
| Older releases | Unsupported |

## Report a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/TannerMidd/SpecPi/security/advisories/new). SpecPi currently accepts private reports only through GitHub.

Do not open a public issue, pull request, discussion, or other public report containing vulnerability or exploit details. A GitHub account is required. If private reporting is unexpectedly unavailable, open a public issue containing no vulnerability details and ask the maintainer to restore the private reporting channel before sharing the report.

Include as much of the following as is safe and practical:

- the affected SpecPi release or commit;
- the affected installer command, extension, tool, workflow, or website component;
- operating system and relevant configuration;
- expected and observed behavior;
- security impact and plausible attack scenario;
- minimal reproduction steps or proof of concept;
- known mitigations or workarounds;
- whether the issue is already public or actively exploited;
- preferred credit or anonymity.

Do not include real credentials, personal data, production secrets, or destructive payloads when a minimized demonstration is sufficient.

SpecPi handles reports on a best-effort basis. Maintainers will acknowledge, assess, and communicate as capacity permits, but the project does not promise fixed response or remediation times. Fix timing depends on impact, exploitability, complexity, upstream coordination, and release safety.

Please keep the report private while impact, mitigations, a fix, and an advisory are coordinated. Disclosure timing will be discussed with the reporter and may be accelerated when details are already public or exploitation is active. SpecPi does not currently operate a bug bounty program.

## Scope

Reports are in scope when they concern SpecPi-owned behavior, including:

- the plan, install, update, doctor, and uninstall lifecycle;
- managed configuration, backups, checksums, rollback, and shell integration;
- bundled extensions, skills, themes, browser integration, and local state;
- Command Guard classification, enforcement, approval, or bypass behavior;
- the GitHub Pages site and repository release or deployment workflows;
- an upstream dependency when SpecPi's integration, configuration, or selected version creates or exposes the vulnerability.

Pi, npm, Chromium, Playwright, DonSeTch, GitHub, and other third-party projects maintain their own security boundaries. Upstream-only vulnerabilities may be redirected to the responsible project. Reports remain relevant to SpecPi when its use of an upstream component creates a distinct risk or requires a SpecPi mitigation.

A disagreement with an intentional, documented limitation is not by itself a vulnerability. Reports that show the implementation violating its stated boundary, silently weakening a protection, exposing protected data, or enabling a practical bypass are welcome.

## Security updates

When appropriate, SpecPi publishes security information through [GitHub Security Advisories](https://github.com/TannerMidd/SpecPi/security/advisories), tagged releases, and [CHANGELOG.md](CHANGELOG.md). An advisory should identify affected and fixed releases, impact, mitigations or workarounds, and upgrade guidance. A CVE may be requested when appropriate.

## Secure installation and operation

- Install a version-pinned npm release or clone and review the matching source tag. Verify npm provenance when relying on the registry artifact. Do not pipe remote installer content directly into a shell.
- Installing the npm package adds the CLI only. Review `specpi plan` before installation or update, and use `--yes` only when every planned external installation is intended.
- Treat `pi install npm:specpi` as limited resource-only mode, not as the managed installer with browser runtime, supporting packages, instructions, backups, and rollback ownership.
- Run `specpi doctor` after installation and updates.
- Run Pi and SpecPi with the least operating-system privilege practical. Use a container or VM for hostile repositories, code, or web content.
- Protect Pi configuration and credentials with operating-system permissions. SpecPi is not a credential or process sandbox.
- Use dedicated test accounts rather than personal authenticated browser sessions.
- Inspect wishlist reports, issue drafts, screenshots, page text, downloads, console output, and visual baselines before sharing them.
- Review optional and global package installations. Some external state and package caches survive rollback or uninstall.

## Security boundaries at a glance

| Area | SpecPi provides | SpecPi does not provide |
| --- | --- | --- |
| npm distribution | Reviewed file allow-list, no install lifecycle script, protected publishing, and requested provenance | Automatic execution of the managed SpecPi installer or proof that packaged code is safe |
| Installer | Explicit plans and confirmation, bounded managed changes, backups, checksums, atomic promotion, and rollback | Rollback of every external package-manager side effect or cache |
| Command Guard | Pre-execution defense in depth for documented model-tool seams | A general sandbox for direct user commands, arbitrary tools, scripts, extensions, or running processes |
| Local improvement state | Explicit collection choice, bounded local records, sanitization, and no SpecPi upload | Guaranteed removal of every plain-language identity or automatic deletion on uninstall |
| Browser | A fresh Chromium context without the personal browser profile | Operating-system or network isolation from hostile web content |

The authoritative assumptions, enforcement seams, residual risks, and component details are in [SECURITY_MODEL.md](SECURITY_MODEL.md).

## Dependencies and supply chain

SpecPi pins reviewed executable dependencies and uses a reviewed lockfile for its managed browser runtime. The npm release workflow validates one tarball, publishes those same bytes from a protected environment with GitHub OIDC, and requests npm provenance. Provenance links an artifact to its build workflow but does not prove the source or dependencies are safe. Pinning, lockfiles, and provenance improve accountability but are not complete reproducible-build guarantees. Installation still trusts the configured package registries, upstream publishers, downloaded browser distribution, GitHub Actions, and the invoking host.

Some optional or bootstrap packages are installed globally and remain external system state. SpecPi uninstall does not remove them. See [THIRD_PARTY.md](THIRD_PARTY.md) for the canonical component and version inventory and [SECURITY_MODEL.md](SECURITY_MODEL.md) for acquisition and rollback boundaries.
