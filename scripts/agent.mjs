import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiHost } from "../extensions/delegation/provider.mjs";

const SDK_NAME = "@earendil-works/pi-coding-agent";
const SDK_VERSION = "0.84.4";
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledResources = [
    "spec.ts",
    "command-guard/index.ts",
    "workflow-controls/index.ts",
    "files/index.ts",
    "browser/index.ts",
    "tool-wishlist/index.ts",
    "ui-refresh/index.ts",
];

function within(candidate, root) {
    const relative = path.relative(root, candidate);

    return (
        relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
}

export function parseAgentArgs(args) {
    const options = { help: false, trustProject: false, sdkDirectory: undefined };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--help") {
            options.help = true;
        } else if (argument === "--trust-project") {
            options.trustProject = true;
        } else if (argument === "--pi-sdk" && options.sdkDirectory === undefined) {
            index += 1;
            const directory = args[index];
            if (typeof directory !== "string" || !path.isAbsolute(directory)) {
                throw new Error("--pi-sdk requires an absolute Pi package directory");
            }

            options.sdkDirectory = directory;
        } else {
            throw new Error("Unsupported specpi agent argument; use --help");
        }
    }

    return options;
}

export function assertSupportedProxy(settingsManager, environment = process.env) {
    const proxyNames = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]);
    if (Object.entries(environment).some(([key, value]) => proxyNames.has(key.toUpperCase()) && Boolean(value))) {
        throw new Error("specpi agent does not support proxy environment settings; use the native Pi launcher");
    }

    if (settingsManager.getGlobalSettings().httpProxy || settingsManager.getProjectSettings().httpProxy) {
        throw new Error("specpi agent does not support Pi httpProxy settings; use the native Pi launcher");
    }
}

export async function loadPiSdk({ sdkDirectory, trustProject = false } = {}) {
    let directory = sdkDirectory;
    if (!directory) {
        let entry;
        try {
            entry = fileURLToPath(import.meta.resolve(SDK_NAME));
        } catch {
            throw new Error("Pi SDK 0.84.4 is unavailable; pass --pi-sdk with its absolute package directory");
        }

        directory = path.resolve(path.dirname(entry), "..");
    }

    if (!path.isAbsolute(directory)) {
        throw new Error("Pi SDK directory must be absolute");
    }

    const canonical = await fs.realpath(directory);
    if (!sdkDirectory && !trustProject) {
        const [canonicalCwd, canonicalSourceRoot] = await Promise.all([
            fs.realpath(process.cwd()),
            fs.realpath(sourceRoot),
        ]);
        let repositoryLocal = within(canonical, canonicalCwd) || within(canonical, canonicalSourceRoot);
        let ancestor = canonicalCwd;
        while (!repositoryLocal) {
            repositoryLocal = within(canonical, path.join(ancestor, "node_modules"));
            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
                break;
            }

            ancestor = parent;
        }

        if (repositoryLocal) {
            throw new Error("Repository-local Pi SDK discovery requires --trust-project or explicit --pi-sdk");
        }
    }

    const metadataPath = path.join(canonical, "package.json");
    if (!within(await fs.realpath(metadataPath), canonical)) {
        throw new Error("Pi SDK metadata resolves outside its package");
    }

    if ((await fs.stat(metadataPath)).size > 1024 * 1024) {
        throw new Error("Unsupported Pi SDK package metadata");
    }

    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    if (
        metadata.name !== SDK_NAME ||
        metadata.version !== SDK_VERSION ||
        metadata.exports?.["."]?.import !== "./dist/index.js"
    ) {
        throw new Error("specpi agent requires the public Pi SDK 0.84.4 package");
    }

    const entry = await fs.realpath(path.join(canonical, metadata.exports["."].import));
    if (!within(entry, canonical)) {
        throw new Error("Pi SDK entry resolves outside its package");
    }

    const sdk = await import(pathToFileURL(entry).href);
    if (sdk.VERSION !== SDK_VERSION) {
        throw new Error("Pi SDK runtime version does not match 0.84.4");
    }

    return sdk;
}

