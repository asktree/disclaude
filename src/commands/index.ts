import { Collection, SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import * as setinfo from "./setinfo";
import * as usage from "./usage";

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const commands = new Collection<string, Command>();

// Register all commands
commands.set(setinfo.data.name, setinfo as Command);
commands.set(usage.data.name, usage as unknown as Command);

export function getCommandsJSON(): object[] {
  return Array.from(commands.values()).map((cmd) => cmd.data.toJSON());
}
