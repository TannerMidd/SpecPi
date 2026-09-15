# Third-party components

The runtime pins are carried forward from SpecPi 0.20.1 without upgrades:

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| [Playwright](https://github.com/microsoft/playwright) | 1.62.1 | Apache-2.0 | Browser control and explicit Chromium setup |
| [@axe-core/playwright](https://github.com/dequelabs/axe-core-npm) | 4.13.0 | MPL-2.0 | Playwright accessibility adapter |
| [axe-core](https://github.com/dequelabs/axe-core) | 4.13.0 | MPL-2.0 | Accessibility rules |
| [pixelmatch](https://github.com/mapbox/pixelmatch) | 7.2.0 | ISC | Pixel comparison |
| [pngjs](https://github.com/pngjs/pngjs) | 7.0.0 | MIT | PNG decoding/encoding |

Chromium is downloaded separately by Playwright; its notices accompany that distribution. No browser executable is bundled in this npm package. Dependency licenses remain with their npm distributions; this list is not a full transitive audit.

Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `typebox` as optional peers. Development checks pin Pi 0.84.4 (MIT), TypeBox 1.3.7 (MIT), TypeScript 6.0.3 (Apache-2.0), and Node declarations 22.20.1 (MIT). None are bundled in the production tarball.

First-party QA code was extracted under MIT from SpecPi 0.20.1, immediately before commit `4f5461ddffeccf60e4894bb6678b72ed95d299fc`. This extraction replaces installer-specific runtime resolution with npm package resolution and standard Playwright browser caching. It does not restore SpecPi's retired installer or modify its current default packages.
