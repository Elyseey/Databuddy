import { EvlogError, log } from "evlog";
import { useLogger as getRequestLogger } from "evlog/elysia";

export function mergeWideEvent(fields: Record<string, unknown>): void {
	try {
		getRequestLogger().set(fields);
	} catch {
		log.info({ service: "api", ...fields });
	}
}

export function captureError(
	error: unknown,
	fields?: Record<string, unknown>
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	try {
		const requestLog = getRequestLogger();
		if (err instanceof EvlogError && err.status >= 400 && err.status < 500) {
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
		if (fields) {
			requestLog.error(err, fields);
		} else {
			requestLog.error(err);
		}
	} catch {
		log.error({
			service: "api",
			error_message: err.message,
			...(fields ?? {}),
		});
	}
}
