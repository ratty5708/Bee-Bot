'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, OverwriteType, PermissionFlagsBits: P, RateLimitError } = require('discord.js');
const config = require('./config');
const db = require('./db');
const games = require('./games');
const { withLock } = require('./lock');
const { isAdmin } = require('./permissions');
const log = require('./logger')('channels');

// Ein frisch erstellter Channel ist kurz leer, bis der Ersteller hineingeschoben wurde.
// Die regelmäßige Bereinigung lässt ihn so lange in Ruhe.
const CREATE_GRACE_MS = 60_000;

// Fehler mit einer Meldung, die 1:1 an den Benutzer gehen darf.
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

const OWNER_ALLOW = P.ViewChannel | P.Connect | P.Speak | P.Stream | P.UseVAD;
const BOT_ALLOW =
  P.ViewChannel | P.Connect | P.MoveMembers | P.ManageChannels | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory;
const BOT_REQUIRED = [
  [P.ViewChannel, 'Kanäle ansehen'],
  [P.ManageChannels, 'Kanäle verwalten'],
  [P.ManageRoles, 'Rollen verwalten'],
  [P.Connect, 'Verbinden'],
  [P.MoveMembers, 'Mitglieder verschieben'],
];

const humanCount = (channel) => channel.members.filter((m) => !m.user.bot).size;

// ---------------------------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------------------------

function resolveCategory(guild, panelChannel) {
  if (config.categoryId) {
    const category = guild.channels.cache.get(config.categoryId);
    if (category?.type === ChannelType.GuildCategory) return category;
    log.warn(`categoryId ${config.categoryId} ist keine Kategorie auf "${guild.name}". Verwende die Kategorie des Panels.`);
  }
  const parent = panelChannel?.parent;
  return parent?.type === ChannelType.GuildCategory ? parent : null;
}

function missingBotPermissions(guild, category) {
  const me = guild.members.me;
  const perms = category ? category.permissionsFor(me) : me?.permissions;
  return BOT_REQUIRED.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
}

function clampUserLimit(n) {
  const cap = config.maxUserLimit;
  if (cap > 0) return n <= 0 ? cap : Math.min(n, cap);
  return Math.max(0, Math.min(n, 99));
}

function userLimitRange() {
  return config.maxUserLimit > 0 ? { min: 1, max: config.maxUserLimit } : { min: 0, max: 99 };
}

function renderName(game, number, member) {
  const name = config.nameTemplate
    .replaceAll('{emoji}', game.emoji || '')
    .replaceAll('{game}', game.label)
    .replaceAll('{number}', String(number))
    .replaceAll('{user}', member.displayName)
    .replace(/\s+/g, ' ')
    .trim();
  return (name || `${game.label} #${number}`).slice(0, 100);
}

// Berechnet den vollständigen Satz an Permission Overwrites für einen temporären Channel.
// Basis sind die Overwrites der Kategorie; darauf kommen Sperre, Channel-Bans, Besitzer und Bot.
// Der Bot darf nur Rechte vergeben, die er selbst hat, deshalb wird alles mit seinen Rechten maskiert.
function buildOverwrites(guild, category, { ownerId, locked, bannedIds }) {
  const me = guild.members.me;
  const mask = (category ? category.permissionsFor(me) : me.permissions)?.bitfield ?? 0n;
  const map = new Map();
  const entry = (id, type) => {
    if (!map.has(id)) map.set(id, { id, type, allow: 0n, deny: 0n });
    return map.get(id);
  };

  if (category) {
    for (const o of category.permissionOverwrites.cache.values()) {
      map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield & mask, deny: o.deny.bitfield & mask });
    }
  }

  if (locked) {
    entry(guild.roles.everyone.id, OverwriteType.Role);
    for (const o of map.values()) {
      if (o.type !== OverwriteType.Role) continue;
      o.allow &= ~P.Connect;
      o.deny |= P.Connect;
    }
  }

  for (const userId of bannedIds) {
    const o = entry(userId, OverwriteType.Member);
    o.allow &= ~P.Connect;
    o.deny |= P.Connect;
  }

  if (ownerId) {
    const o = entry(ownerId, OverwriteType.Member);
    o.allow |= OWNER_ALLOW & mask;
    o.deny &= ~OWNER_ALLOW;
  }

  const bot = entry(me.id, OverwriteType.Member);
  bot.allow |= BOT_ALLOW & mask;
  bot.deny &= ~BOT_ALLOW;

  return [...map.values()].filter((o) => o.allow !== 0n || o.deny !== 0n);
}

