// The one LANCET model this package release accepts: LANCET Nano v0.3.0 (CodeT5-base, CPU INT8).
//
// It is fetched as the release ZIP from the LANCET-model GitHub release, which is the project's
// official checksummed artifact. GitHub rather than Hugging Face, because GitHub is the host most
// likely to be reachable from a restricted network. The ZIP is refused unless its SHA-256 matches;
// only the three files below are extracted from it, and each is refused unless its own digest
// matches. The release host is a transport, not a trust root: a new model needs a new package
// release that changes these values.

export const MODEL_ID = "lancet-nano-v0.3.0-int8";

export const MODEL_ARCHIVE = Object.freeze({
    url: "https://github.com/TannerMidd/LANCET-model/releases/download/v0.3.0/lancet-v0.3.0-nano-cpu-int8.zip",
    bytes: 99563201,
    sha256: "d7ab46ab6477a7803cfed230c3d6fcc27d7bb96864d7ceb83e1bffb28132d3e5",
    /** Where the files sit inside the archive. */
    prefix: "lancet-v0.3.0-nano-cpu-int8/model/",
});

export const MODEL_FILES = Object.freeze({
    "model-int8.onnx": Object.freeze({
        bytes: 110560712,
        sha256: "b635571b0c55fba5224a00e2c9132918db816b76c433e8c8dc75d151ef03de1c",
    }),
    "tokenizer.json": Object.freeze({
        bytes: 2270240,
        sha256: "d30700d23490c46559dcade4d52f0b32950b6d358e00c6d8b340ff819b91c9e7",
    }),
    "model.json": Object.freeze({
        bytes: 2332,
        sha256: "1c7e2595b6a74032b6104024c87862c434b9d6fc0216094efb5a9bbf512649b3",
    }),
});
