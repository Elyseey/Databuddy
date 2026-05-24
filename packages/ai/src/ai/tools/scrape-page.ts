import { tool } from "ai";
import { z } from "zod";

const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const MAX_CONTENT_CHARS = 12_000;
const CACHE_TTL_SECONDS = 86_400;

function getFirecrawlKey(): string | null {
	return process.env.FIRECRAWL_API_KEY ?? null;
}

function cacheKey(domain: string, path: string): string {
	return `scrape:${domain}:${path}`;
}

async function getCached(key: string): Promise<string | null> {
	try {
		const { redis } = await import("@databuddy/redis");
		return await redis.get(key);
	} catch {
		return null;
	}
}

async function setCache(key: string, value: string): Promise<void> {
	try {
		const { redis } = await import("@databuddy/redis");
		await redis.set(key, value, "EX", CACHE_TTL_SECONDS);
	} catch {}
}

interface ScrapeResult {
	url: string;
	title: string | null;
	description: string | null;
	statusCode: number | null;
	content: string;
	internalLinks: string[];
	cached?: boolean;
}

async function scrapePage(
	domain: string,
	path: string
): Promise<ScrapeResult | { error: string }> {
	const apiKey = getFirecrawlKey();
	if (!apiKey) {
		return { error: "Page scraping is not configured" };
	}

	const cleanPath = path.startsWith("/") ? path : `/${path}`;
	const key = cacheKey(domain, cleanPath);

	const cached = await getCached(key);
	if (cached) {
		try {
			return { ...(JSON.parse(cached) as ScrapeResult), cached: true };
		} catch {}
	}

	const url = `https://${domain}${cleanPath}`;

	try {
		const res = await fetch(`${FIRECRAWL_API}/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				url,
				formats: ["markdown", "links"],
				onlyMainContent: true,
				timeout: 15000,
			}),
			signal: AbortSignal.timeout(20_000),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				error: `Scrape failed (${res.status}): ${body.slice(0, 200)}`,
			};
		}

		const data = (await res.json()) as {
			success: boolean;
			data?: {
				markdown?: string;
				links?: string[];
				metadata?: {
					title?: string;
					description?: string;
					statusCode?: number;
				};
			};
		};

		if (!data.success || !data.data?.markdown) {
			return { error: "Page returned no content" };
		}

		const markdown = data.data.markdown;
		const meta = data.data.metadata;
		const allLinks = data.data.links ?? [];
		const internalLinks = allLinks
			.filter((l) => {
				try {
					const u = new URL(l);
					return u.hostname === domain || u.hostname === `www.${domain}`;
				} catch {
					return l.startsWith("/");
				}
			})
			.map((l) => {
				try {
					return new URL(l).pathname;
				} catch {
					return l;
				}
			})
			.filter((p, i, arr) => arr.indexOf(p) === i)
			.slice(0, 30);

		const result: ScrapeResult = {
			url,
			title: meta?.title ?? null,
			description: meta?.description ?? null,
			statusCode: meta?.statusCode ?? null,
			content:
				markdown.length > MAX_CONTENT_CHARS
					? `${markdown.slice(0, MAX_CONTENT_CHARS)}\n…[truncated]`
					: markdown,
			internalLinks,
		};

		setCache(key, JSON.stringify(result));

		return result;
	} catch (err) {
		return {
			error: `Scrape failed: ${(err as Error).message?.slice(0, 200)}`,
		};
	}
}

export function createScrapeTools(domain: string) {
	const scrapeTool = tool({
		description: `Scrape a page from ${domain} and return its content as markdown plus internal links. Use to understand the product: what the site does, key pages, pricing, CTAs. Also use when investigating page-level anomalies. Scrape "/" first for product context, then specific pages as needed. Results are cached for 24h.`,
		inputSchema: z.object({
			path: z
				.string()
				.describe(
					"Page path to scrape (e.g. '/', '/pricing', '/docs'). Must be a path on the current website."
				),
		}),
		execute: ({ path }) => scrapePage(domain, path),
	});

	return { scrape_page: scrapeTool };
}
