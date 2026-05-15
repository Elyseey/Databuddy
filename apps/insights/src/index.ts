import { db, shutdownPostgres, sql } from "@databuddy/db";
import { closeInsightsQueue, getInsightsQueue } from "@databuddy/redis";
import { Elysia } from "elysia";
import { initLogger, log } from "evlog";
import {
	ensureInsightsDispatchSchedule,
	ensureInsightsMaintenanceSchedule,
} from "./scheduler";
import { startInsightsWorker } from "./worker";

const environment =
	process.env.UNKEY_ENVIRONMENT_SLUG ??
	(process.env.NODE_ENV === "development" ? "development" : "production");
const workerEnabled = process.env.INSIGHTS_WORKER_ENABLED !== "false";
const DRAIN_TIMEOUT_MS = 10_000;

initLogger({
	env: {
		service: "insights",
		environment,
		region: process.env.UNKEY_REGION,
		commitHash: process.env.UNKEY_GIT_COMMIT_SHA,
	},
	sampling: {},
});

process.on("unhandledRejection", (reason) => {
	log.error({
		process: "unhandledRejection",
		reason: reason instanceof Error ? reason.message : String(reason),
	});
	exitAfterDrain(1);
});

process.on("uncaughtException", (error) => {
	log.error({
		process: "uncaughtException",
		error_message: error.message,
		error_stack: error.stack,
		error_source: "process",
	});
	exitAfterDrain(1);
});

let shuttingDown = false;
let insightsWorker: ReturnType<typeof startInsightsWorker> | null = null;

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("shutdown timeout")),
					timeoutMs
				);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

async function drainAll() {
	await withTimeout(
		Promise.allSettled([
			insightsWorker?.close() ?? Promise.resolve(),
			closeInsightsQueue(),
			shutdownPostgres(),
		]),
		DRAIN_TIMEOUT_MS
	).catch((error) => {
		log.error({
			lifecycle: "shutdown",
			error_message: error instanceof Error ? error.message : String(error),
		});
	});
}

function exitAfterDrain(code: number) {
	if (shuttingDown) {
		process.exit(code);
	}
	shuttingDown = true;
	drainAll()
		.catch((error) => {
			log.error({
				lifecycle: "shutdown",
				error_message: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => process.exit(code));
}

async function shutdown(signal: string) {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	log.info("lifecycle", `${signal} received, shutting down gracefully`);
	await drainAll();
	process.exit(0);
}

if (workerEnabled) {
	insightsWorker = startInsightsWorker();
	await Promise.all([
		ensureInsightsDispatchSchedule(),
		ensureInsightsMaintenanceSchedule(),
	]);
	log.info("lifecycle", "insights worker started");
} else {
	log.info("lifecycle", "insights worker disabled");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

type ProbeResult =
	| { status: "ok"; latency_ms: number }
	| { status: "error"; latency_ms: number; error: string };

async function probe(fn: () => Promise<void>): Promise<ProbeResult> {
	const start = performance.now();
	try {
		await fn();
		return { status: "ok", latency_ms: Math.round(performance.now() - start) };
	} catch (error) {
		return {
			status: "error",
			latency_ms: Math.round(performance.now() - start),
			error: error instanceof Error ? error.message : "unknown",
		};
	}
}

const app = new Elysia()
	.get("/health/status", async () => {
		const [postgres, bullmqRedis] = await Promise.all([
			probe(() => db.execute(sql`SELECT 1`).then(() => {})),
			probe(async () => {
				const client = await getInsightsQueue().client;
				await client.ping();
			}),
		]);

		const services = { postgres, bullmqRedis };
		const status = Object.values(services).every((s) => s.status === "ok")
			? "ok"
			: "degraded";

		return Response.json(
			{ status, workerEnabled, services },
			{ status: status === "ok" ? 200 : 503 }
		);
	})
	.get("/health", () => ({ status: "ok", workerEnabled }));

export default {
	port: Number(process.env.PORT ?? 4002),
	fetch: app.fetch,
};
