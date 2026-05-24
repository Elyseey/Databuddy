import { executeQuery } from "@databuddy/ai/query";
import dayjs from "dayjs";

export interface DetectedSignal {
	baseline: number;
	current: number;
	deltaPercent: number;
	detectedAt: string;
	direction: "up" | "down";
	label: string;
	method: "zscore" | "wow";
	metric: string;
	severity: "critical" | "warning" | "info";
	zScore?: number;
}

export interface DetectSignalsParams {
	lookbackDays: number;
	timezone: string;
	websiteId: string;
}

interface AnomalyMetric {
	dailyField: string;
	key: string;
	label: string;
	summaryField: string;
}

const ANOMALY_METRICS: AnomalyMetric[] = [
	{
		key: "visitors",
		label: "Visitors",
		dailyField: "visitors",
		summaryField: "unique_visitors",
	},
	{
		key: "sessions",
		label: "Sessions",
		dailyField: "sessions",
		summaryField: "sessions",
	},
	{
		key: "pageviews",
		label: "Pageviews",
		dailyField: "pageviews",
		summaryField: "pageviews",
	},
	{
		key: "bounce_rate",
		label: "Bounce rate",
		dailyField: "bounce_rate",
		summaryField: "bounce_rate",
	},
	{
		key: "session_duration",
		label: "Avg. session duration",
		dailyField: "median_session_duration",
		summaryField: "median_session_duration",
	},
];

interface DailyRow {
	bounce_rate?: unknown;
	date?: unknown;
	median_session_duration?: unknown;
	pageviews?: unknown;
	sessions?: unknown;
	visitors?: unknown;
}

export function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

export function mad(values: number[]): number {
	if (values.length < 2) {
		return 0;
	}
	const med = median(values);
	const deviations = values.map((v) => Math.abs(v - med));
	return median(deviations);
}

const MAD_SCALE = 1.4826;

export function safeDeltaPercent(current: number, previous: number): number {
	if (previous === 0) {
		return current === 0 ? 0 : 100;
	}
	return ((current - previous) / previous) * 100;
}

function isWeekend(dateStr: string): boolean {
	const day = dayjs(dateStr).day();
	return day === 0 || day === 6;
}

export function assignSeverity(
	zScore: number | undefined,
	deltaPercent: number
): "critical" | "warning" | "info" {
	const absZ = zScore === undefined ? 0 : Math.abs(zScore);
	const absD = Math.abs(deltaPercent);
	if (absZ >= 3.5 || absD >= 60) {
		return "critical";
	}
	if (absZ >= 3.0 || absD >= 50) {
		return "warning";
	}
	return "info";
}

export type QueryFn = typeof executeQuery;

export async function detectSignals(
	params: DetectSignalsParams,
	queryFn: QueryFn = executeQuery
): Promise<DetectedSignal[]> {
	const { websiteId, lookbackDays, timezone } = params;

	const today = dayjs();
	const dailyFrom = today
		.subtract(lookbackDays - 1, "day")
		.format("YYYY-MM-DD");
	const dailyTo = today.format("YYYY-MM-DD");

	const rows = (await queryFn(
		{
			projectId: websiteId,
			type: "events_by_date",
			from: dailyFrom,
			to: dailyTo,
			timezone,
			timeUnit: "day",
			limit: lookbackDays + 5,
		},
		undefined,
		timezone
	)) as DailyRow[];

	const sorted = [...rows].sort((a, b) =>
		String(a.date ?? "").localeCompare(String(b.date ?? ""))
	);

	const zscoreSignals = detectZscore(sorted);

	const wowSignals = await detectWow(params, today, queryFn);

	const wowDirection = new Map<string, "up" | "down">();
	for (const s of wowSignals) {
		wowDirection.set(s.metric, s.direction);
	}
	const reconciledZscore = zscoreSignals.filter((s) => {
		const wow = wowDirection.get(s.metric);
		return wow === undefined || wow === s.direction;
	});

	const all = [...reconciledZscore, ...wowSignals];

	const byMetric = new Map<string, DetectedSignal>();
	for (const signal of all) {
		const prev = byMetric.get(signal.metric);
		if (!prev || Math.abs(signal.deltaPercent) > Math.abs(prev.deltaPercent)) {
			byMetric.set(signal.metric, signal);
		}
	}

	const filtered = [...byMetric.values()].filter((signal) => {
		const absDelta = Math.abs(signal.current - signal.baseline);
		if (signal.metric === "session_duration") {
			return absDelta >= 60 && Math.max(signal.current, signal.baseline) >= 20;
		}
		if (signal.metric === "bounce_rate") {
			return absDelta >= 10;
		}
		const peak = Math.max(signal.current, signal.baseline);
		if (peak < 80) {
			return false;
		}
		return absDelta >= 50;
	});

	const collapsed = collapseCorrelated(filtered);

	return collapsed.sort(
		(a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent)
	);
}

const TRAFFIC_METRICS = new Set(["visitors", "sessions", "pageviews"]);

