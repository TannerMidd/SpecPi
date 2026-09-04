import { describe, expect, it } from "vitest";
import { LatestRequest } from "../../src/renderer/src/lib/latest-request";

describe("latest asynchronous renderer request", () => {
    it("[C8] rejects older selections, prior projects, and invalidated errors", () => {
        const requests = new LatestRequest();
        const fileA = requests.begin("project-a");
        const fileB = requests.begin("project-a");

        expect(requests.isCurrent(fileA, "project-a")).toBe(false);
        expect(requests.isCurrent(fileB, "project-a")).toBe(true);
        expect(requests.isCurrent(fileB, "project-b")).toBe(false);

        requests.invalidate();
        expect(requests.isCurrent(fileB, "project-a")).toBe(false);
    });
});
