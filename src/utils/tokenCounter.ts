import { encoding_for_model, TiktokenModel } from '@dqbd/tiktoken';

export class TokenCounter {
  private encoder: any;

  constructor() {
    // Use cl100k_base encoding (used by GPT-4 and Claude models)
    // This is a reasonable approximation for Claude's tokenization
    this.encoder = encoding_for_model('gpt-4' as TiktokenModel);
  }

  countTokens(text: string): number {
    try {
      const tokens = this.encoder.encode(text);
      return tokens.length;
    } catch (error) {
      console.error('Error counting tokens:', error);
      // Fallback to rough estimation (1 token ≈ 4 characters)
      return Math.ceil(text.length / 4);
    }
  }

  countMessageTokens(messages: Array<{ role: string; content: string | any[] }>): number {
    let totalTokens = 0;

    for (const message of messages) {
      // Account for message formatting overhead (role, etc.)
      totalTokens += 4; // Approximate overhead per message

      // Count role tokens
      totalTokens += this.countTokens(message.role);

      // Count content tokens
      if (typeof message.content === 'string') {
        totalTokens += this.countTokens(message.content);
      } else if (Array.isArray(message.content)) {
        // Handle multimodal content
        for (const block of message.content) {
          if (block.type === 'text') {
            totalTokens += this.countTokens(block.text || '');
          } else if (block.type === 'image') {
            // Images typically consume ~1000-2000 tokens depending on size
            // Use a conservative estimate
            totalTokens += 1500;
          }
        }
      }
    }

    return totalTokens;
  }

  trimMessagesToTokenLimit(
    messages: Array<{ role: string; content: string | any[] }>,
    maxTokens: number,
    preserveLatest: number = 5
  ): Array<{ role: string; content: string | any[] }> {
    if (messages.length <= preserveLatest) {
      return messages;
    }

    // Always keep the latest messages
    const latestMessages = messages.slice(-preserveLatest);
    const olderMessages = messages.slice(0, -preserveLatest);

    let currentTokens = this.countMessageTokens(latestMessages);
    const trimmedMessages: Array<{ role: string; content: string | any[] }> = [];

    // Add older messages from newest to oldest until we hit the limit
    for (let i = olderMessages.length - 1; i >= 0; i--) {
      const messageTokens = this.countMessageTokens([olderMessages[i]]); // Use the proper counting method

      if (currentTokens + messageTokens <= maxTokens) {
        trimmedMessages.unshift(olderMessages[i]);
        currentTokens += messageTokens;
      } else {
        // We've hit the limit
        break;
      }
    }

    // If we had to trim, add a system message indicating context was trimmed
    if (trimmedMessages.length < olderMessages.length) {
      const skippedCount = olderMessages.length - trimmedMessages.length;
      trimmedMessages.unshift({
        role: 'user',
        content: `[Context Note: ${skippedCount} earlier messages were trimmed to fit token limit]`,
      });
    }

    return [...trimmedMessages, ...latestMessages];
  }

  estimateTokenCost(tokens: number, model: string = 'claude-3-haiku'): { input: number; output: number } {
    // Rough cost estimates per million tokens (as of 2024)
    const costs: Record<string, { input: number; output: number }> = {
      'claude-3-haiku': { input: 0.25, output: 1.25 },
      'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-opus': { input: 15.0, output: 75.0 },
    };

    const modelCost = costs[model] || costs['claude-3-haiku'];

    return {
      input: (tokens / 1_000_000) * modelCost.input,
      output: (tokens / 1_000_000) * modelCost.output,
    };
  }

  cleanup(): void {
    if (this.encoder) {
      this.encoder.free();
    }
  }
}