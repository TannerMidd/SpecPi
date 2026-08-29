import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_CHARS = 16 * 1024;
export const DEFAULT_MAX_FILES = 4000;
export const DEFAULT_MAX_DEPTH = 16;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function sanitizeTerminalText(value, options = {}) {
  const preserveNewlines = options.preserveNewlines === true;
  let result = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" && preserveNewlines) result += character;
    else if (character === "\t") result += "  ";
    else if (code < 32 || (code >= 127 && code <= 159)) result += "�";
    else result += character;
  }
  return result;
}

function isInside(parent, candidate) {
  const relativePath = path.relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
}

function hasSymlinkComponent(root, candidate) {
  if (!isInside(root, candidate)) return true;
  const relativePath = path.relative(root, candidate);
  let current = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function resolveBrowserRoot(argument, cwd, home = os.homedir()) {
  let value = String(argument || "").trim();
  if (!value) return path.resolve(cwd);
  if (value === "~") value = home;
  else if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(home, value.slice(2));
  }
  const resolved = path.resolve(cwd, value);
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(resolved);
    stat = fs.statSync(canonical);
  } catch {
    throw new Error(`Path is not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
  return canonical;
}

function parseStatus(output, repoRoot, root) {
  const statuses = new Map();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const fileName = record.slice(3);
    if ((code.includes("R") || code.includes("C")) && fields[index + 1]) index += 1;
    const absolute = path.resolve(repoRoot, fileName);
    if (!isInside(root, absolute)) continue;
    statuses.set(normalizeRelative(path.relative(root, absolute)), code);
  }
  return statuses;
}

function discoverWithGit(root, repoRoot, maxFiles) {
  const output = runGit(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (output === undefined) return undefined;
  const files = [];
  let truncated = false;
  for (const fileName of output.split("\0")) {
    if (!fileName) continue;
    const absolute = path.resolve(repoRoot, fileName);
    if (!isInside(root, absolute)) continue;
    try {
      const linkStat = fs.lstatSync(absolute);
      if (hasSymlinkComponent(root, absolute) || linkStat.isSymbolicLink() || !linkStat.isFile()) continue;
    } catch {
      continue;
    }
    files.push(normalizeRelative(path.relative(root, absolute)));
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
  }
  return { files, truncated };
}

function discoverWithFileSystem(root, maxFiles, maxDepth) {
  const files = [];
  let truncated = false;

  function visit(directory, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push(normalizeRelative(path.relative(root, absolute)));
        if (files.length >= maxFiles) truncated = true;
      }
    }
  }

  visit(root, 0);
  return { files, truncated };
}

export function discoverProject(root, options = {}) {
  const canonicalRoot = fs.realpathSync(root);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const repoRootOutput = runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  const repoRoot = repoRootOutput ? path.resolve(repoRootOutput.trim()) : undefined;
  const discovered = repoRoot
    ? discoverWithGit(canonicalRoot, repoRoot, maxFiles)
    : discoverWithFileSystem(canonicalRoot, maxFiles, maxDepth);
  const fallback = discovered ?? discoverWithFileSystem(canonicalRoot, maxFiles, maxDepth);
  const statusOutput = repoRoot ? runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) : undefined;
  const statuses = repoRoot && statusOutput !== undefined ? parseStatus(statusOutput, repoRoot, canonicalRoot) : new Map();
  for (const [relativePath, status] of statuses) {
    if (!status.includes("D") || fallback.files.includes(relativePath)) continue;
    if (fallback.files.length >= maxFiles) {
      fallback.truncated = true;
      break;
    }
    fallback.files.push(relativePath);
  }
  return {
    root: canonicalRoot,
    repoRoot,
    files: fallback.files.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    statuses,
    truncated: fallback.truncated,
  };
}

function directoryNode(name, relativePath, absolutePath, parent) {
  return { name, relativePath, absolutePath, parent, directory: true, children: [], changed: false };
}

export function buildFileTree(snapshot) {
  const root = directoryNode(path.basename(snapshot.root) || snapshot.root, "", snapshot.root, undefined);
  const directories = new Map([["", root]]);

  for (const relativePath of snapshot.files) {
    const parts = relativePath.split("/").filter(Boolean);
    let parent = root;
    let parentPath = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      let node = directories.get(currentPath);
      if (!node) {
        node = directoryNode(part, currentPath, path.join(snapshot.root, ...currentPath.split("/")), parent);
        parent.children.push(node);
        directories.set(currentPath, node);
      }
      parent = node;
      parentPath = currentPath;
    }
    const name = parts.at(-1);
    if (!name) continue;
    const status = snapshot.statuses.get(relativePath);
    parent.children.push({
      name,
      relativePath,
      absolutePath: path.join(snapshot.root, ...relativePath.split("/")),
      parent,
      directory: false,
      status,
      changed: Boolean(status),
    });
  }

  function finish(node) {
    if (!node.directory) return node.changed;
    node.children.sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
    let changed = false;
    for (const child of node.children) {
      if (finish(child)) changed = true;
    }
    node.changed = changed;
    return changed;
  }
  finish(root);
  return root;
}

export function flattenFileTree(root, expanded, query = "", changedOnly = false) {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = [];

  function matches(node) {
    if (changedOnly && !node.changed) return false;
    if (!normalizedQuery) return true;
    if (!node.directory) return node.relativePath.toLowerCase().includes(normalizedQuery);
    return node.children.some(matches);
  }

  function visit(node, depth) {
    for (const child of node.children) {
      if (!matches(child)) continue;
      rows.push({ node: child, depth });
      const forcedOpen = Boolean(normalizedQuery);
      if (child.directory && (forcedOpen || expanded.has(child.relativePath))) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return rows;
}

export function readTextFile(filePath, maximumBytes = MAX_FILE_BYTES, root) {
  if (root && hasSymlinkComponent(fs.realpathSync(root), path.resolve(filePath))) {
    throw new Error("Symbolic links are not opened.");
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not opened.");
  if (!stat.isFile()) throw new Error("Only regular files can be opened.");
  if (stat.size > maximumBytes) throw new Error(`File is larger than ${Math.round(maximumBytes / 1024 / 1024)} MiB.`);
  const data = fs.readFileSync(filePath);
  if (data.includes(0)) throw new Error("Binary files are not shown.");
  return data.toString("utf8");
}

export function readGitDiff(filePath, repoRoot) {
  if (!repoRoot || !isInside(repoRoot, filePath)) return [];
  const relativePath = normalizeRelative(path.relative(repoRoot, filePath));
  const output = runGit(repoRoot, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", relativePath]);
  return output ? output.replace(/\n$/, "").split("\n") : [];
}

export function formatReviewMessage(relativePath, startLine, endLine, selectedText, comment) {
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const safePath = sanitizeTerminalText(relativePath);
  const extension = sanitizeTerminalText(path.extname(relativePath).slice(1));
  const safeSelection = sanitizeTerminalText(selectedText, { preserveNewlines: true });
  const longestFence = Math.max(3, ...([...safeSelection.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  const fence = "`".repeat(longestFence);
  const truncated = safeSelection.length > MAX_REVIEW_CHARS;
  const excerpt = truncated
    ? `${safeSelection.slice(0, MAX_REVIEW_CHARS)}\n… [selection truncated by ZenPi]`
    : safeSelection;
  const safeComment = sanitizeTerminalText(comment, { preserveNewlines: true }).trim();
  return `Review comment for ${JSON.stringify(safePath)} (${range}):\n\n${fence}${extension || "text"}\n${excerpt}\n${fence}\n\n${safeComment}`;
}
