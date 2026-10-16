import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissFirstUseModal } from './first-use.mjs';
import { wavFile } from './wav.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'my-finds.gpx');


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
  // La musique choisie est retenue (préférence globale) et rechargée au
  // démarrage : la retirer, sans quoi les specs suivantes l'auraient.
  await page.locator('#musicConfigTab').click();
  const remove = page.locator('#btnAudioFileRemove');
  if (await remove.isVisible()) await remove.click();
  await expect.poll(async () => (await recordingSettings(page)).audio_file).toBe('');
  // Les musiques récentes aussi sont retenues : repartir d'une liste vide.
  await page.request.put('/api/settings', { data: { recording: { audio_recent: [] } } });
  await expect.poll(async () => (await recordingSettings(page)).audio_recent).toEqual([]);

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

  // Choisir une musique cale la vidéo dessus : rien n'est coupé, mais le
  // fondu de sortie reste proposé, comme celui d'entrée — il finira avec elle.
  await expect(status).toContainText('Durée calée sur la musique');
  await expect(box).toBeVisible();

  // Retour au rythme en jours/seconde : la vidéo (quelques secondes pour les
  // 6 caches de la fixture) devient bien plus courte que la musique.
  await page.locator('#btnUnlinkAudio').click();
  await expect(box).toBeVisible();
  await expect(fade).not.toBeChecked();
  await expect(status).toContainText('elle sera coupée en fin de vidéo');
  expect(await fadePlan()).toBeNull();
  // La forme d'onde montre la partie de la musique que la vidéo ne joue pas.
  const waveform = page.locator('#musicWaveform');
  await expect(waveform).toBeVisible();
  await expect(waveform.locator('[data-legend="cut"]')).toBeVisible();
  await expect(waveform.locator('[data-legend="fade"]')).toBeHidden();
  await expect(page.locator('#musicWaveformSpan')).toHaveText('1 min');

  await fade.check();
  await expect(status).toContainText('elle se terminera en fondu');
  await expect(waveform.locator('[data-legend="fade"]')).toBeVisible();
  expect(Number(await waveform.locator('.mw-fade').getAttribute('width'))).toBeGreaterThan(0);
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out).toBe(true);
  const plan = await fadePlan();
  expect(plan.seconds).toBe(3);
  expect(plan.endMs).toBeGreaterThan(0);
  expect(plan.endMs).toBeLessThan(60_000);

  // Durée réglable, bornée à 30 s.
  const seconds = page.locator('#inputAudioFadeOutSeconds');
  await expect(seconds).toBeEnabled();
  await seconds.fill('1.5');
  await seconds.blur();
  await expect.poll(async () => (await fadePlan()).seconds).toBe(1.5);
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out_seconds).toBe(1.5);
  await seconds.fill('99');
  await seconds.blur();
  await expect(seconds).toHaveValue('30');
  await seconds.fill('3');
  await seconds.blur();
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out_seconds).toBe(3);

  // Remet la préférence globale dans son état initial pour les specs suivantes.
  await fade.uncheck();
  await expect(seconds).toBeDisabled();
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
  // Musique trop courte et non répétée : le fondu de sortie, proposé avec
  // toute musique, finirait avec elle, avant la fin de la vidéo.
  await expect(fadeBox).toBeVisible();
  await expect(status).toContainText('se termine avant la fin de la vidéo');
  expect((await plans()).loop).toBeNull();
  const waveform = page.locator('#musicWaveform');
  await expect(waveform.locator('[data-legend="silent"]')).toBeVisible();
  await expect(waveform.locator('.mw-loops line')).toHaveCount(0);

  await loop.check();
  await expect(status).toContainText('elle sera répétée en boucle');
  // 4 s de musique sur 30 s de vidéo : 7 reprises, plus de fin muette.
  await expect(waveform.locator('.mw-loops line')).toHaveCount(7);
  await expect(waveform.locator('[data-legend="loop"]')).toBeVisible();
  await expect(waveform.locator('[data-legend="silent"]')).toBeHidden();
  await expect.poll(async () => (await recordingSettings(page)).audio_loop).toBe(true);
  // Boucle sur le fichier entier tant que le blanc de fin n'est pas ignoré.
  // Sans fondu demandé, le raccord minimal de 10 ms (pas de clic à la
  // reprise), qui ne s'annonce pas.
  expect((await plans()).loop).toEqual({ startMs: 0, endMs: 4000, crossfadeMs: 10 });
  await expect(status).not.toContainText('enchaînent en fondu');

  // Reprises en fondu enchaîné : chaque reprise arrive 1 s plus tôt (une
  // toutes les 3 s au lieu de 4 : 9 reprises sur 30 s au lieu de 7).
  const crossfade = page.locator('#cbAudioLoopCrossfade');
  await expect(crossfade).toBeEnabled();
  await expect(page.locator('#inputAudioLoopCrossfadeSeconds')).toBeDisabled();
  await crossfade.check();
  await expect(page.locator('#inputAudioLoopCrossfadeSeconds')).toBeEnabled();
  expect((await plans()).loop).toEqual({ startMs: 0, endMs: 4000, crossfadeMs: 1000 });
  await expect(status).toContainText('Les reprises s\'enchaînent en fondu.');
  await expect(waveform.locator('.mw-loops line')).toHaveCount(9);
  // L'écoute joue la reprise construite avec son raccord : elle avance.
  const head = waveform.locator('.mw-playhead');
  await page.locator('#btnMusicListen').click();
  await expect.poll(async () => Number(await head.getAttribute('x1'))).toBeGreaterThan(5);
  await page.locator('#btnMusicListen').click();
  await expect(page.locator('#btnMusicListen')).toHaveAttribute('aria-pressed', 'false');
  await crossfade.uncheck();
  await expect.poll(async () => (await recordingSettings(page)).audio_loop_crossfade).toBe(false);
  await expect(waveform.locator('.mw-loops line')).toHaveCount(7);
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
  await expect(loop).not.toBeChecked();
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


