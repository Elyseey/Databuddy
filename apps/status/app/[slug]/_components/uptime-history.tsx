"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildUptimeHeatmapDays } from "@databuddy/ui/uptime";

interface UptimeHistoryProps {
	dailyData: Array<{
		date: string;
		downtime_seconds?: number;
		successful_checks?: number;
		total_checks?: number;
		uptime_percentage?: number;
	}>;
	days: number;
}

type HeatmapDay = ReturnType<typeof buildUptimeHeatmapDays>[number];
type UptimeSeverity =
	| "empty"
	| "operational"
	| "degraded"
	| "partial"
	| "major";

interface UptimeSegment {
	length: number;
	severity: UptimeSeverity;
	start: number;
}

interface TooltipState {
	above: boolean;
	index: number;
	left: number;
	top: number;
}

const TOOLTIP_WIDTH = 224;
const TOOLTIP_GUTTER = 12;
const TOOLTIP_HIDE_MS = 120;

const SEGMENT_COLORS: Record<UptimeSeverity, string> = {
	empty: "var(--muted)",
	operational: "#06c652",
	degraded: "#fbbf24",
	partial: "#fb8f24",
	major: "#ff2b3c",
};

const SEVERITY_META: Record<
	UptimeSeverity,
	{ background: string; label: string; text: string }
> = {
	empty: {
		background: "var(--muted)",
		label: "No Data",
		text: "var(--muted-foreground)",
	},
	operational: {
		background: "color-mix(in oklab, #06c652 16%, transparent)",
		label: "Operational",
		text: "#03903b",
	},
	degraded: {
		background: "color-mix(in oklab, #fbbf24 20%, transparent)",
		label: "Degraded Performance",
		text: "#b7791f",
	},
	partial: {
		background: "color-mix(in oklab, #fb8f24 18%, transparent)",
		label: "Partial Outage",
		text: "#c05621",
	},
	major: {
		background: "color-mix(in oklab, #ff2b3c 16%, transparent)",
		label: "Major Outage",
		text: "#dc2626",
	},
};

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function getSeverity(day: Pick<HeatmapDay, "hasData" | "uptime">) {
	if (!day.hasData) {
		return "empty";
	}
	if (day.uptime >= 99.9) {
		return "operational";
	}
	if (day.uptime >= 99) {
		return "degraded";
	}
	if (day.uptime >= 90) {
		return "partial";
	}
	return "major";
}

function buildSegments(days: HeatmapDay[]): UptimeSegment[] {
	const segments: UptimeSegment[] = [];

	for (const [index, day] of days.entries()) {
		const severity = getSeverity(day);
		const previous = segments.at(-1);

		if (previous?.severity === severity) {
			previous.length += 1;
			continue;
		}

		segments.push({ length: 1, severity, start: index + 1 });
	}

	return segments;
}

function getOrdinalSuffix(day: number) {
	if (day >= 11 && day <= 13) {
		return "th";
	}
	switch (day % 10) {
		case 1:
			return "st";
		case 2:
			return "nd";
		case 3:
			return "rd";
		default:
			return "th";
	}
}

function formatLongDate(date: Date): string {
	const day = date.getDate();

	return `${date.toLocaleDateString("en-US", {
		month: "long",
	})} ${day}${getOrdinalSuffix(day)} ${date.getFullYear()}`;
}

