import type { AppContext } from "@databuddy/ai/config/context";
import { ANTHROPIC_CACHE_1H, models } from "@databuddy/ai/config/models";
import { insightDedupeKey } from "@databuddy/ai/insights/dedupe";
import { hasWebInsightData } from "@databuddy/ai/insights/fetch-context";
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
import {
	and,
	db,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "@databuddy/db";
import {
	account,
	analyticsInsights,
	annotations,
	type InsightGenerationConfigSnapshot,
	type InsightGenerationTool,
	member,
	websites,
} from "@databuddy/db/schema";
import {
	invalidateAgentContextSnapshotsForWebsite,
	invalidateInsightsCachesForOrganization,
} from "@databuddy/redis";
import { generateText, Output, stepCountIs, ToolLoopAgent } from "ai";
import { randomUUIDv7 } from "bun";
import dayjs from "dayjs";
import { createGitHubTools } from "@databuddy/ai/tools/github-tools";
import { detectSignals, safeDeltaPercent } from "./detection";
import { enrichSignals } from "./enrichment";
import type { EnrichedSignal } from "./enrichment";
import {
	captureInsightsError,
	emitInsightsEvent,
	setInsightsLog,
} from "./lib/evlog-insights";

const AGENT_TIMEOUT_MS = 90_000;
const RECENT_INSIGHTS_PROMPT_LIMIT = 12;
const DEFAULT_MAX_INSIGHTS = 2;
const TOOL_NAMES = [
	"web_metrics",
	"product_metrics",
	"ops_context",
	"business_context",
] as const satisfies readonly InsightGenerationTool[];

interface ExecutableTool {
	execute?: (...args: never[]) => unknown;
}

function withToolCallBudget<T extends object>(
	tools: T,
	onExecute: (toolName: string) => void
): T {
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			const executable = tool as ExecutableTool;
			return [
				name,
				{
					...(tool as object),
					execute: (...args: never[]) => {
						onExecute(name);
						return executable.execute?.(...args);
					},
				},
			];
		})
	) as T;
}

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

