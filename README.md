<div align="center">
  <img src="static/img/mygcflow-icon.png" alt="MyGCFlow" width="96">
  <h1>MyGCFlow</h1>
  <p>Turn your geocaching finds into an animated map — and record it as a video.</p>
  <p><a href="README.fr.md">🇫🇷 Version française</a></p>
</div>

---

MyGCFlow is a **desktop application for Windows**: it runs a local Flask server
and opens in your default browser. Nothing is uploaded anywhere — your GPX file,
your database and your videos stay on your machine.

Load the `My Finds` Pocket Query exported from geocaching.com, style the map the
way you like, then play your caches back day by day and export the result as a
video (with a music track if you want one).

## Features

- **GPX import** — `.gpx` or the `.zip` downloaded from geocaching.com, imported
  in the background with a progress bar.
- **Filters** — by cache type, date range, country/region.
- **Map styles** — OpenStreetMap, Toner (light/dark), Watercolor, or a vector
  basemap whose stroke, fill, background and line width you set yourself.
- **Point styles** — vector shapes (circle, triangle, size, fill and border) or
  icon sets (Geocaching, Smiley); colors can follow the official cache-type
  colors.
- **Flash effect** — animation played when each cache appears, including an
  impulse mode (halo + expanding wave, staggered geographically).
- **Travel trail** — optional line that follows the geocacher from one stop to
  the next and reaches the new caches just as they appear (grouping radius,
  curves, long-jump arcs, color, width, pattern, glow, head, fading trail).
- **Overlay** — title and info block (find count, current date), styled through
  text/box/shadow/position controls or raw CSS.
- **Animation** — start/end dates, duration per day or total target duration,
  end pause, animated point appearance, and an optional camera follow that
  tracks either each day's caches or the head of the route.
- **Audio** — add a music track, set its volume, or derive the animation length
  from the track's duration.
- **Video recording** — two pipelines: **MediaRecorder** (fast, in-browser
  `.webm`) or **frames + ffmpeg** (slower, lossless, server-side assembly), with
  FPS, bitrate, output resolution, slowdown and quality scale. You choose the
  file name and the destination folder; the latest videos stay listed in the
  app.
- **Themes** — the whole styling setup saved as a named theme, with
  duplicate / rename / reset / JSON import-export, plus bundled examples.
- **Evolution mode** — instead of your own finds, animate every cache of an
  area from CSV exports: each one appears on its placement date and disappears
  when it is archived.
- **Bilingual UI** — French and English, switchable at runtime.
- **Offline** — every third-party library is vendored locally; no CDN, no
  network access required beyond the map tiles.

## Install (end users)