test('la dernière musique est rechargée au démarrage, avec le calage sur elle', async ({ page }) => {
  const info = page.locator('#audioFileInfo');
  const include = page.locator('#cbRecordAudioEnable');
  const remove = page.locator('#btnAudioFileRemove');
  const rhythmMode = async () => (await (await page.request.get('/api/settings')).json()).animation.rhythm_mode;
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mygcflowReady === true);
    await dismissFirstUseModal(page);
    await page.locator('a[href="#animation"]').click();
    await page.locator('#musicConfigTab').click();
  };
  const uploads = [];
  page.on('request', (request) => { if (request.url().includes('/upload_audio')) uploads.push(request.url()); });

  await expect(remove).toBeHidden();
  // 6 s : au-dessus de la durée minimale de la vidéo (fin comprise).
  await page.locator('#inputAudioFile').setInputFiles(wavFile('reprise.wav', 6, 0));
  await expect(remove).toBeVisible();
  // Retenue une fois copiée sur le serveur, avec son nom d'origine.
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_file.replace(/[0-9a-f]{16}/, 'H'), r.audio_file_name];
  }).toEqual(['reprise-H.wav', 'reprise.wav']);
  await expect.poll(rhythmMode).toBe('music');

  // Au redémarrage : la musique revient, sans nouvel envoi, et la vidéo
  // est de nouveau calée dessus.
  await reopen();
  await expect(info).toContainText('reprise.wav');
  await expect(include).toBeChecked();
  await expect(remove).toBeVisible();
  await expect(page.locator('#musicSyncStatus')).toContainText('Durée calée sur la musique (6 s)');
  await expect(page.locator('#rhythmModeMusic')).toBeChecked();
  expect(uploads).toHaveLength(1);

  // « Inclure la musique » décochée : elle est rechargée sans être forcée.
  await include.uncheck();
  await expect.poll(async () => (await recordingSettings(page)).audio_enabled).toBe(false);
  await reopen();
  await expect(info).toContainText('reprise.wav');
  await expect(include).not.toBeChecked();
  await expect(page.locator('#musicTabDot')).toBeHidden();
  await include.check();
  await expect.poll(async () => (await recordingSettings(page)).audio_enabled).toBe(true);

  // Retirée : oubliée, y compris au démarrage suivant.
  await remove.click();
  await expect(info).toContainText('Aucune musique sélectionnée');
  await expect(remove).toBeHidden();
  await expect(include).toBeDisabled();
  await expect.poll(async () => (await recordingSettings(page)).audio_file).toBe('');
  await reopen();
  await expect(info).toContainText('Aucune musique sélectionnée');
  await expect(remove).toBeHidden();
});


test('la musique s\'écoute seule, telle que la vidéo l\'utilisera', async ({ page }) => {
  const row = page.locator('#musicListenRow');
  const listen = page.locator('#btnMusicListen');
  const listenEnd = page.locator('#btnMusicListenEnd');
  const head = page.locator('#musicWaveform .mw-playhead');
  const headX = async () => Number(await head.getAttribute('x1'));
  // Une ligne verticale a une boîte de largeur nulle : toBeVisible la dirait
  // toujours masquée. On lit donc son affichage.
  const headShown = () => head.evaluate((el) => el.style.display !== 'none');

  await expect(row).toBeHidden();
  // 20 s de musique démarrée à 5 s : vidéo calée sur les 15 s restantes.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('ecoute.wav', 20, 0));
  await expect(row).toBeVisible();
  await page.locator('#inputAudioStart').fill('5');
  await page.locator('#inputAudioStart').blur();
  await expect(page.locator('#musicSyncStatus')).toContainText('Durée calée sur la musique (15 s)');

  // Écoute complète : depuis le point de départ (5 s sur 20, x = 250).
  await listen.click();
  await expect(listen).toHaveAttribute('aria-pressed', 'true');
  await expect(listen).toContainText('Arrêter');
  await expect.poll(headShown).toBe(true);
  await expect.poll(headX).toBeGreaterThan(255);
  expect(await headX()).toBeLessThan(500);
  await listen.click();
  await expect(listen).toHaveAttribute('aria-pressed', 'false');
  await expect(listen).toContainText('Écouter');
  expect(await headShown()).toBe(false);

  // Écouter la fin : les 8 dernières secondes de la vidéo (de 12 à 20 s du
  // fichier, x ≥ 600), puis arrêt automatique avec la vidéo.
  await expect(listenEnd).toBeEnabled();
  await listenEnd.click();
  await expect(listenEnd).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(headX).toBeGreaterThanOrEqual(600);
  await expect(listenEnd).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
  expect(await headShown()).toBe(false);
});


