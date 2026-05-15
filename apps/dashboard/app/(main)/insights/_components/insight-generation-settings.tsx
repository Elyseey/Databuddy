"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { insightQueries } from "@/lib/insight-api";
import { orpc } from "@/lib/orpc";
import { FloppyDiskIcon, GearIcon, MediaPlayIcon } from "@databuddy/ui/icons";
import {
	Badge,
	Button,
	Card,
	Field,
	Input,
	Skeleton,
	guessTimezone,
} from "@databuddy/ui";
import { Checkbox, Select, Switch } from "@databuddy/ui/client";

type Depth = "light" | "standard" | "deep";
type Frequency = "hourly" | "daily" | "weekly" | "custom";
type ModelTier = "fast" | "balanced" | "deep";
type ToolName =
	| "web_metrics"
	| "product_metrics"
	| "ops_context"
	| "business_context";

interface WebsiteOption {
	domain: string;
	id: string;
	name: string | null;
}

interface ConfigFormState {
	allowedTools: ToolName[];
	cooldownHours: string;
	cron: string;
	depth: Depth;
	enabled: boolean;
	frequency: Frequency;
	lookbackDays: string;
	maxInsightsPerWebsite: string;
	maxSteps: string;
	maxToolCalls: string;
	modelTier: ModelTier;
	timezone: string;
}

interface InsightGenerationSettingsProps {
	organizationId?: string;
	websites: WebsiteOption[];
}

const DEFAULT_FORM: ConfigFormState = {
	allowedTools: ["web_metrics", "product_metrics", "ops_context"],
	cooldownHours: "6",
	cron: "",
	depth: "standard",
	enabled: true,
	frequency: "weekly",
	lookbackDays: "7",
	maxInsightsPerWebsite: "3",
	maxSteps: "24",
	maxToolCalls: "16",
	modelTier: "balanced",
	timezone: "UTC",
};

const TOOL_OPTIONS: { label: string; value: ToolName }[] = [
	{ label: "Web", value: "web_metrics" },
	{ label: "Product", value: "product_metrics" },
	{ label: "Ops", value: "ops_context" },
	{ label: "Business", value: "business_context" },
];

