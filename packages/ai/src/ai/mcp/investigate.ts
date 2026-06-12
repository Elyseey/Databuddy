import { generateObject } from "ai";
import { z } from "zod";
import { models } from "../config/models";
import { defineMcpTool, McpToolError } from "./define-tool";
import { type McpAgentToolTrace, runMcpAgentWithTrace } from "./run-agent";

const INVESTIGATION_TIMEOUT_MS = 180_000;
const SYNTHESIS_TIMEOUT_MS = 60_000;
const MAX_TRACE_INPUT_CHARS = 300;
const MAX_TRACE_OUTPUT_CHARS = 1500;

export const investigationMemoSchema = z.object({
	headline: z
		.string()
		.describe(
			"One sentence with the key numbers in it. Specific to this site, never generic."
		),
	narrative: z
		.string()
		.describe(
			"Analyst memo in markdown: what changed, why it happened, what it means. Short paragraphs, numbers inline."
		),
	causalChain: z
		.array(
			z.object({
				step: z.string().describe("One link in the cause-to-effect chain"),
				evidence: z
					.string()
					.describe("The observed data backing this link, with numbers"),
			})
		)
		.describe("Ordered cause-to-effect steps. Empty if no causal link found."),
	deadEnds: z
		.array(
			z.object({
				hypothesis: z.string(),
				ruledOutBecause: z
					.string()
					.describe("The data that ruled this hypothesis out"),
			})
		)
		.describe("Hypotheses checked and eliminated during the investigation."),
	confidence: z.object({
		level: z.enum(["high", "medium", "low"]),
		reason: z
			.string()
			.describe(
				"Why this confidence level, and what data would raise it if low"
			),
	}),
	actions: z
		.array(z.string())
		.describe("Concrete next steps ranked by impact. Empty if none warranted."),
});

export type InvestigationMemo = z.infer<typeof investigationMemoSchema>;

export interface InvestigationReceipts {
	queriesRun: { tool: string; input: string }[];
	sourcesChecked: string[];
	steps: number;
}

export function buildReceipts(
	steps: number,
	toolCalls: McpAgentToolTrace[]
): InvestigationReceipts {
	return {
		steps,
		queriesRun: toolCalls.map((call) => ({
			tool: call.name,
			input: JSON.stringify(call.input ?? {}).slice(0, MAX_TRACE_INPUT_CHARS),
		})),
		sourcesChecked: [...new Set(toolCalls.map((call) => call.name))],
	};
}

function formatUtcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function shiftDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * 86_400_000);
}

export function buildInvestigationWindow(
	lookbackDays: number,
	now: Date = new Date()
): { from: string; to: string; halves: string } {
	const to = now;
	const from = shiftDays(to, -(lookbackDays - 1));
	const halfDays = Math.floor(lookbackDays / 2);
	const secondHalfStart = shiftDays(to, -(halfDays - 1));
	const firstHalfEnd = shiftDays(secondHalfStart, -1);
	const firstHalfStart = shiftDays(firstHalfEnd, -(halfDays - 1));
	return {
		from: formatUtcDay(from),
		to: formatUtcDay(to),
		halves: `${formatUtcDay(firstHalfStart)} to ${formatUtcDay(firstHalfEnd)} vs ${formatUtcDay(secondHalfStart)} to ${formatUtcDay(to)} (${halfDays} days each)`,
	};
}