test('l\'aperçu se met en pause quand l\'onglet passe en arrière-plan, et reprend au retour', async ({ page }) => {
  // Onglet masqué : le rendu (rAF) s'arrête, l'animation se fige ; la musique
  // continuait et se retrouvait en avance au retour.
  const pause = page.locator('#btnPauseAnimation');
  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  // Dernière position de la musique annoncée par la lecture (ms de vidéo).
  const lastPosition = () => page.evaluate(() => window.musicPositions.at(-1) ?? 0);

  await page.locator('#inputAudioFile').setInputFiles(wavFile('apercu.wav', 20, 0));
  await expect(page.locator('#musicSyncStatus')).toContainText('Durée calée sur la musique (20 s)');
  await page.evaluate(() => {
    window.musicPositions = [];
    document.addEventListener('mygcflow:music-playback', (event) => {
      if (event.detail.state === 'position') window.musicPositions.push(event.detail.elapsedMs);
    });
  });

  await page.locator('#btnQuickPreview').click();
  await expect(pause).toHaveClass(/\bpause\b/);
  await expect.poll(lastPosition).toBeGreaterThan(300);

  await setHidden(true);
  await expect(pause).toHaveClass(/\brestart\b/);
  // Contexte audio suspendu : la musique ne bouge plus.
  const frozen = await lastPosition();
  await page.waitForTimeout(500);
  expect(await lastPosition() - frozen).toBeLessThan(100);

  await setHidden(false);
  await expect(pause).toHaveClass(/\bpause\b/);
  await expect.poll(lastPosition).toBeGreaterThan(frozen + 200);

  // Pause demandée par l'utilisateur : revenir sur l'onglet ne la lève pas.
  await page.locator('#btnQuickPause').click();
  await expect(pause).toHaveClass(/\brestart\b/);
  await setHidden(true);
  await setHidden(false);
  await page.waitForTimeout(300);
  await expect(pause).toHaveClass(/\brestart\b/);

  await page.locator('#btnQuickStop').click();
  await expect(page.locator('#controlBar')).toHaveAttribute('data-playback-state', 'idle');
});


test('une musique illisible partout est signalée dès le choix, et tenue hors de la vidéo', async ({ page }) => {
  const listen = page.locator('#btnMusicListen');
  const include = page.locator('#cbRecordAudioEnable');

  // Ni le navigateur ni ffmpeg ne la lisent : l'inclure ferait échouer l'export.
  await page.locator('#inputAudioFile').setInputFiles({
    name: 'illisible.wma', mimeType: 'audio/x-ms-wma', buffer: Buffer.from('pas de la musique'),
  });
  await expect(page.locator('#audioFileInfo')).toContainText('illisible.wma');
  await expect(page.locator('.gcm-toast', { hasText: 'Cette musique est illisible' })).toBeVisible();
  await expect(include).not.toBeChecked();
  await expect(include).toBeDisabled();
  await expect.poll(async () => (await recordingSettings(page)).audio_enabled).toBe(false);

  // Auparavant : « Arrêter » affiché sur un silence, sans fin.
  await listen.click();
  await expect(page.locator('.gcm-toast', { hasText: 'ne peut pas être lue' })).toBeVisible();
  await expect(listen).toHaveAttribute('aria-pressed', 'false');
  await expect(listen).toContainText('Écouter');
});


