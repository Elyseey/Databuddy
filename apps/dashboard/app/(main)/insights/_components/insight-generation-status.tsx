"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { InsightsAiResponse } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	ClockIcon,
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

	const latestRun = useMemo(
		() => (runsQuery.data?.runs?.[0] as InsightRunSummary | undefined) ?? null,
		[runsQuery.data?.runs]
	);
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
			? ((latestRun.completedItems +
					latestRun.failedItems +
					latestRun.skippedItems) /
					latestRun.totalItems) *
				100
			: activeQueuedRun?.queuedItems
				? 2
				: 0;

	return (
		<Card aria-label="Insight generation status">
			<Card.Header className="flex-row items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<ClockIcon
						aria-hidden
						className="size-4 shrink-0 text-primary"
						weight="duotone"
					/>
					<div className="min-w-0">
						<Card.Title>Generation</Card.Title>
						<Card.Description>{statusLabel(status)}</Card.Description>
					</div>
				</div>
				<StatusBadge status={status} />
			</Card.Header>

			<Card.Content className="space-y-3">
				{runsQuery.isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-3 w-3/5 rounded" />
						<Skeleton className="h-2 w-full rounded" />
					</div>
				) : latestRun ? (
					<>
						<Progress
							size="sm"
							tone={progressTone(latestRun.status)}
							value={progress}
						/>
						<div className="grid gap-2 text-muted-foreground text-xs sm:grid-cols-4">
							<Stat
								label="Items"
								value={`${settledItems(latestRun)}/${latestRun.totalItems}`}
							/>
							<Stat
								label="Succeeded"
								value={String(latestRun.completedItems)}
							/>
							<Stat label="Failed" value={String(latestRun.failedItems)} />
							<Stat
								label="Updated"
								value={formatRelative(
									latestRun.finishedAt ?? latestRun.updatedAt
								)}
							/>
						</div>
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
					<p className="text-muted-foreground text-xs">No runs yet.</p>
				)}
			</Card.Content>
		</Card>
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
		<div className="flex min-w-0 items-center justify-between gap-2 sm:block">
			<p>{label}</p>
			<p className="truncate font-medium text-foreground tabular-nums">
				{value}
			</p>
		</div>
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

function formatRelative(value: string | Date | null): string {
	if (!value) {
		return "Never";
	}
	return `${dayjs(value).fromNow(true)} ago`;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}
