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
  await page.locator('#musicConfigTab').click();
});


// Le mode de rythme et la durée totale sont des préférences globales : ces
// tests les modifient (choisir une musique cale la vidéo dessus), et les specs
// suivants s'attendent au mode jours/seconde. On remet donc l'état initial.
test.afterEach(async ({ page }) => {
  await page.locator('#animationConfigTab').click();
  // Seulement en « Par durée » : saisir une durée depuis un autre mode y
  // basculerait, et le retour au rythme adopterait le rythme calculé.
  const duration = page.locator('#inputTotalDuration');
  if (await page.locator('#rhythmModeDuration').isChecked()) {
    await duration.fill('01:00');
    await duration.blur();
  }
  await page.locator('label:has(#rhythmModeRate)').click();
  await expect.poll(async () => page.evaluate(async () => {
    const { animation } = await (await fetch('/api/settings')).json();
    return [animation.rhythm_mode, animation.total_duration_seconds];
  })).toEqual(['rate', 60]);
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


test('une musique plus longue que la vidéo peut se terminer en fondu', async ({ page }) => {
  const box = page.locator('#audioFadeOutBox');
  const fade = page.locator('#cbAudioFadeOut');
  const status = page.locator('#musicSyncStatus');
  const fadePlan = () => page.evaluate(async () => (await import('/static/js/index.js')).audioFadeOutPlan());

  await page.locator('#inputAudioFile').setInputFiles(wavFile('longue.wav', 60, 0));

  // Choisir une musique cale la vidéo dessus : rien à couper, pas d'option.
  await expect(status).toContainText('Durée calée sur la musique');
  await expect(box).toBeHidden();

  // Retour au rythme en jours/seconde : la vidéo (quelques secondes pour les
  // 6 caches de la fixture) devient bien plus courte que la musique.
  await page.locator('#btnUnlinkAudio').click();
  await expect(box).toBeVisible();
  await expect(fade).not.toBeChecked();
  await expect(status).toContainText('elle sera coupée en fin de vidéo');
  expect(await fadePlan()).toBeNull();

  await fade.check();
  await expect(status).toContainText('elle se terminera en fondu');
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out).toBe(true);
  const plan = await fadePlan();
  expect(plan.seconds).toBe(3);
  expect(plan.endMs).toBeGreaterThan(0);
  expect(plan.endMs).toBeLessThan(60_000);

  // Remet la préférence globale dans son état initial pour les specs suivantes.
  await fade.uncheck();
  await expect(status).toContainText('elle sera coupée en fin de vidéo');
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out).toBe(false);
});


test('une musique plus courte que la vidéo peut être répétée en boucle', async ({ page }) => {
  const loopBox = page.locator('#audioLoopBox');
  const loop = page.locator('#cbAudioLoop');
  const fadeBox = page.locator('#audioFadeOutBox');
  const status = page.locator('#musicSyncStatus');
  const plans = () => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return { loop: app.audioLoopPlan(), fade: app.audioFadeOutPlan() };
  });

  // 2 s de son + 2 s de blanc ; vidéo imposée à 30 s, bien plus longue.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('courte.wav', 2, 2));
  await expect(status).toContainText('Durée calée sur la musique');
  await expect(loopBox).toBeHidden();
  await page.locator('#animationConfigTab').click();
  await page.locator('label:has(#rhythmModeDuration)').click();
  await page.locator('#inputTotalDuration').fill('00:30');
  await page.locator('#inputTotalDuration').blur();
  await page.locator('#musicConfigTab').click();

  await expect(loopBox).toBeVisible();
  await expect(loop).not.toBeChecked();
  // Musique trop courte et non répétée : rien à fondre en fin de vidéo.
  await expect(fadeBox).toBeHidden();
  await expect(status).toContainText('se termine avant la fin de la vidéo');
  expect((await plans()).loop).toBeNull();

  await loop.check();
  await expect(status).toContainText('elle sera répétée en boucle');
  await expect.poll(async () => (await recordingSettings(page)).audio_loop).toBe(true);
  // Boucle sur le fichier entier tant que le blanc de fin n'est pas ignoré.
  expect((await plans()).loop).toEqual({ endMs: null });
  // Une musique en boucle joue encore à la fin : le fondu redevient pertinent.
  await expect(fadeBox).toBeVisible();

  // Blanc de fin ignoré : la boucle reprend dès la fin du son (2 s + marge).
  await page.locator('#cbAudioTrimSilence').check();
  // À quelques millisecondes près : la piste est rééchantillonnée pour l'analyse.
  expect((await plans()).loop.endMs).toBeGreaterThan(2250);
  expect((await plans()).loop.endMs).toBeLessThan(2350);

  await page.locator('#cbAudioFadeOut').check();
  await expect(status).toContainText('Elle se terminera en fondu.');
  expect((await plans()).fade).toEqual({ seconds: 3, endMs: 30_000 });

  // Remet les préférences globales dans leur état initial.
  await page.locator('#cbAudioFadeOut').uncheck();
  await page.locator('#cbAudioTrimSilence').uncheck();
  await loop.uncheck();
  await expect(fadeBox).toBeHidden();
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_loop, r.audio_fade_out, r.audio_trim_silence];
  }).toEqual([false, false, false]);
});


test('le nom du fichier est affiché en texte, son infobulle suit la sélection', async ({ page }) => {
  const info = page.locator('#audioFileInfo');
  const tooltip = page.locator('.tooltip');
  const showTooltip = async () => {
    // L'infobulle est posée une fois la durée lue : attendre son instance.
    await expect.poll(() => info.getAttribute('data-bs-toggle')).toBe('tooltip');
    await page.mouse.move(0, 0);
    await info.hover();
  };

  // Un nom de fichier peut contenir du balisage (permis sous Linux) : il ne
  // doit jamais être interprété, ni dans la zone d'info ni dans l'infobulle.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('<b>gras</b>.wav', 2, 0));
  await expect(info.locator('strong')).toHaveText('<b>gras</b>.wav');
  await expect(info.locator('b')).toHaveCount(0);
  await showTooltip();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toContainText('<b>gras</b>.wav');
  await expect(tooltip.locator('b')).toHaveCount(0);

  // Un autre fichier remplace l'infobulle au lieu d'en empiler une seconde.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('second.wav', 2, 0));
  await expect(info).toContainText('second.wav');
  await showTooltip();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toContainText('second.wav');
  await expect(tooltip).not.toContainText('gras');

  // Musique retirée : plus aucune infobulle sur le message par défaut.
  await page.locator('#inputAudioFile').setInputFiles([]);
  await expect(info).toContainText('Aucune musique sélectionnée');
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await info.hover();
  await expect(tooltip).toHaveCount(0);
  expect(await info.getAttribute('data-bs-toggle')).toBeNull();
});


test('une musique sans blanc de fin ne propose pas l\'option', async ({ page }) => {
  await page.locator('#inputAudioFile').setInputFiles(wavFile('sans-blanc.wav', 4, 0));

  await expect(page.locator('#audioFileInfo')).toContainText('sans-blanc.wav');
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 4 s');
  await expect(page.locator('#audioTrailingSilence')).toBeHidden();
});
