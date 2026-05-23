import { tool } from "ai";
import { z } from "zod";
import { db, eq, and } from "@databuddy/db";
import { account, member } from "@databuddy/db/schema";

const GITHUB_API = "https://api.github.com";
const MAX_RESULTS = 10;

async function getGitHubToken(
	organizationId: string,
	preferUserId?: string
): Promise<string | null> {
	if (preferUserId) {
		const [ghAccount] = await db
			.select({ accessToken: account.accessToken })
			.from(account)
			.where(
				and(
					eq(account.userId, preferUserId),
					eq(account.providerId, "github")
				)
			)
			.limit(1);

		if (ghAccount?.accessToken) return ghAccount.accessToken;
	}

	const [fallback] = await db
		.select({ accessToken: account.accessToken })
		.from(account)
		.innerJoin(member, eq(member.userId, account.userId))
		.where(
			and(
				eq(member.organizationId, organizationId),
				eq(account.providerId, "github")
			)
		)
		.limit(1);

	return fallback?.accessToken ?? null;
}

export async function githubFetch(
	path: string,
	token: string
): Promise<unknown> {
	const res = await fetch(`${GITHUB_API}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		return { error: `GitHub API ${res.status}: ${res.statusText}` };
	}

	return res.json();
}

export interface GitHubToolsParams {
	organizationId: string;
	userId?: string;
}

export function createGitHubTools(params: GitHubToolsParams) {
	let cachedToken: string | null | undefined;

	async function getToken(): Promise<string | null> {
		if (cachedToken !== undefined) return cachedToken;
		cachedToken = await getGitHubToken(params.organizationId, params.userId);
		return cachedToken;
	}

	const getRecentDeploysTool = tool({
		description:
			"Get recent GitHub deployments for a repo. Use when a metric changed and you want to check if a deploy happened in the same time window. Returns SHA, environment, timestamp, and author.",
		inputSchema: z.object({
			owner: z.string().describe("GitHub repo owner (user or org)"),
			repo: z.string().describe("GitHub repo name"),
			environment: z
				.string()
				.optional()
				.describe("Filter by environment (e.g. production, staging)"),
			limit: z
				.number()
				.min(1)
				.max(MAX_RESULTS)
				.optional()
				.default(5)
				.describe("Number of deploys to return"),
		}),
		execute: async ({ owner, repo, environment, limit }) => {
			const token = await getToken();
			if (!token) {
				return { error: "No GitHub account connected for this organization" };
			}

			const envFilter = environment
				? `&environment=${encodeURIComponent(environment)}`
				: "";
			const data = await githubFetch(
				`/repos/${owner}/${repo}/deployments?per_page=${limit}${envFilter}`,
				token
			);

			if (data && typeof data === "object" && "error" in data) return data;

			const deploys = data as Array<{
				id: number;
				sha: string;
				ref: string;
				environment: string;
				created_at: string;
				description: string | null;
				creator: { login: string } | null;
			}>;

			return {
				repo: `${owner}/${repo}`,
				count: deploys.length,
				deploys: deploys.map((d) => ({
					sha: d.sha.slice(0, 7),
					ref: d.ref,
					environment: d.environment,
					deployedAt: d.created_at,
					description: d.description,
					author: d.creator?.login,
				})),
			};
		},
	});

	const getRecentCommitsTool = tool({
		description:
			"Get recent commits from a GitHub repo, optionally filtered by date range. Use when investigating what code changes happened around a metric anomaly. Returns commit message, author, and date.",
		inputSchema: z.object({
			owner: z.string().describe("GitHub repo owner"),
			repo: z.string().describe("GitHub repo name"),
			since: z
				.string()
				.optional()
				.describe("Only commits after this ISO date (e.g. 2026-05-15T00:00:00Z)"),
			until: z
				.string()
				.optional()
				.describe("Only commits before this ISO date"),
			limit: z
				.number()
				.min(1)
				.max(MAX_RESULTS)
				.optional()
				.default(5)
				.describe("Number of commits to return"),
		}),
		execute: async ({ owner, repo, since, until, limit }) => {
			const token = await getToken();
			if (!token) {
				return { error: "No GitHub account connected for this organization" };
			}

			const queryParams = new URLSearchParams({ per_page: String(limit) });
			if (since) queryParams.set("since", since);
			if (until) queryParams.set("until", until);

			const data = await githubFetch(
				`/repos/${owner}/${repo}/commits?${queryParams}`,
				token
			);

			if (data && typeof data === "object" && "error" in data) return data;

			const commits = data as Array<{
				sha: string;
				commit: {
					message: string;
					author: { name: string; date: string } | null;
				};
			}>;

			return {
				repo: `${owner}/${repo}`,
				count: commits.length,
				commits: commits.map((c) => ({
					sha: c.sha.slice(0, 7),
					message: c.commit.message.split("\n")[0].slice(0, 120),
					author: c.commit.author?.name,
					date: c.commit.author?.date,
				})),
			};
		},
	});

	const getRecentPullRequestsTool = tool({
		description:
			"Get recently merged PRs from a GitHub repo. Use when you found a deploy or commit that correlates with a metric change and want to understand what feature or fix was shipped. Returns PR title, merge date, and author.",
		inputSchema: z.object({
			owner: z.string().describe("GitHub repo owner"),
			repo: z.string().describe("GitHub repo name"),
			limit: z
				.number()
				.min(1)
				.max(MAX_RESULTS)
				.optional()
				.default(5)
				.describe("Number of PRs to return"),
		}),
		execute: async ({ owner, repo, limit }) => {
			const token = await getToken();
			if (!token) {
				return { error: "No GitHub account connected for this organization" };
			}

			const data = await githubFetch(
				`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${limit}`,
				token
			);

			if (data && typeof data === "object" && "error" in data) return data;

			const prs = data as Array<{
				number: number;
				title: string;
				merged_at: string | null;
				user: { login: string } | null;
				labels: Array<{ name: string }>;
			}>;

			const merged = prs.filter((pr) => pr.merged_at);

			return {
				repo: `${owner}/${repo}`,
				count: merged.length,
				pullRequests: merged.map((pr) => ({
					number: pr.number,
					title: pr.title.slice(0, 120),
					mergedAt: pr.merged_at,
					author: pr.user?.login,
					labels: pr.labels.map((l) => l.name),
				})),
			};
		},
	});

	const listReposTool = tool({
		description:
			"List GitHub repos the connected account can access, sorted by last push. Call this first to find the repo name before querying deploys or commits.",
		inputSchema: z.object({
			limit: z
				.number()
				.min(1)
				.max(20)
				.optional()
				.default(10)
				.describe("Number of repos to return"),
		}),
		execute: async ({ limit }) => {
			const token = await getToken();
			if (!token) {
				return { error: "No GitHub account connected for this organization" };
			}

			const data = await githubFetch(
				`/user/repos?sort=pushed&direction=desc&per_page=${limit}`,
				token
			);

			if (data && typeof data === "object" && "error" in data) return data;

			const repos = data as Array<{
				full_name: string;
				private: boolean;
				pushed_at: string | null;
				default_branch: string;
			}>;

			return {
				count: repos.length,
				repos: repos.map((r) => ({
					name: r.full_name,
					private: r.private,
					lastPush: r.pushed_at,
					defaultBranch: r.default_branch,
				})),
			};
		},
	});

	return {
		github_deploys: getRecentDeploysTool,
		github_commits: getRecentCommitsTool,
		github_pull_requests: getRecentPullRequestsTool,
		github_repos: listReposTool,
	};
}
