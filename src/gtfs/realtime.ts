import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
const { transit_realtime } = GtfsRealtimeBindings;
import type { AuthConfig } from "../config.js";
import { applyAuth } from "../auth.js";

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

type FeedMessage = TransitRealtime.FeedMessage;
type IFeedEntity = TransitRealtime.IFeedEntity;

interface CacheEntry {
  data: FeedMessage;
  fetchedAt: number;
}

export interface FeedFetchResult {
  url: string;
  ok: boolean;
  entities: IFeedEntity[];
  headerTimestamp: number | null;
  error?: string;
  durationMs: number;
}

const feedCache = new Map<string, CacheEntry>();
// Mirrors the static-import lock pattern: under concurrent tool calls we
// sometimes see the same URL fetched N times. Sharing the in-flight promise
// collapses them to a single network request.
const inflight = new Map<string, Promise<FeedMessage>>();

export function clearFeedCache(): void {
  feedCache.clear();
  inflight.clear();
}

async function fetchOnce(
  url: string,
  auth: AuthConfig | null,
  signal: AbortSignal
): Promise<FeedMessage> {
  const { url: authedUrl, headers } = applyAuth(url, auth);
  const response = await fetch(authedUrl, { headers, signal });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch GTFS-RT feed ${url}: ${response.status} ${response.statusText}`
    );
  }

  const buffer = await response.arrayBuffer();
  return transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

export async function fetchFeed(
  url: string,
  auth: AuthConfig | null
): Promise<FeedMessage> {
  const now = Date.now();
  const cached = feedCache.get(url);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const pending = (async () => {
    let lastErr: unknown;
    // One immediate retry on failure. Feeds are flaky and one retry turns
    // most transient hiccups into successes; backoff is skipped deliberately
    // because most failures here are network-level and a second attempt ~ms
    // later is as good as one ~250ms later.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await fetchOnce(
          url,
          auth,
          AbortSignal.timeout(FETCH_TIMEOUT_MS)
        );
        feedCache.set(url, { data, fetchedAt: Date.now() });
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  })();

  inflight.set(url, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(url);
  }
}

/**
 * Fetch all feeds concurrently, returning per-URL outcomes. Callers that
 * only want entities can flatMap `.entities`; callers that need operational
 * visibility (get_system_status) can inspect `.ok` / `.error` per feed.
 */
export async function fetchAllFeedsDetailed(
  urls: string[],
  auth: AuthConfig | null
): Promise<FeedFetchResult[]> {
  if (urls.length === 0) return [];

  const results = await Promise.all(
    urls.map(async (url): Promise<FeedFetchResult> => {
      const start = Date.now();
      try {
        const feed = await fetchFeed(url, auth);
        return {
          url,
          ok: true,
          entities: feed.entity ?? [],
          headerTimestamp: feed.header?.timestamp
            ? Number(feed.header.timestamp)
            : null,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[gtfs-mcp] Error fetching feed ${url}: ${msg}`);
        return {
          url,
          ok: false,
          entities: [],
          headerTimestamp: null,
          error: msg,
          durationMs: Date.now() - start,
        };
      }
    })
  );

  return results;
}

export async function fetchAllFeeds(
  urls: string[],
  auth: AuthConfig | null
): Promise<IFeedEntity[]> {
  const results = await fetchAllFeedsDetailed(urls, auth);
  return results.flatMap((r) => r.entities);
}
