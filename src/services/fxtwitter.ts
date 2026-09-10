import { TWEET_API_BASE_URL, TWEET_FETCH_TIMEOUT_MS } from "../constants";

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

export interface FxTweet {
  id: string;
  url: string;
  text: string;
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

// Matches twitter.com / x.com status links plus the common "fixer" mirrors so
// links people already pasted through fxtwitter/vxtwitter still get expanded.
const TWEET_URL_REGEX =
  /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(\w{1,20})\/status(?:es)?\/(\d{1,25})/gi;

export interface TweetLink {
  url: string;
  screenName: string;
  id: string;
}

/**
 * Extract tweet links from message text. Links wrapped in <angle brackets> are
 * skipped, matching Discord's own "don't embed this" convention.
 */
export function extractTweetLinks(text: string): TweetLink[] {
  const results: TweetLink[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(TWEET_URL_REGEX)) {
    const [url, screenName, id] = match;
    const start = match.index ?? 0;
    const end = start + url.length;
    const suppressed = text[start - 1] === "<" && text[end] === ">";
    if (suppressed || seen.has(id)) continue;
    seen.add(id);
    results.push({ url, screenName, id });
  }

  return results;
}

export async function fetchTweet(link: TweetLink): Promise<FxFetchResult> {
  const apiUrl = `${TWEET_API_BASE_URL}/${link.screenName}/status/${link.id}`;

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
