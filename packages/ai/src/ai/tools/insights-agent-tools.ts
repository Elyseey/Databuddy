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
import { executeAgentSqlForWebsite } from "./execute-sql-query";
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
const ALL_QUERY_TYPES = Object.keys(QueryBuilders);
const QUERY_TYPE_LIST = ALL_QUERY_TYPES.join(", ");
const BUSINESS_INSIGHTS_TYPE_LIST = BUSINESS_INSIGHT_QUERY_TYPES.join(", ");
const OPS_INSIGHTS_TYPE_LIST = OPS_INSIGHT_QUERY_TYPES.join(", ");
const PRODUCT_INSIGHTS_TYPE_LIST = PRODUCT_INSIGHT_QUERY_TYPES.join(", ");

function isValidQueryType(type: string): boolean {
	return type in QueryBuilders;
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
			.describe(`Any query type from the analytics engine. ${ALL_QUERY_TYPES.length} types available.`)
			.refine(isValidQueryType, "Unknown query type"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.describe("Row limit"),
		filters: z
			.array(
				z.object({
					field: z.string().describe("Filter field: path, country, device_type, browser_name, os_name, referrer, utm_source, utm_medium, utm_campaign"),
					value: z.string().describe("Filter value"),
				})
			)
			.optional()
			.describe("Optional filters to segment the data"),
	});

	const webMetricsTool = tool({
		description:
			`Query any analytics data for the current or previous period. Batch up to 8 queries per call. ${ALL_QUERY_TYPES.length} query types available including: summary_metrics, top_pages, entry_pages, exit_pages, recent_errors (stack traces), errors_by_page, error_types, session_flow, session_list, interesting_sessions, sessions_by_device, sessions_by_browser, web_vitals_by_page, web_vitals_by_browser, revenue_overview, revenue_by_referrer, custom_events_discovery, custom_events_trends, country, region, city, utm_campaigns, device_types, and many more. You can filter any query by path, country, device_type, browser_name, os_name, referrer, utm_source, utm_medium, utm_campaign to segment the data.`,
		inputSchema: z.object({
			period: z
				.enum(["current", "previous"])
				.describe("Which period to query"),
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
				if (!isValidQueryType(q.type)) {
					results.push({ type: q.type, rowCount: 0, data: [] });
					continue;
				}

				const limit = q.limit ?? DEFAULT_LIMIT;
				const filters = q.filters?.map((f) => ({
					field: f.field,
					operator: "equals" as const,
					value: f.value,
				}));
				const req: QueryRequest = {
					projectId: params.websiteId,
					type: q.type,
					from: range.from,
					to: range.to,
					timezone: params.timezone,
					limit,
					filters,
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

	const sqlTool = tool({
		description:
			`Run read-only ClickHouse SQL for cross-table joins, session-level analysis, and queries web_metrics can't express. Use web_metrics first for standard queries — SQL is for complex analysis only.

Tables: analytics.events (client_id, session_id, time, path, referrer, browser_name, device_type, country, region, event_name, time_on_page, scroll_depth), analytics.error_spans (client_id, session_id, timestamp, path, message, stack, error_type), analytics.web_vitals_spans (client_id, timestamp, path, metric_name, metric_value), analytics.custom_events (owner_id, event_name, timestamp, properties, session_id), analytics.revenue (owner_id, transaction_id, amount Decimal(18,4), currency, provider, type, customer_id, created).

ClickHouse rules: Use uniq(col) not COUNT(DISTINCT). quantileTDigest does NOT work on Decimal — cast first: quantileTDigest(0.5)(toFloat64(col)). Pageviews = event_name = 'screen_view'. Website ID column = client_id (not website_id). Revenue uses owner_id not client_id. Timestamps: time in events, timestamp in error_spans/vitals. Use toDate(time) for grouping. No UNION/subqueries — use CTEs. Use {paramName:Type} placeholders only.`,
		inputSchema: z.object({
			sql: z.string().describe("Read-only ClickHouse SQL with {websiteId:String} filter"),
			params: z.record(z.string(), z.unknown()).optional(),
		}),
		execute: async ({ sql, params: sqlParams }) => {
			const result = await executeAgentSqlForWebsite({
				websiteId: params.websiteId,
				websiteDomain: params.domain,
				sql,
				params: sqlParams,
			});
			return truncatePayload(result);
		},
	});

	return {
		tools: {
			business_context: businessContextTool,
			execute_sql: sqlTool,
			ops_context: opsContextTool,
			product_metrics: productMetricsTool,
			web_metrics: webMetricsTool,
		},
	};
}
