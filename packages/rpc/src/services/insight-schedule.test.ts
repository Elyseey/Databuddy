import { describe, expect, it } from "bun:test";
import { getNextInsightRunAt } from "./insight-schedule";

describe("getNextInsightRunAt", () => {
	it("returns null when scheduling is disabled", () => {
		const next = getNextInsightRunAt(
			{ cron: null, enabled: false, frequency: "daily" },
			new Date(2026, 0, 15, 10, 30)
		);

		expect(next).toBeNull();
	});

	it("schedules hourly runs at the next top of hour", () => {
		const next = getNextInsightRunAt(
			{ cron: null, enabled: true, frequency: "hourly" },
			new Date(2026, 0, 15, 10, 30, 22)
		);

		expect(next).toEqual(new Date(2026, 0, 15, 11, 0, 0, 0));
	});

	it("schedules daily runs for 9am the next day", () => {
		const next = getNextInsightRunAt(
			{ cron: null, enabled: true, frequency: "daily" },
			new Date(2026, 0, 15, 10, 30)
		);

		expect(next).toEqual(new Date(2026, 0, 16, 9, 0, 0, 0));
	});

	it("schedules weekly runs seven days out at 9am", () => {
		const next = getNextInsightRunAt(
			{ cron: null, enabled: true, frequency: "weekly" },
			new Date(2026, 0, 15, 10, 30)
		);

		expect(next).toEqual(new Date(2026, 0, 22, 9, 0, 0, 0));
	});

	it("supports simple five-field cron expressions", () => {
		const next = getNextInsightRunAt(
			{ cron: "*/15 * * * *", enabled: true, frequency: "custom" },
			new Date(2026, 0, 15, 10, 1, 45)
		);

		expect(next).toEqual(new Date(2026, 0, 15, 10, 15, 0, 0));
	});

	it("returns null for invalid custom cron", () => {
		const next = getNextInsightRunAt(
			{ cron: "not cron", enabled: true, frequency: "custom" },
			new Date(2026, 0, 15, 10, 1, 45)
		);

		expect(next).toBeNull();
	});
});
