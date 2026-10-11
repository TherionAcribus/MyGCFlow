import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');


// WAV PCM 16 bits mono : `toneSeconds` de la 440 Hz puis `silenceSeconds` de
// silence numérique. Généré en mémoire pour ne pas versionner de binaire.
function wavFile(name, toneSeconds, silenceSeconds) {
  const rate = 8000;
  const toneSamples = Math.round(toneSeconds * rate);
  const total = toneSamples + Math.round(silenceSeconds * rate);
  const buffer = Buffer.alloc(44 + total * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + total * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < toneSamples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000), 44 + i * 2);
  }
  return { name, mimeType: 'audio/wav', buffer };
}


async function recordingSettings(page) {
  return page.evaluate(async () => (await (await fetch('/api/settings')).json()).recording);
}


test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#filtersCounter')).toContainText('6 / 6', { timeout: 45_000 });
  await page.locator('a[href="#animation"]').click();
});


test('un blanc de fin est signalé et peut être ignoré', async ({ page }) => {
  const box = page.locator('#audioTrailingSilence');
  const trim = page.locator('#cbAudioTrimSilence');
  const status = page.locator('#musicSyncStatus');

  await expect(box).toBeHidden();

  await page.locator('#inputAudioFile').setInputFiles(wavFile('avec-blanc.wav', 4, 3));

  await expect(box).toBeVisible();
  await expect(page.locator('#audioTrailingSilenceText')).toContainText('3.0');
  // Option non cochée par défaut : la durée reste celle du fichier.
  await expect(trim).not.toBeChecked();
  await expect(status).toContainText('Musique : 7 s');

  await trim.check();
  // 7 s − 3 s de blanc + 0,3 s de marge, arrondi à l'affichage.
  await expect(status).toContainText('Musique : 4 s');
  await expect(status).toContainText('Durée calée sur la musique (4 s)');
  await expect.poll(async () => (await recordingSettings(page)).audio_trim_silence).toBe(true);

  // Décocher rend sa durée complète à la musique (et remet la préférence
  // globale dans son état initial pour les specs suivantes).
  await trim.uncheck();
  await expect(status).toContainText('Musique : 7 s');
  await expect.poll(async () => (await recordingSettings(page)).audio_trim_silence).toBe(false);
});


test('une musique sans blanc de fin ne propose pas l\'option', async ({ page }) => {
  await page.locator('#inputAudioFile').setInputFiles(wavFile('sans-blanc.wav', 4, 0));

  await expect(page.locator('#audioFileInfo')).toContainText('sans-blanc.wav');
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 4 s');
  await expect(page.locator('#audioTrailingSilence')).toBeHidden();
});
