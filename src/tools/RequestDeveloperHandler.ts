import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { LedgerClient, LedgerUnavailable } from "../services/ledger";
import { config } from "../config";
import { DEV_REQUEST_LIMIT_PER_HOUR } from "../constants";

interface RequestDeveloperInput {
  title: string;
  details: string;
  kind?: "feature" | "bug";
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Passes feature requests and bug reports about the bot to its developer (via Ledger),
 * so "I can't do that" turns into a ticket someone works on.
 */
export class RequestDeveloperHandler implements ToolHandler {
  name = "request_developer";
  description =
    "Pass a feature request or bug report about yourself to your developer, who builds and deploys you. Use it when someone wishes you could do something you can't, asks for a change to how you work, or reports you doing something wrong. Then tell them you've passed it on and give the request id. Write it so a developer can act on it without the chat. Don't use it for questions you can answer yourself.";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title, e.g. 'Chart stock prices' or 'Tweet embeds miss quoted videos'.",
      },
      details: {
        type: "string",
        description: "What they want and why, with an example from the conversation.",
      },
      kind: { type: "string", enum: ["feature", "bug"] },
    },
    required: ["title", "details"],
    additionalProperties: false,
  };

  private recent = new Map<string, number[]>();

  constructor(private ledger: LedgerClient) {}

  validateInput(input: ToolInput): boolean {
    const typed = input as RequestDeveloperInput;
    return (
      typeof typed.title === "string" &&
      typed.title.trim().length > 0 &&
      typeof typed.details === "string" &&
      typed.details.trim().length > 0
    );
  }

  /** True if this user may file another request now (and counts it). */
  private allow(userId: string, now: number): boolean {
    const times = (this.recent.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    if (times.length >= DEV_REQUEST_LIMIT_PER_HOUR) {
      this.recent.set(userId, times);
      return false;
    }
    times.push(now);
    this.recent.set(userId, times);
    return true;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { title, details } = input as RequestDeveloperInput;
    const kind = (input as RequestDeveloperInput).kind === "bug" ? "bug" : "feature";
    const message = context.message;
    const guild = message.guild;

    const allowed = config.ledger.guildIds;
    if (allowed.length > 0 && (!guild || !allowed.includes(guild.id))) {
      return {
        content:
          "Developer requests aren't turned on here. Suggest they ask in the server where requests are on.",
        error: true,
      };
    }
    if (!this.allow(message.author.id, Date.now())) {
      return {
        content: `This person has already filed ${DEV_REQUEST_LIMIT_PER_HOUR} requests in the last hour. Ask them to wait a bit.`,
        error: true,
      };
    }

    const requester = message.member?.displayName ?? message.author.displayName;
    try {
      const item = await this.ledger.request({
        title,
        details,
        kind,
        requester,
        server: guild?.name,
        link: guild ? message.url : undefined,
      });
      console.log(
        `   📮 Developer request filed: ${item.id} (${kind}) ${title.trim().slice(0, 120)}`,
      );
      return {
        content: `Passed to the developer as ${item.id ?? "a new request"}: "${item.title}". Nothing more is needed from them now.`,
      };
    } catch (error) {
      const reason = error instanceof LedgerUnavailable ? error.message : String(error);
      console.warn(`   ⚠️ Developer request not filed: ${reason}`);
      return {
        content:
          "Couldn't reach the developer's tracker just now, so the request was NOT filed. Say so and suggest trying again later.",
        error: true,
      };
    }
  }
}
