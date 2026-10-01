// The one LANCET model this package release accepts: LANCET Nano v0.4.3 (CodeT5+ 220M, windowed,
// CPU INT8).
//
// It is fetched as the release ZIP from the LANCET-model GitHub release, which is the project's
// official checksummed artifact. GitHub rather than Hugging Face, because GitHub is the host most
// likely to be reachable from a restricted network. The ZIP is refused unless its SHA-256 matches;
// only the files below are extracted from it, and each is refused unless its own digest matches.
// The release host is a transport, not a trust root: a new model needs a new package release that
// changes these values.

export const MODEL_ID = "lancet-nano-v0.4.3-int8";

export const MODEL_ARCHIVE = Object.freeze({
    url: "https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.3/lancet-v0.4.3-nano-cpu-int8.zip",
    bytes: 108521974,
    sha256: "75b7307abf16a9c63806be6a6aa88e9b18cc463cddf7e4fdc6c9b8e27d4c985c",
    /** Where the files sit inside the archive. */
    prefix: "lancet-v0.4.3-nano-cpu-int8/model/",
});

// The encoder, the head that pools and scores its output (the float32 export of `head.npz` that
// the release ships for non-Python runtimes, bit-for-bit the same values), the tokenizer and the
// thresholds.
export const MODEL_FILES = Object.freeze({
    "encoder-int8.onnx": Object.freeze({
        bytes: 110550587,
        sha256: "4e7d6a53d27a7321a2638a4bf446301e8e343c51000963331469e3ab20aae2a4",
    }),
    "head.bin": Object.freeze({
        bytes: 4730888,
        sha256: "80def54b93bd97191a6e57a09164885a479cad228a3ec83f04efec32576d3c42",
    }),
    "head.json": Object.freeze({
        bytes: 1059,
        sha256: "dc4911d9cb469326cbf7a5eca7dc41328f80d9d394d10333b407345fa007cff2",
    }),
    "vocab.json": Object.freeze({
        bytes: 703051,
        sha256: "43bb485f4de0f2fd49b370bef4efab23ea3ab6d0019e72bdd9cec1436a6eaa2b",
    }),
    "merges.txt": Object.freeze({
        bytes: 294364,
        sha256: "5d346f84939a98df0cde902df7d60154b461cde1b90dc653ab9b81d74e752a4d",
    }),
    "model.json": Object.freeze({
        bytes: 1996,
        sha256: "85f6682e709a3dcfb59f2a9b3d79e83184a9deef0ef5f85f8912d369ae091b89",
    }),
});
