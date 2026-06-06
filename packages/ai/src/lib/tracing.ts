import { EvlogError, log } from "evlog";
import { getActiveAiRequestLogger } from "./request-logger";

export function mergeWideEvent(fields: Record<string, unknown>): void {
	const requestLogger = getActiveAiRequestLogger();
	if (requestLogger) {
		requestLogger.set(fields);
		return;
	}
	log.info({ service: "api", ...fields });
}

export function captureError(
	error: unknown,
	fields?: Record<string, unknown>
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	const requestLog = getActiveAiRequestLogger();
	if (
		requestLog &&
		err instanceof EvlogError &&
		err.status >= 400 &&
		err.status < 500
	) {
		requestLog.set({
			client_http_error: true,
			http_status: err.status,
			error_message: err.message,
		});
		if (fields) {
			requestLog.warn(err.message, fields);
		} else {
			requestLog.warn(err.message);
		}
		return;
	}
	if (requestLog) {
		if (fields) {
			requestLog.error(err, fields);
		} else {
			requestLog.error(err);
		}
		return;
	}
	log.error({
		service: "api",
		error_message: err.message,
		...(fields ?? {}),
	});
}