async function applyPermissions(channel, row) {
  const bannedIds = db.listBans(row.channelId).map((b) => b.userId);
  const overwrites = buildOverwrites(channel.guild, channel.parent, {
    ownerId: row.ownerId,
    locked: row.locked,
    bannedIds,
  });
  await channel.permissionOverwrites.set(overwrites, 'BeeBot: Berechtigungen des temporären Channels');
}

// Prüft nur die sicherheitsrelevanten Teile (Sperren, Lock, Besitzer). Wurden sie manuell verändert,
// stellt der Bot sie wieder her. Andere Änderungen von Admins bleiben unangetastet.
function permissionsIntact(channel, row) {
  const ow = channel.permissionOverwrites.cache;
  for (const { userId } of db.listBans(row.channelId)) {
    const o = ow.get(userId);
    if (!o || !o.deny.has(P.Connect) || o.allow.has(P.Connect)) return false;
  }
  if (row.locked) {
    const everyone = ow.get(channel.guild.roles.everyone.id);
    if (!everyone || !everyone.deny.has(P.Connect)) return false;
    for (const o of ow.values()) {
      if (o.type === OverwriteType.Role && o.allow.has(P.Connect)) return false;
    }
  }
  const owner = ow.get(row.ownerId);
  if (!owner || !owner.allow.has(P.Connect)) return false;
  return true;
}

// Entfernt ein Mitglied aus seinem Voicechannel: in den Kick-Channel aus der Config, sonst Disconnect.
async function removeFromVoice(member, reason) {
  const target = config.kickTargetChannelId ? member.guild.channels.cache.get(config.kickTargetChannelId) : null;
  if (target?.isVoiceBased() && target.id !== member.voice.channelId) {
    try {
      await member.voice.setChannel(target, reason);
      return;
    } catch (err) {
      log.warn(`Verschieben in den Kick-Channel fehlgeschlagen, trenne stattdessen: ${err.message}`);
    }
  }
  await member.voice.disconnect(reason);
}

// ---------------------------------------------------------------------------------------------
// Erstellen
// ---------------------------------------------------------------------------------------------

const creating = new Set();

async function createLocked(member, gameValue, panelChannel) {
  const guild = member.guild;

  const existing = db.getChannelByOwner(guild.id, member.id);
  if (existing) {
    const ch = guild.channels.cache.get(existing.channelId);
    if (ch) throw new UserError(`Du besitzt bereits einen temporären Channel: ${ch}`);
    db.deleteChannel(existing.channelId); // Eintrag ohne Discord-Channel
  }

  if (config.maxChannels > 0 && db.countChannels(guild.id) >= config.maxChannels) {
    throw new UserError('Die maximale Anzahl an Channels wurde erreicht.');
  }

  const game = games.findGame(guild.id, gameValue);
  if (!game) throw new UserError('Bitte wähle zuerst ein Spiel aus.');
  if (!member.voice.channelId) throw new UserError('Du musst dich zuerst in einem Voicechannel befinden.');

  const category = resolveCategory(guild, panelChannel);
  const missing = missingBotPermissions(guild, category);
  if (missing.length) {
    log.error(`Fehlende Bot-Rechte auf "${guild.name}" (${category?.name ?? 'ohne Kategorie'}): ${missing.join(', ')}`);
    throw new UserError(`Der Channel konnte nicht erstellt werden. Dem Bot fehlen Rechte: ${missing.join(', ')}.`);
  }
  if (category && category.children.cache.size >= 50) {
    throw new UserError('Der Channel konnte nicht erstellt werden. Die Kategorie ist voll (max. 50 Kanäle).');
  }

  const used = db.usedNumbers(guild.id, game.value);
  let number = 1;
  while (used.has(number)) number++;

  let channel;
  try {
    channel = await guild.channels.create({
      name: renderName(game, number, member),
      type: ChannelType.GuildVoice,
      parent: category?.id ?? null,
      userLimit: clampUserLimit(game.userLimit ?? config.defaultUserLimit),
      permissionOverwrites: buildOverwrites(guild, category, { ownerId: member.id, locked: false, bannedIds: [] }),
      reason: `Temporärer Voicechannel für ${member.user.tag}`,
    });
  } catch (err) {
    log.error(`Channel konnte auf "${guild.name}" nicht erstellt werden:`, err);
    throw new UserError('Der Channel konnte nicht erstellt werden.');
  }

  try {
    db.insertChannel({ channelId: channel.id, guildId: guild.id, ownerId: member.id, game: game.value, number });
  } catch (err) {
    log.error('Channel konnte nicht gespeichert werden, lösche ihn wieder:', err);
    await channel.delete('BeeBot: Speichern fehlgeschlagen').catch(() => {});
    throw new UserError('Der Channel konnte nicht erstellt werden.');
  }

  log.info(`Erstellt: "${channel.name}" (${channel.id}) für ${member.user.tag} auf "${guild.name}"`);
  return channel;
}

