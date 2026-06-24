"use client";

import { flush, track } from "@databuddy/sdk";
import type {
	AppEventName,
	AppEventNameWithProperties,
	AppEventProperties,
	EmptyAppEventName,
} from "@databuddy/shared/custom-events";

export { APP_EVENTS, readUtmProperties } from "@databuddy/shared/custom-events";
export type { SignupMethod } from "@databuddy/shared/custom-events";

interface TrackOptions {
	flush?: boolean;
}

export function trackAppEvent<Name extends EmptyAppEventName>(
	name: Name,
	options?: TrackOptions
): void;
export function trackAppEvent<Name extends AppEventNameWithProperties>(
	name: Name,
	properties: AppEventProperties[Name],
	options?: TrackOptions
): void;
export function trackAppEvent<Name extends AppEventName>(
	name: Name,
	propertiesOrOptions?: AppEventProperties[Name] | TrackOptions,
	options?: TrackOptions
) {
	try {
		const properties =
			options || !propertiesOrOptions || !("flush" in propertiesOrOptions)
				? (propertiesOrOptions as Record<string, unknown> | undefined)
				: undefined;
		const trackOptions =
			options ??
			(properties ? undefined : (propertiesOrOptions as TrackOptions));

		track(name, properties);
		if (trackOptions?.flush) {
			flush();
		}
	} catch {
		// SDK may not be loaded yet.
	}
}
