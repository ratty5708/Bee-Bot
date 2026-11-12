const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const config = require('./config');
const games = require('./games');
const log = require('./logger')('panel');

const SELECT_ID = 'tempvc_game';
const BUTTON_ID = 'tempvc_create';

function buildPanel(guildId) {
  const list = games.getGames(guildId);
  const empty = list.length === 0;

  const embed = new EmbedBuilder()
    .setTitle(config.panel.title)
    .setDescription(config.panel.description)
    .setColor(config.panel.color);

  // Ein Dropdown braucht mindestens eine Option, daher ein deaktivierter Platzhalter.
  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder(empty ? 'Noch keine Spiele – /spiel hinzufügen' : config.panel.selectPlaceholder)
    .setDisabled(empty)
    .addOptions(
      empty
        ? [{ label: 'Keine Spiele', value: 'none' }]
        : list.map((g) => ({ label: g.label, value: g.value, emoji: g.emoji })),
    );

  const button = new ButtonBuilder()
    .setCustomId(BUTTON_ID)
    .setLabel(config.panel.buttonLabel)
    .setStyle(ButtonStyle.Success)
    .setEmoji('➕')
    .setDisabled(empty);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(button),
    ],
  };
}

// Aktualisiert alle mit /setup geposteten Panels eines Servers; gelöschte Panels werden vergessen.
async function refreshPanels(guild) {
  const content = buildPanel(guild.id);
  for (const { channelId, messageId } of [...games.getPanels(guild.id)]) {
    try {
      const channel = await guild.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(content);
    } catch (err) {
      // 10003 = Unknown Channel, 10008 = Unknown Message
      if (err.code === 10003 || err.code === 10008) games.removePanel(guild.id, messageId);
      else log.error('Aktualisieren fehlgeschlagen:', err.message);
    }
  }
}

module.exports = { buildPanel, refreshPanels, SELECT_ID, BUTTON_ID };
