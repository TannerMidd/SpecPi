import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PATH_LIMIT = 4096;
const unixProtected = [
  /^\/$/, /^\/boot(?:\/|$)/i, /^\/etc(?:\/|$)/i, /^\/bin(?:\/|$)/i,
  /^\/sbin(?:\/|$)/i, /^\/(?:usr|lib|lib64|opt|srv|var)(?:\/|$)/i,
  /^\/root\/?$/i, /^\/home\/?$/i, /^\/home\/[^/]+\/?$/i,
  /(?:^|\/)(?:\.bashrc|\.profile|\.zshrc|\.zprofile)$/i,
  /(?:zenpi|pi).*(?:auth|session|history|mission|trust|private|command.guard)/i,
];
const windowsProtected = [
  /^[a-z]:[\\/]$/i, /^[a-z]:[\\/]Windows(?:[\\/]|$)/i,
  /^[a-z]:[\\/]Boot(?:[\\/]|$)/i, /^[a-z]:[\\/](?:ProgramData|Program Files(?: \(x86\))?)(?:[\\/]|$)/i,
  /^[a-z]:[\\/]Users[\\/]?$/i, /^[a-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i,
  /^\\\\[^\\/]+\\[^\\/]+[\\/]?$/i, /(?:^|[\\/])(?:\.pi|zenpi)(?:[\\/]|$)/i,
  /(?:^|[\\/])Documents[\\/](?:WindowsPowerShell|PowerShell)[\\/](?:Microsoft\.)?PowerShell_profile\.ps1$/i,
  /(?:^|[\\/])profile\.ps1$/i,
];
const privatePath = /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg)(?:[\\/]|$)|(?:^|[\\/])(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|credentials|token|secret|private\.key|config\.gcloud|hosts\.yml|passwd|shadow|ntuser\.dat|login data)(?:$|[\\/])|(?:^|[\\/])(?:\.docker|\.kube)[\\/]config(?:\.json)?$|(?:^|[\\/])\.config[\\/]gcloud(?:[\\/]|$)|(?:^|[\\/])Windows[\\/]System32[\\/]config[\\/](?:SAM|SECURITY|SYSTEM)(?:$|[\\/])|(?:^|[\\/])(?:Microsoft[\\/])?(?:Credentials|Vault|Keychains)(?:[\\/]|$)|\.(?:pem|key|p12|pfx)$/i;

function slash(value, windows) { return windows ? value.replaceAll("/", "\\") : value.replaceAll("\\", "/"); }
function lexical(value, cwd, windows) {
  let raw = String(value).slice(0, PATH_LIMIT);
  if (!windows && raw === "~") raw = os.homedir();
  else if (!windows && raw.startsWith("~/")) raw = path.posix.join(os.homedir(), raw.slice(2));
  if (windows) {
    const normalized = slash(raw, true);
    const base = path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\") ? normalized : path.win32.resolve(slash(cwd, true), normalized);
    return path.win32.normalize(base).replace(/\\+$/, (m) => m.length > 1 ? "\\" : m);
  }
  return path.posix.normalize(path.posix.isAbsolute(raw) ? raw : path.posix.resolve(cwd, raw));
}
function canonicalNearest(value, windows) {
  const api = windows ? fs.realpathSync.native : fs.realpathSync;
  const pathApi = windows ? path.win32 : path.posix;
  let current = value;
  try { return api(current); } catch { /* Find the nearest existing ancestor without enumerating protected directories. */ }
  const suffix = [];
  while (current && current !== pathApi.dirname(current)) {
    suffix.unshift(pathApi.basename(current));
    current = pathApi.dirname(current);
    try { return pathApi.join(api(current), ...suffix); } catch { /* continue */ }
  }
  return undefined;
}
function isProtected(value, windows, read) {
  if (read) return privatePath.test(value) || /(?:^|[\\/])(?:\.pi|zenpi)(?:[\\/]|$)/i.test(value) || /(?:zenpi|pi).*(?:auth|session|history|mission|trust|private)/i.test(value);
  return (windows ? windowsProtected : unixProtected).some((pattern) => pattern.test(value)) || privatePath.test(value);
}

