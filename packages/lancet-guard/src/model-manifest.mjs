// The one LANCET model this package release accepts: LANCET Nano v0.4.2 (CodeT5+ 220M, CPU INT8).
//
// It is fetched as the release ZIP from the LANCET-model GitHub release, which is the project's
// official checksummed artifact. GitHub rather than Hugging Face, because GitHub is the host most
// likely to be reachable from a restricted network. The ZIP is refused unless its SHA-256 matches;
// only the three files below are extracted from it, and each is refused unless its own digest
// matches. The release host is a transport, not a trust root: a new model needs a new package
// release that changes these values.

export const MODEL_ID = "lancet-nano-v0.4.2-int8";

export const MODEL_ARCHIVE = Object.freeze({
    url: "https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.2/lancet-v0.4.2-nano-cpu-int8.zip",
    bytes: 99770834,
    sha256: "dfe70d0cd84142acb5551f9972557f4cddb5ea76477d7ed99fbbd070170f06f9",
    /** Where the files sit inside the archive. */
    prefix: "lancet-v0.4.2-nano-cpu-int8/model/",
});

export const MODEL_FILES = Object.freeze({
    "model-int8.onnx": Object.freeze({
        bytes: 110560681,
        sha256: "1b6249c369ad390682d034fb9ee872dcecaa0c3418eb89218b6fa6111594a547",
    }),
    "tokenizer.json": Object.freeze({
        bytes: 2270240,
        sha256: "d30700d23490c46559dcade4d52f0b32950b6d358e00c6d8b340ff819b91c9e7",
    }),
    "model.json": Object.freeze({
        bytes: 3027,
        sha256: "0154d7f2529b64e65f802743a3e89ccc301ac2b8b23f0b61fed2834db46cd675",
    }),
});