test('un format que le navigateur ne décode pas s\'écoute par une version convertie', async ({ page }) => {
  // Vrai .wma, produit par le ffmpeg de l'application : aucun navigateur ne
  // le décode, ffmpeg si.
  const folder = mkdtempSync(path.join(tmpdir(), 'mygcflow-wma-'));
  const target = path.join(folder, 'morceau.wma');
  const made = spawnSync(process.env.MYGCFLOW_E2E_PYTHON, ['-c', [
    'import subprocess, sys, imageio_ffmpeg',
    'subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-t", "6",'
      + ' "-i", "sine=frequency=440:sample_rate=44100", "-c:a", "wmav2", sys.argv[1]], check=True)',
  ].join('\n'), target], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const listen = page.locator('#btnMusicListen');
  const head = page.locator('#musicWaveform .mw-playhead');

  await page.locator('#inputAudioFile').setInputFiles({
    name: 'morceau.wma', mimeType: 'audio/x-ms-wma', buffer: readFileSync(target),
  });
  rmSync(folder, { recursive: true, force: true });
  // Mesurée sur la version convertie : durée, forme d'onde, calage.
  await expect(page.locator('#musicSyncStatus')).toContainText('Durée calée sur la musique (6 s)');
  await expect(page.locator('#musicWaveform')).toBeVisible();
  await expect(page.locator('#cbRecordAudioEnable')).toBeChecked();
  await expect(page.locator('#cbRecordAudioEnable')).toBeEnabled();

  await listen.click();
  await expect.poll(async () => Number(await head.getAttribute('x1'))).toBeGreaterThan(50);
  await listen.click();
  await expect(listen).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.gcm-toast', { hasText: /illisible|ne peut pas être lue/ })).toHaveCount(0);
  // L'export garde l'original.
  await expect.poll(async () => (await recordingSettings(page)).audio_file).toMatch(/^morceau-[0-9a-f]{16}\.wma$/);
});


test('une musique récente se retire de la liste, avec sa copie', async ({ page }) => {
  const dropdown = page.locator('#recentMusicDropdown');
  const menu = page.locator('#recentMusicMenu');
  const recent = async () => (await recordingSettings(page)).audio_recent;
  const storedFiles = async () => (await (await page.request.get('/api/audio')).json()).files.map((f) => f.file);

  await page.locator('#inputAudioFile').setInputFiles(wavFile('a-retirer.wav', 3, 0));
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 3 s');
  await page.locator('#inputAudioFile').setInputFiles(wavFile('a-garder.wav', 4, 0));
  await expect.poll(async () => (await recent()).map((r) => r.name)).toEqual(['a-garder.wav', 'a-retirer.wav']);
  const removed = (await recent()).find((r) => r.name === 'a-retirer.wav').file;
  expect(await storedFiles()).toContain(removed);

  await page.locator('#btnRecentMusic').click();
  // Place occupée par les copies, sous la liste.
  await expect(menu.locator('#recentMusicStorage')).toContainText(/Copies des musiques : .* (Mo|Go)/);
  // La musique courante ne se retire pas d'ici.
  await expect(menu.locator('.recent-music-remove')).toHaveCount(1);
  await menu.getByRole('button', { name: 'Retirer « a-retirer.wav » des musiques récentes' }).click();

  await expect.poll(async () => (await recent()).map((r) => r.name)).toEqual(['a-garder.wav']);
  expect(await storedFiles()).not.toContain(removed);
  // Plus rien d'autre que la musique courante : le menu disparaît.
  await expect(dropdown).toBeHidden();
});


test('une musique récente se reprend en un clic, avec son point de départ', async ({ page }) => {
  const dropdown = page.locator('#recentMusicDropdown');
  const menu = page.locator('#recentMusicMenu');
  const start = page.locator('#inputAudioStart');
  const uploads = [];
  page.on('request', (request) => { if (request.url().includes('/upload_audio')) uploads.push(request.url()); });
  const recent = async () => (await recordingSettings(page)).audio_recent;

  await expect(dropdown).toBeHidden();
  // Première musique, démarrée à 3 s.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('premiere.wav', 10, 0));
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 10 s');
  await start.fill('3');
  await start.blur();
  await expect.poll(async () => (await recent()).map((r) => [r.name, r.start])).toEqual([['premiere.wav', 3]]);
  // Seule musique connue, et c'est la courante : rien d'autre à proposer.
  await expect(dropdown).toBeHidden();

  // Une seconde musique : la première devient « récente ».
  await page.locator('#inputAudioFile').setInputFiles(wavFile('seconde.wav', 8, 0));
  await expect(dropdown).toBeVisible();
  await expect.poll(async () => (await recent()).map((r) => r.name)).toEqual(['seconde.wav', 'premiere.wav']);
  await page.locator('#btnRecentMusic').click();
  await expect(menu.locator('.dropdown-item')).toHaveCount(2);
  await expect(menu.locator('.dropdown-item.active')).toContainText('seconde.wav');
  await expect(menu.locator('.dropdown-item').nth(1)).toContainText('à partir de 3 s');

  // Reprise : sans nouvel envoi, avec son point de départ.
  expect(uploads).toHaveLength(2);
  await menu.locator('.dropdown-item', { hasText: 'premiere.wav' }).click();
  await expect(page.locator('#audioFileInfo')).toContainText('premiere.wav');
  await expect(start).toHaveValue('3');
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 7 s (à partir de 3 s)');
  await expect.poll(async () => (await recordingSettings(page)).audio_file).toMatch(/^premiere-/);
  expect(uploads).toHaveLength(2);

  // Retenue d'une session à l'autre.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#musicConfigTab').click();
  await expect(page.locator('#audioFileInfo')).toContainText('premiere.wav');
  await expect(dropdown).toBeVisible();

  // Musique retirée du dossier audio/ entre-temps : elle quitte la liste.
  const gone = (await recent()).find((r) => r.name === 'seconde.wav');
  rmSync(path.join(process.env.MYGCFLOW_E2E_RUNTIME, 'audio', gone.file));
  await page.locator('#btnRecentMusic').click();
  await menu.locator('.dropdown-item', { hasText: 'seconde.wav' }).click();
  await expect(page.locator('.gcm-toast', { hasText: 'n\'est plus disponible' })).toBeVisible();
  await expect.poll(async () => (await recent()).map((r) => r.name)).toEqual(['premiere.wav']);
  await expect(page.locator('#audioFileInfo')).toContainText('premiere.wav');
  await expect(dropdown).toBeHidden();
});


// Dépose `files` ({ name, type, buffer }) sur la fenêtre, comme depuis
// l'explorateur de fichiers.
async function dropFiles(page, files) {
  const dataTransfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const { name, type, bytes } of list) dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
    return dt;
  }, files.map(({ name, type, buffer }) => ({ name, type, bytes: [...buffer] })));
  await page.dispatchEvent('body', 'dragenter', { dataTransfer });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}


