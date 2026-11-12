'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const db = require('./db');
const cm = require('./channelManager');
const { authorityOver, checkTarget } = require('./permissions');
const { customId, parseCustomId, buildControlPanel, refreshControlPanel } = require('./controlPanel');
const log = require('./logger')('manage');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] };

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

// Lädt Channel und prüft die Befugnis. Wird bei JEDEM Schritt aufgerufen (Button, Auswahl, Bestätigung),
// damit nichts auf veralteten oder manipulierten Daten beruht.
function context(interaction, channelId) {
  const row = db.getChannel(channelId);
  const channel = row && row.guildId === interaction.guildId ? interaction.guild.channels.cache.get(channelId) : null;
  if (!row || !channel) return { error: 'Dieser temporäre Channel existiert nicht mehr.' };
  const authority = authorityOver(interaction.member, row);
  if (!authority) return { error: '⛔ Nur der Besitzer dieses Channels oder ein Server-Admin kann das tun.' };
  return { row, channel, authority };
}

async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

const isFromEphemeral = (interaction) => Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));

// Antwortet passend: Folge-Schritte in einer Ephemeral-Nachricht ersetzen diese, sonst neue Ephemeral-Antwort.
async function respond(interaction, content, components = []) {
  const payload = { content, embeds: [], components, allowedMentions: NO_MENTIONS };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  if (interaction.isMessageComponent() && isFromEphemeral(interaction)) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: EPHEMERAL });
}

function errorText(err) {
  if (err instanceof cm.UserError) return `⚠️ ${err.message}`;
  if (err?.code === 50013) return '❌ Dem Bot fehlen die nötigen Rechte für diese Aktion.';
  if (err?.code === 10003) return '❌ Dieser Channel existiert nicht mehr.';
  log.error('Unerwarteter Fehler bei einer Verwaltungsaktion:', err);
  return '❌ Das hat nicht geklappt. Bitte versuche es erneut.';
}

function confirmRow(yesAction, channelId, targetId, yesLabel, style) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(yesAction, channelId, targetId)).setLabel(yesLabel).setStyle(style),
    new ButtonBuilder().setCustomId(customId('cancel', channelId)).setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
  );
}

function memberOptions(members, describe) {
  return members.slice(0, 25).map((m) => ({
    label: m.displayName.slice(0, 100),
    description: describe?.(m)?.slice(0, 100) || m.user.username.slice(0, 100),
    value: m.id,
  }));
}

// ---------------------------------------------------------------------------------------------
// Buttons im Verwaltungsmenü
// ---------------------------------------------------------------------------------------------

async function openRename(interaction, { channel }) {
  const modal = new ModalBuilder()
    .setCustomId(customId('rename_modal', channel.id))
    .setTitle('Channel umbenennen')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Neuer Name')
        .setDescription('Discord erlaubt höchstens 2 Umbenennungen pro 10 Minuten.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(100)
            .setValue(channel.name)
            .setRequired(true),
        ),
    );
  await interaction.showModal(modal);
}

async function openLimit(interaction, { channel }) {
  const { min, max } = cm.userLimitRange();
  const modal = new ModalBuilder()
    .setCustomId(customId('limit_modal', channel.id))
    .setTitle('Benutzerlimit ändern')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Maximale Mitglieder')
        .setDescription(min === 0 ? `0 bis ${max}, 0 = unbegrenzt` : `${min} bis ${max}`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('limit')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(2)
            .setValue(String(channel.userLimit || (min === 0 ? 0 : max)))
            .setRequired(true),
        ),
    );
  await interaction.showModal(modal);
}

async function toggleLock(interaction, { channel }, locked) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const changed = await cm.setLocked(channel, locked);
  await refreshControlPanel(channel);
  if (!changed) return respond(interaction, locked ? 'ℹ️ Der Channel ist bereits gesperrt.' : 'ℹ️ Der Channel ist bereits offen.');
  return respond(
    interaction,
    locked
      ? '🔒 Der Channel ist gesperrt. Wer schon drin ist, bleibt drin; niemand Neues kann beitreten.'
      : '🔓 Der Channel ist wieder offen.',
  );
}

async function openTransfer(interaction, { channel, row }) {
  const candidates = [...channel.members.values()].filter((m) => !m.user.bot && m.id !== row.ownerId);
  if (!candidates.length) return respond(interaction, 'ℹ️ Es ist niemand sonst im Channel, an den du den Besitz übertragen kannst.');
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId('transfer_pick', channel.id))
    .setPlaceholder('Neuen Besitzer auswählen …')
    .addOptions(memberOptions(candidates));
  return respond(interaction, '👑 An wen soll der Besitz übertragen werden?', [new ActionRowBuilder().addComponents(select)]);
}

async function openKick(interaction, { channel, authority }) {
  const actor = interaction.member;
  const candidates = [...channel.members.values()].filter((m) => !checkTarget(actor, authority, m));
  if (!candidates.length) return respond(interaction, 'ℹ️ Es ist niemand im Channel, den du kicken kannst.');
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId('kick_pick', channel.id))
    .setPlaceholder('Mitglied zum Kicken auswählen …')
    .addOptions(memberOptions(candidates));
  return respond(interaction, '👢 Wen möchtest du aus dem Channel kicken?', [new ActionRowBuilder().addComponents(select)]);
}

