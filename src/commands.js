'use strict';

const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const log = require('./logger')('commands');

// Admin-Befehle sind standardmäßig nur für "Kanäle verwalten" sichtbar. Zusätzlich prüft der Bot
// bei jeder Ausführung serverseitig (falls ein Admin die Sichtbarkeit in den Servereinstellungen ändert).
const ADMIN = PermissionFlagsBits.ManageChannels;

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Postet das Panel zum Erstellen temporärer Voicechannels.')
    .setDefaultMemberPermissions(ADMIN)
    .addChannelOption((o) =>
      o
        .setName('kanal')
        .setDescription('Kanal für das Panel (Standard: panelChannelId aus der Config, sonst dieser Kanal)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement),
    ),
  new SlashCommandBuilder()
    .setName('tempchannels')
    .setDescription('Zeigt alle aktiven temporären Channels.')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName('tempchannels_cleanup')
    .setDescription('Bereinigt verwaiste und leere temporäre Channels.')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName('tempchannels_config')
    .setDescription('Zeigt die aktuelle Konfiguration.')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder()
    .setName('spiel')
    .setDescription('Spiele im Dropdown verwalten.')
    .setDefaultMemberPermissions(ADMIN)
    .addSubcommand((sub) =>
      sub
        .setName('hinzufügen')
        .setDescription('Fügt ein Spiel zum Dropdown hinzu.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Name des Spiels, z. B. Valorant').setRequired(true).setMaxLength(50),
        )
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji für Dropdown und Kanalname (Standard: 🎮)'))
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription('Benutzerlimit für Channels dieses Spiels (Standard aus der Config)')
            .setMinValue(1)
            .setMaxValue(99),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('entfernen')
        .setDescription('Entfernt ein Spiel aus dem Dropdown.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Spiel, das entfernt werden soll').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('liste').setDescription('Zeigt alle Spiele im Dropdown.')),
  new SlashCommandBuilder()
    .setName('kanal')
    .setDescription('Öffnet das Verwaltungsmenü deines temporären Voicechannels.'),
].map((c) => c.toJSON());

// Registriert die Slash-Commands direkt auf einem Server (sofort verfügbar).
async function registerForGuild(guild) {
  try {
    await guild.commands.set(commands);
    log.info(`Befehle registriert auf "${guild.name}"`);
  } catch (err) {
    log.error(`Registrierung auf "${guild.name}" fehlgeschlagen:`, err.message);
  }
}

module.exports = { commands, registerForGuild };