export function InsightGenerationSettings({
	organizationId,
	websites,
}: InsightGenerationSettingsProps) {
	const queryClient = useQueryClient();
	const [scope, setScope] = useState("organization");
	const websiteId = scope === "organization" ? null : scope;
	const [form, setForm] = useState<ConfigFormState>(DEFAULT_FORM);

	const configQuery = useQuery({
		...orpc.insightGeneration.getConfig.queryOptions({
			input: {
				organizationId,
				websiteId: websiteId ?? undefined,
			},
		}),
		enabled: !!organizationId,
	});

	useEffect(() => {
		const config = configQuery.data;
		if (!config) {
			return;
		}
		setForm({
			allowedTools: normalizeTools(config.allowedTools as ToolName[]),
			cooldownHours: String(config.cooldownHours),
			cron: config.cron ?? "",
			depth: config.depth as Depth,
			enabled: config.enabled,
			frequency: config.frequency as Frequency,
			lookbackDays: String(config.lookbackDays),
			maxInsightsPerWebsite: String(config.maxInsightsPerWebsite),
			maxSteps: String(config.maxSteps),
			maxToolCalls: String(config.maxToolCalls),
			modelTier: config.modelTier as ModelTier,
			timezone: config.timezone || guessTimezone(),
		});
	}, [configQuery.data]);

	const selectedScopeLabel = useMemo(() => {
		if (scope === "organization") {
			return "Organization";
		}
		const website = websites.find((item) => item.id === scope);
		return website?.name || website?.domain || "Website";
	}, [scope, websites]);

	const saveMutation = useMutation({
		...orpc.insightGeneration.upsertConfig.mutationOptions(),
		onSuccess: async () => {
			toast.success("Insights settings saved");
			await invalidateInsightGenerationQueries(queryClient, organizationId);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Could not save settings"
			);
		},
	});

	const triggerMutation = useMutation({
		...orpc.insightGeneration.triggerRun.mutationOptions(),
		onSuccess: async (data) => {
			toast.success(
				data.status === "queued"
					? `Queued ${data.queuedItems} insight job${data.queuedItems === 1 ? "" : "s"}`
					: "No websites available to run"
			);
			await invalidateInsightGenerationQueries(queryClient, organizationId);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Could not start run"
			);
		},
	});

	const isBusy =
		configQuery.isLoading ||
		saveMutation.isPending ||
		triggerMutation.isPending;

	const patch = () => ({
		...formToPatch(form),
		organizationId,
		websiteId: websiteId ?? undefined,
	});

	return (
		<Card aria-label="Insight generation settings">
			<Card.Header className="flex-row items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex items-center gap-2">
						<GearIcon
							aria-hidden
							className="size-4 text-primary"
							weight="duotone"
						/>
						<Card.Title>Controls</Card.Title>
						{configQuery.data?.source && (
							<Badge className="capitalize" size="sm" variant="muted">
								{configQuery.data.source}
							</Badge>
						)}
					</div>
					<Card.Description>{selectedScopeLabel}</Card.Description>
				</div>
				<div className="w-44 shrink-0">
					<Select
						disabled={!organizationId || isBusy}
						onValueChange={(value) => setScope(String(value))}
						value={scope}
					>
						<Select.Trigger>
							<Select.Value />
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="organization">Organization</Select.Item>
							{websites.map((website) => (
								<Select.Item key={website.id} value={website.id}>
									{website.name || website.domain}
								</Select.Item>
							))}
						</Select.Content>
					</Select>
				</div>
			</Card.Header>

			<Card.Content className="space-y-4">
				{configQuery.isLoading ? (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						{Array.from({ length: 8 }).map((_, index) => (
							<Skeleton className="h-14 rounded" key={index} />
						))}
					</div>
				) : (
					<>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<Switch
								checked={form.enabled}
								disabled={isBusy}
								label="Enabled"
								onCheckedChange={(value) =>
									setForm((current) => ({
										...current,
										enabled: Boolean(value),
									}))
								}
							/>

							<Field>
								<Field.Label>Frequency</Field.Label>
								<Select
									disabled={isBusy}
									onValueChange={(value) =>
										setForm((current) => ({
											...current,
											frequency: value as Frequency,
										}))
									}
									value={form.frequency}
								>
									<Select.Trigger>
										<Select.Value />
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="hourly">Hourly</Select.Item>
										<Select.Item value="daily">Daily</Select.Item>
										<Select.Item value="weekly">Weekly</Select.Item>
										<Select.Item value="custom">Custom</Select.Item>
									</Select.Content>
								</Select>
							</Field>

							<Field>
								<Field.Label>Depth</Field.Label>
								<Select
									disabled={isBusy}
									onValueChange={(value) =>
										setForm((current) => ({
											...current,
											depth: value as Depth,
										}))
									}
									value={form.depth}
								>
									<Select.Trigger>
										<Select.Value />
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="light">Light</Select.Item>
										<Select.Item value="standard">Standard</Select.Item>
										<Select.Item value="deep">Deep</Select.Item>
									</Select.Content>
								</Select>
							</Field>

							<Field>
								<Field.Label>Model</Field.Label>
								<Select
									disabled={isBusy}
									onValueChange={(value) =>
										setForm((current) => ({
											...current,
											modelTier: value as ModelTier,
										}))
									}
									value={form.modelTier}
								>
									<Select.Trigger>
										<Select.Value />
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="fast">Fast</Select.Item>
										<Select.Item value="balanced">Balanced</Select.Item>
										<Select.Item value="deep">Deep</Select.Item>
									</Select.Content>
								</Select>
							</Field>
						</div>

						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<NumberField
								disabled={isBusy}
								label="Lookback"
								max={90}
								min={1}
								onChange={(value) =>
									setForm((current) => ({ ...current, lookbackDays: value }))
								}
								suffix="days"
								value={form.lookbackDays}
							/>
							<NumberField
								disabled={isBusy}
								label="Cards"
								max={10}
								min={1}
								onChange={(value) =>
									setForm((current) => ({
										...current,
										maxInsightsPerWebsite: value,
									}))
								}
								suffix="per site"
								value={form.maxInsightsPerWebsite}
							/>
							<NumberField
								disabled={isBusy}
								label="Steps"
								max={64}
								min={1}
								onChange={(value) =>
									setForm((current) => ({ ...current, maxSteps: value }))
								}
								value={form.maxSteps}
							/>
							<NumberField
								disabled={isBusy}
								label="Tool calls"
								max={64}
								min={1}
								onChange={(value) =>
									setForm((current) => ({ ...current, maxToolCalls: value }))
								}
								value={form.maxToolCalls}
							/>
						</div>

						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<NumberField
								disabled={isBusy}
								label="Cooldown"
								max={168}
								min={1}
								onChange={(value) =>
									setForm((current) => ({ ...current, cooldownHours: value }))
								}
								suffix="hours"
								value={form.cooldownHours}
							/>
							<Field className="lg:col-span-2">
								<Field.Label>Cron</Field.Label>
								<Input
									disabled={isBusy || form.frequency !== "custom"}
									onChange={(event) =>
										setForm((current) => ({
											...current,
											cron: event.target.value,
										}))
									}
									placeholder="0 9 * * 1"
									value={form.cron}
								/>
							</Field>
							<Field>
								<Field.Label>Timezone</Field.Label>
								<Input
									disabled={isBusy}
									onChange={(event) =>
										setForm((current) => ({
											...current,
											timezone: event.target.value,
										}))
									}
									value={form.timezone}
								/>
							</Field>
						</div>

						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							{TOOL_OPTIONS.map((tool) => (
								<Checkbox
									checked={form.allowedTools.includes(tool.value)}
									disabled={isBusy || tool.value === "web_metrics"}
									key={tool.value}
									label={tool.label}
									onCheckedChange={(checked) =>
										setForm((current) => ({
											...current,
											allowedTools: toggleTool(
												current.allowedTools,
												tool.value,
												Boolean(checked)
											),
										}))
									}
								/>
							))}
						</div>
					</>
				)}
			</Card.Content>

			<Card.Footer>
				<Button
					disabled={!organizationId || isBusy}
					onClick={() => saveMutation.mutate(patch())}
					size="sm"
					type="button"
					variant="secondary"
				>
					<FloppyDiskIcon className="size-4" />
					Save
				</Button>
				<Button
					disabled={!organizationId || isBusy}
					onClick={() =>
						triggerMutation.mutate({
							...formToPatch(form),
							force: true,
							organizationId,
							websiteIds: websiteId ? [websiteId] : undefined,
						})
					}
					size="sm"
					type="button"
				>
					<MediaPlayIcon className="size-4" />
					Run now
				</Button>
			</Card.Footer>
		</Card>
	);
}

