import { describe, expect, it } from "bun:test";
import { APP_EVENTS, MARKETING_PARAM_KEYS, readUtmProperties } from "./custom-events";

const SNAKE_CASE_EVENT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

describe("custom event helpers", () => {
	it("keeps app event names uniform", () => {
		expect(new Set(Object.values(APP_EVENTS)).size).toBe(
			Object.values(APP_EVENTS).length
		);

		for (const eventName of Object.values(APP_EVENTS)) {
			expect(eventName).toMatch(SNAKE_CASE_EVENT_NAME);
		}
	});

	it("keeps marketing params needed for ad attribution", () => {
		expect(MARKETING_PARAM_KEYS).toEqual([
			"utm_source",
			"utm_medium",
			"utm_campaign",
			"utm_term",
			"utm_content",
			"gclid",
			"fbclid",
			"ttclid",
			"twclid",
			"li_fat_id",
			"msclkid",
			"oppref",
			"wolref",
		]);
	});

	it("reads only trimmed UTM properties", () => {
		const params = new URLSearchParams({
			utm_source: " openai_ads ",
			utm_medium: "cpc",
			utm_campaign: "x".repeat(200),
			gclid: "click-id",
		});

		expect(readUtmProperties(params)).toEqual({
			utm_source: "openai_ads",
			utm_medium: "cpc",
			utm_campaign: "x".repeat(160),
		});
	});
});
