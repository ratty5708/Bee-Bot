'use strict';

const path = require('node:path');
const fs = require('node:fs');
const log = require('./logger')('config');

const FILE = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  categoryId: '',
  panelChannelId: '',
  maxChannels: 25,
  defaultUserLimit: 0,
  maxUserLimit: 0,
  nameTemplate: '{emoji} {game} #{number}',
  allowedRoleIds: [],
  adminRoleIds: [],
  kickTargetChannelId: '',
  sweepIntervalSeconds: 60,
  panel: {
    title: '🐝 Temporären Voicechannel erstellen',
    description:
      '1. Tritt einem beliebigen Voicechannel bei (z. B. der Lobby).\n' +
      '2. Wähle unten ein Spiel aus.\n' +
      '3. Klicke auf **Channel erstellen**. Du wirst automatisch hineingeschoben.\n\n' +
      'Der Kanal wird gelöscht, sobald ihn der letzte Spieler verlässt.',
    color: '#F5B700',
    selectPlaceholder: 'Spiel auswählen …',
    buttonLabel: 'Channel erstellen',
  },
  games: [],
};

const SNOWFLAKE = /^\d{17,20}$/;

function id(value, field) {
  if (value === undefined || value === null || value === '') return '';
  const s = String(value).trim();
  if (!SNOWFLAKE.test(s)) {
    log.warn(`"${field}" ist keine gültige Discord-ID und wird ignoriert: ${s}`);
    return '';
  }
  return s;
}

function idList(value, field) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => id(v, field)).filter(Boolean);
}

function int(value, field, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    if (value !== undefined) log.warn(`"${field}" muss eine ganze Zahl von ${min} bis ${max} sein. Verwende ${fallback}.`);
    return fallback;
  }
  return n;
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') log.warn('config.json fehlt, verwende Standardwerte.');
    else throw new Error(`config.json ist kein gültiges JSON: ${err.message}`);
  }

  const maxUserLimit = int(raw.maxUserLimit, 'maxUserLimit', 0, 99, DEFAULTS.maxUserLimit);
  let nameTemplate = typeof raw.nameTemplate === 'string' && raw.nameTemplate.trim() ? raw.nameTemplate : DEFAULTS.nameTemplate;
  if (!nameTemplate.includes('{game}')) log.warn('"nameTemplate" enthält kein {game}. Die Channelnamen zeigen dann kein Spiel.');

  const cfg = {
    categoryId: id(raw.categoryId, 'categoryId'),
    panelChannelId: id(raw.panelChannelId, 'panelChannelId'),
    maxChannels: int(raw.maxChannels, 'maxChannels', 0, 500, DEFAULTS.maxChannels),
    defaultUserLimit: int(raw.defaultUserLimit, 'defaultUserLimit', 0, 99, DEFAULTS.defaultUserLimit),
    maxUserLimit,
    nameTemplate,
    allowedRoleIds: idList(raw.allowedRoleIds, 'allowedRoleIds'),
    adminRoleIds: idList(raw.adminRoleIds, 'adminRoleIds'),
    kickTargetChannelId: id(raw.kickTargetChannelId, 'kickTargetChannelId'),
    sweepIntervalSeconds: int(raw.sweepIntervalSeconds, 'sweepIntervalSeconds', 15, 3600, DEFAULTS.sweepIntervalSeconds),
    panel: { ...DEFAULTS.panel, ...(raw.panel || {}) },
    games: Array.isArray(raw.games) ? raw.games : DEFAULTS.games,
  };

  return Object.freeze(cfg);
}

module.exports = load();
