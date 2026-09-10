#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const extensionRoot = path.resolve(scriptDirectory, "..");
export const repositoryRoot = path.resolve(extensionRoot, "..");
export const packageFiles = Object.freeze([
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "src/extension.js",
    "src/conversation-coordinator.js",
    "src/rpc-client.js",
    "src/launch.js",
    "src/chat-state.js",
    "src/delegates.js",
    "src/guard.js",
    "src/context.js",
    "src/file-filters.js",
    "src/code-references.js",
    "src/images.js",
    "src/image-queue.js",
    "src/conversation-actions.js",
    "src/workspace-actions.js",
    "src/session-catalog.js",
    "src/webview.js",
    "media/icon.svg",
    "media/marketplace-icon.png",
    "media/chat.css",
    "media/chat.js",
    "media/chat-extras.js",
    "media/chat-extras.css",
    "media/chat-picker.js",
    "media/chat-picker.css",
]);

function xml(value) {
    return String(value).replace(/[<>&"']/g, (character) => {
        return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character];
    });
}

export function crc32(data) {
    let checksum = 0xffffffff;
    for (const byte of data) {
        checksum ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
        }
    }

    return (checksum ^ 0xffffffff) >>> 0;
}

// VSIX is an Open Packaging Convention ZIP. Stored entries keep this small,
// deterministic builder dependency-free; timestamps are fixed to 1980-01-01.
export function createZip(entries) {
    const localRecords = [];
    const centralRecords = [];
    const names = new Set();
    let offset = 0;
    for (const entry of entries) {
        if (
            typeof entry.name !== "string" ||
            !/^[a-zA-Z0-9_./\[\]-]+$/.test(entry.name) ||
            entry.name.startsWith("/") ||
            entry.name.split("/").some((segment) => segment === ".." || segment === "." || segment === "") ||
            names.has(entry.name)
        ) {
            throw new Error("Archive entries must have unique, safe relative paths");
        }

        names.add(entry.name);
        const name = Buffer.from(entry.name);
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const checksum = crc32(data);
        if (name.length > 0xffff || data.length > 0xffffffff || offset > 0xffffffff) {
            throw new Error("Archive exceeds ZIP32 limits");
        }

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0x0021, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        localRecords.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0x0021, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centralRecords.push(central, name);
        offset += local.length + name.length + data.length;
    }

    const centralSize = centralRecords.reduce((sum, record) => sum + record.length, 0);
    if (entries.length > 0xffff || offset > 0xffffffff || centralSize > 0xffffffff) {
        throw new Error("Archive exceeds ZIP32 limits");
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...localRecords, ...centralRecords, end]);
}

function manifestXml(manifest) {
    return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Tags>${xml(manifest.keywords.join(","))}</Tags>
    <Categories>${xml(manifest.categories.join(","))}</Categories>
    <GalleryFlags>Public Preview</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(manifest.repository.url)}" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/${xml(manifest.icon)}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(manifest.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

export function packageExtension({
    sourceRoot = extensionRoot,
    licensePath = path.join(repositoryRoot, "LICENSE"),
} = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    if (
        manifest.name !== "specpi-chat" ||
        manifest.publisher !== "tannermidd" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) ||
        manifest.main !== "./src/extension.js" ||
        manifest.private !== true ||
        manifest.icon !== "media/marketplace-icon.png" ||
        Object.keys(manifest.dependencies || {}).length > 0
    ) {
        throw new Error("Unexpected SpecPi Chat manifest; review the package contract before packaging");
    }

    const entries = packageFiles.map((name) => {
        const source = path.join(sourceRoot, name);
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(`Package source must be a regular file: ${name}`);
        }

        const actualRoot = fs.realpathSync(sourceRoot);
        const actualSource = fs.realpathSync(source);
        const relative = path.relative(actualRoot, actualSource);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Package source escapes extension directory: ${name}`);
        }

        return { name: `extension/${name}`, data: fs.readFileSync(source) };
    });
    entries.push({ name: "extension/LICENSE", data: fs.readFileSync(licensePath) });
    entries.push({ name: "extension.vsixmanifest", data: manifestXml(manifest) });
    entries.push({
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
`,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    return { archive: createZip(entries), manifest, entries: entries.map((entry) => entry.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length > 2) {
        throw new Error("Run without arguments; the VSIX is written under .specpi-test/vscode");
    }

    const result = packageExtension();
    const outputDirectory = path.join(repositoryRoot, ".specpi-test", "vscode");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `${result.manifest.name}-${result.manifest.version}.vsix`);
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, result.archive, { flag: "wx" });
    fs.renameSync(temporary, output);
    process.stdout.write(`Packaged ${result.entries.length} files (${result.archive.length} bytes): ${output}\n`);
}
