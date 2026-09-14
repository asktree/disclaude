import {
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
  TWEET_FX_BASE_URL,
  TWEET_REMOVAL_HINT,
  TWEET_TRANSLATION_MAX_LENGTH,
  TWEET_USER_RATE_LIMIT,
  TWEET_USER_RATE_WINDOW_MS,
} from "../constants";
import { extractTweetLinks, fetchTweet, FxTweet, parseTweetUrl } from "../services/fxtwitter";
import { TweetLinkStore } from "../services/tweetLinkStore";

const DISCORD_UNKNOWN_MESSAGE = 10008;

interface PendingExpansion {
  cancelled: boolean;
}

/**
 * Expands tweet links into rich embeds (fxtwitter-style) and lets the person
 * who posted the link remove the embed again by reacting with a delete emoji.
 *
 * Rendering is delegated to FixTweet: the bot replies with an fxtwitter.com
 * link and Discord unfurls it, which gives the familiar FixTweet embed
 * including inline video and photo mosaics. The bot adds what FixTweet can't:
 * a translation line, hiding the original X preview, and removal by reaction.
 *
 * This is deliberately independent from the Claude conversation flow: it never
 * calls the model, and it runs for every message whether or not the bot is
 * mentioned. One reply is posted per tweet link so each can be removed on its
 * own.
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

        const content = this.buildContent(result.tweet, message.author.id);
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

  private async safeReply(message: Message, payload: { content: string }): Promise<Message | null> {
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
  // Message construction
  // ---------------------------------------------------------------------------

  /**
   * The reply is plain text: an fxtwitter.com link for Discord to unfurl, an
   * optional translation, and the removal hint. The hint doubles as the marker
   * that identifies our replies later.
   */
  private buildContent(tweet: FxTweet, posterId: string): string {
    const lines = [`${TWEET_FX_BASE_URL}/${tweet.author.screen_name}/status/${tweet.id}`];

    // FixTweet's own translated URLs don't carry the translation through to
    // Discord's crawler, so add it here from the API response instead.
    const t = tweet.translation;
    if (t?.text && t.source_lang !== t.target_lang && t.text.trim() !== tweet.text?.trim()) {
      const from = t.source_lang_en || t.source_lang.toUpperCase();
      lines.push(
        `🌐 **Translated from ${from}:** ${this.truncate(t.text.trim(), TWEET_TRANSLATION_MAX_LENGTH)}`,
      );
    }

    lines.push(this.removalHint(posterId));
    return lines.join("\n");
  }

  private removalHint(posterId: string): string {
    return `-# <@${posterId}> ${TWEET_REMOVAL_HINT}`;
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
   * Only our tweet replies are removable this way, never ordinary Claude
   * replies. Tracked messages are known; otherwise look for our removal hint
   * next to a tweet link in the message text. (Discord's unfurled embed is
   * attached asynchronously, so it is deliberately not part of the check.)
   */
  isTweetEmbedMessage(message: Message): boolean {
    if (this.store.getByBotMessage(message.id)) return true;
    if (!message.content.includes(TWEET_REMOVAL_HINT)) return false;
    return extractTweetLinks(message.content).tweets.length > 0;
  }

  /**
   * True when `message` is a Discord reply to one of our tweet embeds. Used by
   * the Claude flow: replying to a bot message pings the bot, but a reply to a
   * tweet embed is conversation about the tweet, not a question for Claude.
   */
  async isReplyToTweetEmbed(message: Message): Promise<boolean> {
    const referenceId = message.reference?.messageId;
    if (!referenceId) return false;
    if (this.store.getByBotMessage(referenceId)) return true;
    try {
      const referenced = await message.channel.messages.fetch(referenceId);
      return referenced.author.id === this.botId && this.isTweetEmbedMessage(referenced);
    } catch {
      return false;
    }
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
