'use strict';

// Tests ohne Discord-Verbindung: Datenbank, Locks, Berechtigungen, Erstellen/Löschen mit Mock-Objekten.
// Ausführen mit: npm test
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionFlagsBits: P,
  PermissionsBitField,
  ModalBuilder,
} = require('discord.js');

const db = require('../src/db');
const { withLock } = require('../src/lock');

before(() => db.open(':memory:'));

const G = '100000000000000001';
const BOT = '200000000000000001';
const SERVER_OWNER = '300000000000000001';
let nextId = 400000000000000000n;
const newId = () => String(nextId++);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------------

function makeOverwrite(id, type, allow, deny) {
  return { id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) };
}

function makeEnv({ botPerms = PermissionsBitField.All } = {}) {
  const channels = new Collection();
  const guild = {
    id: G,
    name: 'Testserver',
    available: true,
    ownerId: SERVER_OWNER,
    roles: { everyone: { id: G } },
    members: { me: { id: BOT, permissions: new PermissionsBitField(botPerms) } },
    channels: { cache: channels },
  };
  const client = { user: { id: BOT }, guilds: { cache: new Collection([[G, guild]]) }, channels: { cache: channels } };
  const deleted = [];

  function makeChannel({ id = newId(), name = 'x', type = ChannelType.GuildVoice, overwrites = [] } = {}) {
    const ch = {
      id,
      name,
      type,
      guild,
      client,
      parent: null,
      userLimit: 0,
      members: new Collection(),
      permissionOverwrites: {
        cache: new Collection(),
        async set(list) {
          this.cache = new Collection(list.map((o) => [o.id, makeOverwrite(o.id, o.type, o.allow, o.deny)]));
        },
      },
      async delete() {
        await sleep(5);
        channels.delete(id);
        deleted.push(id);
      },
    };
    ch.permissionOverwrites.set(overwrites);
    channels.set(id, ch);
    return ch;
  }

  guild.channels.create = async (opts) => {
    await sleep(10 + Math.random() * 20); // API-Latenz: erzeugt echte Überlappung bei parallelen Aufrufen
    const ch = makeChannel({ name: opts.name, overwrites: opts.permissionOverwrites });
    ch.userLimit = opts.userLimit;
    return ch;
  };

  function makeMember({ id = newId(), bot = false, perms = 0n, inVoice = true } = {}) {
    const member = {
      id,
      guild,
      client,
      displayName: `User${id.slice(-3)}`,
      user: { id, tag: `user${id.slice(-3)}`, bot, username: `user${id.slice(-3)}` },
      permissions: new PermissionsBitField(perms),
      roles: { cache: new Collection(), highest: { comparePositionTo: () => 0 } },
      voice: {
        channelId: inVoice ? 'lobby' : null,
        async setChannel(ch) {
          if (!member.voice.channelId) {
            const err = new Error('Target user is not connected to voice.');
            err.code = 40032;
            throw err;
          }
          await sleep(5);
          const old = channels.get(member.voice.channelId);
          old?.members.delete(member.id);
          member.voice.channelId = ch.id;
          ch.members.set(member.id, member);
        },
        async disconnect() {
          channels.get(member.voice.channelId)?.members.delete(member.id);
          member.voice.channelId = null;
        },
      },
    };
    return member;
  }

  return { guild, client, channels, deleted, makeChannel, makeMember };
}

function resetDb() {
  for (const row of db.listChannels()) db.deleteChannel(row.channelId);
}

// ---------------------------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------------------------