function buildSystemPrompt(
	config: InsightGenerationConfigSnapshot,
	options?: { investigationMode?: boolean }
): string {
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
- Write for a founder who skims Slack in 10 seconds. Every insight must answer: "should I care, and what should I do?"
- Titles must be direct and scannable. Lead with the outcome, not the metric. Good: "Checkout errors tripled after Tuesday's deploy". Bad: "Error rate shows concerning upward trend". Bad: "Session engagement softened".
- Only surface signals that would change what someone does today. If the answer is "monitor it" or "keep watching", it's not worth reporting.
- Prefer reliability risks, conversion impact, and customer health over vanity traffic changes. A 200% traffic spike from bots is noise. A 5% drop in checkout completion is a crisis.
- Skip errors that are known, expected, or low-impact. Only flag errors that are NEW this period and affecting user-facing flows.
- Prefer 1-2 high-signal insights over 3-5 mediocre ones. Silence is better than noise.
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
- Return no more than ${targetCount} insights. Fewer is better. Do not pad to fill the count.
- Each insight must be one clear signal with 1-5 metrics; primary metric first.
- Title: under 80 chars. Start with what happened, not what metric moved. Use active voice. Include direction and magnitude when it fits. Examples: "Google traffic doubled, now 80% of all visitors", "Three new JS errors appeared after traffic surge", "Checkout page lost 25% of visitors this week". Never use hedging words like "concerning", "softened", "worth watching", "shows signs of". Never use raw metric jargon (INP, LCP, FCP, TTFB, CLS, p75) in titles.
- Description: 1-2 sentences, under 480 chars. Say what changed and why it matters to the business. Do not restate numbers from the metrics array.
- Suggestion: one specific action, under 400 chars. Name the exact surface to check (page, funnel step, referrer, error class). Never say "monitor", "watch", "keep an eye on", or "track closely".
- Metrics array owns the numbers. Description references labels, not values.
- subjectKey must be stable; sources must include only evidence domains used; confidence 0-1 reflects evidence strength.
</output_rules>

<quality_examples>
Good title: "Google traffic doubled, now drives 80% of all visits"
Good title: "Three new JS errors appeared after this week's traffic spike"
Good title: "Checkout page lost 25% of visitors since Tuesday"
Good title: "/pricing page traffic dropped 16% while rest of site grew"
Bad title: "Session engagement softened" (ambivalent, not scannable)
Bad title: "Error rate shows concerning upward trend" (hedging, vague)
Bad title: "Traffic changes worth monitoring" (not actionable)
Bad title: "INP p75 still rising" (jargon)
Bad title: "Bounce rate increased slightly" (who cares?)
Bad: Reporting known/recurring errors as if they're new.
Bad: "Monitor this" or "keep watching" as a suggestion.
Bad: Flagging a traffic spike without checking if it's real users or bots.
</quality_examples>${
		options?.investigationMode
			? `

<investigation_rules>
- Investigate the pre-computed signals. Do not generate additional observations unless they directly explain a detected signal.
- Drop any signal that, after investigation, turns out to be noise (low absolute impact, known pattern, bot traffic, or no actionable root cause). Return fewer insights rather than padding with noise.
- Cite statistical evidence for causal claims. Confidence above 0.7 requires temporal proximity, segment isolation, or corroborating signals.
- Use rootCause to state the hypothesis concisely. Use evidence array for supporting data points.
- Set investigationDepth to "investigated" when you used tools to validate, "surface" when reporting pre-computed data only.
- If GitHub tools are available (github_repos, github_commits, github_deploys, github_pull_requests): check for code changes in the anomaly time window. Start with github_repos to find the repo, then github_commits with the since/until dates matching the anomaly window. If a commit correlates temporally, check github_pull_requests for context on what shipped.
- When a metric change correlates with a deploy or merged PR, cite the specific commit SHA and PR title in the evidence array with type "temporal".
</investigation_rules>`
			: ""
	}`;
}

function formatSignalBlock(signal: EnrichedSignal, index: number): string {
	const method =
		signal.method === "zscore"
			? `z-score: ${signal.zScore}, severity: ${signal.severity}`
			: `WoW, severity: ${signal.severity}`;
	const header = `Signal ${index + 1}: ${signal.label} ${signal.direction === "up" ? "increased" : "dropped"} ${Math.abs(signal.deltaPercent).toFixed(1)}% (${method})`;
	const baseline = `  Current: ${signal.current.toLocaleString()} | Baseline: ${signal.baseline.toLocaleString()}`;
	const detected = `  Detected: ${signal.detectedAt}`;
	const parts = [header, baseline, detected];

	if (signal.segments.length > 0) {
		parts.push("");
		parts.push("  Segment analysis:");
		for (const seg of signal.segments) {
			const movers = seg.topMovers
				.map(
					(m) =>
						`${m.name} ${m.deltaPercent > 0 ? "increased" : "dropped"} ${Math.abs(m.deltaPercent).toFixed(1)}%`
				)
				.join(", ");
			parts.push(`  - ${seg.dimension}: ${movers}`);
		}
	}

	if (signal.errorContext) {
		const ec = signal.errorContext;
		parts.push("");
		parts.push(
			`  Error context: Errors ${ec.deltaPercent > 0 ? "increased" : "decreased"} ${Math.abs(ec.deltaPercent).toFixed(0)}% (${ec.totalErrorsPrevious.toLocaleString()} -> ${ec.totalErrorsCurrent.toLocaleString()})`
		);
		if (ec.topNewErrors.length > 0) {
			parts.push(`  - New errors: ${ec.topNewErrors.join(", ")}`);
		}
		if (ec.topSpikedErrors.length > 0) {
			parts.push(`  - Spiked errors: ${ec.topSpikedErrors.join(", ")}`);
		}
	}

	if (signal.annotations.length > 0) {
		parts.push("");
		parts.push("  Annotations in window:");
		for (const annotation of signal.annotations) {
			const tags =
				annotation.tags.length > 0 ? ` [${annotation.tags.join(", ")}]` : "";
			parts.push(`  - [${annotation.date}] "${annotation.title}"${tags}`);
		}
	}

	if (signal.githubContext) {
		const gc = signal.githubContext;
		parts.push("");
		parts.push(`  GitHub (${gc.repo}):`);
		if (gc.commits.length > 0) {
			parts.push(`  Recent commits (${gc.commits.length}):`);
			for (const c of gc.commits.slice(0, 5)) {
				parts.push(`  - [${c.date?.slice(0, 10)}] ${c.sha} ${c.message}`);
			}
		}
		if (gc.recentPRs.length > 0) {
			parts.push(`  Merged PRs (${gc.recentPRs.length}):`);
			for (const pr of gc.recentPRs.slice(0, 5)) {
				parts.push(
					`  - #${pr.number} ${pr.title} (merged ${pr.mergedAt?.slice(0, 10)})`
				);
			}
		}
	}

	return parts.join("\n");
}

