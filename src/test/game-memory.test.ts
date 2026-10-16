import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GameMemory, LEGACY_READER, type ReaderSpawner } from '../main/game-memory';

/** A reader folder as the setup script leaves it (the scripts and ClrMD only have to be there). */
function readerFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'bitmat-reader-'));
  mkdirSync(path.join(folder, 'lib'));
  for (const file of ['reader.ps1', LEGACY_READER, path.join('lib', 'Microsoft.Diagnostics.Runtime.dll')]) writeFileSync(path.join(folder, file), '');
  return folder;
}

/** A reading line, as both readers send them. */
const READING = JSON.stringify({ inGame: true, user: { name: 'warrre', x: 10, y: 20 } });
/** Node scripts standing in for the readers: sending readings, failing to compile, or saying nothing. */
const SENDS = `setInterval(() => console.log(${JSON.stringify(READING)}), 30)`;
const FAILS = `console.error('Add-Type: (12,5): error CS1002: ; expected'); process.exit(1)`;
const SILENT = 'setInterval(() => {}, 1000)';

/** Runs the compiled reader as `newReader` and the legacy one as a reader that works. */
function standIns(newReader: string): ReaderSpawner {
  return (script) => spawn(process.execPath, ['-e', path.basename(script) === LEGACY_READER ? SENDS : newReader]);
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  for (const since = Date.now(); !check() && Date.now() - since < ms; ) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
};

test('the compiled reader failing to start (a compile error): the legacy one takes over, said once with the reason', async () => {
  const memory = new GameMemory(readerFolder(), { spawnReader: standIns(FAILS) });
  memory.start();
  try {
    assert.ok(await waitFor(() => memory.latest() !== null), 'readings from the legacy reader');
    assert.ok(memory.legacy);
    assert.equal(memory.takeNotice(), 'New memory reader failed (Add-Type: (12,5): error CS1002: ; expected); using the old one');
    assert.equal(memory.takeNotice(), null);
    assert.equal(memory.latest()?.user?.name, 'warrre');
  } finally {
    memory.stop();
  }
});

test('the compiled reader saying nothing for too long: the legacy one takes over', async () => {
  const memory = new GameMemory(readerFolder(), { spawnReader: standIns(SILENT), fallbackAfterMs: 300 });
  memory.start();
  try {
    assert.ok(await waitFor(() => memory.latest() !== null), 'readings from the legacy reader');
    assert.ok(memory.legacy);
    assert.match(memory.takeNotice() ?? '', /^New memory reader failed \(nothing from it in 0 s\); using the old one$/);
  } finally {
    memory.stop();
  }
});

test('the compiled reader working: it stays, nothing to say; stopping it before it has spoken is no failure', async () => {
  // (A few seconds' grace: a loaded machine can take a while just to start the stand-in.)
  const memory = new GameMemory(readerFolder(), { spawnReader: standIns(SENDS), fallbackAfterMs: 5000 });
  memory.start();
  try {
    assert.ok(await waitFor(() => memory.latest() !== null));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(!memory.legacy);
    assert.equal(memory.takeNotice(), null);
  } finally {
    memory.stop();
  }
  const quiet = new GameMemory(readerFolder(), { spawnReader: standIns(SILENT), fallbackAfterMs: 300 });
  quiet.start();
  quiet.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!quiet.legacy);
  assert.equal(quiet.takeNotice(), null);
});
