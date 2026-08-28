import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VIEWPORT_PRESETS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  tablet: Object.freeze({ width: 834, height: 1112 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

export const DEFAULT_DIFF_THRESHOLD = 0.1;
export const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.01;
export const MAX_VIEWPORT_PIXELS = 8_000_000;
export const MAX_CAPTURE_PIXELS = 8_000_000;
export const MAX_CAPTURE_DIMENSION = 8_192;
export const MAX_PNG_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export function normalizeBrowserUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("A browser URL is required.");
  const candidate = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)
    ? `http://${raw}`
    : raw;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid browser URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URLs must use http: or https:.");
  }
  return url.href;
}

export function resolveViewport({ preset, width, height } = {}) {
  if (width !== undefined || height !== undefined) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200 || width > 4096 || height > 4096) {
      throw new Error("Custom viewport width and height must both be integers from 200 to 4096.");
    }
    if (width * height > MAX_VIEWPORT_PIXELS) {
      throw new Error(`Custom viewport exceeds the ${MAX_VIEWPORT_PIXELS.toLocaleString()} pixel limit.`);
    }
    return { width, height };
  }
  const name = preset ?? "desktop";
  const viewport = VIEWPORT_PRESETS[name];
  if (!viewport) throw new Error(`Unknown viewport preset: ${name}`);
  return { ...viewport };
}

export function resolveUserPath(cwd, value, label = "path") {
  const raw = String(value ?? "").trim().replace(/^@/, "");
  if (!raw) throw new Error(`${label} is required.`);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

export function assertDistinctPaths(entries) {
  const seen = new Map();
  for (const [label, file] of entries) {
    const normalized = path.resolve(file);
    let canonical = normalized;
    try {
      canonical = fs.realpathSync(normalized);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { canonical = path.join(fs.realpathSync(path.dirname(normalized)), path.basename(normalized)); } catch {}
    }
    let identity = canonical;
    try {
      const stat = fs.statSync(normalized);
      identity = `inode:${stat.dev}:${stat.ino}`;
    } catch {}
    const previous = seen.get(identity) || seen.get(canonical);
    if (previous) throw new Error(`${label} must not alias ${previous}: ${normalized}`);
    seen.set(identity, label);
    seen.set(canonical, label);
  }
}

export function sanitizeArtifactSegment(value) {
  const normalized = String(value ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "session";
}

export function makeArtifactPath(agentDir, sessionId, kind, extension = "png") {
  const dir = path.join(agentDir, "zenpi", "browser-artifacts", sanitizeArtifactSegment(sessionId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  const suffix = Math.random().toString(16).slice(2, 10);
  return path.join(dir, `${sanitizeArtifactSegment(kind)}-${stamp}-${suffix}.${extension}`);
}

export async function publishBuffer(file, data, { overwrite = false, signal } = {}) {
  if (signal?.aborted) throw new Error("Browser operation aborted.");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.promises.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    if (signal?.aborted) throw new Error("Browser operation aborted.");
    if (overwrite) {
      await fs.promises.rename(temporary, file);
    } else {
      try {
        await fs.promises.link(temporary, file);
      } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Output already exists: ${file}. Pass overwrite=true only when replacement is intended.`);
        throw error;
      }
      await fs.promises.unlink(temporary);
    }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

export function getAgentDir(extensionUrl) {
  if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR);
  return path.resolve(path.dirname(fileURLToPath(extensionUrl)), "../..");
}

export async function loadBrowserRuntime(runtimeDir) {
  const packageJson = path.join(runtimeDir, "package.json");
  if (!fs.existsSync(packageJson)) {
    throw new Error(`ZenPi browser runtime is not installed at ${runtimeDir}. Run zenpi update without --skip-browser-install.`);
  }
  const require = createRequire(packageJson);
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtimeDir, "browsers");
  try {
    const playwright = require("playwright");
    const { PNG } = require("pngjs");
    const pixelmatchPath = require.resolve("pixelmatch");
    const pixelmatchModule = await import(pathToFileURL(pixelmatchPath).href);
    return { playwright, PNG, pixelmatch: pixelmatchModule.default };
  } finally {
    if (previousBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
  }
}

export function readPngDimensions(buffer, label = "PNG") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a" || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label} is not a valid PNG.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > MAX_CAPTURE_DIMENSION || height > MAX_CAPTURE_DIMENSION || width * height > MAX_CAPTURE_PIXELS) {
    throw new Error(`${label} dimensions ${width}x${height} exceed browser image limits.`);
  }
  return { width, height };
}

export function assertPngResourceBounds(buffer, label = "PNG") {
  if (buffer.length > MAX_PNG_BYTES) throw new Error(`${label} exceeds the ${MAX_PNG_BYTES} byte compressed-size limit.`);
  return readPngDimensions(buffer, label);
}

function boundedPngWrite(PNG, image, label) {
  const buffer = PNG.sync.write(image);
  if (buffer.length > MAX_PNG_BYTES) throw new Error(`${label} exceeds the ${MAX_PNG_BYTES} byte compressed-size limit.`);
  return buffer;
}

export function comparePngBuffers(baselineBuffer, currentBuffer, { PNG, pixelmatch }, options = {}) {
  const threshold = options.threshold ?? DEFAULT_DIFF_THRESHOLD;
  const maxDiffPixelRatio = options.maxDiffPixelRatio ?? DEFAULT_MAX_DIFF_PIXEL_RATIO;
  if (typeof threshold !== "number" || threshold < 0 || threshold > 1) throw new Error("threshold must be between 0 and 1.");
  if (typeof maxDiffPixelRatio !== "number" || maxDiffPixelRatio < 0 || maxDiffPixelRatio > 1) {
    throw new Error("maxDiffPixelRatio must be between 0 and 1.");
  }
  assertPngResourceBounds(baselineBuffer, "Baseline PNG");
  assertPngResourceBounds(currentBuffer, "Current PNG");

  const baseline = PNG.sync.read(baselineBuffer);
  const current = PNG.sync.read(currentBuffer);
  const dimensionsMatch = baseline.width === current.width && baseline.height === current.height;
  if (!dimensionsMatch) {
    const width = Math.max(baseline.width, current.width);
    const height = Math.max(baseline.height, current.height);
    if (width * height > MAX_CAPTURE_PIXELS) throw new Error("Dimension-mismatch diff would exceed browser image limits.");
    const diff = new PNG({ width, height });
    diff.data.fill(255);
    for (let offset = 1; offset < diff.data.length; offset += 4) {
      diff.data[offset] = 0;
      diff.data[offset + 1] = 0;
    }
    return {
      pass: false,
      dimensionsMatch,
      baseline: { width: baseline.width, height: baseline.height },
      current: { width: current.width, height: current.height },
      diffPixels: Math.max(baseline.width * baseline.height, current.width * current.height),
      diffPixelRatio: 1,
      diffBuffer: boundedPngWrite(PNG, diff, "Diff PNG"),
      threshold,
      maxDiffPixelRatio,
    };
  }

  const diff = new PNG({ width: current.width, height: current.height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, current.width, current.height, { threshold });
  const pixelCount = current.width * current.height;
  const diffPixelRatio = pixelCount === 0 ? 0 : diffPixels / pixelCount;
  return {
    pass: diffPixelRatio <= maxDiffPixelRatio,
    dimensionsMatch,
    baseline: { width: baseline.width, height: baseline.height },
    current: { width: current.width, height: current.height },
    diffPixels,
    diffPixelRatio,
    diffBuffer: boundedPngWrite(PNG, diff, "Diff PNG"),
    threshold,
    maxDiffPixelRatio,
  };
}
