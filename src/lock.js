'use strict';

// Asynchroner Mutex pro Schlüssel. Aufrufe mit demselben Schlüssel laufen strikt nacheinander,
// verschiedene Schlüssel parallel. Verhindert Race Conditions zwischen await-Punkten
// (z. B. zwei gleichzeitige Klicks auf "Channel erstellen").
const tails = new Map();

async function withLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

module.exports = { withLock };
