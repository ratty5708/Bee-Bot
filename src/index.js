'use strict';

require('dotenv').config();
const { Client, Events, GatewayIntentBits } = require('discord.js');
const log = require('./logger')('bot');

if (!process.env.DISCORD_TOKEN) {
  log.error('DISCORD_TOKEN fehlt in der .env.');
  process.exit(1);
}

const config = require('./config');
const db = require('./db');
const cm = require('./channelManager');
const { handleInteraction } = require('./interactions');
const { handleVoiceStateUpdate } = require('./voice');
const { registerForGuild } = require('./commands');

const GUILD_ID = process.env.GUILD_ID?.trim() || null;
const isManaged = (guildId) => !GUILD_ID || guildId === GUILD_ID;
const SELECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

db.open();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  // Lange Rate-Limits (z. B. 2 Umbenennungen pro 10 Minuten) nicht stillschweigend abwarten,
  // sondern als Fehler zurückgeben, damit der Benutzer sofort eine Meldung bekommt.
  // Bei Sublimits (Channelname) steckt die echte Wartezeit in retryAfter/sublimitTimeout.
  rest: {
    rejectOnRateLimit: (info) => Math.max(info.timeToReset ?? 0, info.retryAfter ?? 0, info.sublimitTimeout ?? 0) > 15_000,
  },
});

// Regelmäßige Bereinigung als Sicherheitsnetz, falls ein Voice-Event verloren geht
// (z. B. Gateway-Reconnect oder ein Mitglied verlässt den Server, während es im Channel ist).
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const stats = await cm.runCleanup(client);
    if (stats.deletedChannels || stats.removedEntries) log.info('Bereinigung:', stats);
    db.purgeSelections(SELECTION_TTL_MS);
  } catch (err) {
    log.error('Bereinigung fehlgeschlagen:', err);
  } finally {
    sweeping = false;
  }
}

client.once(Events.ClientReady, async (c) => {
  log.info(`🐝 Eingeloggt als ${c.user.tag} auf ${c.guilds.cache.size} Server(n)${GUILD_ID ? ` (beschränkt auf ${GUILD_ID})` : ''}`);
  if (GUILD_ID && !c.guilds.cache.has(GUILD_ID)) log.warn(`Der Bot ist nicht auf dem Server GUILD_ID=${GUILD_ID}.`);

  for (const guild of c.guilds.cache.values()) {
    if (isManaged(guild.id)) await registerForGuild(guild);
  }
  try {
    await cm.restoreOnStartup(c);
  } catch (err) {
    log.error('Start-Bereinigung fehlgeschlagen:', err);
  }
  setInterval(sweep, config.sweepIntervalSeconds * 1000);
});

client.on(Events.GuildCreate, (guild) => {
  if (isManaged(guild.id)) registerForGuild(guild);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!isManaged(interaction.guildId)) return;
  handleInteraction(interaction);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!isManaged(newState.guild.id)) return;
  handleVoiceStateUpdate(oldState, newState).catch((err) => log.error('voiceStateUpdate:', err));
});

client.on(Events.ChannelDelete, (channel) => {
  // Manuell gelöschter Channel: Eintrag und Sperren (per CASCADE) entfernen.
  if (db.deleteChannel(channel.id)) log.info(`"${channel.name}" wurde manuell gelöscht. Eintrag entfernt.`);
});

client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
  if (!db.getChannel(newChannel.id)) return;
  cm.repairPermissionsIfNeeded(newChannel).catch((err) => log.error('channelUpdate:', err));
});

client.on(Events.Error, (err) => log.error('Client-Fehler:', err));
client.on(Events.Warn, (msg) => log.warn(msg));
process.on('unhandledRejection', (err) => log.error('Unbehandelte Promise-Ablehnung:', err));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} empfangen, fahre herunter …`);
  try {
    await client.destroy();
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  log.error('Login fehlgeschlagen. Ist DISCORD_TOKEN korrekt?', err.message);
  db.close();
  process.exit(1);
});
