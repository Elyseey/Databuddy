import { db, eq } from "@databuddy/db";
import {
	insightRunItems,
	insightRuns,
	type InsightRun,
	type InsightRunStatus,
} from "@databuddy/db/schema";
import {
	getInsightsQueue,
	INSIGHTS_DISPATCH_JOB_NAME,
	INSIGHTS_GENERATE_WEBSITE_JOB_NAME,
	INSIGHTS_ROLLUP_JOB_NAME,
	insightsRollupJobId,
	type InsightsGenerateWebsiteJobData,
	type InsightsQueueJobData,
	type InsightsRollupJobData,
} from "@databuddy/redis";
import type { Job } from "bullmq";
import { log } from "evlog";
import { generateWebsiteInsights } from "./generation";
import { processRollupJob } from "./rollup";
import { dispatchDueInsightRuns } from "./scheduler";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface RunStatusSummary {
	completedItems: number;
	failedItems: number;
	run: InsightRun | null;
	settled: boolean;
	skippedItems: number;
	status: InsightRunStatus;
	totalItems: number;
}

async function syncRunStatus(runId: string): Promise<RunStatusSummary> {
	const [run, items] = await Promise.all([
		db.query.insightRuns.findFirst({ where: { id: runId } }),
		db
			.select({ status: insightRunItems.status })
			.from(insightRunItems)
			.where(eq(insightRunItems.runId, runId)),
	]);

	const completedItems = items.filter(
		(item) => item.status === "succeeded"
	).length;
	const failedItems = items.filter((item) => item.status === "failed").length;
	const skippedItems = items.filter((item) => item.status === "skipped").length;
	const settledItems = completedItems + failedItems + skippedItems;
	const totalItems = items.length;
	const settled = settledItems === totalItems;

	let status: InsightRunStatus = "running";
	if (totalItems === 0) {
		status = "skipped";
	} else if (settled) {
		if (completedItems > 0 && failedItems === 0) {
			status = "succeeded";
		} else if (completedItems > 0) {
			status = "partially_succeeded";
		} else if (skippedItems === totalItems) {
			status = "skipped";
		} else {
			status = "failed";
		}
	}

	const now = new Date();
	await db
		.update(insightRuns)
		.set({
			completedItems,
			failedItems,
			skippedItems,
			status,
			updatedAt: now,
			...(settled ? { finishedAt: now } : {}),
		})
		.where(eq(insightRuns.id, runId));

	return {
		completedItems,
		failedItems,
		run: run ?? null,
		settled,
		skippedItems,
		status,
		totalItems,
	};
}

async function queueRollupIfSettled(summary: RunStatusSummary): Promise<void> {
	if (!(summary.run && summary.settled && summary.completedItems > 0)) {
		return;
	}
	if (
		summary.status !== "succeeded" &&
		summary.status !== "partially_succeeded"
	) {
		return;
	}

	try {
		await getInsightsQueue().add(
			INSIGHTS_ROLLUP_JOB_NAME,
			{
				organizationId: summary.run.organizationId,
				reason: summary.run.reason,
				runId: summary.run.id,
				timezone: summary.run.timezone,
			},
			{ jobId: insightsRollupJobId(summary.run.id) }
		);
	} catch (error) {
		log.error({
			service: "insights",
			message: "Failed to queue insight rollup job",
			run_id: summary.run.id,
			organization_id: summary.run.organizationId,
			error_message: errorMessage(error),
		});
	}
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
			})
			.where(eq(insightRunItems.id, data.itemId));
		const summary = await syncRunStatus(data.runId);
		await queueRollupIfSettled(summary);
		return { resultCount: result.resultCount, status: result.status };
	} catch (error) {
		await db
			.update(insightRunItems)
			.set({
				errorMessage: errorMessage(error),
				finishedAt: new Date(),
				status: "failed",
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
