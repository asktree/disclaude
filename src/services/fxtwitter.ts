import { TWEET_API_BASE_URL, TWEET_CACHE_TTL_MS, TWEET_FETCH_TIMEOUT_MS } from "../constants";
import { config } from "../config";

/**
 * Minimal typings for the FxTwitter status API.
 * Docs: https://github.com/FxEmbed/FxEmbed/wiki/Status-Fetch-API
 */
export interface FxAuthor {
  name: string;
  screen_name: string;
  url?: string;
  avatar_url?: string;
  avatar_color?: string | null;
}

export interface FxPhoto {
  type: "photo";
  url: string;
  width: number;
  height: number;
  altText?: string;
}

export interface FxVideo {
  type: "video" | "gif";
  url: string;
  thumbnail_url: string;
  width: number;
  height: number;
  duration?: number;
  format?: string;
}

export interface FxPoll {
  choices: { label: string; count: number; percentage: number }[];
  total_votes: number;
  ends_at: string;
  time_left_en: string;
}

export interface FxTranslation {
  text: string;
  source_lang: string;
  target_lang: string;
  /** Human-readable source language name, e.g. "Spanish" */
  source_lang_en?: string;
  provider?: string;
}

export interface FxTweet {
  id: string;
  url: string;
  text: string;
  lang?: string | null;
  /** Only present when a translation was requested and the post needed one */
  translation?: FxTranslation;
  created_at: string;
  created_timestamp: number;
  author: FxAuthor;
  replies?: number;
  retweets?: number;
  likes?: number;
  views?: number | null;
  replying_to?: string | null;
  replying_to_status?: string | null;
  quote?: FxTweet;
  poll?: FxPoll;
  community_note?: { text?: string } | null;
  media?: {
    photos?: FxPhoto[];
    videos?: FxVideo[];
    mosaic?: { type: "mosaic_photo"; formats: { jpeg?: string; webp?: string } };
  };
}

interface FxResponse {
  code: number;
  message: string;
  tweet?: FxTweet | { type?: string; message?: string } | null;
}

export type FxFetchResult =
  | { ok: true; tweet: FxTweet }
  | { ok: false; reason: "not_found" | "private" | "error"; message: string };

// A bare URL token: everything up to whitespace or an angle bracket. Optional
// surrounding <...> is captured so we can honour Discord's no-embed convention.
const URL_TOKEN_REGEX = /(<)?(https?:\/\/[^\s<>]+)(>)?/g;

// Matches twitter.com / x.com status links plus the common "fixer" mirrors so
// links people already pasted through fxtwitter/vxtwitter still get expanded.
// Anchored so trailing paths (/photo/1) and query strings (?s=20) are allowed
// but never change what counts as the status ID.
const TWEET_URL_REGEX =
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(\w{1,20})\/status(?:es)?\/(\d{1,25})(?:[/?#]|$)/i;

export interface TweetLink {
  url: string;
  screenName: string;
  id: string;
}

export function parseTweetUrl(url: string): TweetLink | null {
  const match = url.match(TWEET_URL_REGEX);
  if (!match) return null;
  return { url, screenName: match[1], id: match[2] };
}

export interface ExtractedLinks {
  /** Tweet links that should be expanded, deduplicated by status ID */
  tweets: TweetLink[];
  /** Every non-suppressed URL in the text, tweet or otherwise */
  allUrls: string[];
}

/**
 * Extract tweet links from message text. Links wrapped in <angle brackets> are
 * skipped entirely, matching Discord's own "don't embed this" convention.
 */
export function extractTweetLinks(text: string): ExtractedLinks {
  const tweets: TweetLink[] = [];
  const allUrls: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(URL_TOKEN_REGEX)) {
    const [, open, url, close] = match;
    if (open && close) continue; // <url> means "no embed please"
    allUrls.push(url);

    const link = parseTweetUrl(url);
    if (!link || seen.has(link.id)) continue;
    seen.add(link.id);
    tweets.push(link);
  }

  return { tweets, allUrls };
}

interface CacheEntry {
  promise: Promise<FxFetchResult>;
  expiresAt: number;
}

// Keyed by status ID: repeated links (or many people pasting the same link at
// once) share a single upstream request instead of hammering the API.
const tweetCache = new Map<string, CacheEntry>();

export function fetchTweet(link: TweetLink): Promise<FxFetchResult> {
  const now = Date.now();
  const cached = tweetCache.get(link.id);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = fetchTweetUncached(link).then((result) => {
    // Don't cache transient failures; the next message can retry.
    if (!result.ok && result.reason === "error") tweetCache.delete(link.id);
    return result;
  });
  tweetCache.set(link.id, { promise, expiresAt: now + TWEET_CACHE_TTL_MS });

  // Opportunistic pruning so the map can't grow without bound.
  if (tweetCache.size > 500) {
    for (const [id, entry] of tweetCache) {
      if (entry.expiresAt <= now) tweetCache.delete(id);
    }
  }

  return promise;
}

async function fetchTweetUncached(link: TweetLink): Promise<FxFetchResult> {
  // Appending a language code asks FxTwitter to translate the post as well.
  const translate = config.tweets.translateTo;
  const apiUrl = `${TWEET_API_BASE_URL}/${link.screenName}/status/${link.id}${translate ? `/${translate}` : ""}`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "DisclaudeBot/1.0 (+https://github.com/Henry-E/disclaude)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TWEET_FETCH_TIMEOUT_MS),
    });

    let body: FxResponse | null = null;
    try {
      body = (await response.json()) as FxResponse;
    } catch {
      body = null;
    }

    if (response.ok && body?.code === 200 && body.tweet && "text" in body.tweet) {
      return { ok: true, tweet: body.tweet as FxTweet };
    }

    const status = body?.code ?? response.status;
    if (status === 401) {
      return { ok: false, reason: "private", message: "This post is from a private account" };
    }
    if (status === 404) {
      const tombstone = body?.tweet as { message?: string } | null | undefined;
      return {
        ok: false,
        reason: "not_found",
        message: tombstone?.message || "This post could not be found",
      };
    }
    return { ok: false, reason: "error", message: `fxtwitter returned ${status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "error", message };
  }
}