test('DB: ein Besitzer pro Server, eindeutige Nummern, Sperren werden mit dem Channel gelöscht', () => {
  resetDb();
  db.insertChannel({ channelId: 'c1', guildId: G, ownerId: 'u1', game: 'arma', number: 1 });
  assert.throws(() => db.insertChannel({ channelId: 'c2', guildId: G, ownerId: 'u1', game: 'arma', number: 2 }), /UNIQUE/);
  assert.throws(() => db.insertChannel({ channelId: 'c3', guildId: G, ownerId: 'u2', game: 'arma', number: 1 }), /UNIQUE/);
  // Gleicher Besitzer auf einem anderen Server ist erlaubt.
  db.insertChannel({ channelId: 'c4', guildId: 'other', ownerId: 'u1', game: 'arma', number: 1 });

  assert.equal(db.addBan('c1', 'u9', 'u1'), true);
  assert.equal(db.addBan('c1', 'u9', 'u1'), false, 'doppelte Sperre wird ignoriert');
  assert.equal(db.isBanned('c1', 'u9'), true);
  db.deleteChannel('c1');
  assert.equal(db.isBanned('c1', 'u9'), false, 'ON DELETE CASCADE entfernt die Sperren');
  assert.equal(db.listBans('c1').length, 0);

  db.insertChannel({ channelId: 'c5', guildId: G, ownerId: 'u5', game: 'arma', number: 1 });
  db.insertChannel({ channelId: 'c6', guildId: G, ownerId: 'u6', game: 'arma', number: 2 });
  assert.throws(() => db.setOwner('c6', 'u5'), (err) => db.isUniqueViolation(err));
  assert.equal(db.getChannel('c6').ownerId, 'u6', 'fehlgeschlagener Besitzerwechsel ändert nichts');
});

test('DB: Panel-Auswahl wird gespeichert und überschrieben', () => {
  db.setSelection(G, 'u1', 'arma');
  db.setSelection(G, 'u1', 'wardogs');
  assert.equal(db.getSelection(G, 'u1'), 'wardogs');
  assert.equal(db.getSelection(G, 'u2'), null);
});

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

test('Lock: gleicher Schlüssel läuft nacheinander, verschiedene parallel', async () => {
  const log = [];
  const job = (key, name, ms) =>
    withLock(key, async () => {
      log.push(`${name}+`);
      await sleep(ms);
      log.push(`${name}-`);
    });
  await Promise.all([job('a', 'A1', 20), job('a', 'A2', 1), job('b', 'B1', 1)]);
  assert.ok(log.indexOf('A1-') < log.indexOf('A2+'), `A2 startet erst nach A1: ${log}`);
  assert.ok(log.indexOf('B1-') < log.indexOf('A1-'), `B1 läuft parallel zu A1: ${log}`);
});

test('Lock: ein Fehler gibt den Lock wieder frei', async () => {
  await assert.rejects(withLock('x', async () => { throw new Error('boom'); }));
  assert.equal(await withLock('x', async () => 42), 42);
});

// ---------------------------------------------------------------------------------------------
// Erstellen
// ---------------------------------------------------------------------------------------------

const cm = require('../src/channelManager');
const config = require('../src/config');

test('Erstellen: viele Benutzer gleichzeitig -> eindeutige Nummern, alle verschoben', async () => {
  resetDb();
  const env = makeEnv();
  const members = Array.from({ length: 8 }, () => env.makeMember());
  const channels = await Promise.all(members.map((m) => cm.createTempChannel(m, 'Arma', null)));

  const numbers = db.listChannels(G).map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(channels.map((c) => c.name)).size, 8, 'keine doppelten Namen');
  for (const [i, m] of members.entries()) assert.equal(m.voice.channelId, channels[i].id);
  assert.equal(channels[0].name, '💣 Arma #1');
});