/** Remove only known SpecPi managed paths and explicitly identified SpecPi packages. */
export function selectExternalExtensions(resources, { agentDir, bundleRoot = sourceRoot }) {
    const managed = new Set(bundledResources.map((entry) => path.resolve(agentDir, "extensions", entry)));

    return resources
        .filter((resource) => {
            if (!resource.enabled) {
                return false;
            }

            const resourcePath = path.resolve(resource.path);
            const source = resource.metadata?.source;

            return (
                !managed.has(resourcePath) &&
                !within(resourcePath, path.join(bundleRoot, "extensions")) &&
                !(
                    resource.metadata?.origin === "package" &&
                    typeof source === "string" &&
                    /^npm:specpi(?:@|$)/u.test(source)
                )
            );
        })
        .map((resource) => resource.path);
}

/** Pi's loader gets already-resolved packages, so its implicit resolver must see none. */
export function resourceSettingsFacade(settingsManager) {
    return new Proxy(settingsManager, {
        get(target, key) {
            if (key === "getGlobalSettings" || key === "getProjectSettings") {
                return () => ({ ...target[key](), packages: [] });
            }

            const value = Reflect.get(target, key, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

async function resourceOptions(sdk, settingsManager, options, factories) {
    assertSupportedProxy(settingsManager);
    const manager = new sdk.DefaultPackageManager({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
    });
    const resolved = await manager.resolve(async () => "error");
    const enabledPaths = (resources) =>
        resources.filter((resource) => resource.enabled).map((resource) => resource.path);
    const extensionPaths = selectExternalExtensions(resolved.extensions, options);

    return {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: !options.trustProject,
        additionalExtensionPaths: [
            ...bundledResources.map((entry) => path.join(sourceRoot, "extensions", entry)),
            ...extensionPaths,
        ],
        additionalSkillPaths: enabledPaths(resolved.skills),
        additionalPromptTemplatePaths: enabledPaths(resolved.prompts),
        additionalThemePaths: enabledPaths(resolved.themes),
        extensionFactories: factories,
    };
}

function verifyExtensions(loader) {
    const result = loader.getExtensions();
    if (result.errors.length > 0) {
        throw new Error("Pi extension loading failed; delegation launcher refuses partial policy loading");
    }

    for (const name of ["command-guard/index.ts", "workflow-controls/index.ts"]) {
        const expected = path.resolve(sourceRoot, "extensions", name);
        if (result.extensions.filter((extension) => path.resolve(extension.resolvedPath) === expected).length !== 1) {
            throw new Error("Required SpecPi policy extension did not load exactly once");
        }
    }
}

/** Public SDK runtime factory; the one delegation factory persists across session replacement. */
export function createLauncherRuntimeFactory(sdk, { trustProject = false, delegationFactory, onHost = () => {} }) {
    let currentSession;
    let generation = 0;
    let leaseActive = false;
    let leaseEpoch = 0;
    let launchCwd;

    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        launchCwd ??= path.resolve(cwd);
        const projectTrusted = trustProject && path.resolve(cwd) === launchCwd;
        generation += 1;
        leaseActive = false;
        leaseEpoch += 1;
        onHost(undefined);
        const runtimeGeneration = generation;
        const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrusted });
        const facade = resourceSettingsFacade(settingsManager);
        const options = { cwd, agentDir, trustProject: projectTrusted };
        const lifecycleFactory = (pi) => {
            pi.on("session_shutdown", () => {
                if (generation === runtimeGeneration) {
                    leaseActive = false;
                    leaseEpoch += 1;
                    onHost(undefined);
                }
            });
            const refreshHost = () => {
                if (generation === runtimeGeneration && currentSession?.agent.state.model) {
                    leaseActive = true;
                    leaseEpoch += 1;
                    const issuedEpoch = leaseEpoch;
                    onHost(
                        createPiHost(currentSession, {
                            id: randomUUID(),
                            isCurrent: () =>
                                leaseActive && generation === runtimeGeneration && leaseEpoch === issuedEpoch,
                        }),
                    );
                }
            };

            pi.on("session_start", refreshHost);
            pi.on("model_select", refreshHost);
            pi.on("thinking_level_select", refreshHost);
        };

        const factories = [
            { name: "specpi-owner-lifecycle", factory: lifecycleFactory },
            { name: "specpi-delegation", factory: delegationFactory },
        ];
        const initialOptions = await resourceOptions(sdk, settingsManager, options, factories);
        const services = await sdk.createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: facade,
            resourceLoaderOptions: initialOptions,
        });
        if (
            services.diagnostics.some((diagnostic) => diagnostic.type === "error") ||
            services.modelRuntime.getError()
        ) {
            throw new Error("Pi provider configuration failed; delegation launcher refuses partial policy loading");
        }

        let activeLoader = services.resourceLoader;
        verifyExtensions(activeLoader);
        const delegatedMethods = [
            "getExtensions",
            "getSkills",
            "getPrompts",
            "getThemes",
            "getAgentsFiles",
            "getSystemPrompt",
            "getSystemPromptSource",
            "getAppendSystemPrompt",
            "getAppendSystemPromptSources",
            "extendResources",
        ];
        const loader = Object.fromEntries(
            delegatedMethods.map((name) => [name, (...args) => activeLoader[name](...args)]),
        );
        loader.reload = async () => {
            leaseActive = false;
            leaseEpoch += 1;
            onHost(undefined);
            settingsManager.setProjectTrusted(projectTrusted);
            await settingsManager.reload();
            const nextOptions = await resourceOptions(sdk, settingsManager, options, factories);
            const nextLoader = new sdk.DefaultResourceLoader({
                ...nextOptions,
                cwd,
                agentDir,
                settingsManager: facade,
            });
            await nextLoader.reload();
            verifyExtensions(nextLoader);
            activeLoader = nextLoader;
        };

        services.resourceLoader = loader;
        // Native provider registration refreshes availability asynchronously. Await the
        // public metadata snapshot before the SDK chooses its initial model.
        await services.modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) });
        const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
        currentSession = result.session;
        const selectedModel = currentSession.agent.state.model;
        if (!selectedModel || !services.modelRuntime.getModel(selectedModel.provider, selectedModel.id)) {
            currentSession.dispose();
            throw new Error("Pi has no configured available model; configure Pi before running specpi agent");
        }

        leaseActive = true;
        leaseEpoch += 1;
        const issuedEpoch = leaseEpoch;
        onHost(
            createPiHost(currentSession, {
                id: randomUUID(),
                isCurrent: () => leaseActive && generation === runtimeGeneration && leaseEpoch === issuedEpoch,
            }),
        );

        return { ...result, services, diagnostics: services.diagnostics };
    };
}

