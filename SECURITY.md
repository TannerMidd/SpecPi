# Security policy

Security fixes target the latest tagged SpecPi release. Older releases are unsupported unless an advisory says otherwise.

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/TannerMidd/SpecPi/security/advisories/new). Include the affected version, platform, impact, and a minimal reproduction using synthetic data. Do not post exploit details publicly or include real credentials. If private reporting is unavailable, open an issue requesting restoration of the channel without disclosing the vulnerability.

Responses and fixes are best-effort, without a guaranteed timeline or bug bounty. Coordinate disclosure with the maintainer. Updates appear in [advisories](https://github.com/TannerMidd/SpecPi/security/advisories) and [release notes](CHANGELOG.md).

Reports covering SpecPi's installer, extensions, Chat, website, automation, or dependency integration are welcome. Upstream-only problems may be redirected to the responsible project.

See [SECURITY_MODEL.md](SECURITY_MODEL.md) for trust boundaries and [THIRD_PARTY.md](THIRD_PARTY.md) for dependencies and licenses. SpecPi is not an OS sandbox; use least privilege and containers or VMs for hostile code.