function NumberField({
	disabled,
	label,
	max,
	min,
	onChange,
	suffix,
	value,
}: {
	disabled: boolean;
	label: string;
	max: number;
	min: number;
	onChange: (value: string) => void;
	suffix?: string;
	value: string;
}) {
	return (
		<Field>
			<Field.Label>{label}</Field.Label>
			<Input
				disabled={disabled}
				max={max}
				min={min}
				onChange={(event) => onChange(event.target.value)}
				suffix={suffix}
				type="number"
				value={value}
			/>
		</Field>
	);
}

function normalizeTools(tools: ToolName[]): ToolName[] {
	const unique = new Set<ToolName>(tools);
	unique.add("web_metrics");
	return TOOL_OPTIONS.map((tool) => tool.value).filter((tool) =>
		unique.has(tool)
	);
}

function toggleTool(
	current: ToolName[],
	tool: ToolName,
	enabled: boolean
): ToolName[] {
	if (tool === "web_metrics") {
		return normalizeTools(current);
	}
	const next = new Set<ToolName>(current);
	if (enabled) {
		next.add(tool);
	} else {
		next.delete(tool);
	}
	next.add("web_metrics");
	return normalizeTools([...next]);
}

function boundedInt(
	value: string,
	fallback: number,
	min: number,
	max: number
): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, parsed));
}

function formToPatch(form: ConfigFormState) {
	return {
		allowedTools: normalizeTools(form.allowedTools),
		cooldownHours: boundedInt(form.cooldownHours, 6, 1, 168),
		cron: form.frequency === "custom" ? form.cron.trim() || null : null,
		depth: form.depth,
		enabled: form.enabled,
		frequency: form.frequency,
		lookbackDays: boundedInt(form.lookbackDays, 7, 1, 90),
		maxInsightsPerWebsite: boundedInt(form.maxInsightsPerWebsite, 3, 1, 10),
		maxSteps: boundedInt(form.maxSteps, 24, 1, 64),
		maxToolCalls: boundedInt(form.maxToolCalls, 16, 1, 64),
		modelTier: form.modelTier,
		timezone: form.timezone.trim() || guessTimezone(),
	};
}

async function invalidateInsightGenerationQueries(
	queryClient: ReturnType<typeof useQueryClient>,
	organizationId?: string
) {
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: orpc.insightGeneration.key() }),
		queryClient.invalidateQueries({ queryKey: insightQueries.all() }),
		organizationId
			? queryClient.invalidateQueries({
					queryKey: insightQueries.ai(organizationId).queryKey,
				})
			: Promise.resolve(),
	]);
}
