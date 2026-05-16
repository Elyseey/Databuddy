import { describe, expect, test } from "bun:test";
import { insightSchema, insightsOutputSchema } from "./smart-insights-output";

const baseInsight = {
	title: "Pricing page traffic up 28%",
	description:
		"Pricing Page Visitors became a larger share of site activity while Bounce Rate improved. The audience that arrived this week was more qualified than a broad awareness spike. Worth confirming campaign attribution before drawing wider conclusions.",
	suggestion:
		"Review the journey from Pricing Page Visitors into the next high-intent step and tighten the CTA path if Contact Page Visitors are lagging.",
	metrics: [
		{
			label: "Pricing Page Visitors",
			current: 640,
			previous: 500,
			format: "number" as const,
		},
	],
	severity: "info" as const,
	sentiment: "positive" as const,
	priority: 6,
	type: "traffic_spike" as const,
	subjectKey: "pricing_page",
	sources: ["web" as const],
	confidence: 0.82,
};

describe("insightSchema impactSummary length bound", () => {
	test("accepts a 160-character impactSummary (legacy upper bound)", () => {
		const summary = "x".repeat(160);
		const result = insightSchema.safeParse({ ...baseInsight, impactSummary: summary });
		expect(result.success).toBe(true);
	});

	test("accepts a 220-character impactSummary (current upper bound)", () => {
		const summary = "x".repeat(220);
		const result = insightSchema.safeParse({ ...baseInsight, impactSummary: summary });
		expect(result.success).toBe(true);
	});

	test("rejects a 221-character impactSummary", () => {
		const summary = "x".repeat(221);
		const result = insightSchema.safeParse({ ...baseInsight, impactSummary: summary });
		expect(result.success).toBe(false);
	});

	test("real-world 173-char impactSummary that previously failed now passes", () => {
		const summary =
			"Zero navigation interactions for two consecutive weeks means no visitor can explore the product from the homepage — directly suppressing sign-up and pricing funnel entry.";
		expect(summary.length).toBeGreaterThan(160);
		expect(summary.length).toBeLessThanOrEqual(220);
		const result = insightSchema.safeParse({ ...baseInsight, impactSummary: summary });
		expect(result.success).toBe(true);
	});

	test("impactSummary remains optional", () => {
		const result = insightSchema.safeParse(baseInsight);
		expect(result.success).toBe(true);
	});
});

describe("insightsOutputSchema container", () => {
	test("accepts configured deep runs with up to 10 insights", () => {
		const result = insightsOutputSchema.safeParse({
			insights: Array.from({ length: 10 }, () => baseInsight),
		});
		expect(result.success).toBe(true);
	});

	test("rejects 11 insights", () => {
		const result = insightsOutputSchema.safeParse({
			insights: Array.from({ length: 11 }, () => baseInsight),
		});
		expect(result.success).toBe(false);
	});
});
