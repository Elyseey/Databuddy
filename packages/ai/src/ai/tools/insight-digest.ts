import { tool } from "ai";
import { z } from "zod";
import { summarizeDigestConfig } from "./digest-summary";
import { callRPCProcedure, createToolLogger, getAppContext } from "./utils";

const logger = createToolLogger("Insight Digest Tools");

const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{8,}$/i;

const digestFrequencySchema = z.enum(["hourly", "daily", "weekly"]);

const manageDigestInputSchema = z.object({
	action: z
		.enum(["route", "unroute", "status"])
		.describe(
			"status: read current routing (safe, no confirmation). route: start posting digests to a Slack channel. unroute: stop posting to a Slack channel."
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
			"Cadence for investigations on a new route (hourly, daily, weekly). Ignored for status and unroute."
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
			"Required for route and unroute. Always call with confirmed=false first to preview; only set confirmed=true after the user has explicitly said yes. Ignored for status."
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

export function createInsightDigestTools() {
	const manageInsightDigestTool = tool({
		description:
			"Inspect or change Slack delivery of the analytics insight digest. action=status reads current routing (safe, no confirmation needed). action=route starts posting digests to a Slack channel. action=unroute stops posting to a Slack channel. For route and unroute, call once with confirmed=false to preview, wait for the user to explicitly confirm, then call again with confirmed=true. Investigations run on their own schedule regardless of routing - this only controls where the digest is posted.",
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
					return {
						success: true,
						scope,
						message:
							summary.channels.length > 0
								? `${scope} sends digests to ${describeChannels(summary.channels)} on a ${summary.frequency} cadence.`
								: `No Slack digest delivery is configured for ${scope}.`,
						digest: summary,
					};
				} catch (error) {
					logger.error("Failed to read insight digest config", {
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

			if (!confirmed) {
				return {
					preview: true,
					confirmationRequired: true,
					message:
						action === "route"
							? `Route insight digests for ${scope} to ${channelMention(channelId)}${frequency ? ` on a ${frequency} cadence` : ""}? Reply to confirm.`
							: `Stop routing insight digests for ${scope} to ${channelMention(channelId)}? Reply to confirm.`,
					digest: {
						action,
						channelId,
						frequency: frequency ?? null,
						scope: websiteId ? "website" : "organization",
					},
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
					return {
						success: true,
						message: `Stopped routing insight digests to ${channelMention(channelId)}.`,
						digest: summarizeDigestConfig(config),
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
					message: `Insight digests will be delivered to ${channelMention(channelId)} on a ${summary.frequency} cadence.`,
					digest: summary,
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
