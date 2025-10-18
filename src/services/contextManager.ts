import { Message, Collection, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { config } from '../config';

interface ChannelContext {
  lastResponseTime: number;
  followUpCount: number;
  isMonitoring: boolean;
}

export class ContextManager {
  private channelContexts: Map<string, ChannelContext> = new Map();

  async getMessageContext(
    channel: TextChannel | DMChannel | NewsChannel,
    limit: number = config.bot.maxContextMessages
  ): Promise<Collection<string, Message>> {
    try {
      const messages = await channel.messages.fetch({ limit });
      // Return messages in chronological order (oldest first)
      return messages.reverse();
    } catch (error) {
      console.error('Error fetching message context:', error);
      return new Collection();
    }
  }

  startMonitoring(channelId: string): void {
    this.channelContexts.set(channelId, {
      lastResponseTime: Date.now(),
      followUpCount: 0,
      isMonitoring: true,
    });

    // Set timeout to stop monitoring after configured time
    setTimeout(() => {
      this.stopMonitoring(channelId);
    }, config.bot.followUpTimeoutMs);
  }

  stopMonitoring(channelId: string): void {
    const context = this.channelContexts.get(channelId);
    if (context) {
      context.isMonitoring = false;
    }
  }

  isMonitoringChannel(channelId: string): boolean {
    const context = this.channelContexts.get(channelId);
    return context?.isMonitoring || false;
  }

  shouldRespond(channelId: string): boolean {
    const context = this.channelContexts.get(channelId);
    if (!context || !context.isMonitoring) {
      return false;
    }

    // Check if we've exceeded the follow-up message count
    if (context.followUpCount >= config.bot.followUpMessageCount) {
      this.stopMonitoring(channelId);
      return false;
    }

    return true;
  }

  incrementFollowUpCount(channelId: string): void {
    const context = this.channelContexts.get(channelId);
    if (context) {
      context.followUpCount++;
      context.lastResponseTime = Date.now();
    }
  }

  resetFollowUpCount(channelId: string): void {
    const context = this.channelContexts.get(channelId);
    if (context) {
      context.followUpCount = 0;
    }
  }
}