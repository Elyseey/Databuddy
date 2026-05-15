"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Skeleton } from "../../components/skeleton";
import { cn } from "../utils";
import { usePersistentState } from "../../hooks/use-persistent-state";
import { CaretDownIcon, ChartActivityIcon } from "../../components/icons/nucleo";

interface LatencyDataPoint {
	avg_response_time?: number;
	date: string;
	p50_response_time?: number;
	p95_response_time?: number;
}

interface LatencyChartProps {
	data: LatencyDataPoint[];
	isLoading?: boolean;
	storageKey: string;
}

const CHART_BLOCK_MIN_PX = 168;

const METRICS = [
	{
		key: "p95_response_time",
		label: "p95",
		color: "var(--color-chart-4)",
	},
	{
		key: "avg_response_time",
		label: "Avg",
		color: "var(--color-chart-1)",
	},
] as const;

function formatMs(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${Math.round(ms)}ms`;
}

interface ChartDataPoint {
	avg_response_time: number | null;
	date: string;
	p95_response_time: number | null;
}

function toChartData(data: LatencyDataPoint[]): ChartDataPoint[] {
	return data
		.filter((d) => d.avg_response_time != null || d.p95_response_time != null)
		.map((d) => ({
			date: d.date,
			avg_response_time:
				d.avg_response_time == null
					? null
					: Math.round(d.avg_response_time * 100) / 100,
			p95_response_time:
				d.p95_response_time == null
					? null
					: Math.round(d.p95_response_time * 100) / 100,
		}));
}

function computeSummary(chartData: ChartDataPoint[]) {
	if (chartData.length === 0) {
		return { avg: null, p95: null };
	}
	const latest = chartData.at(-1);
	const avgValues = chartData
		.map((d) => d.avg_response_time)
		.filter((v): v is number => v != null);
	return {
		avg:
			avgValues.length > 0
				? avgValues.reduce((a, b) => a + b, 0) / avgValues.length
				: null,
		p95: latest?.p95_response_time ?? null,
	};
}

function detectGranularity(data: ChartDataPoint[]): "hourly" | "daily" {
	if (data.length < 2) {
		return "daily";
	}
	const first = new Date(data.at(0)?.date ?? "").getTime();
	const second = new Date(data.at(1)?.date ?? "").getTime();
	return (second - first) / (1000 * 60 * 60) < 20 ? "hourly" : "daily";
}

function formatTickDate(
	dateStr: string,
	granularity: "hourly" | "daily"
): string {
	try {
		const d = new Date(dateStr);
		if (granularity === "hourly") {
			return d.toLocaleString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			});
		}
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	} catch {
		return dateStr;
	}
}

function getMetricLabel(dataKey: unknown) {
	if (typeof dataKey !== "string" && typeof dataKey !== "number") {
		return "";
	}

	return METRICS.find((metric) => metric.key === dataKey)?.label ?? String(dataKey);
}

interface LatencyTooltipEntry {
	color?: string;
	dataKey?: unknown;
	value?: unknown;
}

function LatencyTooltipContent({
	active,
	payload,
	label,
	granularity,
}: {
	active?: boolean;
	granularity: "hourly" | "daily";
	label?: unknown;
	payload?: readonly LatencyTooltipEntry[];
}) {
	if (!active || !payload?.length) {
		return null;
	}

	return (
		<div className="min-w-42 overflow-hidden rounded-xl border border-border/70 bg-popover/95 text-popover-foreground shadow-[0_16px_40px_-32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
			<div className="border-border/60 border-b bg-muted/40 px-3 py-2.5">
				<div className="font-semibold text-xs leading-[1.2]">
					Response Time
				</div>
				<div className="mt-1 text-muted-foreground text-[11px] tabular-nums leading-[1.2]">
					{formatTickDate(String(label ?? ""), granularity)}
				</div>
			</div>
			<div className="space-y-1.5 px-3 py-2.5">
				{payload.map((entry) => (
					<div
						className="flex items-center gap-2 text-xs"
						key={String(entry.dataKey)}
					>
						<span
							className="inline-block size-1.5 rounded-full"
							style={{ backgroundColor: entry.color }}
						/>
						<span className="text-muted-foreground">
							{getMetricLabel(entry.dataKey)}
						</span>
						<span className="ml-auto font-mono tabular-nums">
							{typeof entry.value === "number" ? formatMs(entry.value) : "—"}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function renderLatencyTooltip({
	active,
	payload,
	label,
	granularity,
}: {
	active?: boolean;
	granularity: "hourly" | "daily";
	label?: unknown;
	payload?: readonly LatencyTooltipEntry[];
}) {
	return (
		<LatencyTooltipContent
			active={active}
			granularity={granularity}
			label={label}
			payload={payload}
		/>
	);
}

export function LatencyChart({
	data,
	isLoading = false,
	storageKey,
}: LatencyChartProps) {
	const [isOpen, setIsOpen] = usePersistentState(storageKey, false);
	const chartData = useMemo(() => toChartData(data), [data]);
	const summary = useMemo(() => computeSummary(chartData), [chartData]);

	return (
		<div>
			<button
				className="mt-1.5 flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-accent/40"
				onClick={() => setIsOpen((prev) => !prev)}
				type="button"
			>
				<span className="flex shrink-0 items-center gap-1.5 text-balance font-medium text-muted-foreground text-xs uppercase tracking-wider">
					<ChartActivityIcon className="size-3.5" />
					Response Time
				</span>

				<span className="flex min-h-4.5 min-w-0 flex-1 items-center gap-3 text-muted-foreground text-xs tabular-nums">
					{isLoading ? (
						<>
							<Skeleton className="h-3 w-18 rounded" />
							<Skeleton className="h-3 w-18 rounded" />
						</>
					) : summary.avg == null ? (
						<span aria-hidden className="inline-flex gap-3">
							<span className="invisible tabular-nums">999ms</span>
							<span className="invisible tabular-nums">999ms</span>
						</span>
					) : (
						<>
							<span className="flex items-center gap-1">
								<span
									className="inline-block size-1.5 rounded-full"
									style={{ backgroundColor: "var(--color-chart-1)" }}
								/>
								{formatMs(summary.avg)}
							</span>
							{summary.p95 != null && (
								<span className="flex items-center gap-1">
									<span
										className="inline-block size-1.5 rounded-full"
										style={{ backgroundColor: "var(--color-chart-4)" }}
									/>
									{formatMs(summary.p95)}
								</span>
							)}
						</>
					)}
				</span>

				<CaretDownIcon
					className={cn(
						"ml-auto size-3 shrink-0 text-muted-foreground transition-transform duration-150",
						isOpen && "rotate-180"
					)}
					weight="fill"
				/>
			</button>

			<AnimatePresence initial={false}>
				{isOpen && (
					<motion.div
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						initial={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<div className="px-2 pt-2 pb-1">
							<div
								className="w-full"
								style={{ minHeight: CHART_BLOCK_MIN_PX }}
							>
								{isLoading ? (
									<Skeleton
										className="w-full rounded"
										style={{ minHeight: CHART_BLOCK_MIN_PX }}
									/>
								) : chartData.length === 0 ? (
									<div
										className="flex items-center justify-center"
										style={{ minHeight: CHART_BLOCK_MIN_PX }}
									>
										<span className="text-muted-foreground text-xs">
											No response time data
										</span>
									</div>
								) : (
									<LatencyAreaChart data={chartData} />
								)}
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

const AXIS_TICK = {
	fontSize: 11,
	fill: "var(--muted-foreground)",
} as const;

const GRID = {
	stroke: "var(--border)",
	strokeDasharray: "2 4",
	strokeOpacity: 0.35,
	vertical: false,
} as const;

function LatencyAreaChart({ data }: { data: ChartDataPoint[] }) {
	const granularity = useMemo(() => detectGranularity(data), [data]);

	const hasVariation = METRICS.some((m) => {
		const values = data
			.map((d) => d[m.key as keyof ChartDataPoint])
			.filter((v) => v != null) as number[];
		return values.length > 1 && values.some((v) => v !== values.at(0));
	});

	if (!hasVariation) {
		return (
			<div
				className="flex items-center"
				style={{ minHeight: CHART_BLOCK_MIN_PX }}
			>
				<div className="h-px w-full bg-chart-1/30" />
			</div>
		);
	}

	return (
		<div className="w-full" style={{ minHeight: CHART_BLOCK_MIN_PX }}>
			<div className="h-40 w-full min-w-0">
				<ResponsiveContainer height={160} width="100%">
					<AreaChart
						data={data}
						margin={{ top: 8, right: 4, left: 4, bottom: 22 }}
					>
						<defs>
							{METRICS.map((m) => (
								<linearGradient
									id={`latency-g-${m.key}`}
									key={m.key}
									x1="0"
									x2="0"
									y1="0"
									y2="1"
								>
									<stop offset="0%" stopColor={m.color} stopOpacity={0.12} />
									<stop offset="95%" stopColor={m.color} stopOpacity={0} />
								</linearGradient>
							))}
						</defs>

						<CartesianGrid {...GRID} />

						<XAxis
							axisLine={false}
							dataKey="date"
							interval="preserveStartEnd"
							minTickGap={40}
							tick={AXIS_TICK}
							tickFormatter={(v: string) => formatTickDate(v, granularity)}
							tickLine={false}
							tickMargin={8}
						/>

						<YAxis
							axisLine={false}
							domain={["dataMin", "auto"]}
							tick={AXIS_TICK}
							tickFormatter={formatMs}
							tickLine={false}
							width={52}
						/>

						<Tooltip
							content={({ active, payload, label }) =>
								renderLatencyTooltip({
									active,
									granularity,
									label,
									payload,
								})
							}
							cursor={{
								stroke: "var(--border)",
								strokeWidth: 1,
								strokeDasharray: "4 4",
							}}
						/>

						{METRICS.map((m) => (
							<Area
								activeDot={{
									r: 2,
									fill: m.color,
									stroke: "var(--color-background)",
									strokeWidth: 1.5,
								}}
								connectNulls
								dataKey={m.key}
								dot={false}
								fill={`url(#latency-g-${m.key})`}
								key={m.key}
								name={m.label}
								stroke={m.color}
								strokeWidth={1.5}
								type="monotone"
							/>
						))}
					</AreaChart>
				</ResponsiveContainer>
			</div>

			<div className="mt-2 flex min-h-6 items-center justify-end gap-3">
				{METRICS.map((m) => (
					<span
						className="flex items-center gap-1 text-[10px] text-muted-foreground"
						key={m.key}
					>
						<span
							className="inline-block size-1.5 rounded-full"
							style={{ backgroundColor: m.color }}
						/>
						{m.label}
					</span>
				))}
			</div>
		</div>
	);
}
