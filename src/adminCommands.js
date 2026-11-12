'use strict';

const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const db = require('./db');
const games = require('./games');
const cm = require('./channelManager');
const { buildPanel } = require('./panel');
const log = require('./logger')('admin');

const EPHEMERAL = MessageFlags.Ephemeral;

async function handleSetup(interaction) {
  const option = interaction.options.getChannel('kanal');
  const configured = config.panelChannelId ? interaction.guild.channels.cache.get(config.panelChannelId) : null;
  if (config.panelChannelId && !configured && !option) {
    log.warn(`panelChannelId ${config.panelChannelId} wurde auf "${interaction.guild.name}" nicht gefunden.`);
  }
  const target = option ?? configured ?? interaction.channel;

  if (!target?.isTextBased()) {
    return interaction.reply({ content: '⚠️ In diesen Kanal kann der Bot keine Nachrichten posten.', flags: EPHEMERAL });
  }
  const perms = target.permissionsFor(interaction.guild.members.me);
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (!perms?.has(needed)) {
    return interaction.reply({
      content: `⚠️ Dem Bot fehlen in ${target} die Rechte „Kanal ansehen“, „Nachrichten senden“ oder „Links einbetten“.`,
      flags: EPHEMERAL,
    });
  }

  const message = await target.send(buildPanel(interaction.guildId));
  games.addPanel(interaction.guildId, message.channelId, message.id);
  log.info(`Panel gepostet in #${target.name} von ${interaction.user.tag}`);
  return interaction.reply({ content: `✅ Das Panel wurde in ${target} gepostet.`, flags: EPHEMERAL });
}

async function handleList(interaction) {
  const rows = db.listChannels(interaction.guildId);
  const embed = new EmbedBuilder().setTitle('🐝 Aktive temporäre Channels').setColor(config.panel.color);

  if (!rows.length) {
    embed.setDescription('Zurzeit gibt es keine temporären Channels.');
    return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  }

  const lines = rows.map((row) => {
    const channel = interaction.guild.channels.cache.get(row.channelId);
    if (!channel) return `⚠️ \`${row.channelId}\` (Channel fehlt, wird bei der nächsten Bereinigung entfernt)`;
    const humans = cm.humanCount(channel);
    const limit = channel.userLimit ? `/${channel.userLimit}` : '';
    const bans = db.listBans(row.channelId).length;
    return (
      `${row.locked ? '🔒' : '🔊'} ${channel} · 👑 <@${row.ownerId}> · 👥 ${humans}${limit}` +
      (bans ? ` · 🔨 ${bans}` : '') +
      ` · seit <t:${Math.floor(row.createdAt / 1000)}:R>`
    );
  });

  let description = '';
  for (const line of lines) {
    if (description.length + line.length + 1 > 4000) {
      description += '\n…';
      break;
    }
    description += `${line}\n`;
  }
  const max = config.maxChannels > 0 ? ` von max. ${config.maxChannels}` : '';
  embed.setDescription(description).setFooter({ text: `${rows.length} Channel${rows.length === 1 ? '' : 's'}${max}` });
  return interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function handleCleanup(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const stats = await cm.runCleanup(interaction.client, { guildId: interaction.guildId });
  log.info(`Manuelle Bereinigung durch ${interaction.user.tag}:`, stats);
  return interaction.editReply(
    `🧹 Bereinigung abgeschlossen.\n` +
      `• Geprüft: **${stats.checked}**\n` +
      `• Leere Channels gelöscht: **${stats.deletedChannels}**\n` +
      `• Verwaiste Einträge entfernt: **${stats.removedEntries}**\n` +
      `-# Channels, die jünger als ${cm.CREATE_GRACE_MS / 1000} Sekunden sind, bleiben stehen (Ersteller wird gerade hineingeschoben).`,
  );
}

function fmtChannel(id, fallback) {
  return id ? `<#${id}>` : fallback;
}

function fmtRoles(ids, fallback) {
  return ids.length ? ids.map((id) => `<@&${id}>`).join(', ') : fallback;
}

async function handleConfig(interaction) {
  const list = games.getGames(interaction.guildId);
  const gameText = list.length
    ? list.map((g) => `${g.emoji} ${g.label}${g.userLimit ? ` (Limit ${g.userLimit})` : ''}`).join('\n')
    : 'Keine Spiele';
  const limitRange = cm.userLimitRange();

  const embed = new EmbedBuilder()
    .setTitle('⚙️ BeeBot-Konfiguration')
    .setColor(config.panel.color)
    .addFields(
      { name: 'Kategorie', value: fmtChannel(config.categoryId, 'Kategorie des Panel-Kanals'), inline: true },
      { name: 'Panel-Kanal', value: fmtChannel(config.panelChannelId, 'Kanal von /setup'), inline: true },
      { name: 'Kick-Ziel', value: fmtChannel(config.kickTargetChannelId, 'Verbindung trennen'), inline: true },
      {
        name: 'Max. temporäre Channels',
        value: config.maxChannels > 0 ? String(config.maxChannels) : 'unbegrenzt',
        inline: true,
      },
      {
        name: 'Standard-Benutzerlimit',
        value: String(cm.clampUserLimit(config.defaultUserLimit) || 'unbegrenzt'),
        inline: true,
      },
      { name: 'Erlaubte Limits', value: `${limitRange.min} bis ${limitRange.max}${limitRange.min === 0 ? ' (0 = unbegrenzt)' : ''}`, inline: true },
      { name: 'Namensschema', value: `\`${config.nameTemplate}\``, inline: true },
      { name: 'Bereinigung', value: `alle ${config.sweepIntervalSeconds} s`, inline: true },
      { name: 'Guild-Beschränkung', value: process.env.GUILD_ID ? `\`${process.env.GUILD_ID}\`` : 'alle Server', inline: true },
      { name: 'Erstellen erlaubt für', value: fmtRoles(config.allowedRoleIds, 'alle Mitglieder'), inline: true },
      { name: 'Zusätzliche Admin-Rollen', value: fmtRoles(config.adminRoleIds, 'keine'), inline: true },
      { name: 'Aktive Channels', value: String(db.countChannels(interaction.guildId)), inline: true },
      { name: `Spiele (${list.length}/${games.MAX_GAMES})`, value: gameText.slice(0, 1024) },
    )
    .setFooter({ text: 'Änderungen: config.json bearbeiten und Bot neu starten · Spiele: /spiel' });

  return interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

module.exports = { handleSetup, handleList, handleCleanup, handleConfig };
