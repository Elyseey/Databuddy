import { db, eq } from "@databuddy/db";
import { insightRunItems, insightRuns } from "@databuddy/db/schema";
import {
	INSIGHTS_DISPATCH_JOB_NAME,
	INSIGHTS_GENERATE_WEBSITE_JOB_NAME,
	INSIGHTS_MAINTENANCE_JOB_NAME,
	INSIGHTS_ROLLUP_JOB_NAME,
	type InsightsGenerateWebsiteJobData,
	type InsightsQueueJobData,
	type InsightsRollupJobData,
} from "@databuddy/redis";
import type { Job } from "bullmq";
import { generateWebsiteInsights } from "./generation";
import {
	queueRollupIfSettled,
	recoverStaleInsightRuns,
	syncRunStatus,
} from "./recovery";
import { processRollupJob } from "./rollup";
import { dispatchDueInsightRuns } from "./scheduler";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isFinalAttempt(job: Job<InsightsQueueJobData>): boolean {
	return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

async function processGenerateWebsiteJob(
	data: InsightsGenerateWebsiteJobData,
	job: Job<InsightsQueueJobData>
): Promise<{ resultCount: number; status: "skipped" | "succeeded" }> {
	const now = new Date();
	await Promise.all([
		db
			.update(insightRuns)
			.set({
				status: "running",
				startedAt: now,
				updatedAt: now,
			})
			.where(eq(insightRuns.id, data.runId)),
		db
			.update(insightRunItems)
			.set({
				attempts: job.attemptsMade + 1,
				errorMessage: null,
				finishedAt: null,
				startedAt: now,
				status: "running",
				updatedAt: now,
			})
			.where(eq(insightRunItems.id, data.itemId)),
	]);

	try {
		const result = await generateWebsiteInsights({
			config: data.config,
			organizationId: data.organizationId,
			reason: data.reason,
			requestedByUserId: data.requestedByUserId ?? null,
			runId: data.runId,
			websiteId: data.websiteId,
		});

		await db
			.update(insightRunItems)
			.set({
				errorMessage: result.message ?? null,
				finishedAt: new Date(),
				resultCount: result.resultCount,
				status: result.status,
				updatedAt: new Date(),
			})
			.where(eq(insightRunItems.id, data.itemId));
		const summary = await syncRunStatus(data.runId);
		await queueRollupIfSettled(summary);
		return { resultCount: result.resultCount, status: result.status };
	} catch (error) {
		const finalAttempt = isFinalAttempt(job);
		const message = errorMessage(error);
		await db
			.update(insightRunItems)
			.set({
				errorMessage: finalAttempt
					? message
					: `Attempt ${job.attemptsMade + 1} failed, retrying: ${message}`,
				finishedAt: finalAttempt ? new Date() : null,
				status: finalAttempt ? "failed" : "queued",
				updatedAt: new Date(),
			})
			.where(eq(insightRunItems.id, data.itemId));
		const summary = await syncRunStatus(data.runId);
		await queueRollupIfSettled(summary);
		throw error;
	}
}

export function processInsightsJob(job: Job<InsightsQueueJobData>) {
	if (job.name === INSIGHTS_DISPATCH_JOB_NAME) {
		return dispatchDueInsightRuns();
	}

	if (job.name === INSIGHTS_MAINTENANCE_JOB_NAME) {
		return recoverStaleInsightRuns();
	}

	if (job.name === INSIGHTS_GENERATE_WEBSITE_JOB_NAME) {
		return processGenerateWebsiteJob(
			job.data as InsightsGenerateWebsiteJobData,
			job
		);
	}

	if (job.name === INSIGHTS_ROLLUP_JOB_NAME) {
		return processRollupJob(job.data as InsightsRollupJobData);
	}

	throw new Error(`Unknown insights job: ${job.name}`);
}
