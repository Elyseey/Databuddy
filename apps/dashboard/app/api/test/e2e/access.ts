import { readBooleanEnv } from "@databuddy/env/boolean";

const TEST_KEY_HEADER = "x-e2e-test-key";

function notFound(): Response {
	return Response.json({ error: "Not found" }, { status: 404 });
}

export function assertE2EAccess(request: Request): Response | null {
	if (!readBooleanEnv("DATABUDDY_E2E_MODE")) {
		return notFound();
	}

	const key = process.env.DATABUDDY_E2E_TEST_KEY;
	if (!key) {
		return notFound();
	}

	return request.headers.get(TEST_KEY_HEADER) === key
		? null
		: Response.json({ error: "Unauthorized" }, { status: 401 });
}
