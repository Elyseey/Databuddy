import { and, db, desc, eq, inArray, isNull } from "@databuddy/db";
import {
	insightGenerationConfigs,
	insightRunItems,
	insightRuns,
	type InsightGenerationConfig,
	type InsightGenerationConfigSnapshot,
	websites,
} from "@databuddy/db/schema";
import {
	getInsightsQueue,
	INSIGHTS_GENERATE_WEBSITE_JOB_NAME,
	insightsWebsiteJobId,
	type InsightGenerationReason,
} from "@databuddy/redis";
import { randomUUIDv7 } from "bun";
import { z } from "zod";
import { rpcError } from "../errors";
import { type Context, protectedProcedure } from "../orpc";
import { withWorkspace } from "../procedures/with-workspace";
import { getNextInsightRunAt } from "../services/insight-schedule";

const generationToolSchema = z.enum([
	"web_metrics",
	"product_metrics",
	"ops_context",
	"business_context",
]);
const depthSchema = z.enum(["light", "standard", "deep"]);
const frequencySchema = z.enum(["hourly", "daily", "weekly", "custom"]);
const modelTierSchema = z.enum(["fast", "balanced", "deep"]);
const reasonSchema = z.enum(["manual", "scheduled", "cooldown_refresh"]);

const configPatchSchema = z.object({
	allowedTools: z.array(generationToolSchema).min(1).max(4).optional(),
	cooldownHours: z.number().int().min(1).max(168).optional(),
	cron: z.string().min(1).max(120).nullable().optional(),
	depth: depthSchema.optional(),
	enabled: z.boolean().optional(),
	frequency: frequencySchema.optional(),
	lookbackDays: z.number().int().min(1).max(90).optional(),
	maxInsightsPerWebsite: z.number().int().min(1).max(10).optional(),
	maxSteps: z.number().int().min(1).max(64).optional(),
	maxToolCalls: z.number().int().min(1).max(64).optional(),
	modelTier: modelTierSchema.optional(),
	timezone: z.string().min(1).max(80).optional(),
});

const configOutputSchema = z.object({
	allowedTools: z.array(generationToolSchema),
	cooldownHours: z.number(),
	createdAt: z.union([z.date(), z.string()]).nullable(),
	cron: z.string().nullable(),
	depth: depthSchema,
	enabled: z.boolean(),
	frequency: frequencySchema,
	id: z.string().nullable(),
	lastRunAt: z.union([z.date(), z.string()]).nullable(),
	lookbackDays: z.number(),
	maxInsightsPerWebsite: z.number(),
	maxSteps: z.number(),
	maxToolCalls: z.number(),
	modelTier: modelTierSchema,
	nextRunAt: z.union([z.date(), z.string()]).nullable(),
	organizationId: z.string(),
	source: z.enum(["default", "organization", "website"]),
	timezone: z.string(),
	updatedAt: z.union([z.date(), z.string()]).nullable(),
	websiteId: z.string().nullable(),
});

const runOutputSchema = z.object({
	completedItems: z.number(),
	createdAt: z.union([z.date(), z.string()]),
	errorMessage: z.string().nullable(),
	failedItems: z.number(),
	finishedAt: z.union([z.date(), z.string()]).nullable(),
	id: z.string(),
	organizationId: z.string(),
	reason: reasonSchema,
	requestedByUserId: z.string().nullable(),
	skippedItems: z.number(),
	startedAt: z.union([z.date(), z.string()]).nullable(),
	status: z.enum([
		"queued",
		"running",
		"succeeded",
		"partially_succeeded",
		"failed",
		"skipped",
	]),
	timezone: z.string(),
	totalItems: z.number(),
	updatedAt: z.union([z.date(), z.string()]),
});

const runItemOutputSchema = z.object({
	attempts: z.number(),
	configSnapshot: z.unknown(),
	createdAt: z.union([z.date(), z.string()]),
	errorMessage: z.string().nullable(),
	finishedAt: z.union([z.date(), z.string()]).nullable(),
	id: z.string(),
	queueJobId: z.string().nullable(),
	resultCount: z.number(),
	runId: z.string(),
	startedAt: z.union([z.date(), z.string()]).nullable(),
	status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
	updatedAt: z.union([z.date(), z.string()]),
	websiteId: z.string(),
});

const DEFAULT_CONFIG: Omit<
	z.infer<typeof configOutputSchema>,
	| "createdAt"
	| "id"
	| "lastRunAt"
	| "nextRunAt"
	| "organizationId"
	| "source"
	| "updatedAt"
	| "websiteId"