// Erstellt den Channel und schiebt den Benutzer hinein. Pro Server läuft immer nur eine Erstellung
// gleichzeitig; dadurch gibt es weder doppelte Channels noch doppelte Nummern oder ein überschrittenes Limit.
async function createTempChannel(member, gameValue, panelChannel) {
  const key = `${member.guild.id}:${member.id}`;
  if (creating.has(key)) throw new UserError('Dein Channel wird gerade erstellt. Einen Moment bitte.');
  creating.add(key);
  try {
    const channel = await withLock(`create:${member.guild.id}`, () => createLocked(member, gameValue, panelChannel));
    try {
      await member.voice.setChannel(channel, 'Temporärer Voicechannel erstellt');
    } catch (err) {
      await deleteTempChannel(member.client, channel.id, { force: true, reason: 'Ersteller konnte nicht verschoben werden' });
      if (err.code === 40032) throw new UserError('Du musst dich zuerst in einem Voicechannel befinden.');
      log.error(`${member.user.tag} konnte nicht verschoben werden:`, err);
      throw new UserError('Der Channel konnte nicht erstellt werden.');
    }
    return channel;
  } finally {
    creating.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Löschen und Bereinigen
// ---------------------------------------------------------------------------------------------

// Löscht einen temporären Channel. Gelöscht wird ausschließlich, was in der Datenbank als temporär
// eingetragen ist, und nur Voicechannels. Ohne `force` nur, wenn kein Mensch mehr drin ist.
async function deleteTempChannel(client, channelId, { force = false, reason = 'Temporärer Voicechannel ist leer' } = {}) {
  return withLock(`channel:${channelId}`, async () => {
    const row = db.getChannel(channelId);
    if (!row) return false;

    const guild = client.guilds.cache.get(row.guildId);
    if (guild && !guild.available) return false;
    const channel = guild?.channels.cache.get(channelId);
    if (!channel) {
      db.deleteChannel(channelId);
      return true;
    }
    if (channel.type !== ChannelType.GuildVoice) {
      log.error(`${channelId} ist kein Voicechannel und wird nicht gelöscht. Eintrag entfernt.`);
      db.deleteChannel(channelId);
      return false;
    }
    if (!force && humanCount(channel) > 0) return false;

    try {
      await channel.delete(reason);
    } catch (err) {
      if (err.code !== 10003) {
        log.error(`Löschen von "${channel.name}" fehlgeschlagen, neuer Versuch bei der nächsten Bereinigung:`, err.message);
        return false;
      }
    }
    db.deleteChannel(channelId);
    log.info(`Gelöscht: "${channel.name}" (${channelId}) – ${reason}`);
    return true;
  });
}

async function runCleanup(client, { graceMs = CREATE_GRACE_MS, guildId } = {}) {
  const stats = { checked: 0, deletedChannels: 0, removedEntries: 0 };
  for (const row of db.listChannels(guildId)) {
    stats.checked++;
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) {
      // Bot ist nicht mehr auf dem Server.
      db.deleteChannel(row.channelId);
      stats.removedEntries++;
      continue;
    }
    if (!guild.available) continue;

    const channel = guild.channels.cache.get(row.channelId);
    if (!channel) {
      db.deleteChannel(row.channelId);
      stats.removedEntries++;
      log.info(`Verwaister Eintrag entfernt: ${row.channelId} (Channel existiert nicht mehr)`);
      continue;
    }
    if (humanCount(channel) === 0 && Date.now() - row.createdAt >= graceMs) {
      if (await deleteTempChannel(client, row.channelId, { reason: 'Verwaister leerer Channel' })) stats.deletedChannels++;
    }
  }
  return stats;
}

// Übernimmt Einträge aus dem alten data/channels.json (vor der SQLite-Umstellung).
function migrateLegacyStore(client) {
  const file = path.join(__dirname, '..', 'data', 'channels.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('data/channels.json konnte nicht gelesen werden:', err.message);
    return;
  }
  let imported = 0;
  for (const [channelId, info] of Object.entries(raw || {})) {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.guild || channel.type !== ChannelType.GuildVoice || db.getChannel(channelId)) continue;
    try {
      db.insertChannel({
        channelId,
        guildId: channel.guild.id,
        ownerId: info.ownerId || client.user.id,
        game: info.game || 'unbekannt',
        number: info.number || 0,
      });
      imported++;
    } catch (err) {
      log.warn(`Alter Eintrag ${channelId} konnte nicht übernommen werden:`, err.message);
    }
  }
  fs.renameSync(file, `${file}.migrated`);
  log.info(`data/channels.json übernommen (${imported} Channel). Die alte Datei heißt jetzt channels.json.migrated.`);
}

