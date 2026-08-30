import { classifyPath } from "./paths.mjs";

export const POLICY_VERSION = 1;

const DELETE_NAMES = new Set(["rm", "rmdir", "find", "shred", "truncate", "remove-item", "ri", "del", "erase", "rd", "clear-item", "clear-content", "clear-recyclebin"]);
const REGISTRY_PROPERTY_NAMES = new Set(["set-itemproperty", "new-itemproperty", "copy-itemproperty", "move-itemproperty", "rename-itemproperty", "remove-itemproperty", "clear-itemproperty"]);
const POWERSHELL_WRITE_NAMES = new Set(["set-content", "add-content", "out-file", "tee-object", "export-alias", "export-csv", "export-clixml", "export-counter", "export-formatdata", "export-pssession", "new-item", "copy-item", "move-item", "rename-item", "set-item", "compress-archive", "expand-archive", "start-transcript", "add-type", "new-modulemanifest", "save-help", "save-module", "save-package", "save-script"]);
const DISK_NAMES = new Set(["dd", "mkfs", "mkfs.ext4", "wipefs", "fdisk", "parted", "diskpart", "format", "clear-disk", "initialize-disk", "format-volume", "remove-partition", "cipher"]);
const INTERPRETER_NAMES = new Set(["python", "python3", "py", "node", "deno", "bun", "ruby", "perl", "php", "lua", "rscript"]);
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "powershell", "pwsh", "cmd", "cmd.exe", "eval", "iex", "invoke-expression", ...INTERPRETER_NAMES]);
const DOWNLOAD_NAMES = new Set(["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm", "start-bitstransfer", "bitsadmin", "certutil"]);
const DECODER_NAMES = new Set(["base64", "openssl", "certutil", "uudecode"]);
const NETWORK_NAMES = new Set([...DOWNLOAD_NAMES, "scp", "rsync", "invoke-command", "ssh", "sftp", "ftp", "start-process"]);
const READ_NAMES = new Set(["cat", "head", "tail", "less", "more", "get-content", "gc", "type", "copy", "cp"]);
const SERVICE_NAMES = new Set(["service", "systemctl", "launchctl", "sc", "sc.exe", "stop-service", "restart-service", "new-service", "remove-service"]);
const PERMISSION_NAMES = new Set(["chmod", "chown", "chgrp", "setfacl", "icacls", "takeown", "set-acl"]);
const ACCOUNT_NAMES = new Set(["useradd", "usermod", "userdel", "groupadd", "groupmod", "groupdel", "passwd", "chpasswd", "dscl", "net", "new-localuser", "set-localuser", "remove-localuser", "add-localgroupmember", "remove-localgroupmember"]);

const normalized = (value) => String(value || "").toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop();
const pathArguments = (args, options) => args.filter((arg) => typeof arg === "string" && arg !== "--" && !arg.startsWith("-") && !(options.platform === "win32" && /^(?:cmd|cmd\.exe|powershell|pwsh)$/i.test(String(options.shell || "")) && /^\/[a-z?]+$/i.test(arg)) && arg !== "[dynamic]");
function match(id, severity, category, reason, leaf, saferAlternative) {
  return {
    action: severity === "critical" ? "deny" : "ask",
    severity,
    category,
    ruleIds: [id],
    leaves: [{ executable: leaf.executable, operation: leaf.operation, redactedTarget: leaf.redactedTarget }],
    reason,
    ...(saferAlternative ? { saferAlternative } : {}),
  };
}
function targetState(args, options) {
  const targets = pathArguments(args, options);
  const classified = targets.map((target) => ({ target, result: classifyPath(target, options) }));
  const broadProtected = targets.some((target) => {
    if (!/[?*{}]/.test(target)) return false;
    const base = target.replace(/[\\/](?:\*|\.\*|\{[^}]*\})[\\/]?$/, "");
    return base !== target && classifyPath(base, options).protected;
  });
  return {
    targets,
    protectedTarget: classified.some(({ result }) => result.protected),
    rootTarget: broadProtected || classified.some(({ target, result }) => result.kind === "device" || /^(?:\/|~|\.\.|[a-z]:[\\/]?)$/i.test(result.lexical || "") || /^(?:\/(?:\*|\.\*?)?|[a-z]:[\\/](?:\*|\.\*?)?)$/i.test(String(target))),
  };
}
function optionTargets(args, names) {
  const targets = [], lowered = names.map((name) => name.toLowerCase());
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]), lower = arg.toLowerCase();
    const separator = Math.min(...[lower.indexOf("="), lower.indexOf(":")].filter((value) => value > 0), Number.POSITIVE_INFINITY);
    const key = Number.isFinite(separator) ? lower.slice(0, separator) : lower;
    const exact = lowered.filter((name) => name === key);
    const candidates = exact.length ? exact : lowered.filter((name) => name.startsWith("--") && key.startsWith("--") && key.length >= 3 && name.startsWith(key) || /^-[a-z]{2,}$/i.test(name) && /^-[a-z]{2,}$/i.test(key) && name.startsWith(key));
    if (new Set(candidates).size === 1) {
      if (Number.isFinite(separator)) targets.push(arg.slice(separator + 1));
      else if (typeof args[index + 1] === "string") targets.push(args[index + 1]);
      continue;
    }
    for (const name of names) if (/^-[A-Za-z]$/.test(name) && lower.startsWith(name.toLowerCase()) && arg.length > name.length) targets.push(arg.slice(name.length));
  }
  return targets.filter(Boolean);
}
function hasRecursiveFlag(args) {
  return args.some((arg) => /^(?:--recursive|--force|-{1}[a-z]*r[a-z]*|-recurse|-force|\/s|\/mir)$/i.test(arg));
}

