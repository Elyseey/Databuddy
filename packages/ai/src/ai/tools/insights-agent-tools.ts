import { tool } from "ai";
import { z } from "zod";
import {
	BUSINESS_INSIGHT_QUERY_TYPES,
	fetchBusinessMetrics,
} from "../insights/business-context";
import {
	fetchOpsMetrics,
	OPS_INSIGHT_QUERY_TYPES,
} from "../insights/ops-context";
import {
	fetchProductMetrics,
	PRODUCT_INSIGHT_QUERY_TYPES,
} from "../insights/product-context";
import { getAppContext } from "./utils";
import { executeQuery } from "../../query";
import { QueryBuilders } from "../../query/builders";
import type { QueryRequest } from "../../query/types";
import type { WeekOverWeekPeriod } from "../insights/types";

const QUERY_FETCH_TIMEOUT_MS = 45_000;
const MAX_TOOL_RESPONSE_CHARS = 48_000;
const MAX_QUERIES_PER_CALL = 8;
const DEFAULT_LIMIT = 10;

/**
 * Curated allowlist — only query types safe for automated insight generation
 * (no arbitrary SQL, no cross-website access).
 */
const INSIGHTS_AGENT_QUERY_TYPES = [
	"summary_metrics",
	"top_pages",
	"entry_pages",
	"exit_pages",
	"page_time_analysis",
	"error_summary",
	"recent_errors",
	"errors_by_page",
	"error_types",
	"top_referrers",
	"traffic_sources",
	"utm_sources",
	"utm_mediums",
	"utm_campaigns",
	"country",
	"region",
	"browser_name",
	"os_name",
	"device_types",
	"vitals_overview",
	"web_vitals_by_page",
	"web_vitals_by_browser",
	"web_vitals_by_country",
	"custom_events_discovery",
	"custom_events_summary",
	"custom_events_trends",
	"session_metrics",
	"sessions_by_device",
	"sessions_by_browser",
	"revenue_overview",
	"revenue_by_referrer",
	"revenue_by_entry_page",
	"recent_transactions",
] as const;

const INSIGHTS_TYPE_LIST = INSIGHTS_AGENT_QUERY_TYPES.join(", ");
const BUSINESS_INSIGHTS_TYPE_LIST = BUSINESS_INSIGHT_QUERY_TYPES.join(", ");
const OPS_INSIGHTS_TYPE_LIST = OPS_INSIGHT_QUERY_TYPES.join(", ");
const PRODUCT_INSIGHTS_TYPE_LIST = PRODUCT_INSIGHT_QUERY_TYPES.join(", ");

function isAllowedQueryType(type: string): boolean {
	return (
		(INSIGHTS_AGENT_QUERY_TYPES as readonly string[]).includes(type) &&
		type in QueryBuilders
	);
}

function runQueryWithTimeout<T>(
	label: string,
	fn: () => Promise<T>
): Promise<T> {
	return Promise.race([
		fn(),
		new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`${label} timed out`));
			}, QUERY_FETCH_TIMEOUT_MS);
		}),
	]);
}

function truncatePayload(obj: unknown): string {
	const payload = JSON.stringify(obj, null, 0);
	return payload.length > MAX_TOOL_RESPONSE_CHARS
		? `${payload.slice(0, MAX_TOOL_RESPONSE_CHARS)}\n…[truncated]`
		: payload;
}

export interface CreateInsightsAgentToolsParams {
	domain: string;
	periodBounds: WeekOverWeekPeriod;
	timezone: string;
	websiteId: string;
}