// Nach einem Neustart: Altdaten übernehmen, verwaiste Channels bereinigen, Berechtigungen prüfen,
// gesperrte Mitglieder entfernen, die während der Downtime beigetreten sind.
async function restoreOnStartup(client) {
  migrateLegacyStore(client);
  const stats = await runCleanup(client, { graceMs: 0 });

  let repaired = 0;
  for (const row of db.listChannels()) {
    const channel = client.channels.cache.get(row.channelId);
    if (!channel) continue;
    await withLock(`channel:${row.channelId}`, async () => {
      if (!permissionsIntact(channel, row)) {
        await applyPermissions(channel, row).catch((err) => log.error(`Rechte für "${channel.name}":`, err.message));
        repaired++;
      }
    });
    await enforceBans(channel, row);
  }
  log.info(
    `Start-Bereinigung: ${stats.checked} geprüft, ${stats.deletedChannels} leere Channels gelöscht, ` +
      `${stats.removedEntries} verwaiste Einträge entfernt, ${repaired} Berechtigungen wiederhergestellt.`,
  );
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Sperren durchsetzen
// ---------------------------------------------------------------------------------------------

async function enforceBans(channel, row) {
  for (const member of channel.members.values()) {
    if (db.isBanned(row.channelId, member.id) && !isAdmin(member)) {
      await removeFromVoice(member, 'Für diesen temporären Channel gesperrt').catch((err) =>
        log.warn(`Gesperrten Benutzer ${member.user.tag} entfernen fehlgeschlagen:`, err.message),
      );
    }
  }
}

async function repairPermissionsIfNeeded(channel) {
  const row = db.getChannel(channel.id);
  if (!row) return;
  await withLock(`channel:${channel.id}`, async () => {
    const fresh = db.getChannel(channel.id);
    if (!fresh || permissionsIntact(channel, fresh)) return;
    log.warn(`Berechtigungen von "${channel.name}" wurden manuell verändert. Stelle Sperren wieder her.`);
    await applyPermissions(channel, fresh).catch((err) => log.error('Wiederherstellen fehlgeschlagen:', err.message));
  });
}

// ---------------------------------------------------------------------------------------------
// Verwaltungsaktionen (Berechtigungen prüft die Interaktionsschicht vorher, hier wird nur ausgeführt)
// ---------------------------------------------------------------------------------------------

function rateLimitMessage(err) {
  if (err instanceof RateLimitError || err?.status === 429) {
    const waitMs = Math.max(err.timeToReset ?? 0, err.retryAfter ?? 0, err.sublimitTimeout ?? 0) || 600_000;
    const seconds = Math.ceil(waitMs / 1000);
    const minutes = Math.ceil(seconds / 60);
    return `Discord erlaubt das gerade nicht so oft. Versuche es in etwa ${minutes} Minute${minutes === 1 ? '' : 'n'} erneut.`;
  }
  return null;
}

async function renameChannel(channel, name) {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) throw new UserError('Der Name darf nicht leer sein.');
  if (clean.length > 100) throw new UserError('Der Name darf höchstens 100 Zeichen lang sein.');
  try {
    await channel.setName(clean, 'Umbenannt durch den Channel-Besitzer');
  } catch (err) {
    const msg = rateLimitMessage(err);
    if (msg) throw new UserError(`Umbenennen nicht möglich: ${msg} (Limit: 2 Umbenennungen pro 10 Minuten)`);
    if (err.code === 50035) throw new UserError('Discord hat diesen Namen abgelehnt. Bitte wähle einen anderen.');
    throw err;
  }
  return clean;
}

async function setUserLimit(channel, limit) {
  const { min, max } = userLimitRange();
  if (!Number.isInteger(limit) || limit < min || limit > max) {
    throw new UserError(
      min === 0 ? `Bitte gib eine Zahl von 0 bis ${max} ein (0 = unbegrenzt).` : `Bitte gib eine Zahl von ${min} bis ${max} ein.`,
    );
  }
  try {
    await channel.setUserLimit(limit, 'Benutzerlimit durch den Channel-Besitzer geändert');
  } catch (err) {
    const msg = rateLimitMessage(err);
    if (msg) throw new UserError(msg);
    throw err;
  }
}