function buildInvestigationPrompt(
	enrichedSignals: EnrichedSignal[],
	params: {
		annotationContext: string;
		config: InsightGenerationConfigSnapshot;
		domain: string;
		githubRepo?: { owner: string; repo: string };
		orgContext: string;
		period: WeekOverWeekPeriod;
		recentInsightsBlock: string;
		timezone: string;
	}
): string {
	const { domain, period, timezone } = params;
	const signalBlocks = enrichedSignals
		.map((signal, i) => formatSignalBlock(signal, i))
		.join("\n\n");

	const githubInstruction = params.githubRepo
		? `2. Call github_commits for ${params.githubRepo.owner}/${params.githubRepo.repo} with since/until dates matching the anomaly window. If commits correlate temporally with a metric change, check github_pull_requests for what shipped.`
		: "2. If GitHub tools are available, call github_repos first, then github_commits with since/until dates matching the anomaly window.";

	return `Investigating ${enrichedSignals.length} statistical anomalies detected on ${domain}.
Period: ${period.current.from} to ${period.current.to} vs ${period.previous.from} to ${period.previous.to}
Timezone: ${timezone}

DETECTED SIGNALS (statistical evidence):

${signalBlocks}

The segment analysis above shows WHAT changed. Your job is to figure out WHY.

INVESTIGATE each signal by querying deeper data. You MUST make at least 2 tool calls before concluding. Choose what to dig into based on the signal:
- Errors or reliability: query recent_errors (stack traces + paths), errors_by_page, error_types
- Engagement or session changes: query sessions_by_browser, sessions_by_device, entry_pages, exit_pages, page_time_analysis, session_metrics
- Traffic or referrer shifts: query utm_campaigns, utm_sources, traffic_sources
- Performance: query web_vitals_by_page, web_vitals_by_browser, web_vitals_by_country
- Revenue: query revenue_overview, revenue_by_referrer, revenue_by_entry_page, recent_transactions
- Product behavior: query custom_events_discovery, custom_events_trends
- Geographic: query region for sub-country breakdown
${githubInstruction}

When your first query reveals something interesting, FOLLOW THE LEAD. If sessions_by_browser shows LinkedIn dropped 74%, check what happened to LinkedIn as a referrer. If recent_errors shows a specific error on /editor, check errors_by_page for other affected pages. Each follow-up query should narrow the root cause.

After investigating, DROP signals that are noise. For signals worth reporting:
- Explain the root cause with specific evidence from your queries
- Cite specific numbers, paths, error messages, deploy IDs from the data
- Write a title a founder can scan in 2 seconds
- Suggest one concrete action naming the exact page, error, or component to fix

${params.orgContext}${params.annotationContext}${params.recentInsightsBlock}`;
}

async function validateOrRepairInsights(
	insights: ParsedInsight[],
	context: {
		config: InsightGenerationConfigSnapshot;
		domain: string;
		organizationId: string;
		websiteId: string;
	}
): Promise<ParsedInsight[]> {
	const validated = validateInsights(insights);
	if (validated.warnings.length > 0) {
		emitInsightsEvent("warn", "generation.validation_warnings", {
			organization_id: context.organizationId,
			website_id: context.websiteId,
			
			input_count: insights.length,
			output_count: validated.insights.length,
			warning_count: validated.warnings.length,
			warnings: validated.warnings,
		});
	}

	const targetCount = Math.min(maxInsights(context.config), insights.length);
	if (targetCount === 0 || validated.insights.length >= targetCount) {
		return validated.insights.slice(0, targetCount);
	}

	const repairStartedAt = performance.now();
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
					
					organizationId: context.organizationId,
					websiteId: context.websiteId,
					websiteDomain: context.domain,
				},
			},
		});

		const repairedOutput = repair.output?.insights ?? [];
		const repaired = validateInsights(repairedOutput);
		if (repaired.warnings.length > 0) {
			emitInsightsEvent("warn", "generation.repair.validation_warnings", {
				organization_id: context.organizationId,
				website_id: context.websiteId,
				
				input_count: repairedOutput.length,
				output_count: repaired.insights.length,
				warning_count: repaired.warnings.length,
				warnings: repaired.warnings,
			});
		}

		if (repaired.insights.length >= validated.insights.length) {
			emitInsightsEvent("info", "generation.repair.completed", {
				organization_id: context.organizationId,
				website_id: context.websiteId,
				
				duration_ms: Math.round(performance.now() - repairStartedAt),
				input_count: insights.length,
				output_count: repaired.insights.length,
			});
			return repaired.insights.slice(0, targetCount);
		}
	} catch (error) {
		captureInsightsError(error, "generation.repair.failed", {
			organization_id: context.organizationId,
			website_id: context.websiteId,
			
			duration_ms: Math.round(performance.now() - repairStartedAt),
			input_count: insights.length,
			target_count: targetCount,
		});
	}

	return validated.insights.slice(0, targetCount);
}

