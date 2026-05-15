"use client";

import { useQuery } from "@tanstack/react-query";
import { cloneElement, type ReactElement, useMemo } from "react";
import type { InsightsAiResponse } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	ClockCounterClockwiseIcon,
	ClockIcon,
	DatabaseIcon,
	WarningCircleIcon,
} from "@databuddy/ui/icons";
import {
	Badge,
	Card,
	Progress,
	Skeleton,
	StatusDot,
	dayjs,
} from "@databuddy/ui";

type RunStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "partially_succeeded"
	| "failed"
	| "skipped";

interface InsightRunSummary {
	completedItems: number;
	createdAt: string | Date;
	errorMessage: string | null;
	failedItems: number;
	finishedAt: string | Date | null;
	id: string;
	reason: "manual" | "scheduled" | "cooldown_refresh";
	skippedItems: number;
	startedAt: string | Date | null;
	status: RunStatus;
	totalItems: number;
	updatedAt: string | Date;
}

interface InsightGenerationStatusProps {
	generation?: InsightsAiResponse["generation"];
	organizationId?: string;
}

const ACTIVE_STATUSES = new Set<RunStatus>(["queued", "running"]);

export function InsightGenerationStatus({
	generation,
	organizationId,
}: InsightGenerationStatusProps) {
	const runsQuery = useQuery({
		...orpc.insightGeneration.listRuns.queryOptions({
			input: { organizationId, limit: 5 },
		}),
		enabled: !!organizationId,
		refetchInterval: (query) => {
			const latest = (
				query.state.data as { runs?: InsightRunSummary[] } | undefined
			)?.runs?.[0];
			return latest && ACTIVE_STATUSES.has(latest.status) ? 2500 : false;
		},
		refetchOnWindowFocus: false,
	});

	const runs = useMemo(
		() => (runsQuery.data?.runs as InsightRunSummary[] | undefined) ?? [],
		[runsQuery.data?.runs]
	);
	const latestRun = runs[0] ?? null;
	const activeQueuedRun:
		| { queuedItems?: number; runId: string; status: "queued" }
		| undefined =
		generation?.status === "queued" && generation.runId
			? {
					queuedItems: generation.queuedItems,
					runId: generation.runId,
					status: "queued",
				}
			: undefined;

	const status = latestRun?.status ?? activeQueuedRun?.status ?? "skipped";
	const progress =
		latestRun && latestRun.totalItems > 0
			? (settledItems(latestRun) / latestRun.totalItems) * 100
			: activeQueuedRun?.queuedItems
				? 2
				: 0;

	return (
		<Card aria-label="Insight generation status">
			<Card.Header className="flex-row items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex items-center gap-2">
						<ClockCounterClockwiseIcon
							aria-hidden
							className="size-4 text-primary"
							weight="duotone"
						/>
						<Card.Title>Run activity</Card.Title>
					</div>
					<Card.Description>{statusLabel(status)}</Card.Description>
				</div>
				<StatusBadge status={status} />
			</Card.Header>

			<Card.Content className="space-y-4">
				{runsQuery.isLoading ? (
					<div className="space-y-3">
						<Skeleton className="h-3 w-3/5 rounded" />
						<Skeleton className="h-2 w-full rounded" />
						<Skeleton className="h-20 rounded" />
					</div>
				) : latestRun ? (
					<>
						<div className="space-y-3">
							<Progress
								size="sm"
								tone={progressTone(latestRun.status)}
								value={progress}
							/>
							<div className="grid grid-cols-3 gap-2">
								<Stat
									label="Items"
									value={`${settledItems(latestRun)}/${latestRun.totalItems}`}
								/>
								<Stat label="Passed" value={String(latestRun.completedItems)} />
								<Stat label="Failed" value={String(latestRun.failedItems)} />
							</div>
							<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
								<MetaChip
									icon={<ClockIcon />}
									label={reasonLabel(latestRun.reason)}
								/>
								<MetaChip
									icon={<DatabaseIcon />}
									label={formatRelative(
										latestRun.finishedAt ?? latestRun.updatedAt
									)}
								/>
							</div>
							{latestRun.errorMessage && (
								<p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
									{latestRun.errorMessage}
								</p>
							)}
						</div>

						{runs.length > 1 && (
							<div className="divide-y divide-border/60 rounded-md border border-border/60">
								{runs.slice(1).map((run) => (
									<RunRow key={run.id} run={run} />
								))}
							</div>
						)}
					</>
				) : activeQueuedRun ? (
					<>
						<Progress size="sm" value={progress} />
						<p className="text-muted-foreground text-xs">
							Run {shortId(activeQueuedRun.runId)} queued with{" "}
							{activeQueuedRun.queuedItems ?? 0} item
							{activeQueuedRun.queuedItems === 1 ? "" : "s"}.
						</p>
					</>
				) : (
					<div className="rounded-md border border-border/70 border-dashed px-3 py-6 text-center">
						<p className="font-medium text-sm">No runs yet</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Manual and scheduled runs will appear here.
						</p>
					</div>
				)}
			</Card.Content>
		</Card>
	);
}

