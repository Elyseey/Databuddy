import { tool } from "ai";
import { z } from "zod";
import { summarizeDigestConfig } from "./digest-summary";
import { callRPCProcedure, createToolLogger, getAppContext } from "./utils";

const logger = createToolLogger("Insight Digest Tools");

const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,}$/i;

const digestFrequencySchema = z.enum(["hourly", "daily", "weekly"]);

const manageDigestInputSchema = z.object({
	action: z
		.enum(["status", "preview", "route", "unroute"])
		.describe(
			"status: read current routing (safe, no confirmation). preview: show the most recent past digest run for this scope (no mutation). route: start posting digests to a Slack channel. unroute: stop posting to a Slack channel."
		),
	channelId: z
		.string()
		.min(1)
		.max(120)
		.optional()
		.describe(
			"Slack channel ID like 'C082WC4PPGS'. Required for route and unroute. For the current channel use slack_channel_id from context. Not a channel name (do not pass '#general')."
		),
	frequency: digestFrequencySchema
		.optional()
		.describe(
			"Cadence for a new route (hourly, daily, weekly). Ignored for status, preview, unroute."
		),
	websiteId: z
		.string()
		.optional()
		.describe(
			"Scope to one website. Omit to apply to the whole organization."
		),
	confirmed: z
		.boolean()
		.describe(
			"Required for route and unroute. Always call with confirmed=false first to preview the change; only set confirmed=true after the user has explicitly said yes. Ignored for status and preview."
		),
});

type DigestAction = z.infer<typeof manageDigestInputSchema>["action"];

function scopeLabel(websiteId: string | undefined): string {
	return websiteId ? "this website" : "this organization";
}

function channelMention(channelId: string): string {
	return `<#${channelId}>`;
}

function describeChannels(channels: string[]): string {
	if (channels.length === 0) {
		return "no Slack channels";
	}
	if (channels.length === 1) {
		return channelMention(channels[0] as string);
	}
	return `${channels.length} Slack channels (${channels.map(channelMention).join(", ")})`;
}

function invalidChannelIdError(channelId: string, action: DigestAction) {
	return {
		success: false,
		code: "INVALID_CHANNEL_ID",
		message: `"${channelId}" doesn't look like a Slack channel ID. Channel IDs start with C, G, or D followed by uppercase letters and digits (for example C082WC4PPGS). For the current channel use slack_channel_id from context. Refusing to ${action}.`,
	} as const;
}

function missingChannelIdError(action: DigestAction) {
	return {
		success: false,
		code: "MISSING_CHANNEL_ID",
		message: `channelId is required to ${action} a digest. Provide a Slack channel ID like C082WC4PPGS, or use slack_channel_id from context for the current channel.`,
	} as const;
}

function missingOrganizationError(action: DigestAction) {
	return {
		success: false,
		code: "NO_ORGANIZATION",
		message: `Cannot ${action} a digest without an organization in context. Identify the organization first.`,
	} as const;
}

function rpcFailure(action: DigestAction, error: unknown) {
	const message =
		error instanceof Error
			? error.message
			: `Failed to ${action} insight digest.`;
	return {
		success: false,
		code: "RPC_FAILED",
		message,
	} as const;
}

interface RawRun {
	createdAt?: string | Date | null;
	id?: string;
	status?: string;
	summary?: string | null;
	websiteId?: string | null;
}

