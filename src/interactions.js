'use strict';

const { MessageFlags } = require('discord.js');
const db = require('./db');
const games = require('./games');
const cm = require('./channelManager');
const admin = require('./adminCommands');
const { isAdmin, canCreate } = require('./permissions');
const { refreshPanels, SELECT_ID, BUTTON_ID } = require('./panel');
const { postControlPanel, PREFIX: MANAGE_PREFIX } = require('./controlPanel');
const { handleManageInteraction, handleKanalCommand } = require('./manage');
const log = require('./logger')('interactions');

const EPHEMERAL = MessageFlags.Ephemeral;

function replyEphemeral(interaction, content) {
  return interaction.reply({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------------------------
// /spiel
// ---------------------------------------------------------------------------------------------

async function handleSpiel(interaction) {
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'liste') {
    const list = games.getGames(guildId);
    const text = list.length
      ? list.map((g) => `${g.emoji} ${g.label}${g.userLimit ? ` (Limit ${g.userLimit})` : ''}`).join('\n')
      : 'Noch keine Spiele. Füge welche mit `/spiel hinzufügen` hinzu.';
    return replyEphemeral(interaction, `**Spiele im Dropdown (${list.length}/${games.MAX_GAMES}):**\n${text}`);
  }

  if (sub === 'hinzufügen') {
    const name = interaction.options.getString('name', true);
    const emoji = interaction.options.getString('emoji') || '🎮';
    const limit = interaction.options.getInteger('limit');
    const error = games.addGame(guildId, name, emoji, limit);
    if (error) return replyEphemeral(interaction, `⚠️ ${error}`);
    await interaction.deferReply({ flags: EPHEMERAL });
    await refreshPanels(interaction.guild);
    return interaction.editReply(`✅ ${emoji} **${name.trim()}** wurde hinzugefügt. Das Panel ist aktualisiert.`);
  }

  if (sub === 'entfernen') {
    const removed = games.removeGame(guildId, interaction.options.getString('name', true));
    if (!removed) return replyEphemeral(interaction, '⚠️ Dieses Spiel gibt es nicht. Wähle eins aus der Vorschlagsliste.');
    await interaction.deferReply({ flags: EPHEMERAL });
    await refreshPanels(interaction.guild);
    return interaction.editReply(`🗑️ ${removed.emoji} **${removed.label}** wurde entfernt. Das Panel ist aktualisiert.`);
  }
}

async function handleAutocomplete(interaction) {
  if (!isAdmin(interaction.member)) return interaction.respond([]);
  const query = interaction.options.getFocused().toLowerCase();
  const matches = games
    .getGames(interaction.guildId)
    .filter((g) => g.label.toLowerCase().includes(query))
    .slice(0, 25)
    .map((g) => ({ name: g.label, value: g.value }));
  await interaction.respond(matches);
}

// ---------------------------------------------------------------------------------------------
// Panel: Spiel auswählen + Channel erstellen
// ---------------------------------------------------------------------------------------------

async function handleSelect(interaction) {
  // Die Auswahl wird gespeichert, damit sie auch einen Neustart des Bots übersteht.
  db.setSelection(interaction.guildId, interaction.user.id, interaction.values[0]);
  await interaction.deferUpdate();
}

async function handleCreate(interaction) {
  const member = interaction.member;
  const gameValue = db.getSelection(interaction.guildId, interaction.user.id);
  if (!gameValue || !games.findGame(interaction.guildId, gameValue)) {
    return replyEphemeral(interaction, '⚠️ Bitte wähle zuerst ein Spiel aus.');
  }
  if (!member.voice.channelId) {
    return replyEphemeral(interaction, '🔇 Du musst dich zuerst in einem Voicechannel befinden.');
  }
  if (!canCreate(member)) {
    return replyEphemeral(interaction, '⛔ Du hast keine Berechtigung, temporäre Channels zu erstellen.');
  }

  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    const channel = await cm.createTempChannel(member, gameValue, interaction.channel);
    await postControlPanel(channel);
    await interaction.editReply(
      `✅ ${channel} wurde erstellt und du wurdest hineingeschoben.\n` +
        '🎛️ Das Verwaltungsmenü findest du im Chat deines Channels oder jederzeit mit `/kanal`.',
    );
  } catch (err) {
    if (err instanceof cm.UserError) return interaction.editReply(`⚠️ ${err.message}`);
    log.error('Channel konnte nicht erstellt werden:', err);
    await interaction.editReply('❌ Der Channel konnte nicht erstellt werden.');
  }
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

const ADMIN_COMMANDS = {
  setup: admin.handleSetup,
  tempchannels: admin.handleList,
  tempchannels_cleanup: admin.handleCleanup,
  tempchannels_config: admin.handleConfig,
  spiel: handleSpiel,
};

async function handleInteraction(interaction) {
  if (!interaction.inCachedGuild()) return;
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'spiel') await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'kanal') return await handleKanalCommand(interaction);
      const handler = ADMIN_COMMANDS[interaction.commandName];
      if (!handler) return;
      if (!isAdmin(interaction.member)) {
        return await replyEphemeral(interaction, '⛔ Dieser Befehl ist nur für Server-Administratoren.');
      }
      return await handler(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === SELECT_ID) return await handleSelect(interaction);
    if (interaction.isButton() && interaction.customId === BUTTON_ID) return await handleCreate(interaction);

    if ((interaction.isMessageComponent() || interaction.isModalSubmit()) && interaction.customId.startsWith(`${MANAGE_PREFIX}:`)) {
      return await handleManageInteraction(interaction);
    }
  } catch (err) {
    log.error(`Unerwarteter Fehler (${interaction.commandName ?? interaction.customId}):`, err);
    if (!interaction.isRepliable()) return;
    const payload = { content: '❌ Es ist ein Fehler aufgetreten.', flags: EPHEMERAL };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

module.exports = { handleInteraction };
