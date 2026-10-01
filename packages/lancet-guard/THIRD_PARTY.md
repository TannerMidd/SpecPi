# Third-party components

## Runtime dependency

`onnxruntime-node` 1.30.0 (MIT, Microsoft), pinned exactly, with `onnxruntime-common` 1.30.0 (MIT). It bundles prebuilt ONNX Runtime CPU libraries for Windows x64/arm64, Linux x64/arm64 and macOS arm64. Its transitive dependencies (`adm-zip`, `global-agent` and their dependencies) serve only its optional CUDA download, which the guard never needs.

Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as optional peers. Development checks pin Pi 0.84.4 (MIT), TypeScript 6.0.3 (Apache-2.0) and Node declarations 22.20.1 (MIT). None are bundled in the production tarball.

## Copied code

`src/rules.ts` and `tests/rules.test.mjs` carry the local rules and their regressions from specpi-jev-guard 0.4.0 (MIT, Tanner Middleton), commit `da63a13ab7b7b7f3a39799e284a2f103f992477c`, with the Jev-specific parts removed.

`src/tokenizer.mjs` and `src/classifier.mjs` are a JavaScript port of LANCET Nano v0.4.3's `classify.py` runtime (MIT, Tanner Middleton). The byte-to-character table follows GPT-2's published byte-level BPE scheme.

## Model (downloaded, not bundled)

`/lancet-guard setup` downloads LANCET Nano v0.4.3 as `lancet-v0.4.3-nano-cpu-int8.zip` from the [LANCET-model GitHub release](https://github.com/TannerMidd/LANCET-model/releases/tag/v0.4.3) and keeps only `encoder-int8.onnx`, `head.bin`, `head.json`, `vocab.json`, `merges.txt` and `model.json`. The package pins the archive and those files by SHA-256. The model is Apache-2.0 (Tanner Middleton); it was newly trained from the same pinned base, and is fine-tuned from Salesforce CodeT5+ 220M at revision `2b92f36e2782341a50551759fdba0dd15e821f99` (BSD-3-Clause, Copyright (c) 2021 Salesforce.com, Inc.; CodeT5+ by Yue Wang, Hung Le, Akhilesh Deepak Gotmare, Nghi D. Q. Bui, Junnan Li and Steven C. H. Hoi). Its tokenizer is the CodeT5 vocabulary and merges, the same tokenization as earlier releases (Salesforce CodeT5-small, Apache-2.0 declaration at revision `b1ee9570c289f21b5922b9c768a1ce12957bf968`). Its training labels come from tldr-pages (CC BY 4.0), AWS botocore (Apache-2.0), the Azure CLI and GitHub CLI (MIT), kubectl and Docker CLI (Apache-2.0), the ShellRisk-Bench training split (its Atomic Red Team rows are MIT; its InternalAllTheThings rows declare no license), the Shell Safety v2 training split (MIT), SWE-smith and Terminal-Bench trajectories, NL2Bash (MIT), and LANCET's own authored data. No dataset is included in the model release or in this package. The full licenses, notices and model card are in the release ZIP; the guard does not keep them after extraction, and the release page and repository remain their source.
