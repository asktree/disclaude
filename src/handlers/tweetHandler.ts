import {
  APIEmbed,
  Embed,
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  PermissionFlagsBits,
  PermissionsBitField,
  User,
} from "discord.js";
import {
  CACHE_CLEANUP_INTERVAL_MS,
  MAX_TWEETS_PER_MESSAGE,
  TWEET_DELETE_EMOJIS,
  TWEET_EMBED_COLOR,
  TWEET_FX_BASE_URL,
  TWEET_REMOVAL_HINT,
  TWEET_USER_RATE_LIMIT,
  TWEET_USER_RATE_WINDOW_MS,
} from "../constants";
import { extractTweetLinks, fetchTweet, FxTweet, parseTweetUrl } from "../services/fxtwitter";
import { TweetLinkStore } from "../services/tweetLinkStore";
import { config } from "../config";

const DISCORD_UNKNOWN_MESSAGE = 10008;

interface PendingExpansion {
  cancelled: boolean;
}

/**
 * Replies to tweet links with the FxTwitter link (Discord shows its embed) and lets the person
 * who posted the link remove the embed again by reacting with a delete emoji.
 *
 * This is deliberately independent from the Claude conversation flow: it never
 * calls the model, and it runs for every message whether or not the bot is
 * mentioned. One reply is posted per tweet link so each can be removed on its
 * own and never runs into Discord's per-message embed limits.
 */
