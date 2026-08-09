# Translation Checks

- The language switch stores the selection in `localStorage` and the `gcmap_lang` cookie so Flask-Babel stays on the chosen locale across reloads.

## Translating JavaScript strings

- In JS, the only supported helper is `t()` — imported from `notifications.js`, so usually called as `pkg.t('…')`. It reads `window.TRANSLATIONS.messages`, the full gettext catalog served by `/js_translations.js`.
- There is **no** `window.gettext`: `window.gettext ? window.gettext(x) : x` always fell through to the raw French. Do not reintroduce that pattern.
- Interpolate with the `${var}` placeholder syntax inside a **plain quoted string**, never a template literal — the placeholder has to survive into the `msgid` so translators can move it:

```js
// correct: extractable, translatable
pkg.t('Profil "${name}" supprimé', { name: profileName });
// wrong: JS interpolates before extraction, the msgid never exists
`Profil "${profileName}" supprimé`
```

- Extraction reads `babel.cfg`, which maps `static/js/*.js` and `static/js/*.mjs` (single level, so `static/js/vendor/` stays out). Babel needs the `t` keyword passed explicitly, otherwise **no** JS string is picked up:

```bash
pybabel extract -F babel.cfg -k _ -k _l -k t -o messages.pot .
pybabel update -i messages.pot -d translations
pybabel compile -d translations
```

## Checking

- To detect missing strings after adding text, run:

```bash
python check_missing_translations.py
```

- The script compares `messages.pot` with each `translations/<lang>/LC_MESSAGES/messages.po` and exits with a non-zero status if entries are missing or empty.
- Update the `.po` files and recompile (`pybabel compile -d translations`) when the check reports gaps.