test('une musique déposée sur la fenêtre rejoint le sous-onglet Musique', async ({ page }) => {
  const uploads = [];
  page.on('request', (request) => { if (request.url().includes('/upload')) uploads.push(request.url()); });
  // Depuis un autre onglet : le dépôt y ramène.
  await page.locator('a[href="#style"]').click();
  await expect(page.locator('#musicConfigPane')).toBeHidden();

  await dropFiles(page, [wavFile('deposee.wav', 3, 0)]);
  await expect(page.locator('#musicConfigPane')).toBeVisible();
  await expect(page.locator('#audioFileInfo')).toContainText('deposee.wav');
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 3 s');
  await expect(page.locator('#gpxDropOverlay')).not.toHaveClass(/is-visible/);
  // Copiée comme une musique, pas importée comme des trouvailles.
  await expect.poll(() => uploads.filter((u) => u.includes('/upload_audio')).length).toBe(1);
  expect(uploads.filter((u) => !u.includes('/upload_audio'))).toEqual([]);

  // Sans type MIME (fréquent sous Windows) : reconnue à son extension.
  const untyped = { ...wavFile('sans-type.wav', 2, 0), type: '' };
  await dropFiles(page, [untyped]);
  await expect(page.locator('#audioFileInfo')).toContainText('sans-type.wav');
});


test('le niveau sonore standard ajuste chaque morceau, à l\'identique partout, et s\'explique', async ({ page }) => {
  const normalize = page.locator('#cbAudioNormalize');
  const info = page.locator('#audioNormalizeInfo');
  const volumes = () => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return { output: app.audioOutputVolume(), playback: app.musicPlaybackPlan().volume };
  });

  // Actif par défaut.
  await expect(normalize).toBeChecked();
  // Sinusoïde d'amplitude 0,49 : environ −9 dBFS, plus fort que le niveau
  // standard (−16) d'environ 7 dB.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('fort.wav', 6, 0));
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 6 s');
  // Le niveau standard place le curseur, en part du volume du fichier.
  const slider = page.locator('#inputAudioVolume');
  const display = page.locator('#spanAudioVolumeDisplay');
  await expect(info).toBeVisible();
  await expect(info).toHaveText(/^Morceau enregistré fort : niveau standard à 4[3-7] % du fichier\.$/);
  await expect(display).toHaveText(/^4[3-7] %$/);
  const standard = await display.textContent();
  await expect(slider).toHaveAttribute('aria-valuetext', standard);
  // Le curseur et la case renvoient à l'explication.
  await expect(slider).toHaveAttribute('aria-describedby', 'audioNormalizeInfo');
  const normalized = await volumes();
  // Ce que montre le curseur est ce qui sort, à l'aperçu comme aux exports.
  expect(normalized.output).toBe(normalized.playback);
  expect(Math.round(normalized.output * 100)).toBe(parseInt(standard, 10));

  // Infobulle d'aide, au clavier comme à la souris.
  await page.locator('#cbAudioNormalize ~ .audio-help').focus();
  await expect(page.locator('.tooltip')).toContainText('niveau standard');

  // Curseur déplacé à la main (au milieu : 100 %) : la case se décoche.
  await slider.fill('500');
  await expect(normalize).not.toBeChecked();
  await expect(display).toHaveText('100 %');
  await expect(info).toBeHidden();
  expect(await volumes()).toEqual({ output: 1, playback: 1 });
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_normalize, r.audio_volume];
  }).toEqual([false, 1]);
  // Au-delà de 100 % : un morceau peut être relevé (curseur aux trois quarts).
  await slider.fill('750');
  await expect(display).toHaveText('250 %');
  expect((await volumes()).output).toBe(2.5);

  // Recochée : le curseur revient au niveau standard.
  await normalize.check();
  await expect(display).toHaveText(standard);

  // Remet les préférences globales dans leur état initial : sans musique,
  // le niveau standard n'a rien à placer et le volume reste à 100 %.
  await slider.fill('500');
  await page.locator('#btnAudioFileRemove').click();
  await normalize.check();
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_normalize, r.audio_volume];
  }).toEqual([true, 1]);
});


