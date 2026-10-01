export interface LoadedClassifier {
    score(
        command: string,
        shell?: string,
    ): Promise<{
        classification: "risky" | "not_flagged" | "review";
        score: number | null;
        reason: string | null;
        windows?: number;
    }>;
}

export function classifier(directory?: string): Promise<LoadedClassifier>;
export function classifierLoaded(): boolean;