export function classifyPath(input, options = {}) {
  const windows = options.platform === "win32" || options.platform === "windows" || (process.platform === "win32" && !options.platform);
  const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : (windows ? process.cwd() : process.cwd());
  if (typeof input !== "string" || !input || Buffer.byteLength(input, "utf8") > PATH_LIMIT) return { protected: false, indeterminate: true, reason: "The path is malformed or exceeds the safety limit." };
  let requested = input;
  const bashOnWindows = windows && /^(?:bash|sh|zsh|dash|ksh|fish)$/i.test(String(options.shell || ""));
  if (bashOnWindows) {
    if (requested === "~" || requested.startsWith("~/")) requested = path.win32.join(os.homedir(), requested === "~" ? "" : requested.slice(2).replaceAll("/", "\\"));
    else {
      const msysDrive = /^\/(?:cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(requested);
      if (msysDrive) requested = `${msysDrive[1]}:\\${String(msysDrive[2] || "").replaceAll("/", "\\")}`;
    }
  }
  const lexicalPath = lexical(requested, cwd, windows);
  const protectedLexical = isProtected(lexicalPath, windows, Boolean(options.read));
  const normalizedCwd = lexical(cwd, cwd, windows);
  const comparable = (value) => windows ? value.toLowerCase() : value;
  const within = (candidate, root) => comparable(candidate) === comparable(root) || comparable(candidate).startsWith(`${comparable(root)}${windows ? "\\" : "/"}`);
  if (options.read && protectedLexical) {
    return { input, lexical: lexicalPath, canonical: undefined, protected: true, device: false, ads: false, withinWorkspace: within(lexicalPath, normalizedCwd), indeterminate: false, kind: "protected" };
  }
  const canonicalPath = canonicalNearest(lexicalPath, windows);
  const protectedCanonical = canonicalPath ? isProtected(slash(canonicalPath, windows), windows, Boolean(options.read)) : false;
  const canonicalCwd = canonicalNearest(normalizedCwd, windows);
  const withinWorkspace = within(lexicalPath, normalizedCwd) && (!canonicalPath || !canonicalCwd || within(canonicalPath, canonicalCwd));
  const safePseudoDevice = !windows && /^\/dev\/(?:null|zero|random|urandom|stdin|stdout|stderr|fd\/[012])$/i.test(lexicalPath);
  const device = windows ? ((lexicalPath.startsWith("\\\\.") || lexicalPath.startsWith("\\\\?")) ? lexicalPath[3] === "\\" : lexicalPath.toLowerCase().startsWith("\\\\device\\")) : !safePseudoDevice && /^\/dev(?:\/|$)/.test(lexicalPath);
  const ads = windows && /:[^\\/]+$/.test(lexicalPath.slice(3));
  const indeterminate = !canonicalPath && (protectedLexical || windows && lexicalPath.startsWith("\\\\"));
  return {
    input, lexical: lexicalPath, canonical: canonicalPath, protected: protectedLexical || protectedCanonical || device || ads,
    device, ads, withinWorkspace, indeterminate, kind: device ? "device" : ads ? "alternate-data-stream" : protectedLexical || protectedCanonical ? "protected" : "ordinary",
  };
}

export function normalizePath(input, options = {}) { return classifyPath(input, options).lexical; }
export function isProtectedPath(input, options = {}) { return classifyPath(input, options).protected; }

export function pathDecision(input, options = {}) {
  const result = classifyPath(input, options);
  return result.protected ? { action: "deny", severity: "critical", category: "protected-path", ruleIds: ["path.protected"], leaves: [], reason: "The requested path is protected." } : result.indeterminate ? { action: "ask", severity: "high", category: "protected-path", ruleIds: ["path.canonicalization"], leaves: [], reason: "The requested path could not be safely canonicalized." } : { action: "allow", severity: "low", category: "filesystem", ruleIds: [], leaves: [], reason: "The path is outside protected locations." };
}
