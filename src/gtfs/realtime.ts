import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
const { transit_realtime } = GtfsRealtimeBindings;
import type { AuthConfig } from "../config.js";
import { applyAuth } from "../auth.js";

const CACHE_TTL_MS = 30_000;

type FeedMessage = TransitRealtime.FeedMessage;
type IFeedEntity = TransitRealtime.IFeedEntity;

interface CacheEntry {
  data: FeedMessage;
  fetchedAt: number;
}

const feedCache = new Map<string, CacheEntry>();

export function clearFeedCache(): void {
  feedCache.clear();
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

  const { url: authedUrl, headers } = applyAuth(url, auth);
  const response = await fetch(authedUrl, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch GTFS-RT feed ${url}: ${response.status} ${response.statusText}`
    );
  }

  const buffer = await response.arrayBuffer();
  const data = transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  feedCache.set(url, { data, fetchedAt: now });
  return data;
}

export async function fetchAllFeeds(
  urls: string[],
  auth: AuthConfig | null
): Promise<IFeedEntity[]> {
  if (urls.length === 0) {
    return [];
  }

  const feeds = await Promise.all(
    urls.map((url) => fetchFeed(url, auth).catch((err) => {
      console.error(`[gtfs-mcp] Error fetching feed ${url}: ${err}`);
      return null;
    }))
  );

  const entities: IFeedEntity[] = [];
  for (const feed of feeds) {
    if (feed?.entity) {
      entities.push(...feed.entity);
    }
  }
  return entities;
}