test('la musique peut commencer en fondu, une seule fois', async ({ page }) => {
  const box = page.locator('#audioFadeInBox');
  const fadeIn = page.locator('#cbAudioFadeIn');
  const seconds = page.locator('#inputAudioFadeInSeconds');
  const status = page.locator('#musicSyncStatus');
  const fadeInPlan = () => page.evaluate(async () => (await import('/static/js/index.js')).audioFadeInPlan());

  await expect(box).toBeHidden();
  await page.locator('#inputAudioFile').setInputFiles(wavFile('fondu.wav', 20, 0));
  // Toujours utile : proposé dès qu'il y a une musique, durée inactive tant
  // que la case n'est pas cochée.
  await expect(box).toBeVisible();
  await expect(fadeIn).not.toBeChecked();
  await expect(seconds).toBeDisabled();
  expect(await fadeInPlan()).toBeNull();

  await fadeIn.check();
  await expect(seconds).toBeEnabled();
  await expect(status).toContainText('Elle commencera en fondu.');
  await expect(page.locator('#musicWaveform [data-legend="fadeIn"]')).toBeVisible();
  expect(await fadeInPlan()).toEqual({ seconds: 2 });
  await seconds.fill('4');
  await seconds.blur();
  await expect.poll(fadeInPlan).toEqual({ seconds: 4 });
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_fade_in, r.audio_fade_in_seconds];
  }).toEqual([true, 4]);

  // Remet les préférences globales dans leur état initial.
  await seconds.fill('2');
  await seconds.blur();
  await fadeIn.uncheck();
  await expect(page.locator('#musicWaveform [data-legend="fadeIn"]')).toBeHidden();
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_fade_in, r.audio_fade_in_seconds];
  }).toEqual([false, 2]);
});


test('la musique peut démarrer plus loin, au clavier ou par la poignée de la forme d\'onde', async ({ page }) => {
  const start = page.locator('#inputAudioStart');
  const status = page.locator('#musicSyncStatus');
  const savedStart = async () => (await recordingSettings(page)).audio_start_seconds;
  const startMs = () => page.evaluate(async () => (await import('/static/js/index.js')).audioStartMs());

  await expect(page.locator('#audioStartRow')).toBeHidden();
  await page.locator('#inputAudioFile').setInputFiles(wavFile('intro.wav', 20, 0));
  await expect(status).toContainText('Durée calée sur la musique (20 s)');
  await expect(start).toHaveValue('0');

  // Intro de 8 s sautée : la vidéo se cale sur les 12 s restantes.
  await start.fill('8');
  await start.blur();
  await expect(status).toContainText('Musique : 12 s (à partir de 8 s)');
  await expect(status).toContainText('Durée calée sur la musique (12 s)');
  await expect(page.locator('#musicWaveform [data-legend="intro"]')).toBeVisible();
  expect(await startMs()).toBe(8000);
  await expect.poll(savedStart).toBe(8);

  // Au-delà de la musique : ramené pour en garder une seconde.
  await start.fill('60');
  await start.blur();
  await expect(start).toHaveValue('19');
  await expect.poll(savedStart).toBe(19);

  // La poignée de la forme d'onde, glissée au quart, y place le départ.
  const graph = page.locator('#musicWaveform .music-waveform-graph');
  const handle = page.locator('#musicStartHandle');
  const box = await graph.boundingBox();
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2, { steps: 8 });
  await expect(handle.locator('.mw-handle-time')).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => Number(await start.inputValue())).toBeGreaterThan(4);
  expect(Number(await start.inputValue())).toBeLessThan(6.5);
  await expect(handle.locator('.mw-handle-time')).toBeHidden();

  // Au clavier : un dixième de seconde par flèche, une seconde avec Maj.
  const dragged = Number(await start.inputValue());
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await start.inputValue())).toBeCloseTo(dragged + 0.1, 5);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => Number(await start.inputValue())).toBeCloseTo(dragged - 0.9, 5);
  await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round((dragged - 0.9) * 10) / 10));

  // Retenu avec la musique au démarrage suivant…
  const clicked = await start.inputValue();
  await expect.poll(savedStart).toBe(Number(clicked));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#musicConfigTab').click();
  await expect(page.locator('#audioFileInfo')).toContainText('intro.wav');
  await expect(start).toHaveValue(clicked);

  // … et remis à zéro pour une autre musique.
  await page.locator('#inputAudioFile').setInputFiles(wavFile('autre.wav', 6, 0));
  await expect(start).toHaveValue('0');
  await expect.poll(savedStart).toBe(0);
  await expect(page.locator('#musicWaveform [data-legend="intro"]')).toBeHidden();
});


test('un clic sur la forme d\'onde fait écouter à partir de là, sans toucher au départ', async ({ page }) => {
  const listen = page.locator('#btnMusicListen');
  const head = page.locator('#musicWaveform .mw-playhead');
  const savedStart = async () => (await recordingSettings(page)).audio_start_seconds;

  await page.locator('#inputAudioFile').setInputFiles(wavFile('clic.wav', 20, 0));
  await expect(page.locator('#musicSyncStatus')).toContainText('Durée calée sur la musique (20 s)');

  // Aux trois quarts (15 s sur 20) : l'écoute part de là.
  const graph = page.locator('#musicWaveform .music-waveform-graph');
  const box = await graph.boundingBox();
  await graph.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  await expect(listen).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => Number(await head.getAttribute('x1'))).toBeGreaterThanOrEqual(740);
  // Le point de départ, lui, n'a pas bougé.
  await expect(page.locator('#inputAudioStart')).toHaveValue('0');
  expect(await savedStart()).toBe(0);

  // « Écouter », devenu « Arrêter », arrête cette écoute.
  await listen.click();
  await expect(listen).toHaveAttribute('aria-pressed', 'false');
});