export function buildInvestigationBrief(params: {
	lookbackDays: number;
	now?: Date;
	question?: string;
	websiteDomain: string;
	websiteId: string;
}): string {
	const focus = params.question
		? `The user wants to know: "${params.question}". Anchor the investigation on this, but report anything bigger you find on the way.`
		: "No specific question was asked. Find the single most consequential change on this site and explain it.";

	const window = buildInvestigationWindow(params.lookbackDays, params.now);

	return [
		`Run a root-cause investigation on website ${params.websiteId} (${params.websiteDomain}) over the last ${params.lookbackDays} days.`,
		`Window (UTC dates, inclusive): ${window.from} to ${window.to}. For half-over-half comparisons use exactly: ${window.halves}. Note the final day is partial.`,
		focus,
		"",
		"Protocol — work through every phase, in order:",
		`1. Sweep: pull daily trends (events_by_date) for the full ${params.lookbackDays}-day window plus summary_metrics for each half as defined above. In the same sweep, check whether the site records revenue and custom events; if it does, pull their daily trends and half-over-half deltas too. Flag the largest moves.`,
		"2. Enrich: for each flagged move, break it down by page, referrer, country, and device. Pull recent errors if anything degraded. Find WHERE the change is concentrated.",
		"3. Correlate: check deploys, commits, and PRs around the inflection date. Check annotations. If the change looks search-driven, check search console. Find WHEN the cause landed relative to the effect.",
		"4. Conclude: state the causal chain with evidence for every link.",
		"",
		"Rules:",
		"- Money outranks traffic. If the site has revenue or conversion-funnel custom events (checkouts, payments, subscriptions), investigate changes there first and denominate impact in revenue or conversions; pageviews are the proxy of last resort.",
		"- Every claim needs a number from a query you actually ran.",
		"- Compare equal-length periods only. If the window splits unevenly, trim a day or quote per-day rates; never headline a raw total from an 8-day window against a 7-day one.",
		"- Quantify how much of the total change each cause explains (e.g. 'X accounts for 63 of the 230 lost visitors'). Say plainly what share remains unexplained.",
		"- Report hypotheses you ruled out and what ruled them out.",
		"- If you cannot establish a cause, say exactly what you eliminated and what data would settle it. Never hand-wave.",
		"- Timing beats correlation: an effect that starts before its supposed cause is a dead end.",
		"- If a data source errors or is not connected, name it as a gap in your findings; do not silently work around it.",
	].join("\n");
}

export function renderMemoMarkdown(
	memo: InvestigationMemo,
	receipts: InvestigationReceipts
): string {
	const sections = [`# ${memo.headline}`, "", memo.narrative];

	if (memo.causalChain.length > 0) {
		sections.push(
			"",
			"## Causal chain",
			...memo.causalChain.map(
				(link, i) => `${i + 1}. ${link.step}\n   - evidence: ${link.evidence}`
			)
		);
	}

	if (memo.deadEnds.length > 0) {
		sections.push(
			"",
			"## Ruled out",
			...memo.deadEnds.map(
				(deadEnd) => `- ${deadEnd.hypothesis}: ${deadEnd.ruledOutBecause}`
			)
		);
	}

	sections.push(
		"",
		`## Confidence: ${memo.confidence.level}`,
		memo.confidence.reason
	);

	if (memo.actions.length > 0) {
		sections.push(
			"",
			"## Do next",
			...memo.actions.map((action, i) => `${i + 1}. ${action}`)
		);
	}

	sections.push(
		"",
		"## Receipts",
		`${receipts.steps} agent steps, ${receipts.queriesRun.length} tool calls: ${receipts.sourcesChecked.join(", ")}`
	);

	return sections.join("\n");
}

function compactTrace(toolCalls: McpAgentToolTrace[]): string {
	return toolCalls
		.map((call) => {
			const input = JSON.stringify(call.input ?? {}).slice(
				0,
				MAX_TRACE_INPUT_CHARS
			);
			const output = JSON.stringify(call.output ?? null).slice(
				0,
				MAX_TRACE_OUTPUT_CHARS
			);
			return `[${call.index}] ${call.name}(${input}) => ${output}`;
		})
		.join("\n");
}

const MEMO_SYNTHESIS_SYSTEM = [
	"You turn a completed analytics investigation into a structured memo.",
	"Use ONLY facts present in the investigation findings and tool trace. Never invent numbers, dates, commits, or causes.",
	"The headline must contain the most important number. Generic headlines ('Traffic changed recently') are failures.",
	"Headline numbers must compare equal-length periods; prefer per-day rates when the underlying windows differ in length.",
	"causalChain steps must each cite evidence that appears in the trace. If the investigation found no cause, leave causalChain empty and say what was ruled out.",
	"Set confidence honestly: high only when cause, mechanism, and timing all check out AND the causal chain accounts for the majority of the observed change. If most of the change is unexplained, confidence is medium at best and the narrative must say what share remains unexplained.",
].join(" ");

