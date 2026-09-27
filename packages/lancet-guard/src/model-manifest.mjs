// The one LANCET model this package release accepts: LANCET Nano v0.4.0 (CodeT5+ 220M, CPU INT8).
//
// It is fetched as the release ZIP from the LANCET-model GitHub release, which is the project's
// official checksummed artifact. GitHub rather than Hugging Face, because GitHub is the host most
// likely to be reachable from a restricted network. The ZIP is refused unless its SHA-256 matches;
// only the three files below are extracted from it, and each is refused unless its own digest
// matches. The release host is a transport, not a trust root: a new model needs a new package
// release that changes these values.

export const MODEL_ID = "lancet-nano-v0.4.0-int8";

export const MODEL_ARCHIVE = Object.freeze({
    url: "https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.0/lancet-v0.4.0-nano-cpu-int8.zip",
    bytes: 99760511,
    sha256: "b0dde0b755908025221f485163a747bef332174dbfe2f215439f02c5d3123053",
    /** Where the files sit inside the archive. */
    prefix: "lancet-v0.4.0-nano-cpu-int8/model/",
});

export const MODEL_FILES = Object.freeze({
    "model-int8.onnx": Object.freeze({
        bytes: 110560709,
        sha256: "f412c91867f769aa2b7b0bd5625b460efeb2018fcc5bddd4b39f09dfd2dc4f32",
    }),
    "tokenizer.json": Object.freeze({
        bytes: 2270240,
        sha256: "d30700d23490c46559dcade4d52f0b32950b6d358e00c6d8b340ff819b91c9e7",
    }),
    "model.json": Object.freeze({
        bytes: 2196,
        sha256: "809f2ec7ae6d19b462beaa0ff7e0ae97ed68cb8a259384d5b63524fc7dd18954",
    }),
});
