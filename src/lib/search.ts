import { config } from "../config.js";

/**
 * Brain-side web search.
 *
 * Anthropic's server-side web_search tool is entitled on the subscription token
 * but its quota is far too small to build on (it returns too_many_requests after
 * a single successful call and does not recover for hours). So when a search
 * provider is configured we run the search here and hand Claude the results as
 * context instead — inference still happens on the subscription.
 *
 * Provider-agnostic on purpose: Brave is the default, Tavily is a drop-in if
 * Brave's signup or quota gets in the way.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const enabled = () => Boolean(config.search.apiKey);

async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.search.apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  return (data?.web?.results ?? []).map((r: any) => ({
    title: r.title ?? r.url,
    url: r.url,
    snippet: (r.description ?? "").replace(/<[^>]+>/g, ""), // Brave marks hits with <strong>
  }));
}

async function tavilySearch(query: string, count: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.search.apiKey,
      query,
      max_results: count,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  return (data?.results ?? []).map((r: any) => ({
    title: r.title ?? r.url,
    url: r.url,
    snippet: r.content ?? "",
  }));
}

export async function search(query: string): Promise<SearchResult[]> {
  if (!enabled()) return [];
  const count = config.search.resultsPerQuery;
  const run = config.search.provider === "tavily" ? tavilySearch : braveSearch;

  const results = await run(query.slice(0, 400), count);
  // Trim snippets: enough to judge relevance, not enough to blow up the prompt.
  return results.map((r) => ({ ...r, snippet: r.snippet.slice(0, 600) }));
}

/** Render results as a context block Claude can read and cite. */
export function asContext(results: SearchResult[], query: string): string {
  const body = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
    )
    .join("\n\n");

  return `Web search results for "${query}" (retrieved just now):

${body}

Use these results to answer. Cite claims with the numbered references above and prefer them over your training data — your training data may be out of date. If the results do not answer the question, say so rather than guessing.`;
}
