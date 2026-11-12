'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const config = require('./config');
const db = require('./db');
const log = require('./logger')('control');

// Custom-IDs der Verwaltungs-Komponenten: "vcm:<aktion>:<channelId>[:<zielId>]".
// Sie enthalten keinen Zustand außer IDs; alles Weitere (Besitzer, Rechte, Sperren) wird bei jedem
// Klick frisch aus der Datenbank und von Discord gelesen. Deshalb funktionieren die Buttons auch
// nach einem Neustart, und manipulierte IDs bringen nichts.
const PREFIX = 'vcm';

function customId(action, channelId, extra) {
  return [PREFIX, action, channelId, extra].filter(Boolean).join(':');
}

function parseCustomId(id) {
  const [prefix, action, channelId, extra] = id.split(':');
  if (prefix !== PREFIX || !action || !/^\d{17,20}$/.test(channelId || '')) return null;
  if (extra !== undefined && !/^\d{17,20}$/.test(extra)) return null;
  return { action, channelId, extra };
}

function button(action, channelId, label, emoji, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId(action, channelId)).setLabel(label).setEmoji(emoji).setStyle(style);
}

function buildControlPanel(channel, row) {
  const banCount = db.listBans(row.channelId).length;
  const limit = channel.userLimit ? String(channel.userLimit) : 'unbegrenzt';

  const embed = new EmbedBuilder()
    .setTitle('🎛️ Channel-Verwaltung')
    .setColor(config.panel.color)
    .setDescription(
      [
        `👑 **Besitzer:** <@${row.ownerId}>`,
        row.locked ? '🔒 **Status:** gesperrt, niemand Neues kann beitreten' : '🔓 **Status:** offen',
        `👥 **Benutzerlimit:** ${limit}`,
        `🔨 **Gesperrte Mitglieder:** ${banCount}`,
      ].join('\n'),
    )
    .addFields(
      {
        name: 'Channel verwalten',
        value: '✏️ Channel umbenennen\n👥 Benutzerlimit ändern\n🔒 Channel sperren / entsperren\n👑 Besitzer übertragen',
        inline: true,
      },
      {
        name: 'Mitglieder verwalten',
        value: '👢 Mitglied kicken\n🔨 Mitglied bannen\n🔓 Mitglied entbannen\n📋 Gesperrte Mitglieder anzeigen',
        inline: true,
      },
    )
    .setFooter({ text: 'Nur der Besitzer und Server-Admins können diese Buttons nutzen.' });

  const id = row.channelId;
  const channelRow = new ActionRowBuilder().addComponents(
    button('rename', id, 'Umbenennen', '✏️'),
    button('limit', id, 'Benutzerlimit', '👥'),
    row.locked
      ? button('unlock', id, 'Entsperren', '🔓', ButtonStyle.Success)
      : button('lock', id, 'Sperren', '🔒', ButtonStyle.Danger),
    button('transfer', id, 'Besitzer übertragen', '👑', ButtonStyle.Primary),
  );
  const memberRow = new ActionRowBuilder().addComponents(
    button('kick', id, 'Kicken', '👢'),
    button('ban', id, 'Bannen', '🔨', ButtonStyle.Danger),
    button('unban', id, 'Entbannen', '🔓'),
    button('bans', id, 'Gesperrte', '📋'),
  );

  return { embeds: [embed], components: [channelRow, memberRow] };
}

// Postet das Verwaltungsmenü in den Text-Chat des Voicechannels.
async function postControlPanel(channel) {
  const row = db.getChannel(channel.id);
  if (!row) return;
  try {
    const message = await channel.send({
      content: `<@${row.ownerId}> hier verwaltest du deinen Channel.`,
      allowedMentions: { users: [row.ownerId] },
      ...buildControlPanel(channel, row),
    });
    db.setControlMessage(channel.id, message.id);
  } catch (err) {
    log.warn(`Verwaltungsmenü in "${channel.name}" konnte nicht gepostet werden:`, err.message);
  }
}

// Aktualisiert das Menü nach Änderungen (Besitzer, Sperre, Limit, Sperrliste).
async function refreshControlPanel(channel) {
  const row = db.getChannel(channel.id);
  if (!row) return;
  if (!row.controlMessageId) return postControlPanel(channel);
  try {
    const message = await channel.messages.fetch(row.controlMessageId);
    await message.edit({
      content: `<@${row.ownerId}> hier verwaltest du deinen Channel.`,
      allowedMentions: { parse: [] },
      ...buildControlPanel(channel, row),
    });
  } catch (err) {
    if (err.code === 10008) return postControlPanel(channel); // Nachricht wurde gelöscht
    log.warn(`Verwaltungsmenü in "${channel.name}" konnte nicht aktualisiert werden:`, err.message);
  }
}

module.exports = { PREFIX, customId, parseCustomId, buildControlPanel, postControlPanel, refreshControlPanel };
