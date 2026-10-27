// Animation des points de la page Mes poses (docs/mode-poses.md) : bloc du
// thème `points.poses_effects`, chaque effet optionnel.
//
// Copie de poses_effects.py (source de vérité des défauts, préréglages et
// bornes) ; tests/js/poses_effects.test.mjs compare les deux via
// tests/fixtures/poses/poses_effects.json.
//
// `level` résume les cases cochées : un préréglage quand elles correspondent
// exactement, « custom » sinon. Choisir un préréglage ne change que les cases
// (withPreset) : chaque effet garde ses réglages d'intensité.
//
// Module pur (aucun DOM) : testé par node --test.

export const POSES_EFFECT_LEVELS = Object.freeze(['sober', 'balanced', 'rich', 'custom']);
export const POPULARITY_SCALES = Object.freeze(['relative', 'fixed']);
export const ARCHIVED_STYLES = Object.freeze(['grey', 'ghost']);

export const POSES_EFFECT_RANGES = Object.freeze({
    max_scale: Object.freeze([1.2, 4]),
    half_life_days: Object.freeze([1, 365]),
    intensity: Object.freeze([10, 100]),
    after_days: Object.freeze([7, 3650]),
    strength: Object.freeze([10, 100]),
});

export const POSES_EFFECT_TOGGLES = Object.freeze([
    'popularity', 'activity', 'freshness', 'milestone_flash', 'disabled_pulse',
]);

export const POSES_EFFECT_PRESETS = Object.freeze({
    sober: Object.freeze({ popularity: false, activity: false, freshness: false, milestone_flash: false, disabled_pulse: false }),
    balanced: Object.freeze({ popularity: true, activity: false, freshness: true, milestone_flash: true, disabled_pulse: false }),
    rich: Object.freeze({ popularity: true, activity: true, freshness: true, milestone_flash: true, disabled_pulse: true }),
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function posesEffectsDefaults() {
    return {
        level: 'sober',
        popularity: { enabled: false, scale: 'relative', max_scale: 2 },
        activity: { enabled: false, color: '#ffb300', half_life_days: 14, intensity: 60 },
        freshness: { enabled: false, after_days: 365, strength: 70 },
        milestone_flash: false,
        disabled_pulse: false,
        archived_style: 'grey',
    };
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const color = (value, fallback) => (HEX_RE.test(value || '') ? value.toLowerCase() : fallback);
const section = (raw, key) => (raw && typeof raw[key] === 'object' && raw[key] !== null ? raw[key] : {});

function number(value, fallback, [low, high], integer) {
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const clamped = Math.min(high, Math.max(low, n));
    return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

export function posesEffectToggles(effects) {
    return {
        popularity: effects.popularity.enabled,
        activity: effects.activity.enabled,
        freshness: effects.freshness.enabled,
        milestone_flash: effects.milestone_flash,
        disabled_pulse: effects.disabled_pulse,
    };
}

export function posesEffectsLevel(effects) {
    const toggles = posesEffectToggles(effects);
    for (const [name, preset] of Object.entries(POSES_EFFECT_PRESETS)) {
        if (POSES_EFFECT_TOGGLES.every((key) => preset[key] === toggles[key])) return name;
    }
    return 'custom';
}

// Bloc normalisé : valeurs bornées, champs absents = valeur de `current`
// (défauts sinon) ; `level` recalculé d'après les cases.
export function normalizePosesEffects(raw, current = null) {
    const base = current && typeof current === 'object' ? normalizePosesEffects(current) : posesEffectsDefaults();
    const src = raw && typeof raw === 'object' ? raw : {};
    const pop = section(src, 'popularity');
    const act = section(src, 'activity');
    const fresh = section(src, 'freshness');
    const R = POSES_EFFECT_RANGES;
    const out = {
        level: 'custom',
        popularity: {
            enabled: bool(pop.enabled, base.popularity.enabled),
            scale: choice(pop.scale, POPULARITY_SCALES, base.popularity.scale),
            max_scale: number(pop.max_scale, base.popularity.max_scale, R.max_scale, false),
        },
        activity: {
            enabled: bool(act.enabled, base.activity.enabled),
            color: color(act.color, base.activity.color),
            half_life_days: number(act.half_life_days, base.activity.half_life_days, R.half_life_days, true),
            intensity: number(act.intensity, base.activity.intensity, R.intensity, true),
        },
        freshness: {
            enabled: bool(fresh.enabled, base.freshness.enabled),
            after_days: number(fresh.after_days, base.freshness.after_days, R.after_days, true),
            strength: number(fresh.strength, base.freshness.strength, R.strength, true),
        },
        milestone_flash: bool(src.milestone_flash, base.milestone_flash),
        disabled_pulse: bool(src.disabled_pulse, base.disabled_pulse),
        archived_style: choice(src.archived_style, ARCHIVED_STYLES, base.archived_style),
    };
    out.level = posesEffectsLevel(out);
    return out;
}

// Copie dont les cases sont celles du préréglage (réglages conservés).
// « custom » ou un nom inconnu : copie inchangée.
export function withPosesEffectsPreset(effects, level) {
    const out = normalizePosesEffects(effects);
    const preset = POSES_EFFECT_PRESETS[level];
    if (!preset) return out;
    out.popularity.enabled = preset.popularity;
    out.activity.enabled = preset.activity;
    out.freshness.enabled = preset.freshness;
    out.milestone_flash = preset.milestone_flash;
    out.disabled_pulse = preset.disabled_pulse;
    out.level = posesEffectsLevel(out);
    return out;
}

// Un effet demande-t-il un rendu à chaque image pendant l'animation (lueur
// qui s'éteint, pâleur qui gagne, croissance, pulsation) ?
export function posesEffectsAnimate(effects) {
    if (!effects) return false;
    return !!(effects.popularity?.enabled || effects.activity?.enabled
        || effects.freshness?.enabled || effects.disabled_pulse);
}