async function analyzeWebsite(params: {
	config: InsightGenerationConfigSnapshot;
	domain: string;
	githubRepo?: { owner: string; repo: string };
	organizationId: string;
	orgSites: OrgWebsiteRow[];
	period: WeekOverWeekPeriod;
	userId: string;
	websiteId: string;
}): Promise<ParsedInsight[]> {
	const startedAt = performance.now();
	const currentRange = params.period.current;
	const previousRange = params.period.previous;
	const [hasCurrentData, hasPreviousData] = await Promise.all([
		hasWebInsightData(
			params.websiteId,
			params.domain,
			currentRange.from,
			currentRange.to,
			params.config.timezone
		),
		hasWebInsightData(
			params.websiteId,
			params.domain,
			previousRange.from,
			previousRange.to,
			params.config.timezone
		),
	]);
	if (!(hasCurrentData || hasPreviousData)) {
		emitInsightsEvent("info", "generation.agent.skipped_no_data", {
			organization_id: params.organizationId,
			website_id: params.websiteId,
			duration_ms: Math.round(performance.now() - startedAt),
		});
		return [];
	}

	let enrichedSignals: EnrichedSignal[] = [];
	try {
		const signals = await detectSignals({
			websiteId: params.websiteId,
			lookbackDays: params.config.lookbackDays,
			timezone: params.config.timezone,
		});
		if (signals.length > 0) {
			let githubToken: string | null = null;
			if (params.githubRepo) {
				const [ghAccount] = await db
					.select({ accessToken: account.accessToken })
					.from(account)
					.innerJoin(member, eq(member.userId, account.userId))
					.where(
						and(
							eq(member.organizationId, params.organizationId),
							eq(account.providerId, "github")
						)
					)
					.limit(1);
				githubToken = ghAccount?.accessToken ?? null;
			}

			enrichedSignals = await enrichSignals(signals, {
				websiteId: params.websiteId,
				timezone: params.config.timezone,
				lookbackDays: params.config.lookbackDays,
				githubRepo: params.githubRepo,
				githubToken,
			});
		}
	} catch (err) {
		emitInsightsEvent("warn", "generation.detection_failed", {
			error: String(err),
		});
	}

	const investigationMode = enrichedSignals.length > 0;

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
	const userPrompt = investigationMode
		? buildInvestigationPrompt(enrichedSignals, {
				domain: params.domain,
				githubRepo: params.githubRepo,
				period: params.period,
				config: params.config,
				timezone: params.config.timezone,
				recentInsightsBlock,
				annotationContext,
				orgContext,
			})
		: `Analyze this website's period-over-period data and produce insights.

**Current period:** ${currentRange.from} to ${currentRange.to}
**Previous period:** ${previousRange.from} to ${previousRange.to}
**Timezone:** ${params.config.timezone}
**Domain:** ${params.domain}

Use web_metrics to pull metrics for both current and previous periods before inferring trends. Start with summary_metrics for both periods, then add top_pages, error_summary, top_referrers, country, browser_name, vitals_overview, or custom_events queries only when they sharpen the narrative. Use product_metrics for goals, funnels, retention, and custom event behavior when a traffic change may have downstream product impact. Use ops_context for page-level errors, uptime, anomaly signals, and recent flag rollouts when reliability or product changes may explain the trend. Use business_context for revenue totals, attribution, and product mix when commercial impact matters.

Only call these enabled tools: ${allowedTools.join(", ")}.

${orgContext}${annotationContext}${recentInsightsBlock}`;

	const { tools: analyticsTools } = createInsightsAgentTools({
		websiteId: params.websiteId,
		domain: params.domain,
		timezone: params.config.timezone,
		periodBounds: { current: currentRange, previous: previousRange },
	});
	const githubTools = investigationMode
		? createGitHubTools({
				organizationId: params.organizationId,
				userId: params.userId,
			})
		: {};
	const hasGitHub = investigationMode;
	const allTools = { ...analyticsTools, ...githubTools };
	const availableTools = Object.fromEntries(
		Object.entries(allTools).filter(
			([name]) =>
				allowedTools.includes(name as InsightGenerationTool) ||
				name.startsWith("github_")
		)
	) as typeof allTools;
	const activeToolNames = Object.keys(availableTools) as (keyof typeof availableTools)[];

	try {
		const appContext: AppContext = {
			userId: params.userId,
			organizationId: params.organizationId,
			websiteId: params.websiteId,
			websiteDomain: params.domain,
			timezone: params.config.timezone,
			currentDateTime: new Date().toISOString(),
			chatId: `insights:${params.organizationId}:${params.websiteId}`,
			serviceAuth: {
				organizationId: params.organizationId,
				scopes: ["read:data"],
			},
		};
		let toolCallCount = 0;
		let executedToolCallCount = 0;
		const maxToolCalls = Math.max(1, params.config.maxToolCalls) + (hasGitHub ? 3 : 0);
		const tools = withToolCallBudget(availableTools, (toolName) => {
			if (executedToolCallCount >= maxToolCalls) {
				throw new Error(
					`Insight generation tool-call budget exceeded before ${toolName}`
				);
			}
			executedToolCallCount += 1;
		});
		const ai = getAILogger();
		const agent = new ToolLoopAgent({
			model: ai.wrap(modelForTier(params.config.modelTier)),
			instructions: {
				role: "system",
				content: buildSystemPrompt(params.config, { investigationMode }),
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
				const remainingToolCalls = maxToolCalls - executedToolCallCount;
				if (remainingToolCalls <= 0) {
					return { activeTools: [] };
				}
				const activeTools = activeToolNames.slice(0, remainingToolCalls);
				if (stepNumber === 0 && activeTools.includes("web_metrics")) {
					return {
						activeTools: ["web_metrics"],
						toolChoice: { type: "tool", toolName: "web_metrics" },
					};
				}
				return { activeTools };
			},
			onStepFinish: ({ usage, finishReason, toolCalls }) => {
				toolCallCount += toolCalls.length;
				emitInsightsEvent("info", "generation.agent.step_finished", {
					organization_id: params.organizationId,
					website_id: params.websiteId,
					finish_reason: finishReason,
					tool_calls: toolCalls.flatMap((toolCall) =>
						toolCall ? [toolCall.toolName] : []
					),
					total_tokens: usage?.totalTokens,
					tool_call_count: toolCallCount,
					executed_tool_call_count: executedToolCallCount,
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
			const validated = await validateOrRepairInsights(result.output.insights, {
				config: params.config,
				domain: params.domain,
				
				organizationId: params.organizationId,
				websiteId: params.websiteId,
			});
			emitInsightsEvent("info", "generation.agent.completed", {
				organization_id: params.organizationId,
				website_id: params.websiteId,
				duration_ms: Math.round(performance.now() - startedAt),
				raw_output_count: result.output.insights.length,
				output_count: validated.length,
				tool_call_count: toolCallCount,
			});
			setInsightsLog({
				generation_mode: "agent",
				tool_call_count: toolCallCount,
				generated_candidate_count: validated.length,
			});
			return validated;
		}

		emitInsightsEvent("warn", "generation.agent.missing_output", {
			organization_id: params.organizationId,
			website_id: params.websiteId,
			duration_ms: Math.round(performance.now() - startedAt),
			tool_call_count: toolCallCount,
		});
		return [];
	} catch (error) {
		captureInsightsError(error, "generation.agent.failed", {
			organization_id: params.organizationId,
			website_id: params.websiteId,
			duration_ms: Math.round(performance.now() - startedAt),
			error_type: (error as Error).constructor?.name,
		});
		return [];
	}
}

async function persistWebsiteInsights(params: {
	config: InsightGenerationConfigSnapshot;
	insights: GeneratedWebsiteInsight[];
	organizationId: string;
	period: WeekOverWeekPeriod;
	runId: string;
}): Promise<GeneratedWebsiteInsight[]> {
	const startedAt = performance.now();
	const dedupeKeyToId = await fetchInsightDedupeKeyToIdMap(
		params.organizationId,
		params.config.cooldownHours
	);
	const seenInBatch = new Set<string>();
	const finalInsights: GeneratedWebsiteInsight[] = [];
	let duplicateCandidates = 0;

	for (const insight of [...params.insights].sort(
		(a, b) => b.priority - a.priority
	)) {
		const key = dedupeKeyFor(insight);
		if (seenInBatch.has(key)) {
			duplicateCandidates += 1;
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
		emitInsightsEvent("info", "generation.persistence.skipped_empty", {
			organization_id: params.organizationId,
			run_id: params.runId,
			candidate_count: params.insights.length,
			duplicate_candidate_count: duplicateCandidates,
			dedupe_window_count: dedupeKeyToId.size,
		});
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
			rootCause: insight.rootCause ?? null,
			evidence: insight.evidence ?? null,
			investigationDepth: insight.investigationDepth ?? null,
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
					rootCause: sql.raw("excluded.root_cause"),
					evidence: sql.raw("excluded.evidence"),
					investigationDepth: sql.raw("excluded.investigation_depth"),
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
					rootCause: insight.rootCause ?? null,
					evidence: insight.evidence ?? null,
					investigationDepth: insight.investigationDepth ?? null,
					metrics:
						insight.metrics.length > 0
							? (insight.metrics as InsightMetricRow[])
							: null,
				})
				.where(eq(analyticsInsights.id, insight.id))
		)
	);

	const persistedRows = await db
		.select({
			dedupeKey: analyticsInsights.dedupeKey,
			id: analyticsInsights.id,
		})
		.from(analyticsInsights)
		.where(
			and(
				eq(analyticsInsights.organizationId, params.organizationId),
				inArray(
					analyticsInsights.dedupeKey,
					finalInsights.map((insight) => dedupeKeyFor(insight))
				)
			)
		);
	const persistedIdByDedupeKey = new Map(
		persistedRows.flatMap((row) =>
			row.dedupeKey ? [[row.dedupeKey, row.id] as const] : []
		)
	);
	const persistedInsights = finalInsights.map((insight) => {
		const persistedId = persistedIdByDedupeKey.get(dedupeKeyFor(insight));
		return persistedId ? { ...insight, id: persistedId } : insight;
	});

	const websiteInvalidations = [
		...new Set(persistedInsights.map((insight) => insight.websiteId)),
	].map((websiteId) => invalidateAgentContextSnapshotsForWebsite(websiteId));

	await Promise.all([
		invalidateInsightsCachesForOrganization(params.organizationId),
		...websiteInvalidations,
	]);

	emitInsightsEvent("info", "generation.persistence.completed", {
		organization_id: params.organizationId,
		run_id: params.runId,
		duration_ms: Math.round(performance.now() - startedAt),
		result_count: persistedInsights.length,
		insert_count: toInsert.length,
		refresh_count: toRefresh.length,
		invalidated_website_count: websiteInvalidations.length,
	});

	return persistedInsights;
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
	)
		.then(() => {
			emitInsightsEvent("info", "generation.summary_stored", {
				website_id: site.id,
				insight_count: insights.length,
			});
		})
		.catch((error: unknown) => {
			captureInsightsError(error, "generation.summary_store_failed", {
				website_id: site.id,
			});
		});
}

export async function generateWebsiteInsights(
	input: GenerateWebsiteInsightsInput
): Promise<GenerateWebsiteInsightsResult> {
	const startedAt = performance.now();
	const [site] = await db
		.select({
			id: websites.id,
			name: websites.name,
			domain: websites.domain,
			integrations: websites.integrations,
		})
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
		emitInsightsEvent("warn", "generation.website.skipped_missing_site", {
			organization_id: input.organizationId,
			website_id: input.websiteId,
			run_id: input.runId,
			duration_ms: Math.round(performance.now() - startedAt),
		});
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
	setInsightsLog({
		organization_site_count: orgSites.length,
	});

	const period = getComparisonPeriod(input.config.lookbackDays);
	const userId = input.requestedByUserId ?? "insights-worker";
	const ghIntegration = site.integrations?.github as
		| { owner: string; repo: string }
		| undefined;

	const insights = await analyzeWebsite({
		config: input.config,
		domain: site.domain,
		githubRepo: ghIntegration,
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

	emitInsightsEvent("info", "generation.website.completed", {
		organization_id: input.organizationId,
		website_id: input.websiteId,
		run_id: input.runId,
		duration_ms: Math.round(performance.now() - startedAt),
		result_count: saved.length,
		reason: input.reason,
		depth: input.config.depth,
		model_tier: input.config.modelTier,
		allowed_tools: input.config.allowedTools,
	});
	setInsightsLog({
		generation_result_count: saved.length,
		generation_status: saved.length > 0 ? "succeeded" : "skipped",
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