function RunRow({ run }: { run: InsightRunSummary }) {
	return (
		<div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<StatusDot color={statusDotColor(run.status)} />
					<p className="truncate font-medium text-foreground">
						{statusLabel(run.status)}
					</p>
				</div>
				<p className="mt-0.5 text-muted-foreground">
					{settledItems(run)}/{run.totalItems} · {reasonLabel(run.reason)}
				</p>
			</div>
			<p className="shrink-0 text-muted-foreground tabular-nums">
				{formatRelative(run.finishedAt ?? run.updatedAt)}
			</p>
		</div>
	);
}

function StatusBadge({ status }: { status: RunStatus | "skipped" }) {
	const variant =
		status === "failed"
			? "destructive"
			: status === "partially_succeeded"
				? "warning"
				: status === "succeeded"
					? "success"
					: ACTIVE_STATUSES.has(status as RunStatus)
						? "primary"
						: "muted";
	const Icon =
		status === "failed"
			? WarningCircleIcon
			: status === "succeeded"
				? CheckCircleIcon
				: ACTIVE_STATUSES.has(status as RunStatus)
					? ArrowClockwiseIcon
					: undefined;

	return (
		<Badge className="capitalize" size="sm" variant={variant}>
			{Icon ? (
				<Icon
					aria-hidden
					className={
						ACTIVE_STATUSES.has(status as RunStatus)
							? "size-3 animate-spin"
							: "size-3"
					}
					weight="duotone"
				/>
			) : (
				<StatusDot color="muted" />
			)}
			{status.replace("_", " ")}
		</Badge>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
			<p className="text-[11px] text-muted-foreground">{label}</p>
			<p className="mt-0.5 truncate font-semibold text-foreground text-sm tabular-nums">
				{value}
			</p>
		</div>
	);
}

function MetaChip({
	icon,
	label,
}: {
	icon: ReactElement<{
		"aria-hidden"?: boolean;
		className?: string;
		weight?: string;
	}>;
	label: string;
}) {
	return (
		<span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-secondary px-2.5">
			{cloneElement(icon, {
				"aria-hidden": true,
				className: "size-3.5",
				weight: icon.props.weight ?? "duotone",
			})}
			{label}
		</span>
	);
}

function settledItems(run: InsightRunSummary): number {
	return run.completedItems + run.failedItems + run.skippedItems;
}

function progressTone(
	status: RunStatus
): "primary" | "warning" | "destructive" | "success" {
	if (status === "failed") {
		return "destructive";
	}
	if (status === "partially_succeeded") {
		return "warning";
	}
	if (status === "succeeded") {
		return "success";
	}
	return "primary";
}

function statusDotColor(
	status: RunStatus
): "success" | "warning" | "destructive" | "muted" {
	if (status === "succeeded") {
		return "success";
	}
	if (status === "partially_succeeded") {
		return "warning";
	}
	if (status === "failed") {
		return "destructive";
	}
	return "muted";
}

function statusLabel(status: RunStatus | "skipped"): string {
	if (status === "queued") {
		return "Queued";
	}
	if (status === "running") {
		return "Running";
	}
	if (status === "succeeded") {
		return "Complete";
	}
	if (status === "partially_succeeded") {
		return "Completed with failures";
	}
	if (status === "failed") {
		return "Failed";
	}
	return "Idle";
}

function reasonLabel(reason: InsightRunSummary["reason"]): string {
	if (reason === "scheduled") {
		return "Scheduled";
	}
	if (reason === "cooldown_refresh") {
		return "Cooldown";
	}
	return "Manual";
}

function formatRelative(value: string | Date | null): string {
	if (!value) {
		return "Never";
	}
	return `${dayjs(value).fromNow(true)} ago`;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}
