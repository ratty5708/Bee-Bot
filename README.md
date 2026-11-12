# 🐝 BeeBot – Temporäre Voicechannels

Ein Panel mit Spielauswahl und dem Button **➕ Channel erstellen**. Der Bot erstellt einen Voicechannel wie `💣 Arma #1`, schiebt dich hinein und löscht ihn, sobald der letzte Spieler gegangen ist. Der Ersteller ist Besitzer und verwaltet seinen Channel über ein Menü: umbenennen, Limit, sperren, kicken, bannen, Besitz übertragen.

- Node.js + discord.js 14, Daten in SQLite (`data/beebot.db`, eingebaut in Node, kein natives Modul nötig)
- Keine privilegierten Intents nötig
- Läuft im bisherigen Container (Pterodactyl/Gameserver-Hosting) oder auf einem Ubuntu-vServer mit systemd

---

## Inhalt

1. [Funktionen](#1-funktionen)
2. [Umstieg vom alten BeeBot](#2-umstieg-vom-alten-beebot)
3. [Bot im Discord Developer Portal einrichten](#3-bot-im-discord-developer-portal-einrichten)
4. [Konfiguration](#4-konfiguration)
5. [Betrieb im bisherigen Container](#5-betrieb-im-bisherigen-container)
6. [Betrieb auf Ubuntu mit systemd](#6-betrieb-auf-ubuntu-mit-systemd)
7. [Benutzung](#7-benutzung)
8. [Wie der Bot Zuverlässigkeit sicherstellt](#8-wie-der-bot-zuverlässigkeit-sicherstellt)
9. [Fehlersuche](#9-fehlersuche)

---

## 1. Funktionen

**Für alle Mitglieder**
- Panel: Spiel auswählen, **Channel erstellen**, automatisch hineingeschoben werden
- Höchstens ein eigener temporärer Channel pro Person
- Der Channel wird gelöscht, sobald kein Mensch mehr drin ist (Verlassen, Disconnect, Kick, Verschieben, Server verlassen). Bleibt nur ein Bot zurück, wird er ebenfalls gelöscht.

**Für den Channel-Besitzer** (Menü im Chat des Voicechannels oder `/kanal`)

| Channel verwalten | Mitglieder verwalten |
|---|---|
| ✏️ Channel umbenennen | 👢 Mitglied kicken (mit Bestätigung) |
| 👥 Benutzerlimit ändern | 🔨 Mitglied bannen (mit Bestätigung) |
| 🔒 Channel sperren / entsperren | 🔓 Mitglied entbannen |
| 👑 Besitzer übertragen (mit Bestätigung) | 📋 Gesperrte Mitglieder anzeigen |

- Server-Admins können in jedem Channel eingreifen.
- Besitzer können keine Admins oder Moderatoren (Recht „Mitglieder verschieben“) kicken oder bannen.
- Ein Bann gilt nur für diesen einen temporären Channel, nie für den Server, und verschwindet mit dem Channel.
- Verlässt der Besitzer den Channel, bleibt er Besitzer, solange der Channel existiert.

**Für Admins**

| Befehl | Wirkung |
|---|---|
| `/setup [kanal]` | Postet das Panel (in `kanal`, sonst `panelChannelId` aus der Config, sonst im aktuellen Kanal). |
| `/tempchannels` | Übersicht aller aktiven temporären Channels mit Besitzer, Mitgliedern, Sperre und Alter. |
| `/tempchannels_cleanup` | Bereinigt leere und verwaiste temporäre Channels sofort. |
| `/tempchannels_config` | Zeigt die aktuelle Konfiguration. |
| `/spiel hinzufügen name: emoji: limit:` | Fügt ein Spiel hinzu (Emoji und Limit optional). Alle Panels werden sofort aktualisiert. |
| `/spiel entfernen name:` | Entfernt ein Spiel (mit Vorschlagsliste). |
| `/spiel liste` | Zeigt alle Spiele. |

Als Admin gilt: Serverbesitzer, wer „Administrator“, „Server verwalten“ oder „Kanäle verwalten“ hat, oder wer eine Rolle aus `adminRoleIds` hat. Der Bot prüft das bei jeder Ausführung selbst, nicht nur über die Sichtbarkeit der Befehle.

---

## 2. Umstieg vom alten BeeBot

Wenn der bisherige BeeBot schon läuft:

1. **`.env` und `data/` behalten.** Die Spieleliste in `data/guilds.json` und die geposteten Panels werden weiterverwendet. Die alten Panels funktionieren ohne neues `/setup` weiter.
2. `data/channels.json` wird beim ersten Start automatisch in die SQLite-Datenbank übernommen und danach in `channels.json.migrated` umbenannt.
3. **Neues Bot-Recht nötig: „Rollen verwalten“.** Damit setzt der Bot Sperren und Bans über Channel-Berechtigungen. Entweder den Bot über den Link in Abschnitt 3 neu einladen, oder der Bot-Rolle in den Servereinstellungen „Rollen verwalten“ geben.
4. Node.js **22.13 oder neuer** (der Container hat Node 24, das passt).
5. **Geändertes Verhalten:**
   - Besitzer haben keine Discord-Rechte mehr direkt am Channel (vorher: Rechtsklick → Verschieben/Stummschalten). Alles läuft über das Verwaltungsmenü, damit Besitzer keine Admins rauswerfen können.
   - Verlässt der Besitzer den Channel, wird der Besitz nicht mehr automatisch weitergegeben. Er kann ihn selbst übertragen, oder ein Admin greift ein.

---

## 3. Bot im Discord Developer Portal einrichten

1. https://discord.com/developers/applications → **New Application** (oder die bestehende BeeBot-Application öffnen).
2. **Bot** → **Reset Token** → Token kopieren. Er kommt als `DISCORD_TOKEN` in die `.env`. Den Token nie weitergeben oder committen.
3. **General Information** → **Application ID** kopieren → `CLIENT_ID` in der `.env`.
4. Privilegierte Intents (Presence, Server Members, Message Content) werden **nicht** benötigt.
5. Bot einladen. `CLIENT_ID` im Link ersetzen:

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=288443408
   ```

   Der Wert `288443408` enthält genau diese Rechte:

   | Recht | Wofür |
   |---|---|
   | Kanäle ansehen | Kategorie und Channels sehen |
   | Nachrichten senden, Links einbetten, Nachrichtenverlauf lesen | Panel und Verwaltungsmenü |
   | Kanäle verwalten | Channels erstellen, umbenennen, Limit setzen, löschen |
   | Rollen verwalten | Sperren, Bans und Besitzerrechte über Channel-Berechtigungen |
   | Verbinden, Sprechen | in die Channels verschieben, Besitzerrechte vergeben |
   | Mitglieder verschieben | Ersteller hineinschieben, kicken, Gebannte entfernen |

6. **Rollenhierarchie:** In *Servereinstellungen → Rollen* die Bot-Rolle **über** die Rollen der Mitglieder ziehen, die er verschieben soll.
7. **Kategorie-Rechte:** Wenn die Kategorie für temporäre Channels eigene Berechtigungen hat, muss die Bot-Rolle dort die Rechte aus der Tabelle haben (vor allem *Kanäle verwalten*, *Berechtigungen verwalten*, *Verbinden*, *Mitglieder verschieben*).
8. Entwicklermodus aktivieren (*Einstellungen → Erweitert → Entwicklermodus*). Dann per Rechtsklick **ID kopieren** für Server, Kategorie und Kanäle.

---

## 4. Konfiguration

### `.env` (Zugangsdaten, nie committen)

Vorlage: `.env.example`.

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DISCORD_TOKEN` | ja | Bot-Token |
| `CLIENT_ID` | für `npm run deploy` | Application ID |
| `GUILD_ID` | empfohlen | Server-ID. Wenn gesetzt, arbeitet der Bot nur auf diesem Server. |
| `LOG_LEVEL` | nein | `debug`, `info` (Standard), `warn`, `error` |

### `config.json` (Einstellungen, Neustart nach Änderungen)

| Feld | Standard | Bedeutung |
|---|---|---|
| `categoryId` | leer | Kategorie für die temporären Channels. Leer = Kategorie des Kanals, in dem das Panel steht. |
| `panelChannelId` | leer | Kanal, in den `/setup` das Panel postet. Leer = aktueller Kanal. |
| `maxChannels` | `25` | Maximale Anzahl gleichzeitiger temporärer Channels pro Server. `0` = unbegrenzt. |
| `defaultUserLimit` | `0` | Benutzerlimit neuer Channels. `0` = unbegrenzt. Pro Spiel überschreibbar (`/spiel hinzufügen … limit:`). |
| `maxUserLimit` | `0` | Höchstes Limit, das Besitzer einstellen dürfen (1–99). `0` = keine Obergrenze, Besitzer dürfen auch „unbegrenzt“ wählen. |
| `nameTemplate` | `{emoji} {game} #{number}` | Namensschema. Platzhalter: `{emoji}`, `{game}`, `{number}`, `{user}` (Anzeigename des Erstellers). |
| `allowedRoleIds` | `[]` | Nur diese Rollen dürfen Channels erstellen. Leer = alle. |
| `adminRoleIds` | `[]` | Zusätzliche Rollen, die als Admin gelten. |
| `kickTargetChannelId` | leer | Voicechannel, in den Gekickte/Gebannte verschoben werden (z. B. die Lobby). Leer = Verbindung trennen. |
| `sweepIntervalSeconds` | `60` | Wie oft der Bot zur Sicherheit nach leeren Channels sucht (15–3600). |
| `panel` | | Titel, Text, Farbe, Platzhalter und Button-Text des Panels. |
| `games` | | Start-Spiele für Server, auf denen noch nichts per `/spiel` eingestellt wurde. |

### Spiele verwalten

Am einfachsten direkt in Discord mit `/spiel hinzufügen`, `/spiel entfernen` und `/spiel liste`. Die Liste wird pro Server in `data/guilds.json` gespeichert, alle Panels aktualisieren sich sofort, ein Neustart ist nicht nötig. Discord erlaubt höchstens 25 Einträge im Dropdown.

`games` in der `config.json` gilt nur für Server, auf denen noch nie ein Spiel per `/spiel` geändert wurde. Wer die Liste lieber in der Datei pflegt, bearbeitet `data/guilds.json` (bei gestopptem Bot):

```json
{ "value": "valorant", "label": "Valorant", "emoji": "🎯", "userLimit": 5 }
```

`value` ist die interne ID (nicht ändern, solange Channels dieses Spiels existieren), `label` der angezeigte Name, `userLimit` optional.

---

## 5. Betrieb im bisherigen Container

So läuft der Bot im Gameserver-/Pterodactyl-Container (`/home/container`).

1. Bot im Panel **stoppen**.
2. Im Dateimanager (oder per SFTP) diese Dateien hochladen bzw. ersetzen:
   - `package.json`, `package-lock.json`, `config.json`
   - den kompletten Ordner `src/` (die alte Datei `src/store.js` löschen, sie wird nicht mehr gebraucht)
   - optional `README.md`, `.env.example`
3. **Nicht überschreiben:** `.env` und `data/`.
4. In `config.json` die eigenen Werte eintragen (z. B. `categoryId`). Die bisherige `config.json` hatte nur `categoryId`, `panel` und `games`.
5. Im Panel unter *Startup* prüfen: Hauptdatei `src/index.js` bzw. Startbefehl `npm start`, Node-Version 22 oder neuer. Der Container führt `npm install` beim Start selbst aus.
6. Bot **starten**. In der Konsole sollte stehen:
   ```
   INFO  [bot] 🐝 Eingeloggt als BeeBot#1234 …
   INFO  [commands] Befehle registriert auf "…"
   INFO  [channels] Start-Bereinigung: …
   ```
7. In Discord `/tempchannels_config` ausführen und die Werte prüfen.

---

## 6. Betrieb auf Ubuntu mit systemd

Für einen eigenen vServer (Ubuntu 22.04/24.04).

### Installation

```bash
# Node.js 24 installieren
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # muss 22.13 oder neuer sein

# eigener Benutzer ohne Login
sudo useradd --system --create-home --home-dir /opt/beebot --shell /usr/sbin/nologin beebot

# Code holen und Abhängigkeiten installieren
sudo -u beebot git clone https://gitlab.com/jrattay/beebot.git /opt/beebot
cd /opt/beebot
sudo -u beebot npm ci --omit=dev

# Zugangsdaten eintragen
sudo -u beebot cp .env.example .env
sudo -u beebot nano .env
sudo chmod 600 .env

# Datenordner anlegen (systemd erlaubt nur hier Schreibzugriff)
sudo -u beebot mkdir -p data
```

Bei einem Umzug vom Container: `.env` und den Ordner `data/` (mit `guilds.json`) von dort nach `/opt/beebot/` kopieren und `sudo chown -R beebot:beebot /opt/beebot` ausführen.

### Dienst einrichten

```bash
sudo cp /opt/beebot/deploy/beebot.service /etc/systemd/system/beebot.service
sudo systemctl daemon-reload
sudo systemctl enable --now beebot
```

### Bedienen

```bash
sudo systemctl status beebot        # Status
sudo journalctl -u beebot -f        # Log live
sudo systemctl restart beebot       # Neustart, z. B. nach config.json-Änderung
```

Der Dienst startet nach einem Absturz nach 5 Sekunden neu und beim Booten automatisch.

### Update

```bash
cd /opt/beebot
sudo -u beebot git pull
sudo -u beebot npm ci --omit=dev
sudo systemctl restart beebot
```

### Backup

Wichtig sind nur `.env`, `config.json` und `data/`. Die Datenbank im laufenden Betrieb sichern:

```bash
sudo -u beebot sqlite3 /opt/beebot/data/beebot.db ".backup '/opt/beebot/data/backup.db'"
```

---

## 7. Benutzung

1. Ein Admin führt `/setup` aus. Das Panel erscheint.
2. Ein Mitglied tritt einem beliebigen Voicechannel bei (z. B. der Lobby), wählt ein Spiel und klickt **➕ Channel erstellen**.
3. Der Bot erstellt den Channel, schiebt das Mitglied hinein und postet das **Verwaltungsmenü** in den Chat des Voicechannels. Mit `/kanal` lässt es sich jederzeit privat öffnen.
4. Kicken, Bannen und Besitz übertragen laufen in drei Schritten: Mitglied auswählen → bestätigen → erledigt.
5. Wenn der letzte Mensch geht, wird der Channel mit allen Bans gelöscht.

### Fehlermeldungen (nur für den Benutzer sichtbar)

- „Du musst dich zuerst in einem Voicechannel befinden.“
- „Du besitzt bereits einen temporären Channel: …“
- „Bitte wähle zuerst ein Spiel aus.“
- „Der Channel konnte nicht erstellt werden.“ (bei fehlenden Bot-Rechten mit Angabe, welche fehlen)
- „Die maximale Anzahl an Channels wurde erreicht.“
- „⛔ Nur der Besitzer dieses Channels oder ein Server-Admin kann das tun.“
- „Server-Admins und Moderatoren kannst du nicht verwalten.“

---

## 8. Wie der Bot Zuverlässigkeit sicherstellt

| Risiko | Lösung |
|---|---|
| Doppelte Channels bei gleichzeitigen Klicks | Pro Server läuft immer nur eine Erstellung gleichzeitig (Mutex). Zusätzlich verhindern eindeutige Indizes in SQLite einen zweiten Channel pro Besitzer und doppelte Nummern. |
| Normale Channels werden gelöscht | Gelöscht wird nur, was in der Datenbank als temporär eingetragen **und** ein Voicechannel ist. |
| Löschen verpasst (Disconnect, Kick, Server verlassen, Gateway-Reconnect) | Jedes Voice-Event wird geprüft. Zusätzlich sucht der Bot alle `sweepIntervalSeconds` nach leeren Channels. Neue Channels sind 60 Sekunden geschützt, bis der Ersteller drin ist. |
| Bot-Neustart | Alle Daten liegen in SQLite. Beim Start werden leere Channels gelöscht, verwaiste Einträge entfernt, Berechtigungen geprüft und Gebannte, die während der Downtime beigetreten sind, entfernt. Buttons und Menüs tragen nur IDs und funktionieren nach dem Neustart weiter. Auch die Spielauswahl im Panel bleibt gespeichert. |
| Sperren werden per Hand umgangen | Bei jeder Änderung an einem temporären Channel prüft der Bot Bans, Sperre und Besitzerrechte und stellt sie wieder her. Zusätzlich wird bei jedem Beitritt geprüft, ob der Benutzer gebannt ist. |
| Manipulierte Interaktionen | Jeder Klick, jede Auswahl und jede Bestätigung prüft Besitzer bzw. Admin-Status und Zielperson neu auf dem Server. |
| Discord-Rate-Limit beim Umbenennen (2 pro 10 Min.) | Der Bot wartet nicht minutenlang, sondern meldet sofort, wann es wieder geht. |
| Absturz beim Schreiben | SQLite im WAL-Modus. `guilds.json` wird erst in eine temporäre Datei geschrieben und dann umbenannt. |

### Tests

```bash
npm test
```

23 Tests ohne Discord-Verbindung: parallele Erstellung, Doppelklicks, Limit, Löschschutz, Bereinigung, Bans, Sperre, Besitzerwechsel, Rechteprüfung, Wiederherstellung manipulierter Berechtigungen und die Discord-Komponenten.

---

## 9. Fehlersuche

| Problem | Ursache / Lösung |
|---|---|
| Befehle erscheinen nicht | Bot mit Scope `applications.commands` einladen. Discord neu laden (Strg+R). Ist `GUILD_ID` die richtige Server-ID? |
| „Dem Bot fehlen Rechte: …“ | Fehlende Rechte der Bot-Rolle geben, auch in der Kategorie (Abschnitt 3). |
| Benutzer wird nicht verschoben | Bot-Rolle steht unter der Rolle des Benutzers. In der Rollenliste nach oben ziehen. |
| Channel landet in der falschen Kategorie | `categoryId` in `config.json` setzen und neu starten. Im Log steht eine Warnung, wenn die ID keine Kategorie ist. |
| Sperren wirken nicht | Bot braucht „Rollen verwalten“ (in der Kategorie: „Berechtigungen verwalten“). Admins umgehen Channel-Sperren immer, das ist Discord-Verhalten. |
| Mehr Details | `LOG_LEVEL=debug` in der `.env` setzen und neu starten. |
