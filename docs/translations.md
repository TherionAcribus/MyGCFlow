# Translation Checks

- The language switch stores the selection in `localStorage` and the `mygcflow_lang` cookie so Flask-Babel stays on the chosen locale across reloads.

## Translating JavaScript strings

- In JS, the only supported helper is `t()` — imported from `notifications.js`, so usually called as `pkg.t('…')`. It reads `window.TRANSLATIONS.messages`, the full gettext catalog served by `/js_translations.js`.
- French is the canonical source language for `msgid` values. English UI text belongs in the English `msgstr`, not directly in templates alongside French `msgid` values.
- `showToast()` translates its arguments at runtime, but Babel cannot extract arbitrary string arguments passed to it. Wrap every user-visible literal message and title in `t()` so it is added to the catalogs.
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
pybabel extract -F babel.cfg -k _ -k _l -k t -k _tr -o messages.pot .
pybabel update -i messages.pot -d translations
pybabel compile -d translations
```

## Adding a language

- Add the locale to `BABEL_SUPPORTED_LOCALES` in `config.py` and to the
  `#selectLanguage` options in `templates/menu_options.html` (the label goes
  through `_()` like any other string).
- Initialize its catalog from the template, translate the `msgstr`, compile:

```bash
pybabel init -i messages.pot -d translations -l <lang>
pybabel compile -d translations
```

- Also check the language-conditional spots outside gettext: `normalizeLanguage`
  and `homeUrls` (static/js/options.js), `bddInfoLocale` (static/js/bdd.js),
  `_LABELS` (launcher.py), `echartsLocale` (static/js/stats_page_state.js) with
  a `static/vendor/echarts/lang<XX>.js` file if a locale file exists.
- The packaged app keeps Babel's locale data only for the folders found in
  `translations/` (`KEPT_LOCALES` in installer/mygcflow.spec). A missing locale
  makes every page in that language fail (`UnknownLocaleError`) in the built
  executable only, never from source: start the build once in the new language
  before a release.
- `language` in settings.json is free-form — an unknown value simply falls back
  to French server-side.

## Checking

- To detect missing strings after adding text, run:

```bash
python check_missing_translations.py
```

- The script compares `messages.pot` with each `translations/<lang>/LC_MESSAGES/messages.po` and exits with a non-zero status if entries are missing or empty.
- Update the `.po` files and recompile (`pybabel compile -d translations`) when the check reports gaps.