test('Erstellen: Doppelklick desselben Benutzers -> genau ein Channel', async () => {
  resetDb();
  const env = makeEnv();
  const m = env.makeMember();
  const results = await Promise.allSettled([1, 2, 3].map(() => cm.createTempChannel(m, 'Arma', null)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(db.listChannels(G).length, 1);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.ok(r.reason instanceof cm.UserError);
});

test('Erstellen: zweiter Channel desselben Besitzers wird abgelehnt', async () => {
  resetDb();
  const env = makeEnv();
  const m = env.makeMember();
  await cm.createTempChannel(m, 'Arma', null);
  await assert.rejects(cm.createTempChannel(m, 'Wardogs', null), /bereits einen temporären Channel/);
});

test('Erstellen: Benutzer nicht im Voice -> Fehlermeldung, kein Channel bleibt übrig', async () => {
  resetDb();
  const env = makeEnv();
  const m = env.makeMember({ inVoice: false });
  await assert.rejects(cm.createTempChannel(m, 'Arma', null), /zuerst in einem Voicechannel/);
  assert.equal(db.listChannels(G).length, 0);
});

test('Erstellen: Benutzer verlässt Voice während der Erstellung -> Channel wird wieder gelöscht', async () => {
  resetDb();
  const env = makeEnv();
  const m = env.makeMember();
  const original = env.guild.channels.create;
  env.guild.channels.create = async (opts) => {
    const ch = await original(opts);
    m.voice.channelId = null; // Disconnect genau zwischen Erstellen und Verschieben
    return ch;
  };
  await assert.rejects(cm.createTempChannel(m, 'Arma', null), /zuerst in einem Voicechannel/);
  assert.equal(db.listChannels(G).length, 0);
  assert.equal(env.deleted.length, 1);
});

test('Erstellen: Maximalzahl wird auch bei parallelen Klicks eingehalten', async () => {
  resetDb();
  const env = makeEnv();
  const max = config.maxChannels;
  const members = Array.from({ length: max + 5 }, () => env.makeMember());
  const results = await Promise.allSettled(members.map((m) => cm.createTempChannel(m, 'Arma', null)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, max);
  assert.equal(db.countChannels(G), max);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.ok(rejected.every((r) => /maximale Anzahl/.test(r.reason.message)));
});

test('Erstellen: fehlende Bot-Rechte werden gemeldet', async () => {
  resetDb();
  const env = makeEnv({ botPerms: P.ViewChannel | P.Connect | P.ManageChannels });
  await assert.rejects(cm.createTempChannel(env.makeMember(), 'Arma', null), /Rollen verwalten.*Mitglieder verschieben/);
});

// ---------------------------------------------------------------------------------------------
// Löschen
// ---------------------------------------------------------------------------------------------

test('Löschen: nur leere, eingetragene Voicechannels; normale Channels bleiben unberührt', async () => {
  resetDb();
  const env = makeEnv();
  const normal = env.makeChannel({ name: 'Lobby' });
  assert.equal(await cm.deleteTempChannel(env.client, normal.id), false, 'nicht eingetragen -> nie löschen');
  assert.ok(env.channels.has(normal.id));

  const m = env.makeMember();
  const temp = await cm.createTempChannel(m, 'Arma', null);
  assert.equal(await cm.deleteTempChannel(env.client, temp.id), false, 'noch ein Mensch drin');

  const bot = env.makeMember({ bot: true });
  temp.members.set(bot.id, bot);
  await m.voice.disconnect();
  assert.equal(await cm.deleteTempChannel(env.client, temp.id), true, 'nur noch ein Bot drin -> löschen');
  assert.equal(db.getChannel(temp.id), null);
  assert.ok(!env.channels.has(temp.id));
});

test('Löschen: eingetragener Text-Channel wird nie gelöscht, nur der Eintrag entfernt', async () => {
  resetDb();
  const env = makeEnv();
  const text = env.makeChannel({ type: ChannelType.GuildText });
  db.insertChannel({ channelId: text.id, guildId: G, ownerId: 'u1', game: 'arma', number: 1 });
  assert.equal(await cm.deleteTempChannel(env.client, text.id, { force: true }), false);
  assert.ok(env.channels.has(text.id));
  assert.equal(db.getChannel(text.id), null);
});

test('Bereinigung: verwaiste Einträge und leere Channels, junge Channels bleiben', async () => {
  resetDb();
  const env = makeEnv();
  db.insertChannel({ channelId: 'gone', guildId: G, ownerId: 'u1', game: 'arma', number: 1 });
  const empty = env.makeChannel();
  db.insertChannel({ channelId: empty.id, guildId: G, ownerId: 'u2', game: 'arma', number: 2 });
  const stats = await cm.runCleanup(env.client, { graceMs: 60_000 });
  assert.equal(stats.removedEntries, 1);
  assert.equal(stats.deletedChannels, 0, 'jünger als die Schonfrist');
  const stats2 = await cm.runCleanup(env.client, { graceMs: 0 });
  assert.equal(stats2.deletedChannels, 1);
  assert.equal(db.listChannels(G).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Berechtigungen / Overwrites
// ---------------------------------------------------------------------------------------------

test('Overwrites: Sperre, Bans, Besitzer und Bot; Kategorie-Rollen verlieren Connect', () => {
  const env = makeEnv();
  const ROLE = '500000000000000001';
  const category = {
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    permissionOverwrites: {
      cache: new Collection([[ROLE, makeOverwrite(ROLE, OverwriteType.Role, P.Connect | P.ViewChannel, 0n)]]),
    },
  };
  const list = cm.buildOverwrites(env.guild, category, { ownerId: 'owner', locked: true, bannedIds: ['bad'] });
  const by = Object.fromEntries(list.map((o) => [o.id, o]));

  assert.ok(by[G].deny & P.Connect, '@everyone darf nicht beitreten');
  assert.ok(by[ROLE].deny & P.Connect && !(by[ROLE].allow & P.Connect), 'Rollen-Allow aus Kategorie wird aufgehoben');
  assert.ok(by[ROLE].allow & P.ViewChannel, 'andere Kategorie-Rechte bleiben');
  assert.ok(by.bad.deny & P.Connect);
  assert.ok(by.owner.allow & P.Connect, 'Besitzer kommt trotz Sperre rein');
  assert.ok(by[BOT].allow & P.MoveMembers);

  const unlocked = cm.buildOverwrites(env.guild, category, { ownerId: 'owner', locked: false, bannedIds: [] });
  const role = unlocked.find((o) => o.id === ROLE);
  assert.ok(role.allow & P.Connect, 'nach dem Entsperren gilt wieder die Kategorie');
  assert.equal(unlocked.find((o) => o.id === G), undefined);
});

test('Overwrites: Bot vergibt nur Rechte, die er selbst hat', () => {
  const env = makeEnv({ botPerms: P.ViewChannel | P.Connect | P.ManageChannels | P.ManageRoles | P.MoveMembers });
  const list = cm.buildOverwrites(env.guild, null, { ownerId: 'owner', locked: false, bannedIds: [] });
  const owner = list.find((o) => o.id === 'owner');
  assert.equal(owner.allow & P.Speak, 0n, 'Speak hat der Bot nicht -> wird nicht vergeben');
  assert.ok(owner.allow & P.Connect);
});

test('Manipulation: entfernte Ban-Overwrite wird erkannt und wiederhergestellt', async () => {
  resetDb();
  const env = makeEnv();
  const m = env.makeMember();
  const ch = await cm.createTempChannel(m, 'Arma', null);
  const target = env.makeMember();
  await cm.banMember(ch, target, m);
  assert.equal(cm.permissionsIntact(ch, db.getChannel(ch.id)), true);

  ch.permissionOverwrites.cache.delete(target.id); // Admin entfernt die Sperre per Hand
  assert.equal(cm.permissionsIntact(ch, db.getChannel(ch.id)), false);
  await cm.repairPermissionsIfNeeded(ch);
  assert.ok(ch.permissionOverwrites.cache.get(target.id).deny.has(P.Connect));
});

test('Bann: entfernt Mitglied, Unban hebt auf, Besitzer nicht bannbar', async () => {
  resetDb();
  const env = makeEnv();
  const owner = env.makeMember();
  const ch = await cm.createTempChannel(owner, 'Arma', null);
  const target = env.makeMember();
  await target.voice.setChannel(ch);

  await cm.banMember(ch, target, owner);
  assert.equal(target.voice.channelId, null, 'sofort entfernt');
  assert.equal(db.isBanned(ch.id, target.id), true);
  await assert.rejects(cm.banMember(ch, target, owner), /bereits gesperrt/);
  await assert.rejects(cm.banMember(ch, owner, owner), /Besitzer kann nicht gesperrt/);

  await cm.unbanMember(ch, target.id);
  assert.equal(db.isBanned(ch.id, target.id), false);
  assert.equal(ch.permissionOverwrites.cache.get(target.id), undefined);
});

test('Sperren/Entsperren: Status in DB und Overwrites', async () => {
  resetDb();
  const env = makeEnv();
  const ch = await cm.createTempChannel(env.makeMember(), 'Arma', null);
  assert.equal(await cm.setLocked(ch, true), true);
  assert.equal(await cm.setLocked(ch, true), false, 'zweimal sperren ändert nichts');
  assert.equal(db.getChannel(ch.id).locked, true);
  assert.ok(ch.permissionOverwrites.cache.get(G).deny.has(P.Connect));
  await cm.setLocked(ch, false);
  assert.equal(db.getChannel(ch.id).locked, false);
});

test('Besitzerwechsel: neue Rechte, alte entfernt, nur an Mitglieder im Channel', async () => {
  resetDb();
  const env = makeEnv();
  const owner = env.makeMember();
  const ch = await cm.createTempChannel(owner, 'Arma', null);
  const outsider = env.makeMember();
  await assert.rejects(cm.transferOwnership(ch, outsider), /nicht \(mehr\) in diesem Channel/);

  const next = env.makeMember();
  await next.voice.setChannel(ch);
  await cm.transferOwnership(ch, next);
  assert.equal(db.getChannel(ch.id).ownerId, next.id);
  assert.ok(ch.permissionOverwrites.cache.get(next.id).allow.has(P.Connect));
  assert.equal(ch.permissionOverwrites.cache.get(owner.id), undefined, 'alter Besitzer verliert seine Overwrite');

  // Wer schon einen eigenen Channel besitzt, kann keinen zweiten übernehmen.
  const other = env.makeMember();
  await cm.createTempChannel(other, 'Wardogs', null);
  await other.voice.setChannel(ch);
  await assert.rejects(cm.transferOwnership(ch, other), /bereits einen eigenen/);
});

// ---------------------------------------------------------------------------------------------
// Rechteprüfung
// ---------------------------------------------------------------------------------------------

test('Rechte: Besitzer darf keine Admins/Moderatoren verwalten, Fremde haben keine Befugnis', () => {
  const { authorityOver, checkTarget } = require('../src/permissions');
  const env = makeEnv();
  const owner = env.makeMember();
  const admin = env.makeMember({ perms: P.Administrator });
  const mod = env.makeMember({ perms: P.MoveMembers });
  const normal = env.makeMember();
  const row = { ownerId: owner.id };

  assert.equal(authorityOver(owner, row), 'owner');
  assert.equal(authorityOver(admin, row), 'admin');
  assert.equal(authorityOver(normal, row), null);

  assert.match(checkTarget(owner, 'owner', admin), /Admins und Moderatoren/);
  assert.match(checkTarget(owner, 'owner', mod), /Admins und Moderatoren/);
  assert.match(checkTarget(owner, 'owner', owner), /selbst/);
  assert.equal(checkTarget(owner, 'owner', normal), null);
  assert.equal(checkTarget(admin, 'admin', owner), null, 'Admin darf eingreifen');
  assert.match(checkTarget(admin, 'admin', { ...normal, id: SERVER_OWNER }), /Serverbesitzer/);
});

test('Custom-IDs: nur gültige Formate werden akzeptiert', () => {
  const { parseCustomId, customId } = require('../src/controlPanel');
  const id = '123456789012345678';
  assert.deepEqual(parseCustomId(customId('kick_yes', id, id)), { action: 'kick_yes', channelId: id, extra: id });
  assert.equal(parseCustomId('vcm:kick:abc'), null);
  assert.equal(parseCustomId(`vcm:kick:${id}:notanid`), null);
  assert.equal(parseCustomId(`other:kick:${id}`), null);
});

// ---------------------------------------------------------------------------------------------
// Discord-Komponenten (Builder validieren gegen Discords Grenzen)
// ---------------------------------------------------------------------------------------------

test('Komponenten: Panel, Verwaltungsmenü und Modals sind gültig', async () => {
  const { buildPanel } = require('../src/panel');
  const { buildControlPanel } = require('../src/controlPanel');

  const panel = buildPanel(G);
  const json = panel.components.map((c) => c.toJSON());
  assert.equal(panel.embeds[0].toJSON().title, '🐝 Temporären Voicechannel erstellen');
  assert.equal(json[0].components[0].placeholder, 'Spiel auswählen …');
  assert.equal(json[1].components[0].label, 'Channel erstellen');
  assert.equal(json[1].components[0].emoji.name, '➕');
  assert.equal(json[1].components[0].style, 3, 'grüner Button');

  const ch = { userLimit: 5 };
  const cp = buildControlPanel(ch, { channelId: '123456789012345678', ownerId: '1', locked: false });
  const rows = cp.components.map((c) => c.toJSON());
  assert.equal(rows.length, 2);
  assert.equal(rows.flatMap((r) => r.components).length, 8);
  cp.embeds[0].toJSON();

  // Modals über die echte Funktion bauen und gegen die Builder-Validierung prüfen.
  const manage = require('../src/manage');
  assert.ok(manage.handleManageInteraction);
  const shown = [];
  const fake = {
    customId: 'vcm:rename:123456789012345678',
    isButton: () => true,
    guildId: G,
    showModal: async (m) => shown.push(m instanceof ModalBuilder ? m.toJSON() : m),
  };
  // Ohne DB-Eintrag kommt eine Fehlermeldung statt eines Modals (keine Befugnis ohne Channel).
  const replies = [];
  fake.isMessageComponent = () => true;
  fake.isStringSelectMenu = () => false;
  fake.isUserSelectMenu = () => false;
  fake.isModalSubmit = () => false;
  fake.reply = async (p) => replies.push(p);
  fake.message = { flags: { has: () => false } };
  await manage.handleManageInteraction(fake);
  assert.match(replies[0].content, /existiert nicht mehr/);
  assert.equal(shown.length, 0);

  // Echter Channel: Fremder wird abgewiesen, Besitzer bekommt gültige Modals.
  resetDb();
  const env = makeEnv();
  const owner = env.makeMember();
  const chan = await cm.createTempChannel(owner, 'Arma', null);
  const stranger = env.makeMember();
  const interact = (member, action) => ({
    ...fake,
    customId: `vcm:${action}:${chan.id}`,
    guild: env.guild,
    member,
    reply: async (p) => replies.push(p),
  });

  await manage.handleManageInteraction(interact(stranger, 'rename'));
  assert.match(replies.at(-1).content, /Nur der Besitzer/);
  assert.equal(shown.length, 0, 'kein Modal für Unbefugte');

  await manage.handleManageInteraction(interact(owner, 'rename'));
  await manage.handleManageInteraction(interact(owner, 'limit'));
  assert.equal(shown.length, 2, `Modals erwartet, Antworten: ${JSON.stringify(replies.slice(1))}`);
  assert.equal(shown[0].custom_id, `vcm:rename_modal:${chan.id}`);
  assert.equal(shown[0].components[0].type, 18, 'Label-Komponente');
  assert.equal(shown[0].components[0].component.value, chan.name);
  assert.equal(shown[1].components[0].component.custom_id, 'limit');
});
