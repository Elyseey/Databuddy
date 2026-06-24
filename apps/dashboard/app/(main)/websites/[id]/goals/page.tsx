"use client";

import { GATED_FEATURES } from "@databuddy/shared/types/features";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { FeatureGate } from "@/components/feature-gate";
import { List } from "@/components/ui/composables/list";
import { useAutocompleteData } from "@/hooks/use-autocomplete";
import { useDateFilters } from "@/hooks/use-date-filters";
import {
	type CreateGoalData,
	type Goal,
	type GoalAnalyticsRecord,
	useBulkGoalAnalytics,
	useGoals,
} from "@/hooks/use-goals";
import { TopBar } from "@/components/layout/top-bar";
import { dynamicQueryFiltersAtom } from "@/stores/jotai/filterAtoms";
import type { DynamicQueryFilter, GoalFilter } from "@/types/api";
import { EditGoalDialog } from "./_components/edit-goal-dialog";
import { GoalItemSkeleton } from "./_components/goal-item";
import { GoalsList } from "./_components/goals-list";
import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	PlusIcon,
	TargetIcon,
	TrendUpIcon,
} from "@databuddy/ui/icons";
import { Button, Card } from "@databuddy/ui";
import { DeleteDialog } from "@databuddy/ui/client";
import { formatNumber } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";

function GoalsListSkeleton() {
	return (
		<List className="rounded bg-card">
			{[1, 2, 3].map((i) => (
				<GoalItemSkeleton key={i} />
			))}
		</List>
	);
}

const filterOperatorMap = {
	contains: "contains",
	eq: "equals",
	in: "in",
	ne: "not_equals",
	not_contains: "not_contains",
	not_in: "not_in",
	starts_with: "starts_with",
} satisfies Record<DynamicQueryFilter["operator"], GoalFilter["operator"]>;

function toGoalFilters(filters: DynamicQueryFilter[]): GoalFilter[] {
	return filters.map((filter) => ({
		field: filter.field,
		operator: filterOperatorMap[filter.operator],
		value: Array.isArray(filter.value)
			? filter.value.map(String)
			: String(filter.value),
	}));
}

function GoalsSummary({
	analytics,
	goals,
	isLoading,
}: {
	analytics?: GoalAnalyticsRecord;
	goals: Goal[];
	isLoading: boolean;
}) {
	const results = Object.values(analytics ?? {}).filter((result) => result.ok);
	const completions = results.reduce(
		(total, result) => total + result.data.total_users_completed,
		0
	);
	const averageConversion =
		results.length > 0
			? results.reduce(
					(total, result) => total + result.data.overall_conversion_rate,
					0
				) / results.length
			: 0;

	const cards = [
		{
			icon: TargetIcon,
			label: "Active goals",
			value: formatNumber(goals.filter((goal) => goal.isActive).length),
		},
		{
			icon: CheckCircleIcon,
			label: "Completions",
			value: formatNumber(completions),
		},
		{
			icon: TrendUpIcon,
			label: "Avg. conversion",
			value: `${averageConversion.toFixed(1)}%`,
		},
	];

	return (
		<div className="grid gap-3 md:grid-cols-3">
			{cards.map(({ icon: Icon, label, value }) => (
				<Card className="rounded" key={label}>
					<Card.Content className="flex items-center gap-3 p-4">
						<div className="flex size-9 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
							<Icon className="size-4" weight="duotone" />
						</div>
						<div className="min-w-0">
							<p className="text-muted-foreground text-xs">{label}</p>
							{isLoading ? (
								<div className="mt-1 h-5 w-16 animate-pulse rounded bg-muted" />
							) : (
								<p className="font-semibold text-foreground text-lg tabular-nums">
									{value}
								</p>
							)}
						</div>
					</Card.Content>
				</Card>
			))}
		</div>
	);
}

