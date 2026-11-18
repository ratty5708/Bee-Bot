// Postet die Commits eines Pushs als Changelog in einen Discord-Kanal (per Webhook).
// Aufruf aus GitHub Actions: node .github/scripts/discord-changelog.mjs
//   DISCORD_WEBHOOK   Webhook-URL des Changelog-Kanals (Secret)
//   CHANGELOG_TITLE   Überschrift, z. B. „🐝 Website-Update“
//   GITHUB_EVENT_PATH von GitHub gesetzt (Push-Event als JSON)
// Commits mit [no changelog] / [skip changelog] in der Nachricht und Merge-Commits werden übersprungen.
// Lokal testen: DRY_RUN=1 GITHUB_EVENT_PATH=event.json node .github/scripts/discord-changelog.mjs
import { readFileSync } from 'node:fs';

const MAX_DESCRIPTION = 4000; // Discord-Grenze 4096
const SKIP = /\[(no|skip)[ -]changelog\]/i;

const { DISCORD_WEBHOOK, CHANGELOG_TITLE = '🐝 Update', GITHUB_EVENT_PATH, DRY_RUN } = process.env;

const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
const lines = (event.commits ?? [])
  .filter((c) => c.distinct !== false)
  .map((c) => c.message)
  .filter((m) => !SKIP.test(m) && !/^Merge (branch|pull request|remote-tracking)/.test(m))
  .map((m) => `• ${m.split('\n')[0].trim()}`);

if (lines.length === 0) {
  console.log('Keine Changelog-relevanten Commits.');
  process.exit(0);
}

// Auf mehrere Nachrichten verteilen, falls die Beschreibung zu lang wird
const chunks = [];
let current = '';
for (const line of lines) {
  if (current && current.length + line.length + 1 > MAX_DESCRIPTION) {
    chunks.push(current);
    current = '';
  }
  current += (current ? '\n' : '') + line;
}
chunks.push(current);

const date = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Vienna' });

for (const [i, description] of chunks.entries()) {
  const body = {
    allowed_mentions: { parse: [] }, // kein @everyone/@here aus Commit-Texten
    embeds: [
      {
        title: i === 0 ? CHANGELOG_TITLE : `${CHANGELOG_TITLE} (Fortsetzung)`,
        description,
        color: 0xf5b301,
        footer: { text: date },
      },
    ],
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(body, null, 2));
    continue;
  }
  if (!DISCORD_WEBHOOK) {
    console.log('DISCORD_WEBHOOK fehlt – nichts gesendet.');
    process.exit(0);
  }

  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Discord antwortet ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
}
console.log(`${lines.length} Einträge ${DRY_RUN ? "ausgegeben (Testlauf)" : "an Discord gesendet"}.`);