export async function runAgent(args = []) {
    const options = parseAgentArgs(args);
    if (options.help) {
        console.log(
            "Usage: specpi agent [--trust-project] [--pi-sdk ABSOLUTE_PACKAGE_DIRECTORY]\n\nRuns Pi 0.84.4's interactive SDK with optional bounded delegation.\nProject settings, resources, and AGENTS are disabled by default.\n--trust-project enables project resources for this launch; no trust decision is saved.\nUses Pi-owned parent state. No package installation or proxy support.\nNative Pi CLI flags and built-in CLI extensions are not provided.",
        );

        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("specpi agent requires an interactive terminal");
    }

    const sdk = await loadPiSdk(options);
    const { createDelegationExtension } = await import("../extensions/delegation/extension.mjs");
    let host;
    const delegationFactory = createDelegationExtension(() => host);
    const factory = createLauncherRuntimeFactory(sdk, {
        trustProject: options.trustProject,
        delegationFactory,
        onHost(value) {
            host = value;
        },
    });
    const cwd = process.cwd();
    const agentDir = sdk.getAgentDir();
    const runtime = await sdk.createAgentSessionRuntime(factory, {
        cwd,
        agentDir,
        sessionManager: sdk.SessionManager.create(cwd),
    });
    try {
        await new sdk.InteractiveMode(runtime).run();
    } finally {
        host = undefined;
        await runtime.session.abort();
        await runtime.dispose();
    }
}