export function createInsightsAgentTools(
	params: CreateInsightsAgentToolsParams
) {
	const singleQuerySchema = z.object({
		type: z
			.string()
			.describe(`Analytics query type. Allowed: ${INSIGHTS_TYPE_LIST}`)
			.refine(isAllowedQueryType, "Unknown or disallowed query type"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.describe(
				"Row limit for list-style queries (top_pages, referrers, etc.)"
			),
	});

	const webMetricsTool = tool({
		description:
			"Query analytics data for the current or previous period. Batch up to 8 query types per call. Available types: summary_metrics, top_pages, entry_pages, exit_pages, page_time_analysis, error_summary, recent_errors (with stack traces), errors_by_page, error_types, top_referrers, traffic_sources, utm_sources, utm_mediums, utm_campaigns, country, region, browser_name, os_name, device_types, vitals_overview, web_vitals_by_page, web_vitals_by_browser, web_vitals_by_country, custom_events_discovery, custom_events_summary, custom_events_trends, session_metrics, sessions_by_device, sessions_by_browser, revenue_overview, revenue_by_referrer, revenue_by_entry_page, recent_transactions. Use this to dig deeper into anomalies — e.g. if mobile traffic dropped, query device_types and sessions_by_device. If errors spiked, query recent_errors for stack traces and errors_by_page for affected pages.",
		inputSchema: z.object({
			period: z
				.enum(["current", "previous"])
				.describe(
					"Which WoW window: current week vs previous week (same calendar alignment as smart insights)."
				),
			queries: z.array(singleQuerySchema).min(1).max(MAX_QUERIES_PER_CALL),
		}),
		execute: async ({ period, queries }) => {
			const range =
				period === "current"
					? params.periodBounds.current
					: params.periodBounds.previous;

			const results: Array<{
				type: string;
				rowCount: number;
				data: unknown[];
			}> = [];

			for (const q of queries) {
				if (!isAllowedQueryType(q.type)) {
					results.push({
						type: q.type,
						rowCount: 0,
						data: [],
					});
					continue;
				}

				const limit = q.limit ?? (q.type === "top_pages" ? 10 : DEFAULT_LIMIT);
				const req: QueryRequest = {
					projectId: params.websiteId,
					type: q.type,
					from: range.from,
					to: range.to,
					timezone: params.timezone,
					limit: q.type === "vitals_overview" ? undefined : limit,
				};

				try {
					const data = (await runQueryWithTimeout(`web_metrics:${q.type}`, () =>
						executeQuery(req, params.domain, params.timezone)
					)) as Record<string, unknown>[];
					results.push({
						type: q.type,
						rowCount: Array.isArray(data) ? data.length : 0,
						data: Array.isArray(data) ? data : [],
					});
				} catch {
					results.push({
						type: q.type,
						rowCount: 0,
						data: [],
					});
				}
			}

			return truncatePayload({ period, range, results });
		},
	});

	const productMetricQuerySchema = z.object({
		type: z
			.enum(PRODUCT_INSIGHT_QUERY_TYPES)
			.describe(
				`Product context query type. Allowed: ${PRODUCT_INSIGHTS_TYPE_LIST}`
			),
		limit: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.describe(
				"Max number of goals, funnels, cohorts, or events to summarize."
			),
	});

	const productMetricsTool = tool({
		description:
			"Fetch product analytics context for the current or previous week-over-week period. Use this for goals, funnels, retention, and custom event summaries when a traffic story needs conversion or behavior context.",
		inputSchema: z.object({
			period: z
				.enum(["current", "previous"])
				.describe("Which WoW window: current week vs previous week."),
			queries: z
				.array(productMetricQuerySchema)
				.min(1)
				.max(MAX_QUERIES_PER_CALL),
		}),
		execute: async ({ period, queries }, options) => {
			const appContext = getAppContext(options);
			return truncatePayload(
				await fetchProductMetrics(
					appContext,
					params.periodBounds,
					period,
					queries
				)
			);
		},
	});

	const opsMetricQuerySchema = z.object({
		type: z
			.enum(OPS_INSIGHT_QUERY_TYPES)
			.describe(`Ops context query type. Allowed: ${OPS_INSIGHTS_TYPE_LIST}`),
		limit: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.describe("Max number of pages or anomalies to summarize."),
	});

	const opsContextTool = tool({
		description:
			"Fetch operational context for the current or previous week-over-week period. Use this for errors, page-level error concentration, uptime health, anomaly summaries, and recent flag changes when reliability or rollout activity may explain user behavior.",
		inputSchema: z.object({
			period: z
				.enum(["current", "previous"])
				.describe("Which WoW window: current week vs previous week."),
			queries: z.array(opsMetricQuerySchema).min(1).max(MAX_QUERIES_PER_CALL),
		}),
		execute: async ({ period, queries }, options) => {
			const appContext = getAppContext(options);
			return truncatePayload(
				await fetchOpsMetrics(appContext, params.periodBounds, period, queries)
			);
		},
	});

	const businessMetricQuerySchema = z.object({
		type: z
			.enum(BUSINESS_INSIGHT_QUERY_TYPES)
			.describe(
				`Business context query type. Allowed: ${BUSINESS_INSIGHTS_TYPE_LIST}`
			),
		limit: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.describe("Max number of products to summarize."),
	});

	const businessContextTool = tool({
		description:
			"Fetch business context for the current or previous week-over-week period. Use this for revenue totals, attributed vs unattributed revenue, and top products when you need to understand commercial impact.",
		inputSchema: z.object({
			period: z
				.enum(["current", "previous"])
				.describe("Which WoW window: current week vs previous week."),
			queries: z
				.array(businessMetricQuerySchema)
				.min(1)
				.max(MAX_QUERIES_PER_CALL),
		}),
		execute: async ({ period, queries }, options) => {
			const appContext = getAppContext(options);

			return truncatePayload(
				await fetchBusinessMetrics(
					appContext,
					params.periodBounds,
					period,
					queries
				)
			);
		},
	});

	return {
		tools: {
			business_context: businessContextTool,
			ops_context: opsContextTool,
			product_metrics: productMetricsTool,
			web_metrics: webMetricsTool,
		},
	};
}
