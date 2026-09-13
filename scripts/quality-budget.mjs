import fs from "node:fs";

const defaultPrices = { input: 0.15, output: 0.5 };
const validPrices = (prices) =>
    prices && [prices.input, prices.output].every((value) => Number.isFinite(value) && value > 0);

// One ledger spans pilots, retries and the full run. Reservations are durable
// before dispatch; an interrupted request keeps its entire reservation.
export class QualityBudget {
    constructor(file, capUsd) {
        this.file = file;
        if (!(capUsd > 0) || !Number.isFinite(capUsd)) {
            throw new Error("A finite positive spending cap is required.");
        }

        this.data = fs.existsSync(file)
            ? JSON.parse(fs.readFileSync(file, "utf8"))
            : { capMicros: Math.floor(capUsd * 1e6), requests: [] };
        if (this.data.capMicros !== Math.floor(capUsd * 1e6)) {
            throw new Error("The existing spending cap cannot change.");
        }

        if (
            !Array.isArray(this.data.requests) ||
            new Set(this.data.requests.map((item) => item.id)).size !== this.data.requests.length ||
            this.data.requests.some(
                (item) =>
                    typeof item.id !== "string" ||
                    !Number.isSafeInteger(item.chargeMicros) ||
                    item.chargeMicros < 0 ||
                    (item.prices !== undefined && !validPrices(item.prices)) ||
                    !["reserved", "settled"].includes(item.status),
            ) ||
            this.totalMicros() > this.data.capMicros
        ) {
            throw new Error("Invalid spending ledger; refuse dispatch.");
        }
    }

    save() {
        const temporary = `${this.file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
        fs.renameSync(temporary, this.file);
    }

    reserve(id, inputBound, outputBound, prices = defaultPrices) {
        if (
            this.data.requests.some((request) => request.id === id) ||
            !Number.isSafeInteger(inputBound) ||
            inputBound < 1 ||
            !Number.isSafeInteger(outputBound) ||
            outputBound < 1 ||
            !validPrices(prices)
        ) {
            throw new Error("Invalid or duplicate request reservation.");
        }

        // $/million-token prices equal microdollars/token; retain 10% headroom.
        const chargeMicros = Math.ceil((inputBound * prices.input + outputBound * prices.output) * 1.1);
        if (this.totalMicros() + chargeMicros > this.data.capMicros) {
            throw new Error("Evaluation spending cap reached before dispatch.");
        }

        this.data.requests.push({
            id,
            inputBound,
            outputBound,
            prices: { ...prices },
            chargeMicros,
            status: "reserved",
        });
        this.save();
    }

    settle(id, input, output, reportedCostUsd) {
        const request = this.data.requests.find((item) => item.id === id);
        if (
            !request ||
            request.status !== "reserved" ||
            !Number.isSafeInteger(input) ||
            input < 1 ||
            input > request.inputBound ||
            !Number.isSafeInteger(output) ||
            output < 0 ||
            output > request.outputBound ||
            !Number.isFinite(reportedCostUsd) ||
            reportedCostUsd < 0
        ) {
            throw new Error("Missing or out-of-bound usage; retain full reservation and stop.");
        }

        // Older GLM records predate per-request rates and keep their original ceiling.
        const prices = request.prices ?? defaultPrices;
        const chargeMicros = Math.ceil(
            Math.max(input * prices.input + output * prices.output, reportedCostUsd * 1e6) * 1.1,
        );
        if (chargeMicros > request.chargeMicros) {
            throw new Error("Provider charge exceeds reservation; stop.");
        }

        Object.assign(request, { input, output, reportedCostUsd, chargeMicros, status: "settled" });
        this.save();
    }

    totalMicros() {
        return this.data.requests.reduce((total, item) => total + item.chargeMicros, 0);
    }
}