> = {
	allowedTools: ["web_metrics", "product_metrics", "ops_context"],
	cooldownHours: 6,
	cron: null,
	depth: "standard",
	enabled: true,
	frequency: "weekly",
	lookbackDays: 7,
	maxInsightsPerWebsite: 3,
	maxSteps: 24,
	maxToolCalls: 16,
	modelTier: "balanced",
	timezone: "UTC",
};

type InsightGenerationConfigPatch = z.infer<typeof configPatchSchema>;
export interface QueueInsightGenerationRunInput
	extends InsightGenerationConfigPatch {
	force?: boolean;
	organizationId: string;
	reason?: z.infer<typeof reasonSchema>;
	requestedByUserId?: string | null;
	websiteIds?: string[];
}

export interface QueueInsightGenerationRunResult {
	queuedItems: number;
	runId: string;
	status: "queued" | "skipped";
}

function rowToConfig(
	row: InsightGenerationConfig | null,
	fallback: z.infer<typeof configOutputSchema>,
	source: "default" | "organization" | "website"
): z.infer<typeof configOutputSchema> {
	if (!row) {
		return { ...fallback, source };
	}

	return {
		allowedTools: row.allowedTools,
		cooldownHours: row.cooldownHours,
		createdAt: row.createdAt,
		cron: row.cron,
		depth: row.depth,
		enabled: row.enabled,
		frequency: row.frequency,
		id: row.id,
		lastRunAt: row.lastRunAt,
		lookbackDays: row.lookbackDays,
		maxInsightsPerWebsite: row.maxInsightsPerWebsite,
		maxSteps: row.maxSteps,
		maxToolCalls: row.maxToolCalls,
		modelTier: row.modelTier,
		nextRunAt: row.nextRunAt,
		organizationId: row.organizationId,
		source,
		timezone: row.timezone,
		updatedAt: row.updatedAt,
		websiteId: row.websiteId,
	};
}

function defaultConfig(
	organizationId: string,
	websiteId: string | null
): z.infer<typeof configOutputSchema> {
	return {
		...DEFAULT_CONFIG,
		createdAt: null,
		id: null,
		lastRunAt: null,
		nextRunAt: null,
		organizationId,
		source: "default",
		updatedAt: null,
		websiteId,
	};
}

function toSnapshot(
	config: z.infer<typeof configOutputSchema>
): InsightGenerationConfigSnapshot {
	return {
		allowedTools: config.allowedTools,
		cooldownHours: config.cooldownHours,
		depth: config.depth,
		lookbackDays: config.lookbackDays,
		maxInsightsPerWebsite: config.maxInsightsPerWebsite,
		maxSteps: config.maxSteps,
		maxToolCalls: config.maxToolCalls,
		modelTier: config.modelTier,
		timezone: config.timezone,
	};
}

function applyPatch(
	config: z.infer<typeof configOutputSchema>,
	patch: z.infer<typeof configPatchSchema>
): z.infer<typeof configOutputSchema> {
	const next = {
		...config,
		...patch,
		cron: patch.cron === undefined ? config.cron : patch.cron,
	};
	if (next.frequency === "custom" && !next.cron) {
		throw rpcError.badRequest("Custom frequency requires a cron expression");
	}
	if (next.frequency !== "custom") {
		next.cron = null;
	}
	return next;
}

async function resolveScope(
	context: Context,
	input: { organizationId?: string | null; websiteId?: string | null },
	permission: "read" | "update"
): Promise<{ organizationId: string; websiteId: string | null }> {
	if (input.websiteId) {
		const workspace = await withWorkspace(context, {
			websiteId: input.websiteId,
			resource: "website",
			permissions: [permission === "read" ? "view_analytics" : "update"],
		});
		if (
			input.organizationId &&
			input.organizationId !== workspace.website.organizationId
		) {
			throw rpcError.badRequest("Website does not belong to organization");
		}
		return {
			organizationId: workspace.website.organizationId,
			websiteId: input.websiteId,
		};
	}

	const organizationId = input.organizationId?.trim() || context.organizationId;
	if (!organizationId) {
		throw rpcError.badRequest("Organization ID is required");
	}
	await withWorkspace(context, {
		organizationId,
		resource: "organization",
		permissions: [permission],
	});
	return { organizationId, websiteId: null };
}

async function findConfig(
	organizationId: string,
	websiteId: string | null
): Promise<InsightGenerationConfig | null> {
	const rows = await db
		.select()
		.from(insightGenerationConfigs)
		.where(
			websiteId
				? and(
						eq(insightGenerationConfigs.organizationId, organizationId),
						eq(insightGenerationConfigs.websiteId, websiteId)
					)
				: and(
						eq(insightGenerationConfigs.organizationId, organizationId),
						isNull(insightGenerationConfigs.websiteId)
					)
		)
		.limit(1);
	return rows[0] ?? null;
}

