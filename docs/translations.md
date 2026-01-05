# Translation Checks

- The language switch stores the selection in `localStorage` and the `gcmap_lang` cookie so Flask-Babel stays on the chosen locale across reloads.
- To detect missing strings after adding text, run:

```bash
python check_missing_translations.py
```

- The script compares `messages.pot` with each `translations/<lang>/LC_MESSAGES/messages.po` and exits with a non-zero status if entries are missing or empty.
- Update the `.po` files and recompile (`pybabel compile -d translations`) when the check reports gaps.