export interface RunInvestigationParams {
	apiKey: Parameters<typeof runMcpAgentWithTrace>[0]["apiKey"];
	billingMode?: Parameters<typeof runMcpAgentWithTrace>[0]["billingMode"];
	lookbackDays: number;
	question?: string;
	requestHeaders: Headers;
	timezone?: string;
	userId: string | null;
	websiteDomain: string;
	websiteId: string;
}

export interface InvestigationResult {
	markdown: string;
	memo: InvestigationMemo;
	receipts: InvestigationReceipts;
}

export async function runInvestigation(
	params: RunInvestigationParams
): Promise<InvestigationResult> {
	const brief = buildInvestigationBrief(params);

	const trace = await runMcpAgentWithTrace({
		question: brief,
		requestHeaders: params.requestHeaders,
		apiKey: params.apiKey,
		userId: params.userId,
		websiteId: params.websiteId,
		websiteDomain: params.websiteDomain,
		timezone: params.timezone,
		billingMode: params.billingMode,
		mutationMode: "dry-run",
		storeMemory: false,
		timeoutMs: INVESTIGATION_TIMEOUT_MS,
	});

	const receipts = buildReceipts(trace.steps, trace.toolCalls);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS);
	try {
		const { object: memo } = await generateObject({
			abortSignal: controller.signal,
			model: models.balanced,
			schema: investigationMemoSchema,
			system: MEMO_SYNTHESIS_SYSTEM,
			prompt: [
				"Investigation findings:",
				trace.answer,
				"",
				"Tool trace (what was actually queried and returned):",
				compactTrace(trace.toolCalls),
			].join("\n"),
		});

		return {
			memo,
			receipts,
			markdown: renderMemoMarkdown(memo, receipts),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export const investigateTool = defineMcpTool(
	{
		name: "investigate",
		description:
			"Deep root-cause investigation for one website: anomaly sweep, segment enrichment, deploy/commit correlation. Returns a memo with causal chain, dead ends, confidence, and receipts. Expensive (~1-2 min); use for 'why did X change?'",
		inputSchema: z.object({
			websiteId: z.string().optional(),
			websiteName: z.string().optional(),
			websiteDomain: z.string().optional(),
			question: z
				.string()
				.min(1)
				.max(2000)
				.optional()
				.describe(
					"Optional steering question, e.g. 'why did signups drop last week?'. Omit to find the most consequential change."
				),
			lookbackDays: z.number().int().min(7).max(60).optional().default(30),
			timezone: z
				.string()
				.optional()
				.describe("IANA timezone (e.g. 'America/New_York'). Defaults to UTC."),
		}),
		outputSchema: z.object({
			memo: investigationMemoSchema,
			receipts: z.object({
				steps: z.number(),
				queriesRun: z.array(z.object({ tool: z.string(), input: z.string() })),
				sourcesChecked: z.array(z.string()),
			}),
			markdown: z.string(),
		}),
		resolveWebsite: true,
		ratelimit: { limit: 3, windowSec: 300 },
		metadata: { evlogAction: "investigation_completed" },
	},
	async (input, ctx) => {
		try {
			return await runInvestigation({
				apiKey: ctx.apiKey,
				userId: ctx.userId,
				requestHeaders: ctx.requestHeaders,
				websiteId: ctx.websiteId as string,
				websiteDomain: ctx.websiteDomain ?? "unknown",
				question: input.question,
				lookbackDays: input.lookbackDays,
				timezone: input.timezone,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new McpToolError(
					"upstream_timeout",
					"Investigation timed out. Try a narrower question or a shorter lookbackDays.",
					{
						hint: "Investigations run a multi-step agent and can take 1-2 minutes.",
					}
				);
			}
			throw err;
		}
	}
);
