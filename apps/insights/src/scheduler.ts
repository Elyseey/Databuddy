import { and, asc, db, eq, isNotNull, isNull, lte } from "@databuddy/db";
import {
	insightGenerationConfigs,
	websites,
	type InsightGenerationFrequency,
} from "@databuddy/db/schema";
import { queueInsightGenerationRun } from "@databuddy/rpc/insight-generation";
import { getNextInsightRunAt } from "@databuddy/rpc/insight-schedule";
import {
	getInsightsQueue,
	INSIGHTS_DISPATCH_JOB_NAME,
	INSIGHTS_MAINTENANCE_JOB_NAME,
	type InsightGenerationReason,
} from "@databuddy/redis";
import { log } from "evlog";
import { getInsightsMaintenanceIntervalMs } from "./recovery";

const DEFAULT_DISPATCH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_DISPATCH_INTERVAL_MS = 60 * 1000;
const MAX_DUE_CONFIGS_PER_TICK = 100;
const FAILED_DISPATCH_RETRY_MS = 60 * 1000;

type DueConfig = typeof insightGenerationConfigs.$inferSelect;

export interface DispatchDueInsightRunsResult {
	claimedConfigs: number;
	dispatchedRuns: number;
	queuedItems: number;
	scannedConfigs: number;
	skippedConfigs: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dispatchIntervalMs(): number {
	const raw = process.env.INSIGHTS_DISPATCH_INTERVAL_MS;
	if (!raw) {
		return DEFAULT_DISPATCH_INTERVAL_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed < MIN_DISPATCH_INTERVAL_MS) {
		return DEFAULT_DISPATCH_INTERVAL_MS;
	}
	return parsed;
}

function nextRunAtFor(config: DueConfig, from: Date): Date | null {
	return getNextInsightRunAt(
		{
			cron: config.cron,
			enabled: config.enabled,
			frequency: config.frequency as InsightGenerationFrequency,
		},
		from
	);
}

async function dueConfigs(now: Date): Promise<DueConfig[]> {
	return await db
		.select()
		.from(insightGenerationConfigs)
		.where(
			and(
				eq(insightGenerationConfigs.enabled, true),
				lte(insightGenerationConfigs.nextRunAt, now)
			)
		)
		.orderBy(asc(insightGenerationConfigs.nextRunAt))
		.limit(MAX_DUE_CONFIGS_PER_TICK);
}

async function claimConfig(
	config: DueConfig,
	now: Date
): Promise<DueConfig | null> {
	const [claimed] = await db
		.update(insightGenerationConfigs)
		.set({
			nextRunAt: nextRunAtFor(config, now),
			updatedAt: now,
		})
		.where(
			and(
				eq(insightGenerationConfigs.id, config.id),
				eq(insightGenerationConfigs.enabled, true),
				lte(insightGenerationConfigs.nextRunAt, now)
			)
		)
		.returning();

	return claimed ?? null;
}

async function markConfigDispatched(
	configId: string,
	now: Date
): Promise<void> {
	await db
		.update(insightGenerationConfigs)
		.set({ lastRunAt: now, updatedAt: now })
		.where(eq(insightGenerationConfigs.id, configId));
}

async function retryConfigSoon(configId: string, now: Date): Promise<void> {
	await db
		.update(insightGenerationConfigs)
		.set({
			nextRunAt: new Date(now.getTime() + FAILED_DISPATCH_RETRY_MS),
			updatedAt: now,
		})
		.where(eq(insightGenerationConfigs.id, configId));
}

async function websiteIdsWithOverrides(
	organizationId: string
): Promise<Set<string>> {
	const rows = await db
		.select({ websiteId: insightGenerationConfigs.websiteId })
		.from(insightGenerationConfigs)
		.where(
			and(
				eq(insightGenerationConfigs.organizationId, organizationId),
				isNotNull(insightGenerationConfigs.websiteId)
			)
		);

	const ids = new Set<string>();
	for (const row of rows) {
		if (row.websiteId) {
			ids.add(row.websiteId);
		}
	}
	return ids;
}

async function orgScheduledWebsiteIds(
	organizationId: string
): Promise<string[]> {
	const overrideIds = await websiteIdsWithOverrides(organizationId);
	const rows = await db
		.select({ id: websites.id })
		.from(websites)
		.where(
			and(
				eq(websites.organizationId, organizationId),
				isNull(websites.deletedAt)
			)
		)
		.orderBy(asc(websites.createdAt));

	return rows
		.map((row) => row.id)
		.filter((websiteId) => !overrideIds.has(websiteId));
}

async function targetWebsiteIds(config: DueConfig): Promise<string[]> {
	if (config.websiteId) {
		return [config.websiteId];
	}
	return await orgScheduledWebsiteIds(config.organizationId);
}

export async function ensureInsightsDispatchSchedule(): Promise<void> {
	const intervalMs = dispatchIntervalMs();
	await getInsightsQueue().upsertJobScheduler(
		INSIGHTS_DISPATCH_JOB_NAME,
		{ every: intervalMs },
		{
			name: INSIGHTS_DISPATCH_JOB_NAME,
			data: {
				reason: "scheduled",
				triggeredAt: new Date().toISOString(),
			},
		}
	);

	log.info({
		service: "insights",
		message: "Insights dispatch scheduler ensured",
		interval_ms: intervalMs,
	});
}

export async function ensureInsightsMaintenanceSchedule(): Promise<void> {
	const intervalMs = getInsightsMaintenanceIntervalMs();
	await getInsightsQueue().upsertJobScheduler(
		INSIGHTS_MAINTENANCE_JOB_NAME,
		{ every: intervalMs },
		{
			name: INSIGHTS_MAINTENANCE_JOB_NAME,
			data: {
				reason: "maintenance",
				triggeredAt: new Date().toISOString(),
			},
		}
	);

	log.info({
		service: "insights",
		message: "Insights maintenance scheduler ensured",
		interval_ms: intervalMs,
	});
}

export async function dispatchDueInsightRuns(
	now = new Date()
): Promise<DispatchDueInsightRunsResult> {
	const configs = await dueConfigs(now);
	const result: DispatchDueInsightRunsResult = {
		scannedConfigs: configs.length,
		claimedConfigs: 0,
		dispatchedRuns: 0,
		queuedItems: 0,
		skippedConfigs: 0,
	};

	for (const config of configs) {
		const claimed = await claimConfig(config, now);
		if (!claimed) {
			result.skippedConfigs += 1;
			continue;
		}
		result.claimedConfigs += 1;

		try {
			const websiteIds = await targetWebsiteIds(claimed);
			if (websiteIds.length === 0) {
				await markConfigDispatched(claimed.id, now);
				result.skippedConfigs += 1;
				continue;
			}

			const queued = await queueInsightGenerationRun({
				organizationId: claimed.organizationId,
				reason: "scheduled" satisfies InsightGenerationReason,
				websiteIds,
			});
			await markConfigDispatched(claimed.id, now);
			result.dispatchedRuns += 1;
			result.queuedItems += queued.queuedItems;
		} catch (error) {
			await retryConfigSoon(claimed.id, now);
			result.skippedConfigs += 1;
			log.error({
				service: "insights",
				message: "Failed to dispatch scheduled insight run",
				config_id: claimed.id,
				organization_id: claimed.organizationId,
				website_id: claimed.websiteId,
				error_message: errorMessage(error),
			});
		}
	}

	return result;
}
