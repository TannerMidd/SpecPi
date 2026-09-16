# Third-party components

This package bundles no third-party runtime code. It has no production dependencies; every runtime import is a Node builtin or a Pi-supplied optional peer.

Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as optional peers. Development checks pin Pi 0.84.4 (MIT), TypeScript 6.0.3 (Apache-2.0), and Node declarations 22.20.1 (MIT). None are bundled in the production tarball.

First-party delegation code was extracted under MIT from SpecPi 0.20.1, immediately before commit `4f5461ddffeccf60e4894bb6678b72ed95d299fc`, where it shipped as the bundled `extensions/delegation` harness extension. This extraction replaces installer-owned file tracking with npm package resolution and drops the Command Guard admission path, which SpecPi no longer ships. It does not restore SpecPi's retired installer.
