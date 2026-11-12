'use strict';

const db = require('./db');
const cm = require('./channelManager');
const { isAdmin } = require('./permissions');
const log = require('./logger')('voice');

// Jeder Voice-Wechsel läuft hier durch: Beitritt, Verlassen, Disconnect, Kick, Verschieben.
async function handleVoiceStateUpdate(oldState, newState) {
  if (oldState.channelId === newState.channelId) return; // nur Mute/Deafen/Stream o. Ä.

  // Beitritt: Ist der Benutzer für diesen temporären Channel gesperrt?
  if (newState.channelId && newState.member) {
    const row = db.getChannel(newState.channelId);
    if (row && db.isBanned(row.channelId, newState.id) && !isAdmin(newState.member)) {
      log.info(`${newState.member.user.tag} ist in "${newState.channel?.name}" gesperrt und wird entfernt.`);
      await cm
        .removeFromVoice(newState.member, 'Für diesen temporären Channel gesperrt')
        .catch((err) => log.warn('Entfernen fehlgeschlagen:', err.message));
    }
  }

  // Verlassen: War das der letzte Mensch im temporären Channel?
  if (oldState.channelId && db.getChannel(oldState.channelId)) {
    const channel = oldState.channel;
    if (!channel || cm.humanCount(channel) === 0) {
      await cm.deleteTempChannel(oldState.client, oldState.channelId);
    }
  }
}

module.exports = { handleVoiceStateUpdate };
