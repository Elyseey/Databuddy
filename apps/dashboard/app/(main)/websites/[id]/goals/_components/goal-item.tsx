"use client";

import { List } from "@/components/ui/composables/list";
import { Skeleton } from "@databuddy/ui";
import type { Goal, GoalAnalyticsResult } from "@/hooks/use-goals";
import { formatNumber } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
	DotsThreeIcon,
	EyeIcon,
	MouseMiddleClickIcon,
	PencilSimpleIcon,
	TrashIcon,
	WarningCircleIcon,
} from "@databuddy/ui/icons";
import { DropdownMenu } from "@databuddy/ui/client";

interface GoalItemProps {
	analytics?: GoalAnalyticsResult;
	goal: Goal;
	isLoadingAnalytics?: boolean;
	onDelete: (goalId: string) => void;
	onEdit: (goal: Goal) => void;
}

const GOAL_TYPE_CONFIG = {
	PAGE_VIEW: {
		icon: EyeIcon,
		bg: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	},
	EVENT: {
		icon: MouseMiddleClickIcon,
		bg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
	},
	CUSTOM: {
		icon: MouseMiddleClickIcon,
		bg: "bg-muted text-muted-foreground",
	},
} as const;

function GoalProgress({ rate }: { rate: number }) {
	const clampedRate = Math.max(0, Math.min(100, rate));
	return (
		<div className="h-2 w-32 overflow-hidden rounded-full bg-muted lg:w-44">
			<div
				className="h-full rounded-full bg-chart-1 transition-[width]"
				style={{ width: `${clampedRate}%` }}
			/>
		</div>
	);
}

export function GoalItem({
	goal,
	analytics,
	isLoadingAnalytics,
	onEdit,
	onDelete,
}: GoalItemProps) {
	const analyticsData = analytics?.ok ? analytics.data : null;
	const analyticsError = analytics && !analytics.ok ? analytics.error : null;
	const rate = analyticsData?.overall_conversion_rate ?? 0;
	const users = analyticsData?.total_users_completed ?? 0;
	const eligibleUsers = analyticsData?.total_users_entered ?? 0;
	const config = GOAL_TYPE_CONFIG[goal.type];
	const TypeIcon = config.icon;

	return (
		<List.Row align="start" className={cn(!goal.isActive && "opacity-50")}>
			<List.Cell className="pt-0.5">
				<div
					className={cn(
						"flex size-8 items-center justify-center rounded",
						config.bg
					)}
				>
					<TypeIcon className="size-4" weight="duotone" />
				</div>
			</List.Cell>

			<List.Cell className="w-40 min-w-0 lg:w-52">
				<p className="wrap-break-word text-pretty font-medium text-foreground text-sm">
					{goal.name}
				</p>
			</List.Cell>

			<List.Cell grow>
				<p className="wrap-break-word text-pretty text-muted-foreground text-xs">
					{goal.target}
				</p>
			</List.Cell>

			<List.Cell className="hidden items-start gap-3 pt-0.5 lg:flex">
				{isLoadingAnalytics ? (
					<>
						<Skeleton className="h-5 w-32 rounded lg:w-44" />
						<div className="flex flex-col items-end gap-0.5">
							<Skeleton className="h-4 w-10 rounded" />
							<Skeleton className="h-3 w-8 rounded" />
						</div>
						<div className="flex flex-col items-end gap-0.5">
							<Skeleton className="h-4 w-10 rounded" />
							<Skeleton className="h-3 w-8 rounded" />
						</div>
					</>
				) : analyticsError ? (
					<div className="flex w-72 items-center justify-end gap-2 text-destructive text-xs">
						<WarningCircleIcon className="size-4 shrink-0" weight="duotone" />
						<span className="truncate">{analyticsError}</span>
					</div>
				) : (
					<>
						<GoalProgress rate={rate} />
						<div className="flex w-16 flex-col items-end">
							<span className="font-semibold text-sm tabular-nums">
								{formatNumber(users)}
							</span>
							<span className="text-muted-foreground text-xs">Completed</span>
						</div>
						<div className="flex w-20 flex-col items-end">
							<span className="font-semibold text-sm tabular-nums">
								{formatNumber(eligibleUsers)}
							</span>
							<span className="text-muted-foreground text-xs">Eligible</span>
						</div>
						<div className="flex w-16 flex-col items-end">
							<span className="font-semibold text-sm text-success tabular-nums">
								{rate.toFixed(1)}%
							</span>
							<span className="text-muted-foreground text-xs">Conversion</span>
						</div>
					</>
				)}
			</List.Cell>

			<List.Cell className="w-14 pt-0.5 text-right lg:hidden">
				{isLoadingAnalytics ? (
					<Skeleton className="ms-auto h-4 w-12 rounded" />
				) : analyticsError ? (
					<WarningCircleIcon
						className="ms-auto size-4 text-destructive"
						weight="duotone"
					/>
				) : (
					<span className="font-semibold text-sm tabular-nums">
						{rate.toFixed(1)}%
					</span>
				)}
			</List.Cell>

			<List.Cell action className="pt-0.5">
				<DropdownMenu>
					<DropdownMenu.Trigger
						aria-label="Goal actions"
						className="inline-flex size-8 items-center justify-center gap-1.5 rounded-md bg-transparent p-0 font-medium text-muted-foreground opacity-50 transition-all duration-(--duration-quick) ease-(--ease-smooth) hover:bg-interactive-hover hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:opacity-100"
						data-dropdown-trigger
					>
						<DotsThreeIcon className="size-5" weight="bold" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" className="w-40">
						<DropdownMenu.Item className="gap-2" onClick={() => onEdit(goal)}>
							<PencilSimpleIcon className="size-4" weight="duotone" />
							Edit
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							className="gap-2 text-destructive focus:text-destructive"
							onClick={() => onDelete(goal.id)}
							variant="destructive"
						>
							<TrashIcon className="size-4 fill-destructive" weight="duotone" />
							Delete
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu>
			</List.Cell>
		</List.Row>
	);
}

export function GoalItemSkeleton() {
	return (
		<div className="flex h-15 items-center gap-4 border-border/80 border-b px-4 last:border-b-0">
			<Skeleton className="size-8 rounded" />
			<div className="min-w-0 flex-1 space-y-1.5">
				<Skeleton className="h-4 w-36" />
				<Skeleton className="h-3 w-48 max-w-full" />
			</div>
			<div className="hidden items-center gap-3 lg:flex">
				<Skeleton className="h-5 w-32 rounded lg:w-44" />
				<Skeleton className="h-4 w-10 rounded" />
				<Skeleton className="h-4 w-10 rounded" />
			</div>
			<Skeleton className="ms-auto h-4 w-12 rounded lg:hidden" />
			<Skeleton className="size-8 rounded" />
		</div>
	);
}