function collapseCorrelated(signals: DetectedSignal[]): DetectedSignal[] {
	const up = signals.filter((s) => s.direction === "up");
	const down = signals.filter((s) => s.direction === "down");

	const collapseTraffic = (group: DetectedSignal[]): DetectedSignal[] => {
		const traffic = group.filter((s) => TRAFFIC_METRICS.has(s.metric));
		const nonTraffic = group.filter((s) => !TRAFFIC_METRICS.has(s.metric));
		if (traffic.length < 2) {
			return group;
		}
		const strongest = traffic.reduce((best, s) =>
			Math.abs(s.deltaPercent) > Math.abs(best.deltaPercent) ? s : best
		);
		return [strongest, ...nonTraffic];
	};

	const collapsedUp = collapseTraffic(up);
	const collapsedDown = collapseTraffic(down);
	return [...collapsedUp, ...collapsedDown];
}

function detectZscore(sorted: DailyRow[]): DetectedSignal[] {
	if (sorted.length < 7) {
		return [];
	}

	const latest = sorted.at(-1);
	if (!latest) {
		return [];
	}

	const latestDate = String(latest.date ?? "");
	const latestIsWeekend = isWeekend(latestDate);
	const baselineAll = sorted.slice(0, -1);

	const baseline = baselineAll.filter((row) => {
		const rowIsWeekend = isWeekend(String(row.date ?? ""));
		return latestIsWeekend === rowIsWeekend;
	});

	if (baseline.length < 6) {
		return [];
	}

	const signals: DetectedSignal[] = [];

	for (const metric of ANOMALY_METRICS) {
		const baselineValues = baseline
			.map((r) => Number(r[metric.dailyField as keyof DailyRow] ?? 0))
			.filter((v) => Number.isFinite(v));

		if (baselineValues.length < 6) {
			continue;
		}

		const baselineMedian = median(baselineValues);
		const baselineMad = mad(baselineValues);
		const scaledMad = baselineMad * MAD_SCALE;
		if (scaledMad === 0) {
			continue;
		}

		const currentValue = Number(
			latest[metric.dailyField as keyof DailyRow] ?? 0
		);
		const zScore = (currentValue - baselineMedian) / scaledMad;
		if (Math.abs(zScore) < 2.5) {
			continue;
		}

		const delta = safeDeltaPercent(currentValue, baselineMedian);
		const direction: "up" | "down" =
			currentValue > baselineMedian ? "up" : "down";

		signals.push({
			metric: metric.key,
			label: metric.label,
			method: "zscore",
			direction,
			current: currentValue,
			baseline: baselineMedian,
			deltaPercent: Number(delta.toFixed(2)),
			zScore: Number(zScore.toFixed(2)),
			severity: assignSeverity(zScore, delta),
			detectedAt: latestDate,
		});
	}

	return signals;
}

async function detectWow(
	params: DetectSignalsParams,
	today: dayjs.Dayjs,
	queryFn: QueryFn
): Promise<DetectedSignal[]> {
	const { websiteId, lookbackDays, timezone } = params;
	const windowDays = Math.max(3, lookbackDays);

	const currentFrom = today
		.subtract(windowDays - 1, "day")
		.format("YYYY-MM-DD");
	const currentTo = today.format("YYYY-MM-DD");
	const previousFrom = today
		.subtract(windowDays * 2 - 1, "day")
		.format("YYYY-MM-DD");
	const previousTo = today.subtract(windowDays, "day").format("YYYY-MM-DD");

	const [currentRows, previousRows] = await Promise.all([
		queryFn(
			{
				projectId: websiteId,
				type: "summary_metrics",
				from: currentFrom,
				to: currentTo,
				timezone,
			},
			undefined,
			timezone
		),
		queryFn(
			{
				projectId: websiteId,
				type: "summary_metrics",
				from: previousFrom,
				to: previousTo,
				timezone,
			},
			undefined,
			timezone
		),
	]);

	const currentRow = (currentRows[0] ?? {}) as Record<string, unknown>;
	const previousRow = (previousRows[0] ?? {}) as Record<string, unknown>;
	const signals: DetectedSignal[] = [];

	for (const metric of ANOMALY_METRICS) {
		const currentValue = Number(currentRow[metric.summaryField] ?? 0);
		const previousValue = Number(previousRow[metric.summaryField] ?? 0);

		if (previousValue === 0 || currentValue === 0) {
			continue;
		}

		const pct = safeDeltaPercent(currentValue, previousValue);
		if (Math.abs(pct) < 40) {
			continue;
		}

		const direction: "up" | "down" =
			currentValue > previousValue ? "up" : "down";

		signals.push({
			metric: metric.key,
			label: metric.label,
			method: "wow",
			direction,
			current: currentValue,
			baseline: previousValue,
			deltaPercent: Number(pct.toFixed(2)),
			severity: assignSeverity(undefined, pct),
			detectedAt: currentTo,
		});
	}

	return signals;
}
