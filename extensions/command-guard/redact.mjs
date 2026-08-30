export const REDACTION_LIMIT = 512;
const SECRET_FLAG = /^(?:--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?token|authorization|credential|private[-_]?key)|(?:password|token|secret|api[-_]?key|auth(?:orization)?)[=:])/i;
const SECRET_ENV = /^(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|NPM_TOKEN|(?:API|AUTH|ACCESS)_TOKEN|PASSWORD|SECRET)[=:]/i;
function truncateUtf8(value, limit, suffix = "…[truncated]") {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const budget = Math.max(0, limit - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > budget) break;
    output += character;
  }
  return `${output}${suffix}`;
}

export function redactCommand(value, limit = REDACTION_LIMIT) {
  if (typeof value !== "string") return "[invalid command]";
  let text = value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[redacted-private-key]");
  text = text.replace(/(["'](?:proxy-)?authorization["']\s*:\s*["'])[^"'\r\n]*(["'])/gi, "$1[redacted]$2");
  text = text.replace(/((?:--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?token|authorization|credential|private[-_]?key))\s+)(["'])[^\r\n]*?\2/gi, "$1$2[redacted]$2");
  text = text.replace(/((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|NPM_TOKEN|(?:API|AUTH|ACCESS)_TOKEN|PASSWORD|SECRET)=)(["'])[^\r\n]*?\2/gi, "$1$2[redacted]$2");
  text = text.replace(/((?:proxy-)?authorization\s*:\s*)(?:bearer|basic|digest)\s+[^\s"']+/gi, "$1[redacted]");
  text = text.replace(/(["'](?:proxy-)?authorization\s*:\s*)[^"'\r\n]+/gi, "$1[redacted]");
  text = text.replace(/((?:proxy-)?authorization\s*:\s*)[^\s"']+/gi, "$1[redacted]");
  text = text.replace(/([?&](?:token|secret|password|api[_-]?key|access_token)=)[^&\s]*/gi, "$1[redacted]");
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1[redacted]@");
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 1) {
    if (SECRET_FLAG.test(parts[i]) || SECRET_ENV.test(parts[i])) {
      if (parts[i].includes("=")) parts[i] = `${parts[i].slice(0, parts[i].indexOf("=") + 1)}[redacted]`;
      else if (parts[i + 2] && !/^\s+$/.test(parts[i + 2])) { parts[i + 2] = "[redacted]"; }
    }
  }
  text = parts.join("");
  return truncateUtf8(text, limit);
}

export function boundedReason(value, limit = 320) {
  return truncateUtf8(redactCommand(String(value || "Command denied by command guard."), Math.max(limit, REDACTION_LIMIT)), limit);
}
