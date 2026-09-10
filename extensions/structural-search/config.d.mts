export declare function integrationsFile(agentDir: string): string;
export declare function readIntegrations(agentDir: string): {
    schema: 1;
    structuralSearch: { enabled: boolean };
    [key: string]: unknown;
};