export default function GoalsPage() {
	const { id } = useParams();
	const websiteId = id as string;
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
	const [deletingGoalId, setDeletingGoalId] = useState<string | null>(null);

	const { dateRange } = useDateFilters();
	const globalFilters = useAtomValue(dynamicQueryFiltersAtom);
	const goalFilters = useMemo(
		() => toGoalFilters(globalFilters),
		[globalFilters]
	);

	const {
		data: goals,
		listOutcome,
		isFetching,
		error,
		refreshAction,
		createGoal,
		updateGoal,
		deleteGoal,
		isCreating,
		isUpdating,
	} = useGoals(websiteId);

	const goalIds = useMemo(() => goals.map((goal) => goal.id), [goals]);

	const { data: goalAnalytics, isLoading: analyticsLoading } =
		useBulkGoalAnalytics(websiteId, goalIds, dateRange, goalFilters, {
			enabled: goalIds.length > 0,
		});

	const autocompleteQuery = useAutocompleteData(websiteId);

	const handleSaveGoal = async (
		data: Goal | Omit<CreateGoalData, "websiteId">
	) => {
		try {
			if ("id" in data && data.id) {
				await updateGoal({
					goalId: data.id,
					updates: {
						name: data.name,
						description: data.description || undefined,
						type: data.type,
						target: data.target,
						filters: data.filters,
						ignoreHistoricData:
							"ignoreHistoricData" in data
								? data.ignoreHistoricData
								: undefined,
					},
				});
			} else {
				await createGoal({
					name: data.name,
					description: data.description || undefined,
					type: data.type,
					target: data.target,
					filters: data.filters,
					ignoreHistoricData:
						"ignoreHistoricData" in data ? data.ignoreHistoricData : undefined,
					websiteId,
				} as CreateGoalData);
			}
			setIsDialogOpen(false);
			setEditingGoal(null);
		} catch (error) {
			console.error("Failed to save goal:", error);
		}
	};

	const handleDeleteGoal = async (goalId: string) => {
		try {
			await deleteGoal(goalId);
			setDeletingGoalId(null);
		} catch (error) {
			console.error("Failed to delete goal:", error);
		}
	};

	return (
		<FeatureGate feature={GATED_FEATURES.GOALS}>
			<div className="relative flex h-full flex-col">
				<TopBar.Title>
					<h1 className="font-semibold text-sm">Goals</h1>
				</TopBar.Title>
				<TopBar.Actions>
					<Button
						aria-label="Refresh"
						disabled={isFetching}
						onClick={refreshAction}
						size="sm"
						variant="secondary"
					>
						<ArrowClockwiseIcon
							className={cn("size-4 shrink-0", isFetching && "animate-spin")}
						/>
					</Button>
					<Button
						onClick={() => {
							setEditingGoal(null);
							setIsDialogOpen(true);
						}}
						size="sm"
					>
						<PlusIcon className="size-4 shrink-0" />
						Create Goal
					</Button>
				</TopBar.Actions>

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
					<div className="space-y-4 p-4 sm:p-5">
						<List.Content
							emptyProps={{
								action: {
									label: "Create a goal",
									onClick: () => {
										setEditingGoal(null);
										setIsDialogOpen(true);
									},
								},
								description:
									"Track single-step conversions like signups, purchases, or activation events.",
								icon: <TargetIcon className="size-6" weight="duotone" />,
								title: "No goals yet",
							}}
							errorProps={{
								action: { label: "Retry", onClick: () => refreshAction() },
								description:
									error?.message ??
									"Something went wrong while loading goal data.",
								icon: <TargetIcon className="size-6" weight="duotone" />,
								title: "Failed to load goals",
							}}
							loading={<GoalsListSkeleton />}
							outcome={listOutcome}
						>
							{(items) => (
								<>
									<GoalsSummary
										analytics={goalAnalytics}
										goals={items}
										isLoading={analyticsLoading}
									/>
									<GoalsList
										analyticsLoading={analyticsLoading}
										goalAnalytics={goalAnalytics}
										goals={items}
										onDeleteGoal={(goalId) => setDeletingGoalId(goalId)}
										onEditGoal={(goal) => {
											setEditingGoal(goal);
											setIsDialogOpen(true);
										}}
									/>
								</>
							)}
						</List.Content>
					</div>
				</div>

				{isDialogOpen && (
					<EditGoalDialog
						autocompleteData={autocompleteQuery.data}
						goal={editingGoal}
						isOpen={isDialogOpen}
						isSaving={isCreating || isUpdating}
						onClose={() => {
							setIsDialogOpen(false);
							setEditingGoal(null);
						}}
						onSave={handleSaveGoal}
					/>
				)}

				{deletingGoalId && (
					<DeleteDialog
						confirmLabel="Delete Goal"
						description="Are you sure you want to delete this goal? This action cannot be undone and will permanently remove all associated analytics data."
						isOpen={!!deletingGoalId}
						onClose={() => setDeletingGoalId(null)}
						onConfirm={() => {
							if (deletingGoalId) {
								return handleDeleteGoal(deletingGoalId);
							}
						}}
						title="Delete Goal"
					/>
				)}
			</div>
		</FeatureGate>
	);
}
