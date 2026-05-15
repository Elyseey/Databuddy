import type { AppContext } from "@databuddy/ai/config/context";
import { ANTHROPIC_CACHE_1H, models } from "@databuddy/ai/config/models";
import { insightDedupeKey } from "@databuddy/ai/insights/dedupe";
import {
	fetchWebPeriodData,
	hasWebInsightData,
} from "@databuddy/ai/insights/fetch-context";
import { formatLegacyWebDataForPrompt } from "@databuddy/ai/insights/normalize";
import type {
	InsightMetricRow,
	WeekOverWeekPeriod,
} from "@databuddy/ai/insights/types";
import { validateInsights } from "@databuddy/ai/insights/validate";
import { getAILogger } from "@databuddy/ai/lib/ai-logger";
import { storeAnalyticsSummary } from "@databuddy/ai/lib/supermemory";
import type { ParsedInsight } from "@databuddy/ai/schemas/smart-insights-output";
import { insightsOutputSchema } from "@databuddy/ai/schemas/smart-insights-output";
import { createInsightsAgentTools } from "@databuddy/ai/tools/insights-agent-tools";
import { and, db, desc, eq, gte, isNotNull, isNull, sql } from "@databuddy/db";
import {
	analyticsInsights,
	annotations,
	type InsightGenerationConfigSnapshot,
	type InsightGenerationTool,
	websites,
} from "@databuddy/db/schema";
import {
	invalidateAgentContextSnapshotsForWebsite,
	invalidateInsightsCachesForOrganization,
} from "@databuddy/redis";
import { generateText, Output, stepCountIs, ToolLoopAgent } from "ai";
import { randomUUIDv7 } from "bun";
import dayjs from "dayjs";
import { log } from "evlog";

const LEGACY_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 120_000;
const RECENT_INSIGHTS_PROMPT_LIMIT = 12;
const DEFAULT_MAX_INSIGHTS = 3;
const TOOL_NAMES = [
	"web_metrics",
	"product_metrics",
	"ops_context",
	"business_context",
] as const satisfies readonly InsightGenerationTool[];

interface OrgWebsiteRow {
	domain: string;
	id: string;
	name: string | null;
}

interface GeneratedWebsiteInsight extends ParsedInsight {
	id: string;
	websiteDomain: string;
	websiteId: string;
	websiteName: string | null;
}

export interface GenerateWebsiteInsightsInput {
	config: InsightGenerationConfigSnapshot;
	organizationId: string;
	reason: string;
	requestedByUserId: string | null;
	runId: string;
	websiteId: string;
}

