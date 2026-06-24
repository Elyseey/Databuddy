"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { NoticeBanner } from "@/app/(main)/websites/_components/notice-banner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
	updateWebsiteCache,
	useDeleteWebsite,
	useUpdateWebsite,
	useWebsite,
	type Website,
} from "@/hooks/use-websites";
import { orpc } from "@/lib/orpc";
import { TOAST_MESSAGES } from "../../_components/constants/settings-constants";
import {
	ArrowRightIcon,
	CheckIcon,
	ClipboardIcon,
	GlobeIcon,
	InfoIcon,
	WarningCircleIcon,
} from "@databuddy/ui/icons";
import { DeleteDialog, Switch } from "@databuddy/ui/client";
import {
	Badge,
	Button,
	Card,
	Field,
	Input,
	SettingsZone,
	SettingsZoneRow,
	Skeleton,
} from "@databuddy/ui";

function GeneralSettingsSkeleton() {
	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-2xl space-y-6 p-5">
				{[1, 2, 3].map((index) => (
					<Card key={`general-settings-skeleton-${index}`}>
						<Card.Header>
							<Skeleton className="h-5 w-32" />
							<Skeleton className="h-4 w-64 max-w-full" />
						</Card.Header>
						<Card.Content className="space-y-4">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
						</Card.Content>
					</Card>
				))}
			</div>
		</div>
	);
}

