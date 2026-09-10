import {
  APIEmbed,
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  PermissionFlagsBits,
  User,
} from "discord.js";
import {
  MAX_TWEETS_PER_MESSAGE,
  TWEET_DELETE_EMOJIS,
  TWEET_EMBED_COLOR,
  TWEET_LINK_TTL_MS,
  TWEET_MAX_GALLERY_IMAGES,
  TWEET_QUOTE_TEXT_MAX_LENGTH,
  TWEET_TEXT_MAX_LENGTH,
  CACHE_CLEANUP_INTERVAL_MS,
} from "../constants";
import { extractTweetLinks, fetchTweet, FxTweet } from "../services/fxtwitter";

const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;
const DELETE_HINT_EMOJI = "🗑️";

interface EmbedLink {
  sourceMessageId: string;
  botMessageId: string;
  channelId: string;
  /** The Discord user who posted the original link */
  authorId: string;
  createdAt: number;
}

/**
 * Expands tweet links into rich embeds (fxtwitter-style) and lets the person
 * who posted the link remove the embed again by reacting with a delete emoji.
 *
 * This is deliberately independent from the Claude conversation flow: it never
 * calls the model, and it runs for every message whether or not the bot is
 * mentioned.
 */
export class TweetEmbedHandler {
  private botId: string;
  private bySource = new Map<string, EmbedLink>();
  private byBotMessage = new Map<string, EmbedLink>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(botId: string) {
    this.botId = botId;
    this.cleanupInterval = setInterval(() => this.prune(), CACHE_CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  private prune(): void {
    const cutoff = Date.now() - TWEET_LINK_TTL_MS;
    for (const [id, link] of this.bySource) {
      if (link.createdAt < cutoff) {
        this.bySource.delete(id);
        this.byBotMessage.delete(link.botMessageId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Posting embeds
  // ---------------------------------------------------------------------------

  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.author.id === this.botId) return;
    if (!message.content) return;

    const links = extractTweetLinks(message.content);
    if (links.length === 0) return;

    const toFetch = links.slice(0, MAX_TWEETS_PER_MESSAGE);
    console.log(`🐦 Found ${links.length} tweet link(s) in message ${message.id}`);

    const results = await Promise.all(toFetch.map((link) => fetchTweet(link)));

    const embeds: APIEmbed[] = [];
    const contentLines: string[] = [];
    const failures: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result.ok) {
        console.log(`   ⚠️ Could not expand ${toFetch[i].url}: ${result.message}`);
        if (result.reason !== "error") failures.push(result.message);
        continue;
      }

      const built = this.buildEmbeds(result.tweet);
      const room = DISCORD_MAX_EMBEDS_PER_MESSAGE - embeds.length;
      embeds.push(...built.embeds.slice(0, room));
      if (built.videoUrl) contentLines.push(built.videoUrl);
    }

    if (embeds.length === 0) {
      // Nothing to show. Private/deleted posts get a short note so the poster
      // knows the link is dead; transient API errors stay silent.
      if (failures.length > 0) {
        await this.safeReply(message, { content: `🐦 ${failures[0]}.` });
      }
      return;
    }

    const sent = await this.safeReply(message, {
      content: contentLines.length > 0 ? contentLines.join("\n") : undefined,
      embeds,
    });
    if (!sent) return;

    const link: EmbedLink = {
      sourceMessageId: message.id,
      botMessageId: sent.id,
      channelId: message.channelId,
      authorId: message.author.id,
      createdAt: Date.now(),
    };
    this.bySource.set(message.id, link);
    this.byBotMessage.set(sent.id, link);

    // Best-effort niceties: hide the original (usually broken) X embed, and
    // pre-add the delete reaction so the poster can remove ours in one click.
    await Promise.all([
      message.suppressEmbeds(true).catch(() => undefined),
      sent.react(DELETE_HINT_EMOJI).catch(() => undefined),
    ]);
  }

  private async safeReply(
    message: Message,
    payload: { content?: string; embeds?: APIEmbed[] },
  ): Promise<Message | null> {
    try {
      return await message.reply({
        ...payload,
        allowedMentions: { parse: [], repliedUser: false },
        failIfNotExists: false,
      });
    } catch (error) {
      console.error("❌ Failed to post tweet embed:", error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Embed construction
  // ---------------------------------------------------------------------------

  private buildEmbeds(tweet: FxTweet): { embeds: APIEmbed[]; videoUrl?: string } {
    const embeds: APIEmbed[] = [];
    let videoUrl: string | undefined;

    const authorName = `${tweet.author.name} (@${tweet.author.screen_name})`;
    const main: APIEmbed = {
      color: TWEET_EMBED_COLOR,
      url: tweet.url,
      author: {
        name: authorName.slice(0, 256),
        url: tweet.author.url || `https://x.com/${tweet.author.screen_name}`,
        icon_url: tweet.author.avatar_url,
      },
      description: this.formatMainText(tweet),
      fields: [],
      timestamp: new Date(tweet.created_timestamp * 1000).toISOString(),
      footer: { text: this.formatFooter(tweet) },
    };

    // Media: photos become an image gallery; videos get a thumbnail plus the
    // raw mp4 in message content, which Discord renders as a playable video.
    const photos = tweet.media?.photos ?? [];
    const videos = tweet.media?.videos ?? [];
    if (photos.length > 0) {
      main.image = { url: photos[0].url };
      for (const photo of photos.slice(1, TWEET_MAX_GALLERY_IMAGES)) {
        embeds.push({ url: tweet.url, image: { url: photo.url } });
      }
    } else if (videos.length > 0) {
      main.image = { url: videos[0].thumbnail_url };
      videoUrl = videos[0].url;
    }

    if (tweet.poll) {
      main.fields!.push(this.formatPoll(tweet.poll));
    }

    if (tweet.quote) {
      main.fields!.push(this.formatQuote(tweet.quote));
      const quotePhotos = tweet.quote.media?.photos ?? [];
      const quoteVideos = tweet.quote.media?.videos ?? [];
      if (!main.image) {
        if (quotePhotos.length > 0) {
          main.image = { url: quotePhotos[0].url };
        } else if (quoteVideos.length > 0) {
          main.image = { url: quoteVideos[0].thumbnail_url };
        }
      }
    }

    if (tweet.community_note?.text) {
      main.fields!.push({
        name: "📝 Readers added context",
        value: this.truncate(tweet.community_note.text, TWEET_QUOTE_TEXT_MAX_LENGTH),
      });
    }

    if (main.fields!.length === 0) delete main.fields;

    embeds.unshift(main);
    return { embeds, videoUrl };
  }

  private formatMainText(tweet: FxTweet): string {
    let text = tweet.text?.trim() ?? "";
    if (tweet.replying_to) {
      const replyUrl = tweet.replying_to_status
        ? `https://x.com/${tweet.replying_to}/status/${tweet.replying_to_status}`
        : `https://x.com/${tweet.replying_to}`;
      text = `*Replying to [@${tweet.replying_to}](${replyUrl})*\n${text}`;
    }
    return this.truncate(text, TWEET_TEXT_MAX_LENGTH) || "​";
  }

  private formatQuote(quote: FxTweet): { name: string; value: string } {
    const media: string[] = [];
    const photos = quote.media?.photos?.length ?? 0;
    const videos = quote.media?.videos?.length ?? 0;
    if (photos > 0) media.push(`🖼️ ${photos} photo${photos === 1 ? "" : "s"}`);
    if (videos > 0) media.push(`🎥 ${videos} video${videos === 1 ? "" : "s"}`);

    let value = this.truncate(quote.text?.trim() ?? "", TWEET_QUOTE_TEXT_MAX_LENGTH);
    if (media.length > 0) value += `${value ? "\n" : ""}${media.join(" · ")}`;
    value += `\n[Open quoted post](${quote.url})`;

    return {
      name: `↩️ Quoting ${quote.author.name} (@${quote.author.screen_name})`.slice(0, 256),
      value: value.slice(0, 1024),
    };
  }

  private formatPoll(poll: NonNullable<FxTweet["poll"]>): { name: string; value: string } {
    const lines = poll.choices.map((choice) => {
      const filled = Math.round(choice.percentage / 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      return `${bar} ${choice.percentage}% · ${choice.label}`;
    });
    lines.push(`${poll.total_votes.toLocaleString()} votes · ${poll.time_left_en}`);
    return { name: "📊 Poll", value: lines.join("\n").slice(0, 1024) };
  }

  private formatFooter(tweet: FxTweet): string {
    const stats: string[] = [];
    if (tweet.likes != null) stats.push(`❤️ ${this.compact(tweet.likes)}`);
    if (tweet.retweets != null) stats.push(`🔁 ${this.compact(tweet.retweets)}`);
    if (tweet.replies != null) stats.push(`💬 ${this.compact(tweet.replies)}`);
    if (tweet.views != null) stats.push(`👁️ ${this.compact(tweet.views)}`);
    return `X  ·  ${stats.join("  ")}  ·  ${DELETE_HINT_EMOJI} to remove`;
  }

  private compact(n: number): string {
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
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
      if (message.embeds.length === 0 && !this.byBotMessage.has(message.id)) return;

      const allowed = await this.canRemove(message, user.id);
      if (!allowed) return;

      await message.delete();
      this.forget(message.id);
      console.log(`🗑️ Removed tweet embed ${message.id} at request of ${user.id}`);
    } catch (error) {
      console.error("❌ Error handling delete reaction:", error);
    }
  }

  async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    const link = this.bySource.get(message.id);
    if (!link) return;

    try {
      const channel = await message.client.channels.fetch(link.channelId);
      if (channel && "messages" in channel) {
        await channel.messages.delete(link.botMessageId);
        console.log(`🗑️ Removed tweet embed ${link.botMessageId}: source message was deleted`);
      }
    } catch (error) {
      console.error("❌ Error removing embed for deleted message:", error);
    } finally {
      this.forget(link.botMessageId);
    }
  }

  private isDeleteEmoji(name: string | null): boolean {
    if (!name) return false;
    const normalized = name.replace(/️/g, "");
    return TWEET_DELETE_EMOJIS.some((emoji) => emoji.replace(/️/g, "") === normalized);
  }

  /**
   * The original poster can always remove the embed. So can anyone who could
   * delete the message anyway (Manage Messages in that channel).
   */
  private async canRemove(botMessage: Message, userId: string): Promise<boolean> {
    const tracked = this.byBotMessage.get(botMessage.id);
    if (tracked?.authorId === userId) return true;

    // Fall back to the reply reference, which survives bot restarts.
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

  private forget(botMessageId: string): void {
    const link = this.byBotMessage.get(botMessageId);
    if (!link) return;
    this.byBotMessage.delete(botMessageId);
    this.bySource.delete(link.sourceMessageId);
  }
}