export interface GenerateWebsiteInsightsResult {
	insightIds: string[];
	message?: string;
	resultCount: number;
	status: "skipped" | "succeeded";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function maxInsights(config: InsightGenerationConfigSnapshot): number {
	return Math.max(
		1,
		Math.min(10, config.maxInsightsPerWebsite || DEFAULT_MAX_INSIGHTS)
	);
}

function promptLookbackDays(config: InsightGenerationConfigSnapshot): number {
	return Math.max(14, Math.min(180, config.lookbackDays * 2));
}

function getComparisonPeriod(lookbackDays: number): WeekOverWeekPeriod {
	const days = Math.max(1, Math.min(90, lookbackDays));
	const now = dayjs();
	return {
		current: {
			from: now.subtract(days, "day").format("YYYY-MM-DD"),
			to: now.format("YYYY-MM-DD"),
		},
		previous: {
			from: now.subtract(days * 2, "day").format("YYYY-MM-DD"),
			to: now.subtract(days, "day").format("YYYY-MM-DD"),
		},
	};
}

function modelForTier(tier: InsightGenerationConfigSnapshot["modelTier"]) {
	if (tier === "fast") {
		return models.quick;
	}
	if (tier === "deep") {
		return models.deep;
	}
	return models.balanced;
}

function normalizeAllowedTools(
	tools: InsightGenerationConfigSnapshot["allowedTools"]
): InsightGenerationTool[] {
	const allowed = new Set<InsightGenerationTool>(
		tools.filter((tool): tool is InsightGenerationTool =>
			(TOOL_NAMES as readonly string[]).includes(tool)
		)
	);
	allowed.add("web_metrics");
	return TOOL_NAMES.filter((tool) => allowed.has(tool));
}

function dedupeKeyFor(insight: GeneratedWebsiteInsight): string {
	return insightDedupeKey({
		...insight,
		changePercent: insight.changePercent ?? null,
	});
}

async function fetchInsightDedupeKeyToIdMap(
	organizationId: string,
	cooldownHours: number
): Promise<Map<string, string>> {
	const cutoff = dayjs().subtract(Math.max(1, cooldownHours), "hour").toDate();
	const rows = await db
		.select({
			id: analyticsInsights.id,
			websiteId: analyticsInsights.websiteId,
			type: analyticsInsights.type,
			sentiment: analyticsInsights.sentiment,
			changePercent: analyticsInsights.changePercent,
			dedupeKey: analyticsInsights.dedupeKey,
			subjectKey: analyticsInsights.subjectKey,
			title: analyticsInsights.title,
		})
		.from(analyticsInsights)
		.where(
			and(
				eq(analyticsInsights.organizationId, organizationId),
				gte(analyticsInsights.createdAt, cutoff)
			)
		)
		.orderBy(desc(analyticsInsights.createdAt));

	const map = new Map<string, string>();
	for (const row of rows) {
		const key =
			row.dedupeKey ??
			insightDedupeKey({
				websiteId: row.websiteId,
				type: row.type as ParsedInsight["type"],
				sentiment: row.sentiment as ParsedInsight["sentiment"],
				changePercent: row.changePercent,
				subjectKey: row.subjectKey,
				title: row.title,
			});
		if (!map.has(key)) {
			map.set(key, row.id);
		}
	}
	return map;
}

async function fetchRecentAnnotations(
	websiteId: string,
	config: InsightGenerationConfigSnapshot
): Promise<string> {
	const since = dayjs().subtract(promptLookbackDays(config), "day").toDate();
	const rows = await db
		.select({
			text: annotations.text,
			xValue: annotations.xValue,
			tags: annotations.tags,
		})
		.from(annotations)
		.where(
			and(
				eq(annotations.websiteId, websiteId),
				gte(annotations.xValue, since),
				isNull(annotations.deletedAt)
			)
		)
		.orderBy(annotations.xValue)
		.limit(20);

	if (rows.length === 0) {
		return "";
	}

	const lines = rows.map((row) => {
		const date = dayjs(row.xValue).format("YYYY-MM-DD");
		const tags = row.tags?.length ? ` [${row.tags.join(", ")}]` : "";
		return `- ${date}: ${row.text}${tags}`;
	});

	return `\n\nUser annotations (known events that may explain changes):\n${lines.join("\n")}`;
}

async function fetchRecentInsightsForPrompt(
	organizationId: string,
	websiteId: string,
	config: InsightGenerationConfigSnapshot
): Promise<string> {
	const since = dayjs().subtract(promptLookbackDays(config), "day").toDate();
	const rows = await db
		.select({
			title: analyticsInsights.title,
			type: analyticsInsights.type,
			createdAt: analyticsInsights.createdAt,
		})
		.from(analyticsInsights)
		.where(
			and(
				eq(analyticsInsights.organizationId, organizationId),
				eq(analyticsInsights.websiteId, websiteId),
				gte(analyticsInsights.createdAt, since)
			)
		)
		.orderBy(desc(analyticsInsights.createdAt))
		.limit(RECENT_INSIGHTS_PROMPT_LIMIT);

	if (rows.length === 0) {
		return "";
	}

	const lines = rows.map(
		(row) =>
			`- [${row.type}] ${row.title} (${dayjs(row.createdAt).format("YYYY-MM-DD")})`
	);

	return `\n\n## Recently reported insights for this website (avoid repeating the same narrative unless something materially changed)\n${lines.join("\n")}`;
}

function formatOrgWebsitesContext(
	orgSites: OrgWebsiteRow[],
	currentWebsiteId: string
): string {
	if (orgSites.length <= 1) {
		return "";
	}
	const sorted = [...orgSites].sort((a, b) =>
		a.domain.localeCompare(b.domain, "en")
	);
	const lines = sorted.map((site) => {
		const label = site.name?.trim() ? site.name.trim() : site.domain;
		const marker =
			site.id === currentWebsiteId
				? " - metrics below are for this site only"
				: "";
		return `- ${label} (${site.domain})${marker}`;
	});
	return `## Organization websites (same account, separate analytics)
Each row is a different tracked property (e.g. marketing site vs app vs docs). The period metrics in this message apply only to the site marked "metrics below". Do not blend numbers across rows. If referrers include another domain from this list, treat it as cross-property traffic and name both sides clearly.

${lines.join("\n")}

`;
}

function buildSystemPrompt(config: InsightGenerationConfigSnapshot): string {
	const targetCount = maxInsights(config);
	const depthInstruction =
		config.depth === "light"
			? "Use the smallest useful tool set. Prefer 1-2 high-confidence insights and skip speculative cross-domain analysis."
			: config.depth === "deep"
				? "Actively cross-check web, product, ops, and business context when those tools are enabled. Prefer a fuller ranked set, but only when signals are distinct and data-backed."
				: "Explore enough context to produce concise, distinct, high-confidence insights without over-querying.";

	return `<role>
You are Databuddy's analytics insights worker. Return up to ${targetCount} period-over-period insights when that many distinct data-backed signals exist. Rank by actionability and user/business impact.
</role>

<configured_run>
- Depth: ${config.depth}. ${depthInstruction}
- Max model/tool-loop steps: ${config.maxSteps}
- Max requested tool calls: ${config.maxToolCalls}
- Lookback period length: ${config.lookbackDays} day(s)
- Enabled tools: ${normalizeAllowedTools(config.allowedTools).join(", ")}
</configured_run>

<selection_rules>
- Write for a founder/operator, not an analytics engineer. Translate technical metrics into plain outcomes: "interactions got slower", "pages feel slower", "setup is leaking users", "one source now dominates traffic".
- Prefer reliability, conversion/product impact, engagement quality, broken instrumentation, and meaningful behavior changes over vanity traffic spikes.
- Score actionability times impact, not raw percentage magnitude. Reserve priority 8-10 for likely user, revenue, or operational impact.
- Prefer fewer, sharper insights over broad coverage. Return only signals a user can act on this period.
- Avoid repeating recently reported narratives unless the signal materially changed.
</selection_rules>

<data_rules>
- Use only provided data, tool results, annotations, and recent-insight context.
- Do not invent revenue, signups, retention, funnel conversion, causality, root causes, or business impact.
- If multiple org websites are listed, keep properties separate; cross-domain referrers are cross-property traffic, not generic referrals.
- Use cautious language for correlations unless segment-level evidence directly proves the cause.
- Do not punt, apologize, or say you cannot produce insights when any useful metrics exist. If one query is sparse, use stronger available evidence and lower confidence.
</data_rules>

<output_rules>
- Return no more than ${targetCount} concise insights: reliability/product risk first, then engagement/acquisition opportunity. Do not make near-duplicates.
- Each insight must be one clear signal with 1-5 metrics; primary metric first.
- Metrics array owns the numbers. Description/suggestion should reference metric labels, not restate values.
- Keep title under 80 chars, description under 320 chars, suggestion under 260 chars.
- Titles must be plain English and user-facing. Do not put raw metric jargon like INP, LCP, FCP, TTFB, CLS, or p75 in titles; put technical metric names only in the metrics array.
- Keep description 1-2 concise sentences: what changed, why it matters, and whether cause is evidence or hypothesis.
- Suggestion must be a specific next action with an operational verb such as inspect, review, compare, segment, drill into, fix, audit, trace, or verify. Never use generic monitoring advice.
- Suggestion must name the exact product surface to inspect next: funnel step, goal, referrer segment, page path, error class, session stream, web vital, flag rollout, or agent diagnostic prompt.
- subjectKey must be stable; sources must include only evidence domains used; confidence 0-1 should reflect evidence strength.
- impactSummary is optional, one sentence under 220 characters.
</output_rules>

<quality_examples>
Good: Error Rate rose while Sessions stayed stable -> reliability issue; suggest reviewing affected page/errors first.
Good: INP p75 rose -> title "Interactions got slower"; metrics can still include "INP p75".
Good: Onboarding step 2 drop-off is 80% -> title "Onboarding is leaking at step 2".
Bad: Pricing Visitors rose -> "revenue opportunity" without business data.
Bad: Twitter rose and Bounce Rate worsened -> "Twitter caused the drop" without segmented engagement data.
Bad: "INP p75 still rising" as a title; users should not need to know web-vitals acronyms.
</quality_examples>`;
}

async function validateOrRepairInsights(
	insights: ParsedInsight[],
	context: {
		config: InsightGenerationConfigSnapshot;
		domain: string;
		mode: "agent" | "legacy";
		organizationId: string;
		websiteId: string;
	}
): Promise<ParsedInsight[]> {
	const validated = validateInsights(insights);
	if (validated.warnings.length > 0) {
		log.warn({
			service: "insights",
			message: "Insights validation repaired or dropped output",
			organization_id: context.organizationId,
			website_id: context.websiteId,
			mode: context.mode,
			warnings: validated.warnings,
		});
	}

	const targetCount = Math.min(maxInsights(context.config), insights.length);
	if (targetCount === 0 || validated.insights.length >= targetCount) {
		return validated.insights.slice(0, targetCount);
	}

	try {
		const ai = getAILogger();
		const repair = await generateText({
			model: ai.wrap(modelForTier(context.config.modelTier)),
			output: Output.object({ schema: insightsOutputSchema }),
			messages: [
				{
					role: "system",
					content: `Repair Databuddy insight cards. Return up to ${targetCount} concise, valid cards when the source contains distinct data-backed signals. Use only the provided metrics and claims; do not invent numbers, causes, revenue impact, or new entities. Keep title <=80 chars, description <=320 chars, suggestion <=260 chars. Write for a founder/operator: titles must be plain English and avoid raw metric jargon like INP, LCP, FCP, TTFB, CLS, or p75. Technical metric names may remain in the metrics array. Suggestions need specific operational actions, not monitoring. Soften unsupported causality.`,
				},
				{
					role: "user",
					content: JSON.stringify(
						{
							domain: context.domain,
							validationWarnings: validated.warnings,
							originalInsights: insights,
						},
						null,
						2
					),
				},
			],
			temperature: 0,
			maxOutputTokens: 4096,
			abortSignal: AbortSignal.timeout(30_000),
			experimental_telemetry: {
				isEnabled: true,
				functionId: "databuddy.insights.worker.repair",
				metadata: {
					source: "insights_worker",
					feature: "smart_insights",
					mode: context.mode,
					organizationId: context.organizationId,
					websiteId: context.websiteId,
					websiteDomain: context.domain,
				},
			},
		});

		const repairedOutput = repair.output?.insights ?? [];
		const repaired = validateInsights(repairedOutput);
		if (repaired.warnings.length > 0) {
			log.warn({
				service: "insights",
				message: "Insights repair validation warnings",
				organization_id: context.organizationId,
				website_id: context.websiteId,
				mode: context.mode,
				warnings: repaired.warnings,
			});
		}

		if (repaired.insights.length >= validated.insights.length) {
			return repaired.insights.slice(0, targetCount);
		}
	} catch (error) {
		log.warn({
			service: "insights",
			message: "Insights repair failed",
			error_message: errorMessage(error),
			organization_id: context.organizationId,
			website_id: context.websiteId,
			mode: context.mode,
		});
	}

	return validated.insights.slice(0, targetCount);
}

async function analyzeWebsiteLegacy(params: {
	config: InsightGenerationConfigSnapshot;
	domain: string;
	organizationId: string;
	orgSites: OrgWebsiteRow[];
	period: WeekOverWeekPeriod;
	recentInsightsBlock: string;
	annotationContext: string;
	userId: string;
	websiteId: string;
}): Promise<ParsedInsight[]> {
	const currentRange = params.period.current;
	const previousRange = params.period.previous;
	const [current, previous] = await Promise.all([
		fetchWebPeriodData(
			params.websiteId,
			params.domain,
			currentRange.from,
			currentRange.to,
			params.config.timezone
		),
		fetchWebPeriodData(
			params.websiteId,
			params.domain,
			previousRange.from,
			previousRange.to,
			params.config.timezone
		),
	]);

	if (current.summary.length === 0 && current.topPages.length === 0) {
		return [];
	}

	const dataSection = formatLegacyWebDataForPrompt(
		current,
		previous,
		currentRange,
		previousRange
	);
	const orgContext = formatOrgWebsitesContext(
		params.orgSites,
		params.websiteId
	);
	const prompt = `Analyze this website's period-over-period data and return insights.

${orgContext}${dataSection}${params.annotationContext}${params.recentInsightsBlock}`;

	try {
		const ai = getAILogger();
		const result = await generateText({
			model: ai.wrap(modelForTier(params.config.modelTier)),
			output: Output.object({ schema: insightsOutputSchema }),
			messages: [
				{
					role: "system",
					content: buildSystemPrompt(params.config),
					providerOptions: ANTHROPIC_CACHE_1H,
				},
				{ role: "user", content: prompt },
			],
			temperature: 0.2,
			maxOutputTokens: 8192,
			abortSignal: AbortSignal.timeout(LEGACY_TIMEOUT_MS),
			experimental_telemetry: {
				isEnabled: true,
				functionId: "databuddy.insights.worker.analyze_website",
				metadata: {
					source: "insights_worker",
					feature: "smart_insights",
					mode: "legacy_fallback",
					organizationId: params.organizationId,
					userId: params.userId,
					websiteId: params.websiteId,
					websiteDomain: params.domain,
					timezone: params.config.timezone,
				},
			},
		});

		return await validateOrRepairInsights(result.output?.insights ?? [], {
			config: params.config,
			domain: params.domain,
			mode: "legacy",
			organizationId: params.organizationId,
			websiteId: params.websiteId,
		});
	} catch (error) {
		log.warn({
			service: "insights",
			message: "Failed to generate insights with legacy fallback",
			error_message: errorMessage(error),
			organization_id: params.organizationId,
			website_id: params.websiteId,
		});
		return [];
	}
}

async function analyzeWebsite(params: {
	config: InsightGenerationConfigSnapshot;
	domain: string;
	organizationId: string;
	orgSites: OrgWebsiteRow[];
	period: WeekOverWeekPeriod;
	userId: string;
	websiteId: string;
}): Promise<ParsedInsight[]> {
	const currentRange = params.period.current;
	const previousRange = params.period.previous;
	const hasData = await hasWebInsightData(
		params.websiteId,
		params.domain,
		currentRange.from,
		currentRange.to,
		params.config.timezone
	);
	if (!hasData) {
		return [];
	}

	const [annotationContext, recentInsightsBlock] = await Promise.all([
		fetchRecentAnnotations(params.websiteId, params.config),
		fetchRecentInsightsForPrompt(
			params.organizationId,
			params.websiteId,
			params.config
		),
	]);

	const allowedTools = normalizeAllowedTools(params.config.allowedTools);
	const orgContext = formatOrgWebsitesContext(
		params.orgSites,
		params.websiteId
	);
	const userPrompt = `Analyze this website's period-over-period data and produce insights.

**Current period:** ${currentRange.from} to ${currentRange.to}
**Previous period:** ${previousRange.from} to ${previousRange.to}
**Timezone:** ${params.config.timezone}
**Domain:** ${params.domain}

Use web_metrics to pull metrics for both current and previous periods before inferring trends. Start with summary_metrics for both periods, then add top_pages, error_summary, top_referrers, country, browser_name, vitals_overview, or custom_events queries only when they sharpen the narrative. Use product_metrics for goals, funnels, retention, and custom event behavior when a traffic change may have downstream product impact. Use ops_context for page-level errors, uptime, anomaly signals, and recent flag rollouts when reliability or product changes may explain the trend. Use business_context for revenue totals, attribution, and product mix when commercial impact matters.

Only call these enabled tools: ${allowedTools.join(", ")}.

${orgContext}${annotationContext}${recentInsightsBlock}`;

	const { tools: allTools } = createInsightsAgentTools({
		websiteId: params.websiteId,
		domain: params.domain,
		timezone: params.config.timezone,
		periodBounds: { current: currentRange, previous: previousRange },
	});
	const tools = Object.fromEntries(
		Object.entries(allTools).filter(([name]) =>
			allowedTools.includes(name as InsightGenerationTool)
		)
	) as Partial<typeof allTools>;

	try {
		const appContext: AppContext = {
			userId: params.userId,
			organizationId: params.organizationId,
			websiteId: params.websiteId,
			websiteDomain: params.domain,
			timezone: params.config.timezone,
			currentDateTime: new Date().toISOString(),
			chatId: `insights:${params.organizationId}:${params.websiteId}`,
		};
		let toolCallCount = 0;
		const ai = getAILogger();
		const agent = new ToolLoopAgent({
			model: ai.wrap(modelForTier(params.config.modelTier)),
			instructions: {
				role: "system",
				content: buildSystemPrompt(params.config),
				providerOptions: ANTHROPIC_CACHE_1H,
			},
			output: Output.object({ schema: insightsOutputSchema }),
			tools,
			stopWhen: stepCountIs(
				Math.max(
					1,
					Math.min(params.config.maxSteps, params.config.maxToolCalls + 2)
				)
			),
			prepareStep: ({ stepNumber }) => {
				if (stepNumber === 0 && "web_metrics" in tools) {
					return {
						activeTools: ["web_metrics"],
						toolChoice: { type: "tool", toolName: "web_metrics" },
					};
				}
				return { activeTools: allowedTools };
			},
			onStepFinish: ({ usage, finishReason, toolCalls }) => {
				toolCallCount += toolCalls.length;
				log.info({
					service: "insights",
					message: "Insights worker agent step finished",
					organization_id: params.organizationId,
					website_id: params.websiteId,
					finish_reason: finishReason,
					tool_calls: toolCalls.flatMap((toolCall) =>
						toolCall ? [toolCall.toolName] : []
					),
					total_tokens: usage?.totalTokens,
					tool_call_count: toolCallCount,
				});
			},
			temperature: 0.2,
			experimental_context: appContext,
			experimental_telemetry: {
				isEnabled: true,
				functionId: "databuddy.insights.worker.analyze_website",
				metadata: {
					source: "insights_worker",
					feature: "smart_insights",
					mode: "agent",
					organizationId: params.organizationId,
					userId: params.userId,
					websiteId: params.websiteId,
					websiteDomain: params.domain,
					timezone: params.config.timezone,
					depth: params.config.depth,
					modelTier: params.config.modelTier,
				},
			},
		});

		const result = await agent.generate({
			messages: [{ role: "user", content: userPrompt }],
			abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
		});

		if (result.output?.insights?.length) {
			return await validateOrRepairInsights(result.output.insights, {
				config: params.config,
				domain: params.domain,
				mode: "agent",
				organizationId: params.organizationId,
				websiteId: params.websiteId,
			});
		}

		log.warn({
			service: "insights",
			message: "Insights worker agent finished without structured output",
			organization_id: params.organizationId,
			website_id: params.websiteId,
		});
	} catch (error) {
		log.warn({
			service: "insights",
			message: "Insights worker agent failed, using legacy fallback",
			error_message: errorMessage(error),
			organization_id: params.organizationId,
			website_id: params.websiteId,
		});
	}

	return analyzeWebsiteLegacy({
		...params,
		annotationContext,
		recentInsightsBlock,
	});
}

async function persistWebsiteInsights(params: {
	config: InsightGenerationConfigSnapshot;
	insights: GeneratedWebsiteInsight[];
	organizationId: string;
	period: WeekOverWeekPeriod;
	runId: string;
}): Promise<GeneratedWebsiteInsight[]> {
	const dedupeKeyToId = await fetchInsightDedupeKeyToIdMap(
		params.organizationId,
		params.config.cooldownHours
	);
	const seenInBatch = new Set<string>();
	const finalInsights: GeneratedWebsiteInsight[] = [];

	for (const insight of [...params.insights].sort(
		(a, b) => b.priority - a.priority
	)) {
		const key = dedupeKeyFor(insight);
		if (seenInBatch.has(key)) {
			continue;
		}
		seenInBatch.add(key);
		const existingId = dedupeKeyToId.get(key);
		finalInsights.push(existingId ? { ...insight, id: existingId } : insight);
		if (finalInsights.length >= maxInsights(params.config)) {
			break;
		}
	}

	if (finalInsights.length === 0) {
		return [];
	}

	const updatePayload = {
		runId: params.runId,
		timezone: params.config.timezone,
		currentPeriodFrom: params.period.current.from,
		currentPeriodTo: params.period.current.to,
		previousPeriodFrom: params.period.previous.from,
		previousPeriodTo: params.period.previous.to,
		createdAt: new Date(),
	};

	const toInsert = finalInsights
		.filter((insight) => {
			const existingId = dedupeKeyToId.get(dedupeKeyFor(insight));
			return !(existingId && insight.id === existingId);
		})
		.map((insight) => ({
			id: insight.id,
			organizationId: params.organizationId,
			websiteId: insight.websiteId,
			runId: params.runId,
			title: insight.title,
			description: insight.description,
			suggestion: insight.suggestion,
			severity: insight.severity,
			sentiment: insight.sentiment,
			type: insight.type,
			priority: insight.priority,
			changePercent: insight.changePercent ?? null,
			dedupeKey: dedupeKeyFor(insight),
			subjectKey: insight.subjectKey,
			sources: insight.sources,
			confidence: insight.confidence,
			impactSummary: insight.impactSummary ?? null,
			metrics:
				insight.metrics.length > 0
					? (insight.metrics as InsightMetricRow[])
					: null,
			timezone: params.config.timezone,
			currentPeriodFrom: params.period.current.from,
			currentPeriodTo: params.period.current.to,
			previousPeriodFrom: params.period.previous.from,
			previousPeriodTo: params.period.previous.to,
		}));

	const toRefresh = finalInsights.filter((insight) => {
		const existingId = dedupeKeyToId.get(dedupeKeyFor(insight));
		return existingId !== undefined && insight.id === existingId;
	});

	if (toInsert.length > 0) {
		await db
			.insert(analyticsInsights)
			.values(toInsert)
			.onConflictDoUpdate({
				target: [analyticsInsights.organizationId, analyticsInsights.dedupeKey],
				targetWhere: isNotNull(analyticsInsights.dedupeKey),
				set: {
					runId: params.runId,
					timezone: params.config.timezone,
					currentPeriodFrom: params.period.current.from,
					currentPeriodTo: params.period.current.to,
					previousPeriodFrom: params.period.previous.from,
					previousPeriodTo: params.period.previous.to,
					createdAt: new Date(),
					title: sql.raw("excluded.title"),
					description: sql.raw("excluded.description"),
					suggestion: sql.raw("excluded.suggestion"),
					severity: sql.raw("excluded.severity"),
					sentiment: sql.raw("excluded.sentiment"),
					type: sql.raw("excluded.type"),
					priority: sql.raw("excluded.priority"),
					changePercent: sql.raw("excluded.change_percent"),
					subjectKey: sql.raw("excluded.subject_key"),
					sources: sql.raw("excluded.sources"),
					confidence: sql.raw("excluded.confidence"),
					impactSummary: sql.raw("excluded.impact_summary"),
					metrics: sql.raw("excluded.metrics"),
				},
			});
	}
	await Promise.all(
		toRefresh.map((insight) =>
			db
				.update(analyticsInsights)
				.set({
					...updatePayload,
					title: insight.title,
					description: insight.description,
					suggestion: insight.suggestion,
					severity: insight.severity,
					sentiment: insight.sentiment,
					type: insight.type,
					priority: insight.priority,
					changePercent: insight.changePercent ?? null,
					dedupeKey: dedupeKeyFor(insight),
					subjectKey: insight.subjectKey,
					sources: insight.sources,
					confidence: insight.confidence,
					impactSummary: insight.impactSummary ?? null,
					metrics:
						insight.metrics.length > 0
							? (insight.metrics as InsightMetricRow[])
							: null,
				})
				.where(eq(analyticsInsights.id, insight.id))
		)
	);

	const websiteInvalidations = [
		...new Set(finalInsights.map((insight) => insight.websiteId)),
	].map((websiteId) => invalidateAgentContextSnapshotsForWebsite(websiteId));

	await Promise.all([
		invalidateInsightsCachesForOrganization(params.organizationId),
		...websiteInvalidations,
	]);

	return finalInsights;
}

function storeWebsiteSummary(
	site: OrgWebsiteRow,
	insights: GeneratedWebsiteInsight[]
): void {
	if (insights.length === 0) {
		return;
	}
	const summary = insights
		.map(
			(insight) =>
				`[${insight.severity}] ${insight.title}: ${insight.description} Suggestion: ${insight.suggestion}`
		)
		.join("\n");

	storeAnalyticsSummary(
		`Insights for ${site.domain} (${dayjs().format("YYYY-MM-DD")}):\n${summary}`,
		site.id,
		{ period: "configured" }
	).catch((error: unknown) => {
		log.warn({
			service: "insights",
			message: "Failed to store analytics summary",
			error_message: errorMessage(error),
			website_id: site.id,
		});
	});
}

export async function generateWebsiteInsights(
	input: GenerateWebsiteInsightsInput
): Promise<GenerateWebsiteInsightsResult> {
	const [site] = await db
		.select({ id: websites.id, name: websites.name, domain: websites.domain })
		.from(websites)
		.where(
			and(
				eq(websites.id, input.websiteId),
				eq(websites.organizationId, input.organizationId),
				isNull(websites.deletedAt)
			)
		)
		.limit(1);

	if (!site) {
		return {
			status: "skipped",
			resultCount: 0,
			insightIds: [],
			message: "Website not found or deleted",
		};
	}

	const orgSites = await db
		.select({ id: websites.id, name: websites.name, domain: websites.domain })
		.from(websites)
		.where(
			and(
				eq(websites.organizationId, input.organizationId),
				isNull(websites.deletedAt)
			)
		)
		.orderBy(websites.domain)
		.limit(100);

	const period = getComparisonPeriod(input.config.lookbackDays);
	const userId = input.requestedByUserId ?? "insights-worker";
	const insights = await analyzeWebsite({
		config: input.config,
		domain: site.domain,
		organizationId: input.organizationId,
		orgSites,
		period,
		userId,
		websiteId: site.id,
	});

	const candidates = insights.map(
		(insight): GeneratedWebsiteInsight => ({
			...insight,
			id: randomUUIDv7(),
			websiteId: site.id,
			websiteName: site.name,
			websiteDomain: site.domain,
		})
	);

	const saved = await persistWebsiteInsights({
		config: input.config,
		insights: candidates,
		organizationId: input.organizationId,
		period,
		runId: input.runId,
	});

	storeWebsiteSummary(site, saved);

	log.info({
		service: "insights",
		message: "Generated website insights",
		organization_id: input.organizationId,
		website_id: input.websiteId,
		run_id: input.runId,
		result_count: saved.length,
		reason: input.reason,
		depth: input.config.depth,
		model_tier: input.config.modelTier,
		allowed_tools: input.config.allowedTools,
	});

	return saved.length > 0
		? {
				status: "succeeded",
				resultCount: saved.length,
				insightIds: saved.map((insight) => insight.id),
			}
		: {
				status: "skipped",
				resultCount: 0,
				insightIds: [],
				message: "No data-backed insights generated",
			};
}