async function openBan(interaction, { channel }) {
  const select = new UserSelectMenuBuilder()
    .setCustomId(customId('ban_pick', channel.id))
    .setPlaceholder('Mitglied zum Bannen auswählen …')
    .setMinValues(1)
    .setMaxValues(1);
  return respond(
    interaction,
    '🔨 Wen möchtest du für diesen Channel sperren? Die Sperre gilt nur für diesen temporären Channel.',
    [new ActionRowBuilder().addComponents(select)],
  );
}

async function banLabels(guild, bans) {
  return Promise.all(
    bans.slice(0, 25).map(async (b) => {
      const member = await fetchMember(guild, b.userId);
      return { ...b, label: member ? member.displayName : `Benutzer ${b.userId}`, username: member?.user.username };
    }),
  );
}

async function openUnban(interaction, { channel }) {
  const bans = db.listBans(channel.id);
  if (!bans.length) return respond(interaction, 'ℹ️ In diesem Channel ist niemand gesperrt.');
  const labeled = await banLabels(interaction.guild, bans);
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId('unban_pick', channel.id))
    .setPlaceholder('Mitglied zum Entbannen auswählen …')
    .addOptions(
      labeled.map((b) => ({
        label: b.label.slice(0, 100),
        description: (b.username ? `@${b.username}` : b.userId).slice(0, 100),
        value: b.userId,
      })),
    );
  return respond(interaction, '🔓 Wessen Sperre möchtest du aufheben?', [new ActionRowBuilder().addComponents(select)]);
}

function showBans(interaction, { channel }) {
  const bans = db.listBans(channel.id);
  if (!bans.length) return respond(interaction, '📋 In diesem Channel ist niemand gesperrt.');
  const lines = bans.map((b) => `• <@${b.userId}>, gesperrt von <@${b.bannedBy}> <t:${Math.floor(b.createdAt / 1000)}:R>`);
  return respond(interaction, `📋 **Gesperrte Mitglieder (${bans.length}):**\n${lines.join('\n')}`.slice(0, 2000));
}

// ---------------------------------------------------------------------------------------------
// Auswahl -> Bestätigung -> Ausführung
// ---------------------------------------------------------------------------------------------

async function pickTransfer(interaction, { channel, row, authority }) {
  const target = channel.members.get(interaction.values[0]);
  if (!target) return respond(interaction, '⚠️ Dieses Mitglied ist nicht mehr im Channel.');
  const who = authority === 'owner' ? 'Danach verlierst du deine Verwaltungsrechte.' : `Bisheriger Besitzer: <@${row.ownerId}>.`;
  return respond(interaction, `👑 Besitz von ${channel} wirklich an ${target} übertragen? ${who}`, [
    confirmRow('transfer_yes', channel.id, target.id, 'Ja, übertragen', ButtonStyle.Success),
  ]);
}

async function confirmTransfer(interaction, { channel }, targetId) {
  await interaction.deferUpdate();
  const target = await fetchMember(interaction.guild, targetId);
  if (!target) return respond(interaction, '⚠️ Dieses Mitglied ist nicht mehr auf dem Server.');
  await cm.transferOwnership(channel, target);
  await refreshControlPanel(channel);
  await channel
    .send({ content: `👑 ${target} verwaltet jetzt diesen Channel.`, allowedMentions: { users: [target.id] } })
    .catch(() => {});
  return respond(interaction, `✅ ${target} ist jetzt Besitzer von ${channel}.`);
}

async function pickKick(interaction, { channel, authority }) {
  const target = channel.members.get(interaction.values[0]);
  if (!target) return respond(interaction, '⚠️ Dieses Mitglied ist nicht mehr im Channel.');
  const denied = checkTarget(interaction.member, authority, target);
  if (denied) return respond(interaction, `⚠️ ${denied}`);
  return respond(interaction, `👢 ${target} wirklich aus ${channel} kicken? Ohne Sperre kann er später wieder beitreten.`, [
    confirmRow('kick_yes', channel.id, target.id, 'Ja, kicken', ButtonStyle.Danger),
  ]);
}

async function confirmKick(interaction, { channel, authority }, targetId) {
  await interaction.deferUpdate();
  const target = await fetchMember(interaction.guild, targetId);
  const denied = checkTarget(interaction.member, authority, target);
  if (denied) return respond(interaction, `⚠️ ${denied}`);
  await cm.kickMember(channel, target);
  log.info(`${interaction.user.tag} hat ${target.user.tag} aus "${channel.name}" gekickt.`);
  return respond(interaction, `👢 ${target} wurde aus dem Channel entfernt.`);
}

