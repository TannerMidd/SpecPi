# Third-party components

This package bundles no third-party runtime code. It has no production dependencies; every runtime import is a Node builtin or a Pi-supplied optional peer.

Git is invoked as an external program through Pi's `exec` seam. It is not bundled, vendored or version-pinned by this package, and it runs with the user's own configuration and credentials.

Pi supplies `@earendil-works/pi-coding-agent` as an optional peer. Development checks pin Pi 0.84.4 (MIT), TypeScript 6.0.3 (Apache-2.0), and Node declarations 22.20.1 (MIT). None are bundled in the production tarball.

First-party experiment code was extracted under MIT from SpecPi 0.20.1, immediately before commit `4f5461ddffeccf60e4894bb6678b72ed95d299fc`, where it shipped as the `/experiment` command of the bundled `extensions/workflow-controls` harness extension. This extraction carries a copy of the Git porcelain parsing helpers, which remain shared in spirit with SpecPi's `/scope` extension, so that the package installs on its own. The task contract that once prefilled the experiment card is now optional context read from a session branch entry, not a dependency.
