import { z } from "zod";

const insightSourceSchema = z.enum(["web", "product", "ops", "business"]);

const insightMetricSchema = z.object({
	label: z
		.string()
		.describe("Short user-facing label (e.g. 'Visitors', 'Bounce rate')"),
	current: z.number().describe("Value for current period"),
	previous: z.number().optional().describe("Value for previous period"),
	format: z
		.enum(["number", "percent", "duration_ms", "duration_s"])
		.default("number"),
});

export const insightSchema = z.object({
	title: z
		.string()
		.describe(
			"Brief plain-English headline under 80 chars for a founder/operator. Avoid raw metric jargon like INP, LCP, FCP, TTFB, CLS, p75 in titles; translate to outcomes such as 'Interactions got slower' or 'Pages feel slower'. Never paste opaque URL slugs."
		),
	description: z
		.string()
		.describe(
			"1-3 concise sentences in plain English explaining what changed and why it matters. Translate technical metrics into user/product outcomes; keep raw metric names in the metrics array. Do NOT restate numbers already in metrics. Keep under 480 characters."
		),
	suggestion: z
		.string()
		.describe(
			"One specific next action in plain English tied to this product's data. Name the surface to inspect (page, funnel step, referrer segment, error class, sessions, flag rollout). Do not give generic monitoring advice. Keep under 400 characters."
		),
	metrics: z
		.array(insightMetricSchema)
		.min(1)
		.max(5)
		.describe(
			"1-5 key data points backing this insight. Always include the primary metric the insight is about, then supporting metrics that add context. These are shown as structured data alongside the narrative description."
		),
	severity: z.enum(["critical", "warning", "info"]),
	sentiment: z
		.enum(["positive", "neutral", "negative"])
		.describe(
			"positive = improving metric, neutral = stable, negative = declining or broken"
		),
	priority: z
		.number()
		.min(1)
		.max(10)
		.describe(
			"1-10 from actionability × business impact, NOT raw % magnitude. User-facing errors, conversion/session drops, or reliability issues outrank vanity traffic spikes. A 5% drop in a meaningful engagement metric can score higher than a 70% visitor increase with no conversion context. Reserve 8-10 for issues that hurt users or revenue signals in the data."
		),
	type: z.enum([
		"error_spike",
		"new_errors",
		"vitals_degraded",
		"custom_event_spike",
		"traffic_drop",
		"traffic_spike",
		"bounce_rate_change",
		"engagement_change",
		"referrer_change",
		"page_trend",
		"positive_trend",
		"performance",
		"uptime_issue",
		"conversion_leak",
		"funnel_regression",
		"channel_concentration",
		"reliability_improved",
		"persistent_error_hotspot",
		"quality_shift",
		"cross_property_dependency",
		"performance_improved",
		"deploy_correlation",
		"segment_regression",
		"error_impact",
		"cross_signal",
	]),
	changePercent: z
		.number()
		.optional()
		.describe(
			"Signed week-over-week % for the primary metric in this insight: (current-previous)/previous*100. Positive when that metric rose, negative when it fell."
		),
	subjectKey: z
		.string()
		.min(1)
		.describe(
			"Stable identifier for the underlying signal, such as pricing_page, organic_search, signup_goal, checkout_revenue, or signup_errors. Reuse the same subjectKey for the same narrative so downstream dedupe can detect repeats."
		),
	sources: z
		.array(insightSourceSchema)
		.min(1)
		.max(4)
		.describe(
			"Which evidence domains support this insight. Use only the domains actually used: web, product, ops, business."
		),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe(
			"Confidence from 0 to 1 based on how directly the data supports the conclusion. Higher when multiple signals align or the cause is explicit in the data."
		),
	impactSummary: z
		.string()
		.optional()
		.describe(
			"Optional short statement of user or business impact. Use when the impact is clear from the available data. Keep to a single sentence."
		),
	rootCause: z
		.string()
		.optional()
		.describe("Root cause hypothesis with evidence citation."),
	evidence: z
		.array(
			z.object({
				type: z.enum(["segment", "error", "annotation", "temporal", "metric"]),
				description: z.string(),
			})
		)
		.max(5)
		.optional()
		.describe("Supporting evidence for the root cause"),
	investigationDepth: z
		.enum(["surface", "investigated", "deep"])
		.optional()
		.describe("How deeply this signal was investigated"),
});

export const insightsOutputSchema = z.object({
	insights: z
		.array(insightSchema)
		.max(10)
		.describe(
			"Insight cards ranked by actionability x business impact. Default runs usually request 1-3 cards, but configured deep runs may request more. When the period is mostly positive, at least one insight MUST still call out a material risk or watch (e.g. session duration down, bounce up, single-channel dependency, volatile referrer, error count up in absolute terms) if those signals appear in the data. Skip repeating a narrative already listed under recently reported insights unless the change is materially new."
		),
});

export type ParsedInsight = z.infer<typeof insightSchema>;
export type InsightMetric = z.infer<typeof insightMetricSchema>;