export default function GeneralSettingsPage() {
	const params = useParams();
	const router = useRouter();
	const websiteId = params.id as string;
	const { data: websiteData } = useWebsite(websiteId);
	const updateWebsiteMutation = useUpdateWebsite();
	const deleteWebsiteMutation = useDeleteWebsite();
	const queryClient = useQueryClient();

	const [showDeleteDialog, setShowDeleteDialog] = useState(false);
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");

	const toggleMutation = useMutation({
		...orpc.websites.togglePublic.mutationOptions(),
		onSuccess: (updatedWebsite: Website) => {
			updateWebsiteCache(queryClient, updatedWebsite);
			queryClient.invalidateQueries({
				queryKey: orpc.websites.getPublicSummary.key(),
			});
		},
	});

	useEffect(() => {
		if (!websiteData) {
			return;
		}
		setName(websiteData.name ?? "");
		setDomain(websiteData.domain ?? "");
	}, [websiteData]);

	const { isCopied: copiedId, copyToClipboard: copyId } = useCopyToClipboard({
		onCopy: () => toast.success("Client ID copied to clipboard"),
	});
	const { isCopied: copiedLink, copyToClipboard: copyLink } =
		useCopyToClipboard({
			onCopy: () => toast.success("Public link copied to clipboard"),
		});

	const isPublic = websiteData?.isPublic ?? false;
	const shareableLink = useMemo(() => {
		if (!(websiteData && typeof window !== "undefined")) {
			return "";
		}
		return `${window.location.origin}/public/${websiteId}`;
	}, [websiteData, websiteId]);

	const hasChanges =
		!!websiteData &&
		(name.trim() !== (websiteData.name ?? "") ||
			domain.trim() !== (websiteData.domain ?? ""));

	const handleDiscard = useCallback(() => {
		if (!websiteData) {
			return;
		}
		setName(websiteData.name ?? "");
		setDomain(websiteData.domain ?? "");
	}, [websiteData]);

	const handleSave = useCallback(async () => {
		if (!(websiteData && hasChanges)) {
			return;
		}

		await toast.promise(
			updateWebsiteMutation.mutateAsync({
				id: websiteId,
				name: name.trim(),
				domain: domain.trim(),
			}),
			{
				loading: "Updating website details...",
				success: "Website details updated",
				error: "Failed to update website details",
			}
		);
	}, [domain, hasChanges, name, updateWebsiteMutation, websiteData, websiteId]);

	const handleDeleteWebsite = useCallback(async () => {
		if (!websiteData) {
			return;
		}
		try {
			await toast.promise(
				deleteWebsiteMutation.mutateAsync({ id: websiteId }),
				{
					loading: TOAST_MESSAGES.WEBSITE_DELETING,
					success: () => {
						router.push("/websites");
						return TOAST_MESSAGES.WEBSITE_DELETED;
					},
					error: TOAST_MESSAGES.WEBSITE_DELETE_ERROR,
				}
			);
		} catch {
			// handled by toast
		}
	}, [websiteData, websiteId, deleteWebsiteMutation, router]);

	const handleTogglePublic = useCallback(
		(checked: boolean) => {
			if (!websiteData) {
				return;
			}
			toast.promise(
				toggleMutation.mutateAsync({ id: websiteId, isPublic: checked }),
				{
					loading: "Updating privacy settings...",
					success: "Privacy settings updated",
					error: "Failed to update privacy settings",
				}
			);
		},
		[websiteData, websiteId, toggleMutation]
	);

	if (!websiteData) {
		return <GeneralSettingsSkeleton />;
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto max-w-2xl space-y-6 p-5">
					<Card>
						<Card.Header>
							<Card.Title>Website Details</Card.Title>
							<Card.Description>
								Client identifier, display name, and registered domain
							</Card.Description>
						</Card.Header>
						<Card.Content className="space-y-5">
							<div className="flex items-center gap-3 rounded bg-secondary px-4 py-3">
								<div className="flex size-7 shrink-0 items-center justify-center rounded bg-accent">
									<GlobeIcon className="size-4 text-muted-foreground" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="font-semibold text-foreground text-xs">
										Client ID
									</p>
									<p className="truncate font-mono text-muted-foreground text-xs">
										{websiteId}
									</p>
								</div>
								<Button
									onClick={() => copyId(websiteId)}
									size="sm"
									variant={copiedId ? "primary" : "ghost"}
								>
									{copiedId ? (
										<CheckIcon className="size-4 shrink-0" weight="bold" />
									) : (
										<ClipboardIcon
											className="size-4 shrink-0"
											weight="duotone"
										/>
									)}
									{copiedId ? "Copied" : "Copy"}
								</Button>
							</div>

							<div className="grid gap-5 sm:grid-cols-2">
								<Field>
									<Field.Label>Name</Field.Label>
									<Input
										onChange={(event) => setName(event.target.value)}
										placeholder="e.g., Marketing Website"
										value={name}
									/>
									<Field.Description>
										Shown in the dashboard and website switcher
									</Field.Description>
								</Field>

								<Field>
									<Field.Label>Domain</Field.Label>
									<Input
										onChange={(event) => setDomain(event.target.value)}
										placeholder="example.com"
										value={domain}
									/>
									<Field.Description>
										Used to identify first-party traffic
									</Field.Description>
								</Field>
							</div>
						</Card.Content>
					</Card>

					<Card>
						<Card.Header className="flex-row items-start justify-between gap-4">
							<div className="space-y-1.5">
								<Card.Title>Public Sharing</Card.Title>
								<Card.Description>
									Anyone with the link can view a read-only public analytics
									page.
								</Card.Description>
							</div>
							<Switch
								aria-label="Toggle public access"
								checked={isPublic}
								disabled={toggleMutation.isPending}
								onCheckedChange={handleTogglePublic}
							/>
						</Card.Header>
						<Card.Content className="space-y-3">
							<div className="flex items-center gap-2">
								<p className="font-medium text-sm">Public overview link</p>
								<Badge variant={isPublic ? "success" : "muted"}>
									{isPublic ? "Enabled" : "Disabled"}
								</Badge>
							</div>
							<div className="flex items-center gap-2">
								<code className="min-w-0 flex-1 overflow-x-auto break-all rounded border bg-secondary px-3 py-2 font-mono text-xs">
									{shareableLink || `/public/${websiteId}`}
								</code>
								<Button
									aria-label="Copy public overview link"
									disabled={!(isPublic && shareableLink)}
									onClick={() => copyLink(shareableLink)}
									size="sm"
									variant="ghost"
								>
									{copiedLink ? (
										<CheckIcon className="size-4 text-success" weight="bold" />
									) : (
										<ClipboardIcon className="size-4" />
									)}
								</Button>
							</div>
							<NoticeBanner
								description={
									isPublic
										? "This URL opens your public overview only. Visitors cannot access settings, private analytics sections, or delete your site."
										: "Enable public sharing to publish a read-only overview link for this website."
								}
								icon={<InfoIcon />}
							/>
						</Card.Content>
					</Card>

					<Card>
						<Card.Header className="flex-row items-start justify-between gap-4">
							<div className="space-y-1.5">
								<Card.Title>Transfer Website</Card.Title>
								<Card.Description>
									Move this website to another organization without deleting
									analytics data.
								</Card.Description>
							</div>
							<Button
								onClick={() =>
									router.push(`/websites/${websiteId}/settings/transfer`)
								}
								size="sm"
								variant="secondary"
							>
								Transfer
								<ArrowRightIcon className="size-4 shrink-0" weight="bold" />
							</Button>
						</Card.Header>
					</Card>

					<SettingsZone title="Destructive actions" variant="destructive">
						<SettingsZoneRow
							action={{
								label: "Delete",
								onClick: () => setShowDeleteDialog(true),
							}}
							description="Permanently delete this website and all its data"
							title="Delete website"
						/>
					</SettingsZone>
				</div>
			</div>

			{hasChanges && (
				<div className="angled-rectangle-gradient sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t bg-secondary px-5 py-4">
					<p className="text-muted-foreground text-sm">
						You have unsaved changes
					</p>
					<div className="flex items-center gap-2">
						<Button onClick={handleDiscard} size="sm" variant="ghost">
							Discard
						</Button>
						<Button
							keyboard={{
								display: "⌘S",
								trigger: (event) =>
									(event.metaKey || event.ctrlKey) && event.key === "s",
								callback: handleSave,
							}}
							loading={updateWebsiteMutation.isPending}
							onClick={handleSave}
							size="sm"
						>
							Save Changes
						</Button>
					</div>
				</div>
			)}

			<DeleteDialog
				confirmLabel="Delete Website"
				description={`Are you sure you want to delete ${websiteData.name || websiteData.domain}?`}
				isDeleting={deleteWebsiteMutation.isPending}
				isOpen={showDeleteDialog}
				itemName={websiteData.name || websiteData.domain}
				onClose={() => setShowDeleteDialog(false)}
				onConfirm={handleDeleteWebsite}
				title="Delete Website"
			>
				<div className="rounded border bg-secondary p-3 text-sm">
					<div className="flex items-start gap-2">
						<WarningCircleIcon className="size-5 shrink-0 text-destructive" />
						<div className="space-y-1">
							<p className="font-medium">Warning:</p>
							<ul className="list-disc space-y-1 pl-4 text-xs">
								<li>All analytics data will be permanently deleted</li>
								<li>Tracking will stop immediately</li>
								<li>All website settings will be lost</li>
							</ul>
						</div>
					</div>
				</div>
			</DeleteDialog>
		</div>
	);
}
