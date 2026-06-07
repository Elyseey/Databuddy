import { setAiRequestLoggerProvider } from "@databuddy/ai/lib/request-logger";
import { setPgErrorFn } from "@databuddy/db";
import { setRpcRequestLoggerProvider, setTrackingFn } from "@databuddy/rpc";
import { log } from "evlog";
import { useLogger } from "evlog/elysia";
import { trackMutationEvent } from "@databuddy/ai/lib/databuddy";
import { initTccTracing } from "@/lib/tcc-otel";

export function configureApiInstrumentation() {
	setTrackingFn(trackMutationEvent);
	setRpcRequestLoggerProvider(useLogger);
	setAiRequestLoggerProvider(useLogger);
	setPgErrorFn(recordPostgresPoolError);
	startTccTracing();
}

function recordPostgresPoolError(error: Error) {
	log.error({
		service: "api",
		component: "postgres_pool",
		error_message: error.message,
		error_stack: error.stack,
	});
}

function startTccTracing() {
	try {
		initTccTracing();
	} catch (error) {
		log.warn({
			service: "api",
			component: "tcc_otel",
			message: "TCC tracing disabled (init failed)",
			error_message: error instanceof Error ? error.message : String(error),
		});
	}
}