async function getEffectiveConfig(
	organizationId: string,
	websiteId: string | null
): Promise<z.infer<typeof configOutputSchema>> {
	const fallback = defaultConfig(organizationId, websiteId);
	const orgConfig = await findConfig(organizationId, null);
	const orgEffective = rowToConfig(
		orgConfig,
		fallback,
		orgConfig ? "organization" : "default"
	);
	if (!websiteId) {
		return orgEffective;
	}

	const websiteConfig = await findConfig(organizationId, websiteId);
	return rowToConfig(
		websiteConfig,
		orgEffective,
		websiteConfig ? "website" : orgEffective.source
	);
}

async function listTargetWebsites(
	organizationId: string,
	websiteIds: string[] | undefined
): Promise<Array<{ id: string }>> {
	const conditions = [
		eq(websites.organizationId, organizationId),
		isNull(websites.deletedAt),
	];
	if (websiteIds?.length) {
		conditions.push(inArray(websites.id, websiteIds));
	}

	const rows = await db
		.select({ id: websites.id })
		.from(websites)
		.where(and(...conditions));

	if (websiteIds?.length && rows.length !== new Set(websiteIds).size) {
		throw rpcError.badRequest(
			"One or more websites are not in this organization"
		);
	}

	return rows;
}

export async function queueInsightGenerationRun(
	input: QueueInsightGenerationRunInput
): Promise<QueueInsightGenerationRunResult> {
	const targetWebsites = await listTargetWebsites(
		input.organizationId,
		input.websiteIds
	);
	const runId = randomUUIDv7();
	const requestedByUserId = input.requestedByUserId ?? null;
	const baseConfig = await getEffectiveConfig(input.organizationId, null);
	const runConfig = applyPatch(baseConfig, input);
	const now = new Date();
	const reason = input.reason ?? "manual";

	await db.insert(insightRuns).values({
		id: runId,
		organizationId: input.organizationId,
		requestedByUserId,
		reason,
		status: targetWebsites.length === 0 ? "skipped" : "queued",
		timezone: runConfig.timezone,
		totalItems: targetWebsites.length,
		...(targetWebsites.length === 0 ? { finishedAt: now } : {}),
	});

	if (targetWebsites.length === 0) {
		return { queuedItems: 0, runId, status: "skipped" };
	}

	const items = await Promise.all(
		targetWebsites.map(async (website) => {
			const websiteConfig = await getEffectiveConfig(
				input.organizationId,
				website.id
			);
			const config = applyPatch(websiteConfig, input);
			const itemId = randomUUIDv7();
			return {
				config: toSnapshot(config),
				itemId,
				jobId: insightsWebsiteJobId(runId, website.id),
				websiteId: website.id,
			};
		})
	);

	await db.insert(insightRunItems).values(
		items.map((item) => ({
			id: item.itemId,
			runId,
			organizationId: input.organizationId,
			websiteId: item.websiteId,
			queueJobId: item.jobId,
			configSnapshot: item.config,
		}))
	);

	try {
		const queue = getInsightsQueue();
		await Promise.all(
			items.map((item) =>
				queue.add(
					INSIGHTS_GENERATE_WEBSITE_JOB_NAME,
					{
						config: item.config,
						itemId: item.itemId,
						organizationId: input.organizationId,
						reason: reason as InsightGenerationReason,
						requestedByUserId,
						runId,
						websiteId: item.websiteId,
					},
					{ jobId: item.jobId }
				)
			)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await Promise.all([
			db
				.update(insightRuns)
				.set({
					errorMessage: message,
					failedItems: items.length,
					finishedAt: new Date(),
					status: "failed",
				})
				.where(eq(insightRuns.id, runId)),
			db
				.update(insightRunItems)
				.set({
					errorMessage: message,
					finishedAt: new Date(),
					status: "failed",
				})
				.where(eq(insightRunItems.runId, runId)),
		]);
		throw rpcError.internal("Failed to queue insight generation");
	}

	return {
		queuedItems: items.length,
		runId,
		status: "queued",
	};
}

export const insightGenerationRouter = {
	getConfig: protectedProcedure
		.route({
			method: "POST",
			path: "/insights/generation/getConfig",
			summary: "Get insight generation config",
			tags: ["Insights"],
		})
		.input(
			z.object({
				organizationId: z.string().nullish(),
				websiteId: z.string().nullish(),
			})
		)
		.output(configOutputSchema)
		.handler(async ({ context, input }) => {
			const scope = await resolveScope(context, input, "read");
			return getEffectiveConfig(scope.organizationId, scope.websiteId);
		}),

	upsertConfig: protectedProcedure
		.route({
			method: "POST",
			path: "/insights/generation/upsertConfig",
			summary: "Create or update insight generation config",
			tags: ["Insights"],
		})
		.input(
			z
				.object({
					organizationId: z.string().nullish(),
					websiteId: z.string().nullish(),
				})
				.extend(configPatchSchema.shape)
		)
		.output(configOutputSchema)
		.handler(async ({ context, input }) => {
			const scope = await resolveScope(context, input, "update");
			const current = await getEffectiveConfig(
				scope.organizationId,
				scope.websiteId
			);
			const next = applyPatch(current, input);
			const existing = await findConfig(scope.organizationId, scope.websiteId);
			const now = new Date();
			const nextRunAt = getNextInsightRunAt(next, now);

			if (existing) {
				await db
					.update(insightGenerationConfigs)
					.set({
						allowedTools: next.allowedTools,
						cooldownHours: next.cooldownHours,
						cron: next.cron,
						depth: next.depth,
						enabled: next.enabled,
						frequency: next.frequency,
						lookbackDays: next.lookbackDays,
						maxInsightsPerWebsite: next.maxInsightsPerWebsite,
						maxSteps: next.maxSteps,
						maxToolCalls: next.maxToolCalls,
						modelTier: next.modelTier,
						nextRunAt,
						timezone: next.timezone,
						updatedAt: now,
					})
					.where(eq(insightGenerationConfigs.id, existing.id));
			} else {
				await db.insert(insightGenerationConfigs).values({
					id: randomUUIDv7(),
					organizationId: scope.organizationId,
					websiteId: scope.websiteId,
					allowedTools: next.allowedTools,
					cooldownHours: next.cooldownHours,
					cron: next.cron,
					depth: next.depth,
					enabled: next.enabled,
					frequency: next.frequency,
					lookbackDays: next.lookbackDays,
					maxInsightsPerWebsite: next.maxInsightsPerWebsite,
					maxSteps: next.maxSteps,
					maxToolCalls: next.maxToolCalls,
					modelTier: next.modelTier,
					nextRunAt,
					timezone: next.timezone,
				});
			}

			return getEffectiveConfig(scope.organizationId, scope.websiteId);
		}),

	triggerRun: protectedProcedure
		.route({
			method: "POST",
			path: "/insights/generation/triggerRun",
			summary: "Queue an insight generation run",
			tags: ["Insights"],
		})
		.input(
			z
				.object({
					force: z.boolean().default(false),
					organizationId: z.string().nullish(),
					reason: reasonSchema.default("manual"),
					websiteIds: z.array(z.string().min(1)).max(100).optional(),
				})
				.extend(configPatchSchema.shape)
		)
		.output(
			z.object({
				queuedItems: z.number(),
				runId: z.string(),
				status: z.enum(["queued", "skipped"]),
			})
		)
		.handler(async ({ context, input }) => {
			const scope = await resolveScope(
				context,
				{ organizationId: input.organizationId },
				"update"
			);
			return queueInsightGenerationRun({
				...input,
				organizationId: scope.organizationId,
				requestedByUserId: context.user?.id ?? null,
			});
		}),

	getRun: protectedProcedure
		.route({
			method: "POST",
			path: "/insights/generation/getRun",
			summary: "Get insight generation run",
			tags: ["Insights"],
		})
		.input(z.object({ runId: z.string() }))
		.output(
			z.object({ items: z.array(runItemOutputSchema), run: runOutputSchema })
		)
		.handler(async ({ context, input }) => {
			const run = await db.query.insightRuns.findFirst({
				where: { id: input.runId },
			});
			if (!run) {
				throw rpcError.notFound("InsightRun", input.runId);
			}

			await withWorkspace(context, {
				organizationId: run.organizationId,
				resource: "organization",
				permissions: ["read"],
			});

			const items = await db.query.insightRunItems.findMany({
				where: { runId: input.runId },
			});

			return { items, run };
		}),

	listRuns: protectedProcedure
		.route({
			method: "POST",
			path: "/insights/generation/listRuns",
			summary: "List insight generation runs",
			tags: ["Insights"],
		})
		.input(
			z.object({
				limit: z.number().int().min(1).max(100).default(20),
				organizationId: z.string().nullish(),
			})
		)
		.output(z.object({ runs: z.array(runOutputSchema) }))
		.handler(async ({ context, input }) => {
			const scope = await resolveScope(context, input, "read");
			const runs = await db
				.select()
				.from(insightRuns)
				.where(eq(insightRuns.organizationId, scope.organizationId))
				.orderBy(desc(insightRuns.createdAt))
				.limit(input.limit);
			return { runs };
		}),
};
