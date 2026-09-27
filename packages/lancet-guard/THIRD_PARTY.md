# Third-party components

## Runtime dependency

`onnxruntime-node` 1.30.0 (MIT, Microsoft), pinned exactly, with `onnxruntime-common` 1.30.0 (MIT). It bundles prebuilt ONNX Runtime CPU libraries for Windows x64/arm64, Linux x64/arm64 and macOS arm64. Its transitive dependencies (`adm-zip`, `global-agent` and their dependencies) serve only its optional CUDA download, which the guard never needs.

Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as optional peers. Development checks pin Pi 0.84.4 (MIT), TypeScript 6.0.3 (Apache-2.0) and Node declarations 22.20.1 (MIT). None are bundled in the production tarball.

## Copied code

`src/rules.ts` and `tests/rules.test.mjs` carry the local rules and their regressions from specpi-jev-guard 0.4.0 (MIT, Tanner Middleton), commit `da63a13ab7b7b7f3a39799e284a2f103f992477c`, with the Jev-specific parts removed.

`src/tokenizer.mjs` and `src/classifier.mjs` are a JavaScript port of LANCET Nano's `classify.py` runtime (MIT, Tanner Middleton). The byte-to-character table follows GPT-2's published byte-level BPE scheme.

## Model (downloaded, not bundled)

`/lancet-guard setup` downloads LANCET Nano v0.3.0 as `lancet-v0.3.0-nano-cpu-int8.zip` from the [LANCET-model GitHub release](https://github.com/TannerMidd/LANCET-model/releases/tag/v0.3.0) and keeps only `model-int8.onnx`, `tokenizer.json` and `model.json`. The package pins the archive and those files by SHA-256. The model is Apache-2.0 (Tanner Middleton), fine-tuned from Salesforce CodeT5-base at revision `02cd2d31bb7c6d0e4d91156167b2de044989c733` (Apache-2.0; CodeT5 by Yue Wang, Weishi Wang, Shafiq Joty and Steven C. H. Hoi). Its training labels come from tldr-pages (CC BY 4.0), AWS botocore (Apache-2.0), the Azure CLI and GitHub CLI (MIT), kubectl and Docker CLI (Apache-2.0), and LANCET's own authored data. The full licenses, notices and model card are in the release ZIP; the guard does not keep them after extraction, and the release page and repository remain their source.