function criticalLeaf(leaf, options) {
  const name = normalized(leaf.executable);
  const args = leaf.args || [];
  const joined = args.join(" ").toLowerCase();
  const targets = targetState(args, options);

  if (DELETE_NAMES.has(name) && (hasRecursiveFlag(args) || name === "find" && args.some((arg) => ["-delete", "-exec", "-execdir"].includes(arg))) && (targets.protectedTarget || targets.rootTarget)) {
    return match("fs.root-recursive-delete", "critical", "filesystem", "Recursive deletion can encompass a protected system, profile, or filesystem root.", leaf, "Delete one specific reviewed workspace path instead.");
  }
  if (DELETE_NAMES.has(name) && targets.protectedTarget) {
    return match("path.protected-mutation", "critical", "protected-path", "The command mutates a protected path.", leaf);
  }
  if (["remove-item", "ri", "del", "erase", "rd"].includes(name) && /(?:registry::|cert:\\?)/i.test(joined)) {
    return match("windows.provider-critical", "critical", "security", "Removing Windows Registry or certificate-store data is permanently denied.", leaf);
  }
  const helpOnly = args.length > 0 && args.every((arg) => /^(?:--?h(?:elp)?|--version|-v|\/\?|help)$/i.test(arg));
  const ddOutput = args.find((arg) => /^of=/i.test(arg));
  const ddTarget = ddOutput ? ddOutput.slice(ddOutput.indexOf("=") + 1) : undefined;
  const destructiveDisk = /\bof=\/dev\/(?:sd|nvme|disk|mapper|md)/i.test(joined)
    || name === "dd" && ddTarget && (classifyPath(ddTarget, options).device || /^(?:\\\\[.?]\\|\\\\device\\)/i.test(ddTarget))
    || /^mkfs(?:\.|$)/i.test(name) && targets.targets.length > 0
    || name === "wipefs" && /(?:^|\s)(?:-a|--all|-o|--offset)(?:\s|$)/i.test(joined)
    || name === "fdisk" && !/(?:^|\s)(?:-l|--list)(?:\s|$)/i.test(joined) && targets.targets.length > 0
    || name === "parted" && /\b(?:mklabel|mkpart|rm|resizepart|set)\b/i.test(joined)
    || ["diskpart", "format", "clear-disk", "initialize-disk", "format-volume", "remove-partition"].includes(name) && !helpOnly
    || name === "cipher" && /(?:^|\s)\/w(?::|\s|$)/i.test(` ${joined}`);
  if (destructiveDisk) return match("disk.destructive", "critical", "disk", "Raw disk, data-wipe, formatting, or partition operations are permanently denied.", leaf);
  if (["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"].includes(name) && !helpOnly || name === "bcdedit" && !/^\s*\/enum\b/i.test(joined) && !helpOnly || name === "vssadmin" && /\b(?:delete|resize)\b/i.test(joined)) {
    return match("system.critical", "critical", "system", "This shutdown, boot, or recovery-state operation is permanently denied.", leaf);
  }
  if (name === "systemctl" && /\b(?:poweroff|reboot|halt|kexec|emergency|rescue)\b/i.test(joined)) return match("system.critical", "critical", "system", "This system-manager operation can stop or destabilize the host.", leaf);
  if (["mdadm", "pvremove", "vgremove", "lvremove", "lvconvert", "zpool", "cryptsetup"].includes(name) && /\b(?:--zero-superblock|--create|remove|destroy|labelclear|luksformat|erase|reencrypt)\b/i.test(joined)) return match("disk.destructive", "critical", "disk", "Destructive RAID, volume-manager, pool, or encrypted-volume operations are permanently denied.", leaf);
  if (["grub-install", "grub-mkconfig", "efibootmgr", "bootcfg"].includes(name) && !helpOnly) return match("boot.destructive", "critical", "system", "Boot-loader configuration mutation is permanently denied.", leaf);
  if ((name === "auditctl" && /(?:^|\s)-e\s*0(?:\s|$)/i.test(` ${joined}`)) || name === "systemctl" && /\b(?:stop|disable|mask)\b.*\b(?:auditd|firewalld|ufw|defender|security)\b/i.test(joined)) return match("security.disable", "critical", "security", "Disabling audit, firewall, or security services is permanently denied.", leaf);
  if (["set-mppreference", "add-mppreference"].includes(name) && /(?:disable|exclusion|realtime|monitoring|mapsreporting|sampleconsent)/i.test(joined)) {
    return match("security.disable", "critical", "security", "Disabling or weakening host security controls is permanently denied.", leaf);
  }
  if (["disable-netfirewallrule", "set-netfirewallprofile", "netsh", "ufw", "iptables", "nft"].includes(name) && /(?:disable|enabled\s+false|state\s+off|firewall.*off|\s-f\b|flush)/i.test(` ${joined}`)) {
    return match("security.disable", "critical", "security", "Disabling or flushing host firewall controls is permanently denied.", leaf);
  }
  if (["setenforce", "csrutil", "spctl"].includes(name) && /(?:^|\s)(?:0|disable|--master-disable)(?:\s|$)/i.test(` ${joined}`)) return match("security.disable", "critical", "security", "Disabling mandatory host security policy is permanently denied.", leaf);
  if ([...SERVICE_NAMES, "net"].includes(name) && /\b(?:stop|disable|delete|remove|unload)\b/i.test(joined) && /(?:windefend|securityhealth|sense|defender|auditd|firewall|crowdstrike|falcon|sentinel|endpoint)/i.test(joined)) return match("security.disable", "critical", "security", "Stopping or removing endpoint, audit, or firewall services is permanently denied.", leaf);
  if ((name === "reg" || REGISTRY_PROPERTY_NAMES.has(name)) && /(?:defender|windows defender|securityhealth)/i.test(joined) && /(?:disable|exclusion|tamper|realtime)/i.test(joined)) return match("security.disable", "critical", "security", "Weakening endpoint security through registry or policy state is permanently denied.", leaf);
  if (name === "set-executionpolicy" && /(?:bypass|unrestricted)/i.test(joined)) return match("security.disable", "critical", "security", "Weakening script execution policy is permanently denied.", leaf);
  if (["printenv", "set"].includes(name) && (name === "set" && args.length === 0 || args.some((arg) => /(?:token|secret|password|credential|api[_-]?key|aws_(?:secret|session)|github_token)/i.test(arg)))) return match("credential.environment-read", "critical", "security", "Reading secret-bearing environment state through a shell is permanently denied.", leaf);
  if (name === "env" && !leaf.nested && !helpOnly) return match("credential.environment-read", "critical", "security", "Dumping the complete process environment can expose credentials and is permanently denied.", leaf);
  if (["get-childitem", "gci", "dir", "get-item", "gi"].includes(name) && args.some((arg) => /^env:/i.test(arg))) return match("credential.environment-read", "critical", "security", "Reading the PowerShell environment provider can expose credentials and is permanently denied.", leaf);
  if (name === "security" && /\b(?:find-(?:generic|internet)-password.*\s-w\b|export)\b/i.test(joined) || name === "secret-tool" && /\b(?:lookup|get|show)\b/i.test(joined) || name === "get-storedcredential" || name === "vaultcmd" && /\/listcreds/i.test(joined)) return match("credential.store-read", "critical", "security", "Reading operating-system credential stores through a shell is permanently denied.", leaf);
  if (name === "git" && /^credential\s+(?:fill|get)\b/i.test(joined) || name === "gh" && /^auth\s+token\b/i.test(joined) || name === "aws" && /^configure\s+export-credentials\b/i.test(joined) || name === "az" && /^account\s+get-access-token\b/i.test(joined) || name === "gcloud" && /^auth\s+(?:print-access-token|application-default\s+print-access-token)\b/i.test(joined) || name === "kubectl" && /^config\s+view\b.*\s--raw\b/i.test(joined)) return match("credential.store-read", "critical", "security", "Printing stored access credentials through a shell is permanently denied.", leaf);
  if (name === "reg" && /^delete\b/i.test(joined) && /(?:hklm|security|sam|system|bcd|defender)/i.test(joined)) {
    return match("registry.system-delete", "critical", "security", "Deleting system or security registry state is permanently denied.", leaf);
  }
  const criticalProcess = args.some((arg) => ["0", "1", "*"].includes(String(arg))) || String(args.at(-1)) === "-1" || /\b(?:system|systemd|init|wininit|csrss|lsass)\b/i.test(joined) || /(?:^|\s)-(?:u|U|G|P)\s+(?:root|0|1)(?:\s|$)|(?:^|\s)-f\s+[.*+](?:\s|$)/i.test(` ${joined}`) || args.includes("--") && args.slice(args.indexOf("--") + 1).includes("-1");
  if (["kill", "killall", "pkill", "taskkill", "stop-process"].includes(name) && criticalProcess) {
    return match("process.broad-kill", "critical", "process", "Broad or critical host process termination is permanently denied.", leaf);
  }
  if (PERMISSION_NAMES.has(name) && targets.protectedTarget && hasRecursiveFlag(args)) {
    return match("security.protected-permissions", "critical", "security", "Recursive permission or ownership changes to protected paths are permanently denied.", leaf);
  }
  const mutationIntent = DELETE_NAMES.has(name) || PERMISSION_NAMES.has(name) || POWERSHELL_WRITE_NAMES.has(name) || ["<redirect>", "cp", "copy", "copy-item", "mv", "move", "move-item", "rename-item", "set-item", "set-content", "add-content", "out-file", "tee", "touch", "mkdir", "new-item", "sed", "dd", "install", "ln", "rsync", "scp", "tar", "unzip", "7z", "7za", "expand-archive", ...DOWNLOAD_NAMES].includes(name) || ["npm", "pnpm", "yarn"].includes(name) && /\b(?:remove|uninstall|unlink)\b/i.test(joined);
  const destinationOptions = ["cp", "install", "ln"].includes(name) ? ["-t", "--target-directory"]
    : name === "copy-item" || name === "move-item" ? ["-destination"]
      : ["compress-archive", "expand-archive"].includes(name) ? ["-destinationpath"]
        : name === "tee-object" || name === "out-file" ? ["-filepath"]
          : name === "export-pssession" ? ["-outputmodule"]
            : name === "add-type" ? ["-outputassembly"]
              : DOWNLOAD_NAMES.has(name) ? ["-o", "--output", "--output-document", "-outfile", "--outfile", "-destination"]
                : POWERSHELL_WRITE_NAMES.has(name) ? ["-path", "-literalpath"] : [];
  const explicitDestination = optionTargets(args, destinationOptions);
  const protectedMutationTargets = ["cp", "copy", "copy-item", "install", "ln"].includes(name) ? (explicitDestination.length ? explicitDestination : targets.targets.slice(-1))
    : ["rsync", "scp"].includes(name) ? targets.targets.slice(-1)
    : ["mv", "move", "move-item", "rename-item"].includes(name) ? [...targets.targets, ...explicitDestination]
      : POWERSHELL_WRITE_NAMES.has(name) ? (explicitDestination.length ? explicitDestination : targets.targets)
      : ["set-content", "add-content", "out-file", "tee", "touch", "mkdir", "new-item"].includes(name) ? targets.targets
      : name === "expand-archive" ? optionTargets(args, ["-destinationpath", "-destination"])
        : DOWNLOAD_NAMES.has(name) ? (explicitDestination.length ? explicitDestination : ["start-bitstransfer", "bitsadmin", "certutil"].includes(name) ? targets.targets.slice(-1) : [])
        : name === "tar" ? optionTargets(args, ["-c", "--directory"])
          : name === "unzip" ? optionTargets(args, ["-d"])
            : name === "7z" || name === "7za" ? optionTargets(args, ["-o"])
      : name === "sed" && args.some((arg) => /^-[a-z]*i/i.test(arg)) ? targets.targets
        : name === "dd" && ddTarget ? [ddTarget] : [];
  if (mutationIntent && protectedMutationTargets.some((target) => classifyPath(target, options).protected)) {
    return match("path.protected-mutation", "critical", "protected-path", "The command writes, moves, or mutates a protected path.", leaf);
  }
  if (mutationIntent && (/zenpi|command-guard|\.pi[\\/].*(?:settings|extensions)/i.test(joined) || targets.targets.some((target) => /(?:\.pi|zenpi).*(?:guard|settings|extensions|auth|session|history|mission|trust)/i.test(target)))) {
    return match("guard.self-tamper", "critical", "protected-path", "The command targets ZenPi guard, configuration, or private state.", leaf);
  }
  return undefined;
}

