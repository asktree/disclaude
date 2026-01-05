import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalActionRowComponentBuilder,
} from "discord.js";
import { UserInfoStore } from "../services/userInfoStore";

export const data = new SlashCommandBuilder()
  .setName("setinfo")
  .setDescription("Set information about yourself that the bot will see (pronouns, bio, etc.)");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const userInfoStore = UserInfoStore.getInstance();
  const existingInfo = await userInfoStore.getUserInfo(interaction.user.id);

  // Create a modal for user input
  const modal = new ModalBuilder().setCustomId("setinfo_modal").setTitle("Set Your Information");

  const pronounsInput = new TextInputBuilder()
    .setCustomId("pronouns")
    .setLabel("Pronouns")
    .setPlaceholder("e.g., she/her, he/him, they/them")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(50);

  if (existingInfo?.pronouns) {
    pronounsInput.setValue(existingInfo.pronouns);
  }

  const bioInput = new TextInputBuilder()
    .setCustomId("bio")
    .setLabel("Bio / Additional Info")
    .setPlaceholder("Anything else you'd like the bot to know about you")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  if (existingInfo?.bio) {
    bioInput.setValue(existingInfo.bio);
  }

  const pronounsRow = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
    pronounsInput,
  );
  const bioRow = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(bioInput);

  modal.addComponents(pronounsRow, bioRow);

  await interaction.showModal(modal);
}
