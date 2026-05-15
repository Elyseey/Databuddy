import {
	infiniteQueryOptions,
	keepPreviousData,
	queryOptions,
} from "@tanstack/react-query";
import { guessTimezone } from "@databuddy/ui";
import type { HistoryInsightRow, Insight } from "@/lib/insight-types";
import { orpc } from "@/lib/orpc";

export const INSIGHT_CACHE = {
	staleTime: 15 * 60 * 1000,
	gcTime: 30 * 60 * 1000,
	historyStaleTime: 5 * 60 * 1000,
} as const;

const INSIGHTS_ROOT = ["insights"] as const;
const HISTORY_PAGE_SIZE = 50;

export const insightQueries = {
	all: () => INSIGHTS_ROOT,
	ai: (orgId: string | undefined) =>
		queryOptions({
			queryKey: [...INSIGHTS_ROOT, "ai", orgId] as const,
			queryFn: () => fetchInsightsAi(orgId ?? ""),
			enabled: !!orgId,
			staleTime: INSIGHT_CACHE.staleTime,
			gcTime: INSIGHT_CACHE.gcTime,
			refetchInterval: INSIGHT_CACHE.staleTime,
			refetchOnWindowFocus: false,
			placeholderData: keepPreviousData,
			retry: 2,
			retryDelay: (attempt: number) => Math.min(2000 * 2 ** attempt, 15_000),
		}),
	historyInfinite: (orgId: string | undefined) =>
		infiniteQueryOptions({
			queryKey: [...INSIGHTS_ROOT, "history-infinite", orgId] as const,
			queryFn: ({ pageParam }) =>
				fetchInsightsHistoryPage(
					orgId ?? "",
					pageParam as number,
					HISTORY_PAGE_SIZE
				),
			initialPageParam: 0,
			getNextPageParam: (lastPage, _allPages, lastPageParam) =>
				lastPage.hasMore
					? (lastPageParam as number) + HISTORY_PAGE_SIZE
					: undefined,
			enabled: !!orgId,
			staleTime: INSIGHT_CACHE.historyStaleTime,
			gcTime: INSIGHT_CACHE.gcTime,
			refetchOnWindowFocus: false,
			placeholderData: keepPreviousData,
			retry: 2,
			retryDelay: (attempt: number) => Math.min(2000 * 2 ** attempt, 15_000),
		}),
	orgNarrative: (orgId: string | undefined, range: "7d" | "30d" | "90d") =>
		queryOptions({
			queryKey: [...INSIGHTS_ROOT, "org-narrative", orgId, range] as const,
			queryFn: () => {
				if (!orgId) {
					throw new Error("No organization");
				}
				return fetchInsightsOrgNarrative(orgId, range);
			},
			enabled: !!orgId,
			staleTime: 60 * 60 * 1000,
			refetchOnWindowFocus: false,
		}),
};

export interface InsightsAiResponse {
	generation?: {
		queuedItems?: number;
		runId?: string;
		status: "queued" | "skipped" | "unavailable";
	};
	insights: Insight[];
	source: "ai" | "fallback";
	success: boolean;
}

export interface InsightsHistoryPage {
	hasMore: boolean;
	insights: HistoryInsightRow[];
	success: boolean;
}

export function fetchInsightsAi(
	organizationId: string
): Promise<InsightsAiResponse> {
	return orpc.insights.feed.call({
		organizationId,
		timezone: guessTimezone(),
	}) as Promise<InsightsAiResponse>;
}

export function fetchInsightsHistoryPage(
	organizationId: string,
	offset: number,
	limit = 50
): Promise<InsightsHistoryPage> {
	return orpc.insights.history.call({
		organizationId,
		limit,
		offset,
	}) as Promise<InsightsHistoryPage>;
}

export interface ClearInsightsResponse {
	deleted: number;
	error?: string;
	success: boolean;
}

export function clearInsightsHistory(
	organizationId: string
): Promise<ClearInsightsResponse> {
	return orpc.insights.clearHistory.call({
		organizationId,
	}) as Promise<ClearInsightsResponse>;
}

export type OrgNarrativeResponse =
	| {
			success: true;
			narrative: string;
			generatedAt: string;
	  }
	| {
			success: false;
			error: string;
	  };

export function fetchInsightsOrgNarrative(
	organizationId: string,
	range: "7d" | "30d" | "90d"
): Promise<OrgNarrativeResponse> {
	return orpc.insights.orgNarrative.call({
		organizationId,
		range,
	}) as Promise<OrgNarrativeResponse>;
}