function ordinaryLeaf(leaf, options) {
  const name = normalized(leaf.executable);
  const args = leaf.args || [];
  const joined = args.join(" ").toLowerCase();

  if (name === "git" && /(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+.*(?:--force|-f\b|--delete)|branch\s+-[dD]|tag\s+-d|rebase\b|filter-(?:branch|repo)|checkout\s+--\s|restore\s+.*(?:--worktree|--staged|--source)|stash\s+(?:drop|clear)|reflog\s+expire|gc\s+.*--prune)/i.test(joined)) return match("git.destructive", "high", "git", "This Git operation discards or rewrites working-tree or remote history.", leaf, "Inspect with git status and git diff first.");
  if (["docker", "podman"].includes(name) && /(?:system\s+prune|(?:rm|rmi|volume\s+rm|network\s+rm)|--volumes|compose\s+down.*(?:-v\b|--volumes))/i.test(joined)) return match("container.destructive", "high", "container", "This container operation removes images, volumes, networks, or resources.", leaf);
  if (name === "kubectl" && /\b(?:delete|drain|cordon|replace|apply|patch|scale)\b/i.test(joined)) return match("container.cluster-mutation", "high", "container", "This cluster operation mutates or removes resources.", leaf);
  if (["terraform", "tofu", "pulumi"].includes(name) && /\b(?:destroy|apply|state\s+rm|down)\b/i.test(joined)) return match("cloud.infrastructure-mutation", "high", "cloud", "This infrastructure operation can replace or destroy remote resources.", leaf);
  if (["aws", "az", "gcloud", "doctl", "heroku", "flyctl"].includes(name) && /\b(?:delete|destroy|terminate|remove|purge|deprovision)\b/i.test(joined)) return match("cloud.resource-delete", "high", "cloud", "This cloud command deletes or deprovisions remote resources.", leaf);
  if (["npm", "pnpm", "yarn", "twine", "cargo", "dotnet", "gem"].includes(name) && /\b(?:publish|unpublish|deprecate|upload|nuget\s+push|yank)\b/i.test(joined)) return match("package.registry-mutation", "high", "package", "Package publication or registry mutation needs approval.", leaf);
  if (["npm", "pnpm", "yarn", "pip", "pip3", "apt", "apt-get", "dnf", "yum", "brew", "winget", "choco"].includes(name) && /\b(?:remove|uninstall|update|upgrade|install|add)\b/i.test(joined)) return match("package.mutation", "medium", "package", "Package installation, update, or removal needs approval.", leaf);
  const pluginExecution = ["npx", "pre-commit"].includes(name) || ["npm", "pnpm"].includes(name) && /^(?:run|test|exec|x)\b/i.test(joined.trim()) || name === "yarn" && joined.trim().length > 0 || ["bun", "deno"].includes(name) && /^(?:run|test|task)\b/i.test(joined.trim()) || name === "cargo" && /^(?:build|check|test|run)\b/i.test(joined.trim());
  if (pluginExecution) return match("execution.plugins-or-hooks", "medium", "dynamic", "This tool can execute project plugins, hooks, scripts, or configuration and needs approval.", leaf);
  if (["export", "set", "setx"].includes(name) && /(?:^|\s)(?:path|[A-Za-z_][A-Za-z0-9_]*)=/i.test(joined)) return match("environment.mutation", "medium", "system", "Environment or PATH mutation needs approval.", leaf);
  if (["set-alias", "new-alias", "import-alias"].includes(name)) return match("dynamic.generated-code", "high", "dynamic", "Alias definitions can redirect later command execution and need approval.", leaf);
  if (["source", "."].includes(name)) return match("dynamic.local-script", "high", "dynamic", "Sourcing an uninspected local script needs approval.", leaf);
  if (NETWORK_NAMES.has(name)) return match("network.or.remote", "high", "network", "Network transfer, download, upload, or remote execution needs approval.", leaf);
  if (["kill", "killall", "pkill", "taskkill", "stop-process"].includes(name)) return match("process.termination", "medium", "process", "Process termination needs approval.", leaf);
  if (DELETE_NAMES.has(name)) return match(hasRecursiveFlag(args) ? "filesystem.recursive-delete" : "filesystem.mutation", "high", "filesystem", hasRecursiveFlag(args) ? "Recursive deletion needs approval." : "File deletion or truncation needs approval.", leaf, "Use a bounded, explicitly reviewed workspace target.");
  if (POWERSHELL_WRITE_NAMES.has(name) || ["cp", "copy", "mv", "move", "tee", "touch", "mkdir", "install", "ln", "rsync", "scp", "tar", "unzip", "7z", "7za"].includes(name) || name === "dd" && !args.every((arg) => /^(?:--?h(?:elp)?|--version|-v)$/i.test(arg)) || name === "sed" && args.some((arg) => /^-[a-z]*i/i.test(arg))) return match("filesystem.write", "high", "filesystem", "Filesystem creation, overwrite, or movement needs approval.", leaf);
  if (name === "find" && args.some((arg) => ["-delete", "-exec", "-execdir"].includes(arg))) return match("filesystem.find-mutation", "high", "filesystem", "Find execution or deletion needs approval.", leaf);
  if (["xargs", "eval", "invoke-expression", "iex"].includes(name)) return match("dynamic.generated-code", "high", "dynamic", "Generated or indirectly invoked code needs approval.", leaf);
  if (SERVICE_NAMES.has(name) && /\b(?:stop|restart|disable|delete|remove|create|start)\b/i.test(joined)) return match("service.mutation", "high", "system", "Service mutation needs approval.", leaf);
  if (PERMISSION_NAMES.has(name) || ACCOUNT_NAMES.has(name)) return match("security.identity-or-permission", "high", "security", "Account, group, ACL, permission, or ownership mutation needs approval.", leaf);
  if (name === "reg" && /^delete\b/i.test(joined)) return match("registry.delete", "high", "security", "Registry deletion needs approval.", leaf);
  if (name === "reg" && /^(?:add|copy|import|load|unload|restore)\b/i.test(joined)) return match("registry.mutation", "high", "security", "Registry mutation needs approval.", leaf);
  if (REGISTRY_PROPERTY_NAMES.has(name)) return match("registry.mutation", "high", "security", "Registry property mutation needs approval regardless of provider-drive spelling.", leaf);
  if (["new-psdrive", "remove-psdrive"].includes(name) && /(?:^|\s)(?:registry|-psprovider\s+registry)\b/i.test(joined)) return match("registry.mutation", "high", "security", "Registry provider-drive mutation needs approval.", leaf);
  if ((name === "schtasks" && /\/delete/i.test(joined)) || name === "unregister-scheduledtask" || name === "crontab" && /(?:^|\s)-r(?:\s|$)/i.test(` ${joined}`) || (name === "wsl" && /--unregister/i.test(joined))) return match("system.registration-delete", "high", "system", "Scheduled-task or subsystem deletion needs approval.", leaf);
  if ((name === "robocopy" && /\/mir\b/i.test(joined)) || name === "clear-winevent" || (name === "wevtutil" && /^cl\b/i.test(joined))) return match("filesystem.broad-mutation", "high", "filesystem", "Mirroring or clearing host data needs approval.", leaf);
  if (["psql", "mysql", "sqlcmd", "sqlite3", "mongosh", "mongo", "redis-cli"].includes(name) && /\b(?:drop|truncate|delete\s+from|flushall|flushdb)\b/i.test(joined)) return match("database.destructive", "high", "database", "Destructive database statements need approval.", leaf);
  if (["prisma", "knex", "sequelize", "alembic", "rails", "rake", "dotnet"].includes(name) && /\b(?:migrate\s+reset|migrate:rollback|migrate:undo|downgrade|db:rollback|database\s+drop)\b/i.test(joined)) return match("database.migration-rollback", "high", "database", "Database reset, drop, or migration rollback needs approval.", leaf);
  if (SHELL_NAMES.has(name) && args.some((arg) => /^(?:-c|-command|-encodedcommand|\/c|\/k|-e|--eval|-r)$/i.test(arg))) return match("dynamic.inline-code", "high", "dynamic", "Inline interpreter code needs approval.", leaf);
  if ((SHELL_NAMES.has(name) && args.some((arg) => /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|py|rb|pl|php|lua|r)(?:$|[?#])/i.test(arg))) || /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|py|rb|pl|php|lua|r)$/i.test(String(leaf.executable || ""))) return match("dynamic.local-script", "high", "dynamic", "Executing a local script that was not statically inspected needs approval.", leaf);
  return undefined;
}

function flatten(analysis) {
  return [...(analysis.leaves || []), ...(analysis.leaves || []).flatMap((leaf) => leaf.nested ? flatten(leaf.nested) : [])];
}
function redirectsWithShell(analysis) {
  return [...(analysis.redirects || []).map((redirect) => ({ redirect, shell: analysis.shell })), ...(analysis.leaves || []).flatMap((leaf) => leaf.nested ? redirectsWithShell(leaf.nested) : [])];
}
function leafOptions(leaf, options) { return { ...options, shell: leaf.shell || options.shell }; }
function nestedNames(leaf) { return [normalized(leaf.executable), ...(leaf.nested ? flatten(leaf.nested).map((entry) => normalized(entry.executable)) : [])]; }
function pipelineGroups(analysis) {
  const groups = [], leaves = analysis.leaves || [];
  const explicit = new Map();
  for (const leaf of leaves) if (Number.isInteger(leaf.pipelineGroup)) explicit.set(leaf.pipelineGroup, [...(explicit.get(leaf.pipelineGroup) || []), leaf]);
  for (const group of explicit.values()) if (group.length > 1) groups.push(group);
  let current = [];
  for (const leaf of leaves) {
    if (leaf.executable === "<redirect>") continue;
    if (leaf.separatorBefore !== "|" && current.length) { if (current.length > 1) groups.push(current); current = []; }
    current.push(leaf);
    if (leaf.nested) groups.push(...pipelineGroups(leaf.nested));
  }
  if (current.length > 1) groups.push(current);
  return groups;
}

export function evaluateRules(analysis, options = {}) {
  const findings = [];
  const allLeaves = flatten(analysis);
  const readsProtectedInput = allLeaves.some((leaf) => READ_NAMES.has(normalized(leaf.executable)) && (leaf.args || []).some((arg) => classifyPath(arg, { ...leafOptions(leaf, options), read: true }).protected));
  if (readsProtectedInput) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["credential.protected-read"], leaves: [], reason: "Reading credential or Pi private-state paths through a shell is permanently denied." });
  if (allLeaves.some((leaf) => {
    const name = normalized(leaf.executable); if (!SHELL_NAMES.has(name)) return false;
    const semanticShell = ["cmd", "cmd.exe"].includes(name) ? "cmd" : ["powershell", "pwsh"].includes(name) ? "powershell" : leaf.shell;
    const scoped = { ...leafOptions(leaf, options), shell: semanticShell, read: true };
    const args = leaf.args || [];
    const inline = args.findIndex((arg) => /^(?:-c|-command|-encodedcommand|\/c|\/k|-e|--eval|-r)$/i.test(String(arg)));
    const candidateArgs = inline >= 0 ? args.slice(0, inline) : args;
    return pathArguments(candidateArgs, scoped).some((arg) => classifyPath(arg, scoped).protected);
  })) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["credential.execution"], leaves: [], reason: "Credential or private-state content connected to an interpreter is permanently denied." });
  for (const group of pipelineGroups(analysis)) {
    const names = group.map((leaf) => nestedNames(leaf)).flat();
    const protectedStage = group.some((leaf) => READ_NAMES.has(normalized(leaf.executable)) && (leaf.args || []).some((arg) => classifyPath(arg, { ...leafOptions(leaf, options), read: true }).protected));
    if (names.some((name) => DOWNLOAD_NAMES.has(name)) && names.some((name) => SHELL_NAMES.has(name))) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["exec.download-pipe"], leaves: [], reason: "Downloaded content connected to an interpreter is permanently denied." });
    if (names.some((name) => DECODER_NAMES.has(name)) && names.some((name) => SHELL_NAMES.has(name))) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["exec.generated-pipe"], leaves: [], reason: "Decoded or generated content connected to an interpreter is permanently denied." });
    if (protectedStage && names.some((name) => NETWORK_NAMES.has(name))) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["credential.exfiltration"], leaves: [], reason: "Credential or private-key data connected to network transfer is permanently denied." });
  }
  if (allLeaves.some((leaf) => NETWORK_NAMES.has(normalized(leaf.executable)) && (leaf.args || []).some((arg) => classifyPath(String(arg).replace(/^@/, ""), { ...leafOptions(leaf, options), read: true }).protected))) findings.push({ action: "deny", severity: "critical", category: "security", ruleIds: ["credential.exfiltration"], leaves: [], reason: "A network command targets credential or private-key data." });
  for (const leaf of allLeaves) {
    const optionsForLeaf = leafOptions(leaf, options);
    const criticalFinding = criticalLeaf(leaf, optionsForLeaf);
    if (criticalFinding) findings.push(criticalFinding);
    else {
      const finding = ordinaryLeaf(leaf, optionsForLeaf);
      if (finding) findings.push(finding);
    }
  }
  for (const entry of redirectsWithShell(analysis)) {
    const redirect = entry.redirect;
    const redirectOptions = { ...options, shell: entry.shell || options.shell };
    const target = typeof redirect === "string" ? undefined : redirect.target || redirect.targetLiteral;
    const output = typeof redirect === "string" ? redirect.includes(">") : redirect.operator ? String(redirect.operator).includes(">") : true;
    if (target && classifyPath(target, { ...redirectOptions, read: !output }).protected) findings.push({ action: "deny", severity: "critical", category: output ? "protected-path" : "security", ruleIds: [output ? "guard.redirect-tamper" : "credential.protected-read"], leaves: [], reason: output ? "A shell redirect targets a protected path." : "A shell redirect reads credential or private-state data." });
    else if (output) findings.push({ action: "ask", severity: "high", category: "filesystem", ruleIds: ["filesystem.redirect"], leaves: [], reason: "A shell redirect may mutate a file and needs approval." });
  }
  if (analysis.indeterminate || (analysis.dynamicConstructs || []).some((entry) => /substitution|environment-expansion|dynamic|depth|limit|batch|nested|heredoc|stopparsing/i.test(entry.kind))) findings.push({ action: "ask", severity: "high", category: "dynamic", ruleIds: ["parser.indeterminate"], leaves: [], reason: "The command could not be completely analyzed; it will not be treated as safe." });
  return findings;
}