interface RawRunItem {
	body?: string | null;
	severity?: string | null;
	title?: string | null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asIsoDate(value: unknown): string | null {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return asString(value);
}

export function createInsightDigestTools() {
	const manageInsightDigestTool = tool({
		description:
			"Inspect, preview, or change Slack delivery of the analytics insight digest. action=status reads current routing (safe). action=preview shows the most recent past digest run for this scope. action=route starts posting digests to a Slack channel. action=unroute stops posting. For route and unroute, call once with confirmed=false to preview, wait for the user to explicitly confirm, then call again with confirmed=true. Quote `current`, `applied`, and `preview` blocks from the result verbatim — never invent dates, cadences, or channel names; the tool result is the source of truth. Render every channel ID as <#CHANNELID>.",
		inputSchema: manageDigestInputSchema,
		execute: async (
			{ action, channelId, frequency, websiteId, confirmed },
			options
		) => {
			const context = getAppContext(options);
			if (!context.organizationId) {
				return missingOrganizationError(action);
			}

			const scopeInput = {
				organizationId: context.organizationId,
				websiteId: websiteId ?? undefined,
			};
			const scope = scopeLabel(websiteId);

			if (action === "status") {
				try {
					const config = await callRPCProcedure(
						"insightGeneration",
						"getConfig",
						scopeInput,
						context
					);
					const summary = summarizeDigestConfig(config);
					const current = {
						scope: websiteId ? "website" : "organization",
						scopeLabel: scope,
						cadence: summary.frequency,
						channels: summary.channels.map(channelMention),
						channelIds: summary.channels,
						source: summary.scope,
						nextRunAt: summary.nextRunAt,
					};
					return {
						success: true,
						action: "status" as const,
						current,
						message:
							summary.channels.length > 0
								? `${scope} sends digests to ${describeChannels(summary.channels)} on a ${summary.frequency} cadence.`
								: `No Slack digest delivery is configured for ${scope}. Investigations still run on a ${summary.frequency} cadence at the ${summary.scope} level.`,
					};
				} catch (error) {
					logger.error("Failed to read insight digest config", {
						websiteId,
						error,
					});
					return rpcFailure(action, error);
				}
			}

			if (action === "preview") {
				try {
					const listResult = (await callRPCProcedure(
						"insightGeneration",
						"listRuns",
						{ limit: 1, organizationId: context.organizationId },
						context
					)) as { runs?: RawRun[] };
					const latest = listResult.runs?.[0];
					if (!latest?.id) {
						return {
							success: true,
							action: "preview" as const,
							preview: { runs: 0 },
							message: `No past digest runs to preview for ${scope} yet. Once the first digest runs you can call action=preview to see it.`,
						};
					}

					const runDetail = (await callRPCProcedure(
						"insightGeneration",
						"getRun",
						{ runId: latest.id },
						context
					)) as { items?: RawRunItem[]; run?: RawRun };

					const items = (runDetail.items ?? []).map((item) => ({
						title: asString(item.title) ?? "Untitled insight",
						body: asString(item.body),
						severity: asString(item.severity),
					}));

					return {
						success: true,
						action: "preview" as const,
						preview: {
							runId: latest.id,
							runAt: asIsoDate(latest.createdAt),
							status: asString(latest.status),
							summary: asString(latest.summary),
							items,
							runs: 1,
						},
						message:
							items.length > 0
								? `Most recent digest for ${scope} had ${items.length} insight${items.length === 1 ? "" : "s"}.`
								: `Most recent digest for ${scope} produced no insights.`,
					};
				} catch (error) {
					logger.error("Failed to preview insight digest", {
						websiteId,
						error,
					});
					return rpcFailure(action, error);
				}
			}

			if (!channelId) {
				return missingChannelIdError(action);
			}
			if (!SLACK_CHANNEL_ID_RE.test(channelId)) {
				return invalidChannelIdError(channelId, action);
			}

			let cadenceWas: string | null = null;
			if (action === "route") {
				try {
					const existing = await callRPCProcedure(
						"insightGeneration",
						"getConfig",
						scopeInput,
						context
					);
					cadenceWas = summarizeDigestConfig(existing).frequency;
				} catch (error) {
					logger.error("Failed to read digest config for cadence diff", {
						websiteId,
						error,
					});
				}
			}

			if (!confirmed) {
				const cadenceLine =
					action === "route" && frequency && cadenceWas && cadenceWas !== frequency
						? ` Cadence change: ${cadenceWas} -> ${frequency}.`
						: "";
				return {
					preview: true,
					confirmationRequired: true,
					proposed: {
						action,
						scope: websiteId ? "website" : "organization",
						scopeLabel: scope,
						channel: channelMention(channelId),
						channelId,
						frequency: frequency ?? null,
						cadenceWas,
					},
					message:
						action === "route"
							? `Route insight digests for ${scope} to ${channelMention(channelId)}${frequency ? ` on a ${frequency} cadence` : ""}.${cadenceLine} Reply to confirm.`
							: `Stop routing insight digests for ${scope} to ${channelMention(channelId)}. Reply to confirm.`,
					instruction:
						"Wait for the user to explicitly confirm before calling this tool again with confirmed=true.",
				};
			}

			try {
				if (action === "unroute") {
					const config = await callRPCProcedure(
						"insightGeneration",
						"removeSlackDelivery",
						{ ...scopeInput, channelId },
						context
					);
					const summary = summarizeDigestConfig(config);
					return {
						success: true,
						action: "unroute" as const,
						applied: {
							scope: websiteId ? "website" : "organization",
							scopeLabel: scope,
							channel: channelMention(channelId),
							channelId,
							cadence: summary.frequency,
							channelsRemaining: summary.channels.map(channelMention),
							nextRunAt: summary.nextRunAt,
						},
						message: `Stopped routing insight digests to ${channelMention(channelId)}.`,
					};
				}

				const config = await callRPCProcedure(
					"insightGeneration",
					"addSlackDelivery",
					{ ...scopeInput, channelId, frequency },
					context
				);
				const summary = summarizeDigestConfig(config);
				return {
					success: true,
					action: "route" as const,
					applied: {
						scope: websiteId ? "website" : "organization",
						scopeLabel: scope,
						channel: channelMention(channelId),
						channelId,
						cadence: summary.frequency,
						cadenceWas,
						cadenceChanged: cadenceWas !== null && cadenceWas !== summary.frequency,
						nextRunAt: summary.nextRunAt,
					},
					message: `Routed insight digests to ${channelMention(channelId)} on a ${summary.frequency} cadence.`,
				};
			} catch (error) {
				logger.error("Failed to manage insight digest", {
					action,
					websiteId,
					channelId,
					error,
				});
				return rpcFailure(action, error);
			}
		},
	});

	return { manage_insight_digest: manageInsightDigestTool } as const;
}