async function pickBan(interaction, { channel, row, authority }) {
  const target = await fetchMember(interaction.guild, interaction.values[0]);
  const denied = checkTarget(interaction.member, authority, target);
  if (denied) return respond(interaction, `⚠️ ${denied}`);
  if (target.id === row.ownerId) return respond(interaction, '⚠️ Der Besitzer kann nicht gesperrt werden. Übertrage zuerst den Besitz.');
  if (db.isBanned(channel.id, target.id)) return respond(interaction, `ℹ️ ${target} ist bereits gesperrt.`);
  return respond(
    interaction,
    `🔨 ${target} wirklich für ${channel} sperren? Er wird sofort entfernt und kann nicht mehr beitreten, bis die Sperre aufgehoben wird.`,
    [confirmRow('ban_yes', channel.id, target.id, 'Ja, bannen', ButtonStyle.Danger)],
  );
}

async function confirmBan(interaction, { channel, authority }, targetId) {
  await interaction.deferUpdate();
  const target = await fetchMember(interaction.guild, targetId);
  const denied = checkTarget(interaction.member, authority, target);
  if (denied) return respond(interaction, `⚠️ ${denied}`);
  await cm.banMember(channel, target, interaction.member);
  await refreshControlPanel(channel);
  log.info(`${interaction.user.tag} hat ${target.user.tag} für "${channel.name}" gesperrt.`);
  return respond(interaction, `🔨 ${target} ist für diesen Channel gesperrt.`);
}

async function pickUnban(interaction, { channel }) {
  await interaction.deferUpdate();
  const userId = interaction.values[0];
  await cm.unbanMember(channel, userId);
  await refreshControlPanel(channel);
  log.info(`${interaction.user.tag} hat die Sperre von ${userId} in "${channel.name}" aufgehoben.`);
  return respond(interaction, `🔓 Die Sperre von <@${userId}> ist aufgehoben.`);
}

// ---------------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------------

async function submitRename(interaction, { channel }) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const name = await cm.renameChannel(channel, interaction.fields.getTextInputValue('name'));
  return respond(interaction, `✏️ Der Channel heißt jetzt **${name}**.`);
}

async function submitLimit(interaction, { channel }) {
  const raw = interaction.fields.getTextInputValue('limit').trim();
  const limit = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  await interaction.deferReply({ flags: EPHEMERAL });
  await cm.setUserLimit(channel, limit);
  await refreshControlPanel(channel);
  return respond(interaction, limit === 0 ? '👥 Das Benutzerlimit ist aufgehoben.' : `👥 Das Benutzerlimit ist jetzt **${limit}**.`);
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

const BUTTONS = {
  rename: openRename,
  limit: openLimit,
  lock: (i, ctx) => toggleLock(i, ctx, true),
  unlock: (i, ctx) => toggleLock(i, ctx, false),
  transfer: openTransfer,
  kick: openKick,
  ban: openBan,
  unban: openUnban,
  bans: showBans,
  transfer_yes: (i, ctx, extra) => confirmTransfer(i, ctx, extra),
  kick_yes: (i, ctx, extra) => confirmKick(i, ctx, extra),
  ban_yes: (i, ctx, extra) => confirmBan(i, ctx, extra),
  cancel: (i) => respond(i, 'Abgebrochen.'),
};
const SELECTS = { transfer_pick: pickTransfer, kick_pick: pickKick, ban_pick: pickBan, unban_pick: pickUnban };
const MODALS = { rename_modal: submitRename, limit_modal: submitLimit };
const NEEDS_TARGET = new Set(['transfer_yes', 'kick_yes', 'ban_yes']);

async function handleManageInteraction(interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const { action, channelId, extra } = parsed;

  let handler;
  if (interaction.isButton()) handler = BUTTONS[action];
  else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) handler = SELECTS[action];
  else if (interaction.isModalSubmit()) handler = MODALS[action];
  if (!handler || (NEEDS_TARGET.has(action) && !extra)) return;

  const ctx = context(interaction, channelId);
  try {
    if (ctx.error) return await respond(interaction, `⚠️ ${ctx.error}`);
    await handler(interaction, ctx, extra);
  } catch (err) {
    await respond(interaction, errorText(err)).catch(() => {});
  }
}

// /kanal: öffnet das Verwaltungsmenü des Channels, in dem man gerade ist (oder den man besitzt).
async function handleKanalCommand(interaction) {
  const member = interaction.member;
  let row = member.voice.channelId ? db.getChannel(member.voice.channelId) : null;
  if (!row) row = db.getChannelByOwner(interaction.guildId, member.id);
  if (!row) {
    return interaction.reply({
      content: '⚠️ Du bist in keinem temporären Channel und besitzt auch keinen.',
      flags: EPHEMERAL,
    });
  }
  const ctx = context(interaction, row.channelId);
  if (ctx.error) return interaction.reply({ content: `⚠️ ${ctx.error}`, flags: EPHEMERAL });
  return interaction.reply({ ...buildControlPanel(ctx.channel, ctx.row), flags: EPHEMERAL, allowedMentions: NO_MENTIONS });
}

module.exports = { handleManageInteraction, handleKanalCommand };
