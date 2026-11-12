'use strict';

const { PermissionFlagsBits } = require('discord.js');
const config = require('./config');

// Server-Administrator im Sinne des Bots: Serverbesitzer, "Administrator", "Server verwalten",
// "Kanäle verwalten" oder eine der in config.json eingetragenen Admin-Rollen.
function isAdmin(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  const p = member.permissions;
  if (
    p.has(PermissionFlagsBits.Administrator) ||
    p.has(PermissionFlagsBits.ManageGuild) ||
    p.has(PermissionFlagsBits.ManageChannels)
  ) {
    return true;
  }
  return config.adminRoleIds.some((id) => member.roles.cache.has(id));
}

// Personen mit übergeordneten Rechten, die ein normaler Channel-Besitzer nicht verwalten darf.
function isProtected(member) {
  if (isAdmin(member)) return true;
  return member.permissions.has(PermissionFlagsBits.MoveMembers);
}

// Wer darf diesen temporären Channel verwalten? 'admin', 'owner' oder null.
function authorityOver(member, row) {
  if (!member || !row) return null;
  if (isAdmin(member)) return 'admin';
  if (row.ownerId === member.id) return 'owner';
  return null;
}

// Prüft, ob `actor` (mit Befugnis `authority`) Moderationsaktionen gegen `target` ausführen darf.
// Gibt eine Fehlermeldung zurück oder null, wenn es erlaubt ist.
function checkTarget(actor, authority, target) {
  if (!target) return 'Dieses Mitglied ist nicht (mehr) auf dem Server.';
  if (target.id === actor.id) return 'Das kannst du nicht bei dir selbst machen.';
  if (target.id === actor.client.user.id) return 'Das geht beim Bot nicht.';
  if (target.id === target.guild.ownerId) return 'Der Serverbesitzer kann nicht verwaltet werden.';

  if (authority === 'admin') {
    if (actor.id === actor.guild.ownerId) return null;
    // Admins untereinander: Rollenhierarchie wie in Discord.
    if (isProtected(target) && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
      return 'Dieses Mitglied hat gleich hohe oder höhere Rechte als du.';
    }
    return null;
  }

  if (isProtected(target)) return 'Server-Admins und Moderatoren kannst du nicht verwalten.';
  return null;
}

// Darf der Benutzer überhaupt temporäre Channels erstellen?
function canCreate(member) {
  if (config.allowedRoleIds.length === 0) return true;
  if (isAdmin(member)) return true;
  return config.allowedRoleIds.some((id) => member.roles.cache.has(id));
}

module.exports = { isAdmin, isProtected, authorityOver, checkTarget, canCreate };
