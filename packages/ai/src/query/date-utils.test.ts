import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shiftDate, todayInTimeZone } from "./date-utils";

describe("shiftDate", () => {
	it("subtracts days across month boundaries", () => {
		expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
		expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
	});

	it("adds days", () => {
		expect(shiftDate("2026-05-31", 1)).toBe("2026-06-01");
	});
});

describe("todayInTimeZone", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves the local calendar day, not the UTC day, near midnight", () => {
		vi.setSystemTime(new Date("2026-05-31T23:30:00Z"));
		expect(todayInTimeZone("UTC")).toBe("2026-05-31");
		expect(todayInTimeZone("Asia/Tokyo")).toBe("2026-06-01");
		expect(todayInTimeZone("America/Los_Angeles")).toBe("2026-05-31");
	});

	it("falls back to the UTC date for an invalid timezone", () => {
		vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
		expect(todayInTimeZone("Not/AZone")).toBe("2026-05-31");
	});
});
