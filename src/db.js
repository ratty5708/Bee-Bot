'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'beebot.db');

// owner_id ist pro Server eindeutig: Jeder Benutzer besitzt höchstens einen temporären Channel.
// (guild_id, game, number) ist eindeutig: keine zwei "Arma #1".
// channel_bans hängt per ON DELETE CASCADE am Channel: Mit dem Channel verschwinden seine Sperren.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS temp_channels (
  channel_id          TEXT    PRIMARY KEY,
  guild_id            TEXT    NOT NULL,
  owner_id            TEXT    NOT NULL,
  game                TEXT    NOT NULL,
  number              INTEGER NOT NULL,
  locked              INTEGER NOT NULL DEFAULT 0,
  control_message_id  TEXT,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_temp_channels_owner  ON temp_channels (guild_id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_temp_channels_number ON temp_channels (guild_id, game, number);

CREATE TABLE IF NOT EXISTS channel_bans (
  channel_id  TEXT    NOT NULL REFERENCES temp_channels (channel_id) ON DELETE CASCADE,
  user_id     TEXT    NOT NULL,
  banned_by   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS panel_selections (
  guild_id    TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  game        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`;

let db = null;
let q = null;

function open(file = DB_FILE) {
  if (db) return;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);

  q = {
    insertChannel: db.prepare(
      `INSERT INTO temp_channels (channel_id, guild_id, owner_id, game, number, locked, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ),
    getChannel: db.prepare('SELECT * FROM temp_channels WHERE channel_id = ?'),
    getByOwner: db.prepare('SELECT * FROM temp_channels WHERE guild_id = ? AND owner_id = ?'),
    listAll: db.prepare('SELECT * FROM temp_channels ORDER BY created_at'),
    listGuild: db.prepare('SELECT * FROM temp_channels WHERE guild_id = ? ORDER BY created_at'),
    countGuild: db.prepare('SELECT COUNT(*) AS n FROM temp_channels WHERE guild_id = ?'),
    usedNumbers: db.prepare('SELECT number FROM temp_channels WHERE guild_id = ? AND game = ?'),
    deleteChannel: db.prepare('DELETE FROM temp_channels WHERE channel_id = ?'),
    setOwner: db.prepare('UPDATE temp_channels SET owner_id = ? WHERE channel_id = ?'),
    setLocked: db.prepare('UPDATE temp_channels SET locked = ? WHERE channel_id = ?'),
    setControlMessage: db.prepare('UPDATE temp_channels SET control_message_id = ? WHERE channel_id = ?'),

    addBan: db.prepare(
      `INSERT OR IGNORE INTO channel_bans (channel_id, user_id, banned_by, created_at) VALUES (?, ?, ?, ?)`,
    ),
    removeBan: db.prepare('DELETE FROM channel_bans WHERE channel_id = ? AND user_id = ?'),
    isBanned: db.prepare('SELECT 1 AS x FROM channel_bans WHERE channel_id = ? AND user_id = ?'),
    listBans: db.prepare('SELECT * FROM channel_bans WHERE channel_id = ? ORDER BY created_at'),

    setSelection: db.prepare(
      `INSERT INTO panel_selections (guild_id, user_id, game, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET game = excluded.game, updated_at = excluded.updated_at`,
    ),
    getSelection: db.prepare('SELECT game FROM panel_selections WHERE guild_id = ? AND user_id = ?'),
    purgeSelections: db.prepare('DELETE FROM panel_selections WHERE updated_at < ?'),
  };
}

function close() {
  if (!db) return;
  db.close();
  db = null;
  q = null;
}

function toChannel(row) {
  if (!row) return null;
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    ownerId: row.owner_id,
    game: row.game,
    number: row.number,
    locked: row.locked === 1,
    controlMessageId: row.control_message_id,
    createdAt: row.created_at,
  };
}

function toBan(row) {
  return { channelId: row.channel_id, userId: row.user_id, bannedBy: row.banned_by, createdAt: row.created_at };
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(err?.message || '');
}

module.exports = {
  open,
  close,
  isUniqueViolation,

  insertChannel({ channelId, guildId, ownerId, game, number }) {
    q.insertChannel.run(channelId, guildId, ownerId, game, number, Date.now());
  },
  getChannel: (channelId) => toChannel(q.getChannel.get(channelId)),
  getChannelByOwner: (guildId, ownerId) => toChannel(q.getByOwner.get(guildId, ownerId)),
  listChannels: (guildId) => (guildId ? q.listGuild.all(guildId) : q.listAll.all()).map(toChannel),
  countChannels: (guildId) => q.countGuild.get(guildId).n,
  usedNumbers: (guildId, game) => new Set(q.usedNumbers.all(guildId, game).map((r) => r.number)),
  deleteChannel: (channelId) => q.deleteChannel.run(channelId).changes > 0,
  setOwner: (channelId, ownerId) => q.setOwner.run(ownerId, channelId).changes > 0,
  setLocked: (channelId, locked) => q.setLocked.run(locked ? 1 : 0, channelId).changes > 0,
  setControlMessage: (channelId, messageId) => q.setControlMessage.run(messageId, channelId),

  addBan: (channelId, userId, bannedBy) => q.addBan.run(channelId, userId, bannedBy, Date.now()).changes > 0,
  removeBan: (channelId, userId) => q.removeBan.run(channelId, userId).changes > 0,
  isBanned: (channelId, userId) => Boolean(q.isBanned.get(channelId, userId)),
  listBans: (channelId) => q.listBans.all(channelId).map(toBan),

  setSelection: (guildId, userId, game) => q.setSelection.run(guildId, userId, game, Date.now()),
  getSelection: (guildId, userId) => q.getSelection.get(guildId, userId)?.game ?? null,
  purgeSelections: (olderThanMs) => q.purgeSelections.run(Date.now() - olderThanMs).changes,
};