Grab the latest build from the
[Releases page](https://github.com/TherionAcribus/MyGCFlow/releases):

- `MyGCFlow-Setup-<version>.exe` — installer;
- the portable zip — unpack it and run `MyGCFlow.exe`.

Both bundle Python, the dependencies and ffmpeg: there is nothing else to
install.

Once launched, MyGCFlow starts a server on `127.0.0.1:51730`, opens your browser
and sits in the notification area (*Open MyGCFlow*, *Videos folder*, *Logs*,
*Quit*). There is no window and no console: close the app from that tray icon
or with the **Quit** button in the app header. Launching MyGCFlow twice simply
reopens a tab.

Troubleshooting flags: `MyGCFlow.exe --no-browser`, `--no-tray` (stop with
Ctrl+C), `--port N`.

## Using it

1. **Data** — on geocaching.com, go to *Profile › Pocket Queries › My Finds*,
   click *Add to Queue*, and download the file when it arrives (it can be
   generated once every 3 days). Load it in the **Data** tab, then filter.
2. **Style** — pick a basemap, style the points, the flash and the route, add
   a title and an info block, and save it all in a theme.
3. **Animation & video** — set the period and the speed, optionally add music,
   hit **Preview** to check the result, then **Export** for the final take.
4. **Preferences** — language, update check, default startup theme, map
   framing.

The app also ships a full in-app guide at `/guide`.

## Where your files live

| Content | Installed app | Development |
| --- | --- | --- |
| Program and resources | `%LOCALAPPDATA%\Programs\MyGCFlow` (read-only) | project folder |
| SQLite database, GeoJSON caches | `%LOCALAPPDATA%\MyGCFlow\instance` | `instance/` |
| Captured frames, audio tracks | `%LOCALAPPDATA%\MyGCFlow\` | project folder |
| Rendered videos | `Videos\MyGCFlow` by default (changeable under *Animation & video › Video export*) | `video/` |
| Logs | `%LOCALAPPDATA%\MyGCFlow\logs\mygcflow.log` | `logs/` |
| Preferences and themes | `%APPDATA%\MyGCFlow` | `%APPDATA%\MyGCFlow` |

Uninstalling removes the program but **keeps** data and videos. `MYGCFLOW_DATA_DIR`
redirects all data, `MYGCFLOW_CONFIG_DIR` the preferences — that is what the
tests use.

## Development

Requirements: Python 3.12, and Node.js only for the end-to-end tests.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py      # dev server (Werkzeug, debugger)
```

`python app.py` is the **development** server; `launcher.py` is the packaged
entry point (waitress + tray icon).

### Layout

```
app.py              Flask app factory
launcher.py         packaged entry point (waitress, tray icon, single instance)
paths.py            every file location, resources vs. user data
config.py           Flask configuration
blueprints/         routes: core, filters, gpx, media, profiles, tasks
bdd.py              GPX parsing and database access
geojson_cache.py    GeoJSON generation and caching
capture.py          video pipelines (frames + ffmpeg, MediaRecorder post-processing)
settings_manager.py preferences and style profiles (JSON, under %APPDATA%)
task_manager.py     background task pool (import, GeoJSON)
static/js/          OpenLayers map, animation, recording, UI
templates/          Jinja templates, including the in-app guide
translations/       gettext catalogs (fr, en)
installer/          PyInstaller spec, Inno Setup script, build.ps1
docs/               internal documentation
```

Stack: Flask + Flask-Babel + SQLAlchemy (SQLite), OpenLayers (WebGL points),
Tabler/Bootstrap, HTMX, ffmpeg via `imageio-ffmpeg`.

### Tests

```powershell
# Python unit tests
.\.venv\Scripts\python.exe -m unittest discover -s tests -t .

# video pipelines (builds real files, checked with ffprobe)
.\.venv\Scripts\python.exe run_video_tests.py            # --quick to skip re-encoding

# browser end-to-end (Playwright)
npm install && npx playwright install chromium
npm run test:e2e
```

### Translations

French is the source language (`msgid`); English lives in the `msgstr`.

```bash
pybabel extract -F babel.cfg -k _ -k _l -k t -k _tr -o messages.pot .
pybabel update -i messages.pot -d translations
pybabel compile -d translations
python check_missing_translations.py
```

See [docs/translations.md](docs/translations.md) for the rules that apply to JS
strings.

### Building the Windows release

Requires Python 3.12 (or `uv`) and [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

Produces `dist\MyGCFlow\MyGCFlow.exe` (portable) and
`dist\MyGCFlow-Setup-<version>.exe`. `-SkipInstaller` stops after the
executable.

Publishing a version: bump `__version__` in `version.py`, commit, then
`git tag v1.2.0 && git push origin v1.2.0` — the
[release workflow](.github/workflows/release.yml) builds and publishes the
GitHub Release.

## Documentation

- [docs/distribution.md](docs/distribution.md) — packaging, file locations, updates
- [docs/preferences-et-profils.md](docs/preferences-et-profils.md) — global settings vs. profiles
- [docs/async-tasks.md](docs/async-tasks.md) — background tasks API
- [docs/mode-evolution.md](docs/mode-evolution.md) — Evolution mode (caches of an area appearing and disappearing, CSV imports)
- [docs/traits-de-deplacement.md](docs/traits-de-deplacement.md) — travel trail (route computation, timing, cost)
- [docs/translations.md](docs/translations.md) — i18n rules
- [docs/notes/README_TESTS_VIDEO.md](docs/notes/README_TESTS_VIDEO.md) — video test matrix

## Credits

MyGCFlow is heavily inspired by
[Geocaching-Animation](https://github.com/GarenKreiz/Geocaching-Animation) by
**GarenKreiz**, a Python script that produces videos animating geocaching
finds on a map — the idea of replaying your finds day by day comes from there.

MyGCFlow is not affiliated with Groundspeak / Geocaching.com.

## Contact

Questions, problems, suggestions: message me through my
[Geocaching profile](https://www.geocaching.com/p/?guid=b19d6e80-a3cd-49f5-8bad-35351a14681c),
write to <at_mop@hotmail.com>, or open an
[issue](https://github.com/TherionAcribus/MyGCFlow/issues).

## License

MyGCFlow is released under the [MIT License](LICENSE).

The bundled dependencies keep their own licenses, listed in
[installer/licenses/THIRD_PARTY_NOTICES.txt](installer/licenses/THIRD_PARTY_NOTICES.txt)
— notably the embedded ffmpeg build, which is GPL v3 and is run as a separate
program.
