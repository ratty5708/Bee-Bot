'use strict';

// Optional: Registriert die Slash-Commands manuell. Der Bot macht das beim Start ohnehin selbst.
require('dotenv').config();
const { PermissionsBitField, PermissionFlagsBits: P, REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Bitte DISCORD_TOKEN, CLIENT_ID und GUILD_ID in der .env setzen.');
  process.exit(1);
}

const BOT_PERMISSIONS = new PermissionsBitField([
  P.ViewChannel,
  P.SendMessages,
  P.EmbedLinks,
  P.ReadMessageHistory,
  P.ManageChannels,
  P.ManageRoles,
  P.Connect,
  P.Speak,
  P.MoveMembers,
]).bitfield;

const rest = new REST().setToken(DISCORD_TOKEN);

rest
  .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  .then(() => console.log(`✅ ${commands.length} Slash-Command(s) registriert.`))
  .catch((err) => {
    if (err.code === 50001) {
      console.error(
        `❌ Missing Access: Der Bot ist nicht auf dem Server mit GUILD_ID ${GUILD_ID},\n` +
          '   wurde ohne den Scope "applications.commands" eingeladen, oder GUILD_ID ist keine Server-ID.\n' +
          `   Einladen über: https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}` +
          `&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`,
      );
      process.exit(1);
    }
    console.error('Registrierung fehlgeschlagen:', err);
    process.exit(1);
  });