function formatDowntime(seconds: number): string {
	if (seconds < 60) {
		return "<1 min";
	}

	const minutes = Math.round(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;

	if (hours === 0) {
		return `${minutes} min${minutes === 1 ? "" : "s"}`;
	}
	if (remainingMinutes === 0) {
		return `${hours} hr${hours === 1 ? "" : "s"}`;
	}
	return `${hours} hr${hours === 1 ? "" : "s"} ${remainingMinutes} min${remainingMinutes === 1 ? "" : "s"}`;
}

function getTooltipTransform(state: TooltipState, isVisible: boolean) {
	if (state.above) {
		return isVisible
			? "translate(-50%, -100%) scale(1)"
			: "translate(-50%, calc(-100% + 4px)) scale(0.96)";
	}

	return isVisible
		? "translate(-50%, 0) scale(1)"
		: "translate(-50%, 4px) scale(0.96)";
}

function UptimeTooltip({
	day,
	isVisible,
	state,
}: {
	day: HeatmapDay;
	isVisible: boolean;
	state: TooltipState;
}) {
	const severity = getSeverity(day);
	const meta = SEVERITY_META[severity];
	const downtimeLabel =
		day.downtimeSeconds > 0 ? formatDowntime(day.downtimeSeconds) : null;

	return (
		<div
			className="pointer-events-none fixed z-[100] w-56 overflow-hidden rounded-xl border border-border/70 bg-popover/95 text-popover-foreground opacity-0 shadow-[0_14px_36px_-30px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-[left,top,opacity,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
			role="tooltip"
			style={{
				left: state.left,
				opacity: isVisible ? 1 : 0,
				top: state.top,
				transform: getTooltipTransform(state, isVisible),
				transformOrigin: state.above ? "bottom center" : "top center",
			}}
		>
			<div
				className="border-border/60 border-b px-3.5 py-3 transition-colors duration-200"
				style={{
					background: meta.background,
					color: meta.text,
				}}
			>
				<div className="flex items-center gap-2">
					<span
						aria-hidden
						className="size-2 rounded-full"
						style={{ background: SEGMENT_COLORS[severity] }}
					/>
					<span className="font-semibold text-sm leading-[1.2]">
						{meta.label}
					</span>
				</div>
				<span className="mt-1 block font-medium text-xs tabular-nums leading-[1.2] opacity-75">
					{day.hasData
						? `${day.uptime.toFixed(2)}% uptime`
						: "No data recorded"}
				</span>
			</div>

			<div className="px-3.5 py-3">
				<div className="font-semibold text-sm tabular-nums leading-[1.2]">
					{formatLongDate(day.date)}
				</div>
				{downtimeLabel ? (
					<p className="mt-2 text-muted-foreground text-xs tabular-nums leading-[1.2]">
						{downtimeLabel} downtime recorded
					</p>
				) : null}
			</div>
		</div>
	);
}

function getActiveSegmentOffset(segment: UptimeSegment, activeIndex: number) {
	return ((activeIndex + 1 - segment.start) / segment.length) * 100;
}

export function UptimeHistory({ dailyData, days }: UptimeHistoryProps) {
	const gridRef = useRef<HTMLDivElement>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const [isTooltipVisible, setIsTooltipVisible] = useState(false);
	const heatmapData = useMemo(
		() => buildUptimeHeatmapDays(dailyData, days),
		[dailyData, days]
	);
	const segments = useMemo(() => buildSegments(heatmapData), [heatmapData]);
	const activeDay = tooltip ? heatmapData[tooltip.index] : null;

	const clearHideTimer = useCallback(() => {
		if (hideTimerRef.current) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
	}, []);

	const hideTooltip = useCallback(() => {
		setIsTooltipVisible(false);
		hideTimerRef.current = setTimeout(() => {
			setTooltip(null);
		}, TOOLTIP_HIDE_MS);
	}, []);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const grid = gridRef.current;

			if (!grid || heatmapData.length === 0) {
				return;
			}

			clearHideTimer();

			const rect = grid.getBoundingClientRect();
			const cellWidth = rect.width / heatmapData.length;
			const index = clamp(
				Math.floor((event.clientX - rect.left) / cellWidth),
				0,
				heatmapData.length - 1
			);
			const tooltipHalfWidth = TOOLTIP_WIDTH / 2;
			const left = clamp(
				rect.left + (index + 0.5) * cellWidth,
				tooltipHalfWidth + TOOLTIP_GUTTER,
				window.innerWidth - tooltipHalfWidth - TOOLTIP_GUTTER
			);
			const above = window.innerHeight - rect.bottom < 260 && rect.top > 180;

			setTooltip({
				above,
				index,
				left,
				top: above ? rect.top - 10 : rect.bottom + 10,
			});
			setIsTooltipVisible(true);
		},
		[clearHideTimer, heatmapData]
	);

	useEffect(
		() => () => {
			clearHideTimer();
		},
		[clearHideTimer]
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between px-0.5 text-muted-foreground text-sm leading-[1.2] sm:text-base">
				<span className="font-medium">{days} days ago</span>
				<span>Today</span>
			</div>
			<div
				aria-label={`${days} day uptime history`}
				className="relative -my-3 grid cursor-pointer gap-x-px py-3 sm:gap-x-[2px]"
				onPointerLeave={hideTooltip}
				onPointerMove={handlePointerMove}
				ref={gridRef}
				role="img"
				style={{
					gridTemplateColumns: `repeat(${heatmapData.length}, minmax(0, 1fr))`,
				}}
			>
				{segments.map((segment) => {
					const activeIndex = tooltip?.index ?? null;
					const containsActive =
						activeIndex !== null &&
						activeIndex + 1 >= segment.start &&
						activeIndex + 1 < segment.start + segment.length;

					return (
						<div
							className="relative h-1.5 overflow-hidden rounded-full"
							key={`${segment.start}-${segment.length}-${segment.severity}`}
							style={{
								background: SEGMENT_COLORS[segment.severity],
								gridColumn: `${segment.start} / span ${segment.length}`,
							}}
						>
							<div
								className="pointer-events-none absolute inset-y-0 transition-[left,opacity] duration-100 ease-[cubic-bezier(0.2,0,0,1)]"
								style={{
									background: "var(--status-bar-active-overlay)",
									left:
										activeIndex === null
											? 0
											: `${getActiveSegmentOffset(segment, activeIndex)}%`,
									opacity: containsActive && isTooltipVisible ? 1 : 0,
									width: `${100 / segment.length}%`,
								}}
							/>
						</div>
					);
				})}
			</div>
			{typeof document !== "undefined" && activeDay && tooltip
				? createPortal(
						<UptimeTooltip
							day={activeDay}
							isVisible={isTooltipVisible}
							state={tooltip}
						/>,
						document.body
					)
				: null}
		</div>
	);
}