test('« Garder la fin du morceau » fait finir la musique avec la vidéo', async ({ page }) => {
  const box = page.locator('#audioKeepEndingBox');
  const keep = page.locator('#cbAudioKeepEnding');
  const start = page.locator('#inputAudioStart');
  const status = page.locator('#musicSyncStatus');
  const startMs = () => page.evaluate(async () => (await import('/static/js/index.js')).audioStartMs());
  const setVideoDuration = async (text) => {
    await page.locator('#animationConfigTab').click();
    if (!(await page.locator('#rhythmModeDuration').isChecked())) {
      await page.locator('label:has(#rhythmModeDuration)').click();
    }
    await page.locator('#inputTotalDuration').fill(text);
    await page.locator('#inputTotalDuration').blur();
    await page.locator('#musicConfigTab').click();
  };

  await page.locator('#inputAudioFile').setInputFiles(wavFile('fin.wav', 30, 0));
  await expect(status).toContainText('Durée calée sur la musique (30 s)');
  // Vidéo calée sur la musique : rien n'est coupé, rien à proposer.
  await expect(box).toBeHidden();

  // Vidéo de 10 s : la musique déborde, sa fin serait coupée.
  await setVideoDuration('00:10');
  await expect(box).toBeVisible();
  await expect(keep).not.toBeChecked();
  await expect(status).toContainText('elle sera coupée en fin de vidéo');

  await keep.check();
  await expect(status).toContainText('Elle commence plus loin pour finir avec la vidéo.');
  await expect(status).toContainText('(à partir de 20 s)');
  await expect.poll(startMs).toBe(20_000);
  // Départ calculé : affiché, ni saisissable ni déplaçable.
  await expect(start).toBeDisabled();
  await expect(start).toHaveValue('20');
  await expect(page.locator('#musicStartHandle')).toHaveAttribute('aria-disabled', 'true');
  // La musique finit avec la vidéo : un fondu de sortie y reste possible.
  await expect(page.locator('#audioFadeOutBox')).toBeVisible();
  // Le départ choisi (0) est conservé à côté de l'option.
  await expect.poll(async () => {
    const r = await recordingSettings(page);
    return [r.audio_keep_ending, r.audio_start_seconds];
  }).toEqual([true, 0]);

  // La vidéo s'allonge : le départ suit.
  await setVideoDuration('00:15');
  await expect.poll(startMs).toBe(15_000);

  // Décocher rend le départ choisi.
  await keep.uncheck();
  await expect(start).toBeEnabled();
  await expect(start).toHaveValue('0');
  await expect.poll(startMs).toBe(0);
  await expect.poll(async () => (await recordingSettings(page)).audio_keep_ending).toBe(false);
});


