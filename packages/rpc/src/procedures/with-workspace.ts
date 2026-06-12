import { hasKeyScope } from "@databuddy/api-keys/resolve";
import { requiredScopesForResource } from "@databuddy/api-keys/scopes";
import {
	type PermissionFor,
	type ResourceType,
	roleHasPermission,
	type User,
} from "@databuddy/auth";
import { db } from "@databuddy/db";
import { cacheNamespaces, cacheable } from "@databuddy/redis";
import type { PlanId } from "@databuddy/shared/types/features";
import { z } from "zod";
import { rpcError } from "../errors";
import { type Context, os } from "../orpc";
import { getMemberRole, getOrganizationOwnerId } from "../utils/organization";

type Website = NonNullable<Awaited<ReturnType<typeof getWebsiteById>>>;

export type WorkspaceTier = "authed" | "demo";

export interface Workspace {
	getCreatedBy: () => Promise<string>;
	organizationId: string;
	plan: PlanId;
	role: string | null;
	tier: WorkspaceTier;
	user: User | null;
	website: Website | null;
}

export interface WithWorkspaceOptions<R extends ResourceType = "organization"> {
	allowCrossOrg?: boolean;
	allowPublicAccess?: boolean;
	organizationId?: string | null;
	permissions?: PermissionFor<R>[];
	requiredPlans?: PlanId[];
	resource?: R;
	websiteId?: string;
}

const getWebsiteById = cacheable(
	async (id: string) => {
		if (!id) {
			return null;
		}
		return await db.query.websites.findFirst({
			where: { id },
		});
	},
	{
		expireInSec: 600,
		prefix: cacheNamespaces.websiteById,
		staleWhileRevalidate: true,
		staleTime: 60,
	}
);

async function getPlanId(context: Context): Promise<PlanId> {
	const billing = await context.getBilling();
	return (billing?.planId ?? "free") as PlanId;
}

function requirePlan(plan: PlanId, requiredPlans: PlanId[] | undefined): void {
	if (!requiredPlans?.length) {
		return;
	}
	if (!requiredPlans.includes(plan)) {
		throw rpcError.featureUnavailable("workspace_action", requiredPlans.at(0));
	}
}

async function requireWebsite(websiteId: string): Promise<Website> {
	const website = await getWebsiteById(websiteId);
	if (!website) {
		throw rpcError.notFound("website", websiteId);
	}
	return website;
}

const READ_ONLY_PERMISSIONS = new Set(["read", "view_analytics"]);

function isReadOnly(permissions: string[]): boolean {
	return permissions.every((p) => READ_ONLY_PERMISSIONS.has(p));
}

type Grant =
	| { granted: true; user: User; role: string }
	| { granted: true; user: null; role: null }
	| { granted: false; denied: Error };

async function resolveGrant(
	context: Context,
	input: {
		organizationId: string;
		resource: string;
		permissions: string[];
		allowCrossOrg: boolean;
	}
): Promise<Grant> {
	const { organizationId, resource, permissions, allowCrossOrg } = input;

	if (context.user) {
		if (
			!allowCrossOrg &&
			context.organizationId &&
			context.organizationId !== organizationId
		) {
			return {
				granted: false,
				denied: rpcError.forbidden(
					"Resource does not belong to the active organization"
				),
			};
		}

		const role = await getMemberRole(context.user.id, organizationId);
		if (!role) {
			return {
				granted: false,
				denied: rpcError.forbidden("You are not a member of this organization"),
			};
		}

		if (
			permissions.length > 0 &&
			!roleHasPermission(role, resource, permissions)
		) {
			return {
				granted: false,
				denied: rpcError.forbidden(
					`Missing required ${resource} permissions: ${permissions.join(", ")}`
				),
			};
		}

		return { granted: true, user: context.user, role };
	}

	if (context.apiKey) {
		if (context.apiKey.organizationId !== organizationId) {
			return {
				granted: false,
				denied: rpcError.forbidden(
					"API key does not have access to this workspace"
				),
			};
		}

		for (const scope of requiredScopesForResource(resource, permissions)) {
			if (!hasKeyScope(context.apiKey, scope)) {
				return {
					granted: false,
					denied: rpcError.forbidden(
						`API key missing required scope: ${scope}`
					),
				};
			}
		}

		return { granted: true, user: null, role: null };
	}

	return { granted: false, denied: rpcError.unauthorized() };
}

export const workspaceInputSchema = z.object({
	organizationId: z.string().nullish(),
});

export async function withWorkspace<R extends ResourceType = "organization">(
	context: Context,
	options: WithWorkspaceOptions<R> & { websiteId: string }
): Promise<Workspace & { website: Website }>;
export async function withWorkspace<R extends ResourceType = "organization">(
	context: Context,
	options?: WithWorkspaceOptions<R>
): Promise<Workspace>;
export async function withWorkspace<R extends ResourceType = "organization">(
	context: Context,
	options: WithWorkspaceOptions<R> = {} as WithWorkspaceOptions<R>
): Promise<Workspace> {
	const {
		websiteId,
		resource = "organization" as R,
		permissions = [],
		requiredPlans,
		allowPublicAccess = false,
		allowCrossOrg = false,
	} = options;

	const planPromise = getPlanId(context);
	const website = websiteId ? await requireWebsite(websiteId) : null;

	const organizationId =
		options.organizationId ?? website?.organizationId ?? context.organizationId;

	if (!organizationId) {
		throw rpcError.badRequest("Workspace is required");
	}

	const effectiveResource = websiteId ? "website" : (resource as string);
	const effectivePermissions = permissions as string[];
	const getCreatedBy = () => resolveCreatedBy(context, organizationId);

	const [grant, plan] = await Promise.all([
		resolveGrant(context, {
			organizationId,
			resource: effectiveResource,
			permissions: effectivePermissions,
			allowCrossOrg,
		}),
		planPromise,
	]);

	if (!grant.granted) {
		if (
			allowPublicAccess &&
			website?.isPublic &&
			isReadOnly(effectivePermissions)
		) {
			return {
				organizationId,
				user: context.user ?? null,
				role: null,
				plan,
				tier: "demo",
				website,
				getCreatedBy,
			};
		}
		throw grant.denied;
	}

	requirePlan(plan, requiredPlans);

	return {
		organizationId,
		user: grant.user,
		role: grant.role,
		plan,
		tier: "authed",
		website,
		getCreatedBy,
	};
}

export async function withFlagsWrite(
	context: Context,
	options: {
		websiteId: string;
		permissions: PermissionFor<"website">[];
	}
): Promise<Workspace & { website: Website }> {
	if (context.apiKey && !hasKeyScope(context.apiKey, "manage:flags")) {
		throw rpcError.forbidden("API key missing manage:flags scope");
	}

	return await withWorkspace<"website">(context, {
		websiteId: options.websiteId,
		resource: "website",
		permissions: options.permissions,
	});
}

async function resolveCreatedBy(
	context: Context,
	organizationId: string
): Promise<string> {
	if (context.user) {
		return context.user.id;
	}

	if (context.apiKey) {
		const ownerId = await getOrganizationOwnerId(organizationId);
		if (!ownerId) {
			throw rpcError.forbidden(
				"Could not resolve organization owner for API key"
			);
		}
		return ownerId;
	}

	throw rpcError.unauthorized();
}

export const withWebsiteRead = os.middleware(
	async ({ context, next }, input: { websiteId: string }) => {
		const workspace = await withWorkspace<"website">(context, {
			websiteId: input.websiteId,
			permissions: ["read"],
			allowPublicAccess: true,
		});
		return next({ context: { workspace } });
	}
);