export class TweetEmbedHandler {
  private botId: string;
  private store: TweetLinkStore;
  /** Source messages whose expansion is still in flight, so a delete can cancel it */
  private pending = new Map<string, PendingExpansion>();
  private userActivity = new Map<string, number[]>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(botId: string, store = new TweetLinkStore()) {
    this.botId = botId;
    this.store = store;
    this.cleanupInterval = setInterval(() => this.store.prune(), CACHE_CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  async init(): Promise<void> {
    await this.store.load();
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.destroy();
  }

  // ---------------------------------------------------------------------------
  // Posting embeds
  // ---------------------------------------------------------------------------

  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.author.id === this.botId) return;
    if (!message.content) return;

    const { tweets, allUrls } = extractTweetLinks(message.content);
    if (tweets.length === 0) return;

    if (!this.withinRateLimit(message.author.id)) {
      console.log(`🐦 Rate limit: skipping tweet links from ${message.author.id}`);
      return;
    }

    const perms = this.botPermissions(message);
    if (perms && !this.canPost(perms, message)) {
      console.log(`🐦 Missing send/embed permission in ${message.channelId}, skipping`);
      return;
    }

    const toFetch = tweets.slice(0, MAX_TWEETS_PER_MESSAGE);
    console.log(`🐦 Found ${tweets.length} tweet link(s) in message ${message.id}`);

    const state: PendingExpansion = { cancelled: false };
    this.pending.set(message.id, state);

    try {
      const results = await Promise.all(toFetch.map((link) => fetchTweet(link)));
      if (state.cancelled) return;

      const failures: string[] = [];
      let posted = 0;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const link = toFetch[i];
        if (!result.ok) {
          console.log(`   ⚠️ Could not expand ${link.url}: ${result.message}`);
          if (result.reason !== "error") failures.push(result.message);
          continue;
        }

        const content = this.buildLinkReply(result.tweet, message.author.id);
        const sent = await this.safeReply(message, { content });
        if (!sent) continue;

        if (state.cancelled) {
          // Source vanished while we were posting; don't leave an orphan.
          await sent.delete().catch(() => undefined);
          return;
        }

        this.store.add({
          sourceMessageId: message.id,
          botMessageId: sent.id,
          channelId: message.channelId,
          authorId: message.author.id,
          createdAt: Date.now(),
        });
        posted++;
      }

      if (posted === 0) {
        // Nothing to show. Private/deleted posts get a short note so the poster
        // knows the link is dead; transient API errors stay silent.
        if (failures.length > 0) {
          await this.safeReply(message, { content: `🐦 ${failures[0]}.` });
        }
        return;
      }

      // Hide the original (usually broken) X preview now that ours is up.
      // Suppression is message-wide, so leave it alone if the message also
      // carries non-tweet links whose previews we'd otherwise wipe out.
      const onlyTweetLinks = allUrls.every((url) => parseTweetUrl(url) !== null);
      if (onlyTweetLinks && (!perms || perms.has(PermissionFlagsBits.ManageMessages))) {
        await message.suppressEmbeds(true).catch(() => undefined);
      }
    } finally {
      this.pending.delete(message.id);
    }
  }

  private withinRateLimit(userId: string): boolean {
    const now = Date.now();
    const recent = (this.userActivity.get(userId) ?? []).filter(
      (t) => now - t < TWEET_USER_RATE_WINDOW_MS,
    );
    if (recent.length >= TWEET_USER_RATE_LIMIT) {
      this.userActivity.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.userActivity.set(userId, recent);
    if (this.userActivity.size > 1000) {
      for (const [id, times] of this.userActivity) {
        if (times.every((t) => now - t >= TWEET_USER_RATE_WINDOW_MS)) this.userActivity.delete(id);
      }
    }
    return true;
  }

  /** Effective permissions for the bot in this channel, or null outside guilds. */
  private botPermissions(message: Message): Readonly<PermissionsBitField> | null {
    const me = message.guild?.members.me;
    if (!me || !message.inGuild()) return null;
    return (message.channel as GuildTextBasedChannel).permissionsFor(me);
  }

  private canPost(perms: Readonly<PermissionsBitField>, message: Message): boolean {
    const sendFlag = message.channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    return perms.has([PermissionFlagsBits.ViewChannel, sendFlag, PermissionFlagsBits.EmbedLinks]);
  }

  private async safeReply(
    message: Message,
    payload: { content?: string; embeds?: APIEmbed[] },
  ): Promise<Message | null> {
    try {
      return await message.reply({
        ...payload,
        allowedMentions: { parse: [], repliedUser: false },
        // If the source message is already gone, don't post at all.
        failIfNotExists: true,
      });
    } catch (error) {
      console.error("❌ Failed to post tweet embed:", error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Embed construction
  // ---------------------------------------------------------------------------

  /**
   * The reply is FxTwitter's own link, so Discord renders FxTwitter's embed with its
   * playable video player, quote tweet and stats. A bot embed can't hold a playable video.
   * Under it: plain links to the original and quoted post, wrapped in <> so they don't unfurl.
   */
  private buildLinkReply(tweet: FxTweet, posterId: string): string {
    const screenName = tweet.author.screen_name;
    // The language suffix makes FxTwitter show the translation under the original text
    const translate = config.tweets.translateTo;
    const t = tweet.translation;
    const needsTranslation = !!translate && !!t?.text && t.source_lang !== t.target_lang;
    const fxUrl = `${TWEET_FX_BASE_URL}/${screenName}/status/${tweet.id}${needsTranslation ? `/${translate}` : ""}`;

    const hasVideo = (t?: FxTweet) => (t?.media?.videos?.length ?? 0) > 0;
    const label = hasVideo(tweet) || hasVideo(tweet.quote) ? "🎥 " : "";

    const links = [`[Original tweet](<https://x.com/${screenName}/status/${tweet.id}>)`];
    if (tweet.quote) links.push(`[Quoted tweet](<${tweet.quote.url}>)`);

    // Small-text hint aimed at the poster. Rendered as a mention but never
    // pings, since replies go out with all mentions disabled.
    return [`${label}${fxUrl}`, `-# ${links.join(" · ")}`, this.removalHint(posterId)].join("\n");
  }

  private removalHint(posterId: string): string {
    return `-# <@${posterId}> ${TWEET_REMOVAL_HINT}`;
  }

  // ---------------------------------------------------------------------------
  // Removal: delete-emoji reaction, or the source message being deleted
  // ---------------------------------------------------------------------------

  async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.id === this.botId) return;
    if (!this.isDeleteEmoji(reaction.emoji.name)) return;

    try {
      if (reaction.partial) await reaction.fetch();
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

      if (message.author?.id !== this.botId) return;
      if (!this.isTweetEmbedMessage(message)) return;

      const allowed = await this.canRemove(message, user.id);
      if (!allowed) return;

      await this.deleteBotMessage(message.channelId, message.id, message);
      console.log(`🗑️ Removed tweet embed ${message.id} at request of ${user.id}`);
    } catch (error) {
      console.error("❌ Error handling delete reaction:", error);
    }
  }

  async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    await this.onSourceDeleted(message.id, message);
  }

  async handleMessageBulkDelete(messages: Iterable<Message | PartialMessage>): Promise<void> {
    for (const message of messages) {
      // Our own replies may be in the same purge; nothing to clean up for those.
      if (message.author?.id === this.botId) continue;
      await this.onSourceDeleted(message.id, message);
    }
  }

  private async onSourceDeleted(
    sourceId: string,
    message: Message | PartialMessage,
  ): Promise<void> {
    const pending = this.pending.get(sourceId);
    if (pending) pending.cancelled = true;

    const links = this.store.getBySource(sourceId);
    if (links.length === 0) return;

    for (const link of links) {
      try {
        const channel = await message.client.channels.fetch(link.channelId);
        if (channel && "messages" in channel) {
          await this.deleteBotMessage(link.channelId, link.botMessageId, channel.messages);
          console.log(`🗑️ Removed tweet embed ${link.botMessageId}: source message was deleted`);
        }
      } catch (error) {
        console.error("❌ Error removing embed for deleted message:", error);
      }
    }
  }

  /**
   * Delete one of our replies and forget it, but only forget once Discord
   * confirms it is gone (deleted now, or already unknown).
   */
  private async deleteBotMessage(
    channelId: string,
    botMessageId: string,
    target: Message | { delete(id: string): Promise<unknown> },
  ): Promise<void> {
    try {
      if ("delete" in target && target instanceof Message) await target.delete();
      else await (target as { delete(id: string): Promise<unknown> }).delete(botMessageId);
      this.store.remove(botMessageId);
    } catch (error: any) {
      if (error?.code === DISCORD_UNKNOWN_MESSAGE) {
        this.store.remove(botMessageId);
        return;
      }
      throw error;
    }
  }

  private isDeleteEmoji(name: string | null): boolean {
    if (!name) return false;
    const normalized = name.replace(/️/g, "");
    return TWEET_DELETE_EMOJIS.some((emoji) => emoji.replace(/️/g, "") === normalized);
  }

  /**
   * Only our tweet embeds are removable this way, never ordinary Claude replies
   * that happen to carry a link preview. Tracked messages are known; otherwise
   * look for our own removal hint alongside an embed that points at a tweet.
   */
  private isTweetEmbedMessage(message: Message): boolean {
    if (this.store.getByBotMessage(message.id)) return true;
    if (!message.content.includes(TWEET_REMOVAL_HINT)) return false;
    // Current replies lead with the FxTwitter link; older ones carried our own embed
    const firstUrl = message.content.match(/https?:\/\/\S+/)?.[0];
    if (firstUrl?.startsWith(TWEET_FX_BASE_URL) && parseTweetUrl(firstUrl)) return true;
    return message.embeds.some(
      (embed: Embed) =>
        embed.color === TWEET_EMBED_COLOR && !!embed.url && parseTweetUrl(embed.url) !== null,
    );
  }

  /**
   * The original poster can always remove the embed. So can anyone who could
   * delete the message anyway (Manage Messages in that channel).
   */
  private async canRemove(botMessage: Message, userId: string): Promise<boolean> {
    const tracked = this.store.getByBotMessage(botMessage.id);
    if (tracked?.authorId === userId) return true;

    // Fall back to the reply reference, which survives lost tracking data.
    const referenceId = botMessage.reference?.messageId;
    if (!tracked && referenceId) {
      try {
        const source = await botMessage.channel.messages.fetch(referenceId);
        if (source.author.id === userId) return true;
      } catch {
        // Source message gone; fall through to the moderator check.
      }
    }

    if (botMessage.guild) {
      try {
        const member = await botMessage.guild.members.fetch(userId);
        if (member.permissionsIn(botMessage.channelId).has(PermissionFlagsBits.ManageMessages)) {
          return true;
        }
      } catch {
        // Member lookup failed; treat as not allowed.
      }
    }

    return false;
  }
}