test('plusieurs morceaux s\'enchaînent en une seule musique, modifiable', async ({ page }) => {
  const status = page.locator('#musicSyncStatus');
  const list = page.locator('#musicPlaylistTracks');
  const tracks = list.locator('li');
  const crossfade = page.locator('#cbAudioPlaylistCrossfade');
  const seconds = page.locator('#inputAudioPlaylistCrossfadeSeconds');
  const settings = () => recordingSettings(page);

  await page.locator('#inputAudioFile').setInputFiles(wavFile('un.wav', 4, 0));
  await expect(status).toContainText('Durée calée sur la musique (4 s)');
  await expect(page.locator('#btnAudioAddTrack')).toBeVisible();
  await expect(list).toBeHidden();

  // Un second morceau : fondu par défaut, borné à 40 % du plus court (1,6 s).
  await page.locator('#inputAudioAddFile').setInputFiles(wavFile('deux.wav', 6, 0));
  await expect(tracks).toHaveCount(2);
  await expect(tracks.nth(0)).toContainText('un.wav');
  await expect(tracks.nth(1)).toContainText('deux.wav');
  await expect(tracks.nth(1)).toContainText('0:06');
  await expect(page.locator('#audioFileInfo')).toContainText('un.wav + deux.wav');
  await expect(crossfade).toBeChecked();
  // 4 + 6 − 1,6 s : la vidéo reste calée sur la musique.
  await expect(status).toContainText('Durée calée sur la musique (8 s)');
  await expect(page.locator('#musicWaveform')).toBeVisible();

  // Fondu d'une seconde, puis sans fondu : l'enchaînement est refait.
  await seconds.fill('1');
  await seconds.blur();
  await expect(status).toContainText('Durée calée sur la musique (9 s)');
  await crossfade.uncheck();
  await expect(status).toContainText('Durée calée sur la musique (10 s)');
  await expect(seconds).toBeDisabled();

  // Ordre inversé.
  await list.getByRole('button', { name: 'Monter « deux.wav »' }).click();
  await expect(tracks.nth(0)).toContainText('deux.wav');
  await expect(page.locator('#audioFileInfo')).toContainText('deux.wav + un.wav');
  await expect.poll(async () => {
    const r = await settings();
    return [r.audio_file.startsWith('enchainement-'), r.audio_playlist.map((t) => t.name)];
  }).toEqual([true, ['deux.wav', 'un.wav']]);
  // Les retouches ne s'empilent pas dans les musiques récentes : la dernière
  // version de l'enchaînement, et le premier morceau choisi seul.
  await expect.poll(async () => (await settings()).audio_recent.map((r) => r.name))
    .toEqual(['deux.wav + un.wav', 'un.wav']);
  expect((await settings()).audio_recent[0].playlist.map((t) => t.name)).toEqual(['deux.wav', 'un.wav']);

  // Retrouvé tel quel au démarrage suivant.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);
  await dismissFirstUseModal(page);
  await page.locator('a[href="#animation"]').click();
  await page.locator('#musicConfigTab').click();
  await expect(tracks).toHaveCount(2);
  await expect(tracks.nth(0)).toContainText('deux.wav');
  await expect(status).toContainText('Durée calée sur la musique (10 s)');

  // Un morceau retiré : il n'en reste qu'un, qui redevient une musique seule.
  await list.getByRole('button', { name: 'Retirer « un.wav » de l\'enchaînement' }).click();
  await expect(list).toBeHidden();
  await expect(page.locator('#audioFileInfo')).toContainText('deux.wav');
  await expect(status).toContainText('Durée calée sur la musique (6 s)');
  await expect.poll(async () => (await settings()).audio_playlist).toEqual([]);

  // Remet le fondu par défaut (préférence globale).
  await page.locator('#inputAudioAddFile').setInputFiles(wavFile('trois.wav', 3, 0));
  await expect(tracks).toHaveCount(2);
  await crossfade.check();
  await seconds.fill('3');
  await seconds.blur();
  await expect.poll(async () => {
    const r = await settings();
    return [r.audio_playlist_crossfade, r.audio_playlist_crossfade_seconds];
  }).toEqual([true, 3]);
});


test('la musique peut s\'arrêter plus tôt, au clavier ou par sa poignée, et finir en fondu', async ({ page }) => {
  const end = page.locator('#inputAudioEnd');
  const status = page.locator('#musicSyncStatus');
  const plans = () => page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return { end: app.audioEndMs(), fade: app.audioFadeOutPlan() };
  });
  const savedEnd = async () => (await recordingSettings(page)).audio_end_seconds;

  await page.locator('#inputAudioFile').setInputFiles(wavFile('arret.wav', 20, 0));
  await expect(status).toContainText('Durée calée sur la musique (20 s)');
  // Sans point de fin : la fin du morceau, affichée, sans coupe.
  await expect(end).toHaveValue('20');
  expect((await plans()).end).toBe(0);

  // Arrêt à 12 s : la vidéo, calée sur la musique, dure 12 s.
  await end.fill('12');
  await end.blur();
  await expect(status).toContainText('Musique : 12 s (jusqu\'à 12 s)');
  await expect(status).toContainText('Durée calée sur la musique (12 s)');
  await expect.poll(async () => (await plans()).end).toBe(12_000);
  await expect(page.locator('#musicWaveform [data-legend="cut"]')).toBeVisible();
  await expect.poll(savedEnd).toBe(12);

  // Fondu de sortie, même calé sur la musique : il finit avec elle.
  await page.locator('#cbAudioFadeOut').check();
  await expect.poll(async () => (await plans()).fade).toEqual({ seconds: 3, endMs: 12_000 });
  await expect(page.locator('#musicWaveform [data-legend="fade"]')).toBeVisible();

  // Poignée de fin au clavier : une seconde de plus avec Maj.
  const handle = page.locator('#musicEndHandle');
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(end).toHaveValue('13');
  await expect(handle).toHaveAttribute('aria-valuenow', '13');
  // Fin : retour au bout du morceau, plus de coupe.
  await page.keyboard.press('End');
  await expect.poll(async () => (await plans()).end).toBe(0);
  await expect(end).toHaveValue('20');
  await expect.poll(savedEnd).toBe(0);

  // Remet la préférence globale dans son état initial.
  await page.locator('#cbAudioFadeOut').uncheck();
  await expect.poll(async () => (await recordingSettings(page)).audio_fade_out).toBe(false);
});


test('une musique sans blanc de fin ne propose pas l\'option', async ({ page }) => {
  await page.locator('#inputAudioFile').setInputFiles(wavFile('sans-blanc.wav', 4, 0));

  await expect(page.locator('#audioFileInfo')).toContainText('sans-blanc.wav');
  await expect(page.locator('#musicSyncStatus')).toContainText('Musique : 4 s');
  await expect(page.locator('#audioTrailingSilence')).toBeHidden();
});