async function setLocked(channel, locked) {
  return withLock(`channel:${channel.id}`, async () => {
    const row = db.getChannel(channel.id);
    if (!row) throw new UserError('Dieser temporäre Channel existiert nicht mehr.');
    if (row.locked === locked) return false;
    db.setLocked(channel.id, locked);
    try {
      await applyPermissions(channel, { ...row, locked });
    } catch (err) {
      db.setLocked(channel.id, row.locked);
      throw err;
    }
    return true;
  });
}

async function kickMember(channel, target) {
  if (target.voice.channelId !== channel.id) throw new UserError(`${target} ist nicht (mehr) in diesem Channel.`);
  await removeFromVoice(target, 'Aus dem temporären Channel gekickt');
}

async function banMember(channel, target, actor) {
  return withLock(`channel:${channel.id}`, async () => {
    const row = db.getChannel(channel.id);
    if (!row) throw new UserError('Dieser temporäre Channel existiert nicht mehr.');
    if (row.ownerId === target.id) throw new UserError('Der Besitzer kann nicht gesperrt werden. Übertrage zuerst den Besitz.');
    if (!db.addBan(channel.id, target.id, actor.id)) throw new UserError(`${target} ist bereits gesperrt.`);
    try {
      await applyPermissions(channel, row);
    } catch (err) {
      db.removeBan(channel.id, target.id);
      throw err;
    }
    if (target.voice.channelId === channel.id) {
      await removeFromVoice(target, 'Für diesen temporären Channel gesperrt').catch((err) =>
        log.warn(`Gesperrten Benutzer entfernen fehlgeschlagen:`, err.message),
      );
    }
  });
}

async function unbanMember(channel, userId) {
  return withLock(`channel:${channel.id}`, async () => {
    const row = db.getChannel(channel.id);
    if (!row) throw new UserError('Dieser temporäre Channel existiert nicht mehr.');
    if (!db.removeBan(channel.id, userId)) throw new UserError('Dieses Mitglied ist nicht gesperrt.');
    try {
      await applyPermissions(channel, row);
    } catch (err) {
      db.addBan(channel.id, userId, 'restore');
      throw err;
    }
  });
}

async function transferOwnership(channel, newOwner) {
  return withLock(`channel:${channel.id}`, async () => {
    const row = db.getChannel(channel.id);
    if (!row) throw new UserError('Dieser temporäre Channel existiert nicht mehr.');
    if (row.ownerId === newOwner.id) throw new UserError(`${newOwner} ist bereits Besitzer.`);
    if (newOwner.user.bot) throw new UserError('Ein Bot kann nicht Besitzer werden.');
    if (newOwner.voice.channelId !== channel.id) throw new UserError(`${newOwner} ist nicht (mehr) in diesem Channel.`);
    if (db.isBanned(channel.id, newOwner.id)) throw new UserError(`${newOwner} ist in diesem Channel gesperrt.`);
    if (db.getChannelByOwner(channel.guild.id, newOwner.id)) {
      throw new UserError(`${newOwner} besitzt bereits einen eigenen temporären Channel.`);
    }

    try {
      db.setOwner(channel.id, newOwner.id);
    } catch (err) {
      if (db.isUniqueViolation(err)) throw new UserError(`${newOwner} besitzt bereits einen eigenen temporären Channel.`);
      throw err;
    }
    try {
      await applyPermissions(channel, { ...row, ownerId: newOwner.id });
    } catch (err) {
      db.setOwner(channel.id, row.ownerId);
      throw err;
    }
    log.info(`Besitz von "${channel.name}" übertragen: ${row.ownerId} -> ${newOwner.id}`);
    return row.ownerId;
  });
}

module.exports = {
  UserError,
  CREATE_GRACE_MS,
  humanCount,
  userLimitRange,
  createTempChannel,
  deleteTempChannel,
  runCleanup,
  restoreOnStartup,
  enforceBans,
  removeFromVoice,
  repairPermissionsIfNeeded,
  renameChannel,
  setUserLimit,
  setLocked,
  kickMember,
  banMember,
  unbanMember,
  transferOwnership,
  // für Tests
  buildOverwrites,
  permissionsIntact,
  renderName,
  clampUserLimit,
};