export const matchRules = evaluateRules;
export const ruleCatalog = Object.freeze({
  version: POLICY_VERSION,
  ruleIds: Object.freeze([
    "boot.destructive", "cloud.infrastructure-mutation", "cloud.resource-delete", "container.cluster-mutation", "container.destructive",
    "credential.environment-read", "credential.execution", "credential.exfiltration", "credential.protected-read", "credential.store-read", "database.destructive", "database.migration-rollback",
    "disk.destructive", "filesystem.outside-workspace", "dynamic.generated-code", "dynamic.inline-code", "dynamic.local-script", "environment.mutation", "exec.download-pipe",
    "exec.generated-pipe", "execution.plugins-or-hooks", "filesystem.broad-mutation", "filesystem.find-mutation", "filesystem.mutation",
    "filesystem.recursive-delete", "filesystem.redirect", "filesystem.write", "fs.root-recursive-delete", "git.destructive", "guard.redirect-tamper",
    "guard.self-tamper", "network.or.remote", "package.mutation", "package.registry-mutation", "parser.indeterminate", "path.protected-mutation",
    "parser.integrity", "parser.syntax", "path.canonicalization", "path.protected", "policy.integrity", "process.broad-kill", "process.fork-bomb", "process.termination", "registry.delete", "registry.mutation", "registry.system-delete", "security.disable",
    "security.identity-or-permission", "security.protected-permissions", "service.mutation", "system.critical", "system.registration-delete",
    "session.locked", "strict.execution", "strict.mutation", "tool.unknown-capability", "windows.provider-critical",
  ]),
  critical: ["filesystem-root", "disk", "boot", "host-security", "broad-process", "guard-tamper", "download-execute"],
  high: ["filesystem", "git", "database", "container", "cloud", "package-publish", "service", "registry", "identity", "network"],
  medium: ["package-install", "process-termination"],
});
