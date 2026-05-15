import {
	getBullMQWorkerConnectionOptions,
	INSIGHTS_JOB_TIMEOUT_MS,
	INSIGHTS_QUEUE_ENV_PREFIX,
	INSIGHTS_QUEUE_NAME,
	type InsightsQueueJobData,
} from "@databuddy/redis";
import { Worker } from "bullmq";
import { log } from "evlog";
import { processInsightsJob } from "./jobs";

const DEFAULT_INSIGHTS_WORKER_CONCURRENCY = 5;

export function getInsightsWorkerConcurrency(
	value = process.env.INSIGHTS_WORKER_CONCURRENCY
): number {
	if (value === undefined || value.trim() === "") {
		return DEFAULT_INSIGHTS_WORKER_CONCURRENCY;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return DEFAULT_INSIGHTS_WORKER_CONCURRENCY;
	}

	return parsed;
}

export function startInsightsWorker() {
	const worker = new Worker<InsightsQueueJobData>(
		INSIGHTS_QUEUE_NAME,
		async (job) => await processInsightsJob(job),
		{
			connection: getBullMQWorkerConnectionOptions({
				envPrefix: INSIGHTS_QUEUE_ENV_PREFIX,
			}),
			concurrency: getInsightsWorkerConcurrency(),
			lockDuration: INSIGHTS_JOB_TIMEOUT_MS * 2,
			stalledInterval: INSIGHTS_JOB_TIMEOUT_MS * 3,
		}
	);

	worker.on("failed", (job, error) => {
		log.error({
			insights_worker: "job_failed",
			error_message: error.message,
			job_id: job?.id,
			job_name: job?.name,
			attempts_made: job?.attemptsMade ?? 0,
		});
	});

	worker.on("completed", (job) => {
		log.info({
			insights_worker: "job_completed",
			job_id: job.id,
			job_name: job.name,
			attempts_made: job.attemptsMade,
			duration_ms:
				job.finishedOn && job.processedOn
					? job.finishedOn - job.processedOn
					: undefined,
		});
	});

	worker.on("stalled", (jobId) => {
		log.error({
			insights_worker: "job_stalled",
			job_id: jobId,
		});
	});

	worker.on("error", (error) => {
		log.error({
			insights_worker: "worker_error",
			error_message: error.message,
		});
	});

	return worker;
}
