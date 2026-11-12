'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const log = require('./logger')('games');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'guilds.json');

const MAX_GAMES = 25; // Discord-Limit für Dropdown-Optionen
const MAX_LABEL = 50;

// guildId -> { games: [{ value, label, emoji, userLimit? }], panels: [{ channelId, messageId }] }
let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') log.error('Konnte guilds.json nicht lesen:', err.message);
}

// Erst in eine temporäre Datei schreiben, dann umbenennen: Bei einem Absturz mitten im Schreiben
// bleibt die alte Datei vollständig erhalten.
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// Neue Server starten mit den Spielen aus config.json.
function guildData(guildId) {
  if (!data[guildId]) data[guildId] = { games: config.games.map((g) => ({ ...g })), panels: [] };
  return data[guildId];
}

function getGames(guildId) {
  return guildData(guildId).games;
}

function findGame(guildId, value) {
  return getGames(guildId).find((g) => g.value === value);
}

const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

function isValidEmoji(emoji) {
  if (CUSTOM_EMOJI.test(emoji)) return true;
  return emoji.length <= 16 && /\p{Extended_Pictographic}/u.test(emoji) && !/[\p{L}\s]/u.test(emoji);
}

// Gibt eine Fehlermeldung zurück oder null bei Erfolg.
function addGame(guildId, label, emoji, userLimit = null) {
  const games = getGames(guildId);
  label = label.trim();
  emoji = emoji.trim();

  if (!label) return 'Der Name darf nicht leer sein.';
  if (label.length > MAX_LABEL) return `Der Name darf höchstens ${MAX_LABEL} Zeichen lang sein.`;
  if (!isValidEmoji(emoji)) return 'Das ist kein gültiges Emoji. Nutze ein normales Emoji (z. B. 🎮) oder ein Server-Emoji.';
  if (games.length >= MAX_GAMES) return `Es sind maximal ${MAX_GAMES} Spiele möglich. Entferne zuerst eins.`;
  if (games.some((g) => g.label.toLowerCase() === label.toLowerCase() || g.value === label.toLowerCase())) {
    return `„${label}“ gibt es schon.`;
  }

  const game = { value: label.toLowerCase(), label, emoji };
  if (Number.isInteger(userLimit) && userLimit > 0) game.userLimit = userLimit;
  games.push(game);
  save();
  return null;
}

function removeGame(guildId, value) {
  const games = getGames(guildId);
  const index = games.findIndex((g) => g.value === value);
  if (index === -1) return null;
  const [removed] = games.splice(index, 1);
  save();
  return removed;
}

function getPanels(guildId) {
  return guildData(guildId).panels;
}

function addPanel(guildId, channelId, messageId) {
  getPanels(guildId).push({ channelId, messageId });
  save();
}

function removePanel(guildId, messageId) {
  const g = guildData(guildId);
  g.panels = g.panels.filter((p) => p.messageId !== messageId);
  save();
}

module.exports = { getGames, findGame, addGame, removeGame, getPanels, addPanel, removePanel, MAX_GAMES };
