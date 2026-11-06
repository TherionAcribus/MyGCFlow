// Vignettes animées des styles de pseudos (static/js/names_thumbs.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nameLabelPose } from '../../static/js/name_labels.mjs';
import { NAME_PRESETS, posesNamesDefaults, withPosesNamesPreset } from '../../static/js/poses_names.mjs';
import { THUMB_PSEUDOS, thumbCandidates, thumbLayout, thumbWaveMs } from '../../static/js/names_thumbs.mjs';

const W = 80;
const H = 52;

test('une vague : un pseudo fictif, trois quand le style les sépare', () => {
    const rise = withPosesNamesPreset(posesNamesDefaults(), 'rise');
    const burst = withPosesNamesPreset(posesNamesDefaults(), 'burst');
    assert.equal(thumbCandidates(rise, 0).length, 1);
    const wave = thumbCandidates(burst, 0);
    assert.equal(wave.length, 3);
    assert.deepEqual(wave.map((c) => c.group), [0, 1, 2]);
    for (const c of [...wave, ...thumbCandidates(burst, 5)]) assert.ok(THUMB_PSEUDOS.includes(c.pseudo));
    // Les vagues changent de pseudo et de graine (directions au hasard).
    assert.notEqual(thumbCandidates(rise, 0)[0].pseudo, thumbCandidates(rise, 1)[0].pseudo);
    assert.notEqual(thumbCandidates(rise, 0)[0].seed, thumbCandidates(rise, 1)[0].seed);
    assert.equal(thumbWaveMs(burst), burst.duration_ms + 2 * burst.stagger_ms);
    assert.equal(thumbWaveMs(rise), rise.duration_ms);
});

test('cadrage : chaque style tient dans la vignette, texte lisible', () => {
    for (const name of Object.keys(NAME_PRESETS)) {
        const opts = withPosesNamesPreset(posesNamesDefaults(), name);
        const { k, anchor, textSize, opts: scaled } = thumbLayout(opts, { width: W, height: H });
        assert.ok(k > 0 && k <= 1, `${name} k=${k}`);
        assert.ok(textSize >= 9 && textSize <= 13, `${name} textSize=${textSize}`);
        // Le moteur dessine à ratio = k : le texte ressort à textSize.
        assert.ok(Math.abs(scaled.size * k - textSize) < 1e-9, name);
        for (let wave = 0; wave < 3; wave++) {
            for (const c of thumbCandidates(opts, wave)) {
                const label = { ...c, start: 0, duration: opts.duration_ms, timeScale: 1, killAt: null, killDur: 0, nudge: [0, 0] };
                for (let i = 0; i <= 40; i++) {
                    const pose = nameLabelPose(label, (opts.duration_ms * i) / 40.0001, opts);
                    if (pose.pending || pose.done || pose.alpha < 0.05) continue;
                    const x = anchor[0] + k * pose.dx;
                    const y = anchor[1] + k * pose.dy;
                    assert.ok(x >= 0 && x <= W, `${name} vague ${wave} x=${x.toFixed(1)}`);
                    assert.ok(y >= 0 && y <= H, `${name} vague ${wave} y=${y.toFixed(1)}`);
                }
            }
        }
    }
});

test('cadrage : sans trajet, pas de réduction ; contour et halo suivent le texte', () => {
    const bubbles = withPosesNamesPreset(posesNamesDefaults(), 'bubbles');
    assert.equal(thumbLayout(bubbles, { width: W, height: H }).k, 1);
    const swirl = withPosesNamesPreset(posesNamesDefaults(), 'swirl');
    const { k, textSize, opts } = thumbLayout(swirl, { width: W, height: H });
    const ratio = textSize / swirl.size;
    assert.ok(Math.abs(opts.glow * k - swirl.glow * ratio) < 1e-9);
    assert.ok(Math.abs(opts.outline_width * k - swirl.outline_width * ratio) < 1e-9);
    // Mesure fournie (canvas) : utilisée à la place de l'estimation.
    const calls = [];
    thumbLayout(swirl, { width: W, height: H, measure: (text, size) => { calls.push([text, size]); return 30; } });
    assert.ok(calls.length > 0 && calls.every(([, size]) => size === textSize));
});
