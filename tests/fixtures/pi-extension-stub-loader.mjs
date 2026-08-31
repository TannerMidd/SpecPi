const PI_MODULE = "@earendil-works/pi-coding-agent";

export async function resolve(specifier, context, nextResolve) {
    if (specifier === PI_MODULE) {
        return {
            url: `data:text/javascript,${encodeURIComponent('export const CONFIG_DIR_NAME = ".pi";')}`,
            shortCircuit: true,
        };
    }

    return nextResolve(specifier, context);
}
