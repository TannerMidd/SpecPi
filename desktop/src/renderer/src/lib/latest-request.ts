export interface RequestToken {
    generation: number;
    scope: string;
}

export class LatestRequest {
    #generation = 0;

    begin(scope: string): RequestToken {
        this.#generation += 1;

        return { generation: this.#generation, scope };
    }

    invalidate(): void {
        this.#generation += 1;
    }

    isCurrent(token: RequestToken, scope: string): boolean {
        return token.generation === this.#generation && token.scope === scope;
    }
}
