export type InsightScheduleFrequency = "hourly" | "daily" | "weekly" | "custom";

export interface InsightScheduleConfig {
	cron: string | null;
	enabled: boolean;
	frequency: InsightScheduleFrequency;
}

const CRON_FIELD_SEPARATOR = /\s+/;

function parseCronField(
	value: string,
	min: number,
	max: number
): number[] | null {
	if (value === "*") {
		return Array.from({ length: max - min + 1 }, (_, index) => min + index);
	}

	if (value.startsWith("*/")) {
		const step = Number.parseInt(value.slice(2), 10);
		if (!Number.isSafeInteger(step) || step <= 0) {
			return null;
		}
		return Array.from(
			{ length: max - min + 1 },
			(_, index) => min + index
		).filter((item) => (item - min) % step === 0);
	}

	const values = value.split(",").map((part) => Number.parseInt(part, 10));
	if (
		values.some(
			(item) => !Number.isSafeInteger(item) || item < min || item > max
		)
	) {
		return null;
	}
	return [...new Set(values)].sort((a, b) => a - b);
}

function nextRunFromCron(cron: string | null, from: Date): Date | null {
	if (!cron) {
		return null;
	}

	const parts = cron.trim().split(CRON_FIELD_SEPARATOR);
	if (parts.length !== 5) {
		return null;
	}

	const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;
	const minutes = parseCronField(minutePart ?? "", 0, 59);
	const hours = parseCronField(hourPart ?? "", 0, 23);
	const days = parseCronField(dayPart ?? "", 1, 31);
	const months = parseCronField(monthPart ?? "", 1, 12);
	const weekdays = parseCronField(weekdayPart ?? "", 0, 7);
	if (!(minutes && hours && days && months && weekdays)) {
		return null;
	}

	const minuteSet = new Set(minutes);
	const hourSet = new Set(hours);
	const daySet = new Set(days);
	const monthSet = new Set(months);
	const weekdaySet = new Set(weekdays.map((day) => (day === 7 ? 0 : day)));
	const candidate = new Date(from);
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const maxMinutes = 366 * 24 * 60;
	for (let i = 0; i < maxMinutes; i += 1) {
		if (
			minuteSet.has(candidate.getMinutes()) &&
			hourSet.has(candidate.getHours()) &&
			daySet.has(candidate.getDate()) &&
			monthSet.has(candidate.getMonth() + 1) &&
			weekdaySet.has(candidate.getDay())
		) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}

	return null;
}

export function getNextInsightRunAt(
	config: InsightScheduleConfig,
	from = new Date()
): Date | null {
	if (!config.enabled) {
		return null;
	}

	const next = new Date(from);
	if (config.frequency === "hourly") {
		next.setHours(next.getHours() + 1, 0, 0, 0);
		return next;
	}

	if (config.frequency === "daily") {
		next.setDate(next.getDate() + 1);
		next.setHours(9, 0, 0, 0);
		return next;
	}

	if (config.frequency === "weekly") {
		next.setDate(next.getDate() + 7);
		next.setHours(9, 0, 0, 0);
		return next;
	}

	return nextRunFromCron(config.cron, from);
}
