import { expect, test } from '@playwright/test';
import { dismissFirstUseModal } from './first-use.mjs';


async function openReadyApp(page) {
  // /#style : base vide, l'app forcerait sinon le retour sur l'onglet
  // Données à chaque résolution du statut, en plein milieu des clics.
  await page.goto('/#style', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mygcflowReady === true);

  // La base du runtime de test est vide tant qu'aucune autre spec n'a chargé de
  // GPX : la modale de première utilisation s'ouvre alors (de façon asynchrone)
  // et son backdrop intercepte les clics sur les onglets. Sans ce renvoi, ces
  // tests ne passaient que dans l'ordre où une spec antérieure avait peuplé la
  // base — cf. le même traitement dans profile-style-state.spec.mjs.
  await dismissFirstUseModal(page);

  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    await app.waitForOverlayCssDefaults?.();
  });
}


test.beforeEach(async ({ page }) => {
  await openReadyApp(page);
});


test('les options restent la source de vérité, y compris en plein écran', async ({ page }) => {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.locator('#cbDisplayTitle').uncheck();
  await page.locator('#gcCssTargetInfos').click();
  await page.locator('#cbDisplayNumberofCaches').uncheck();
  await page.locator('#cbDisplayCurrentDate').uncheck();

  await expect(page.locator('#titleFrame')).toBeHidden();
  await expect(page.locator('#infosFrame')).toBeHidden();
  await expect(page.locator('#titleFrame')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#infosFrame')).toHaveAttribute('aria-hidden', 'true');

  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(page.locator('#titleFrame')).toBeHidden();
  await expect(page.locator('#infosFrame')).toBeHidden();
});


test('le texte est littéral et le CSS importé ne peut pas forcer la visibilité', async ({ page }) => {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.locator('#inputTitle').fill('Titre utilisateur conservé');
  const storedTitle = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    return app.options.infos.title.text;
  });
  expect(storedTitle).toBe('Titre utilisateur conservé');

  const result = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = false;
    app.updateTitleFrame('<img src=x onerror="window.__overlayXss = true">Titre');
    const css = app.changeTitleCssValues(
      'display:block; color:#123456; background-image:url(https://example.invalid/a.png); padding:8px;',
    );
    return {
      css,
      text: document.querySelector('#titleFrame').textContent,
      images: document.querySelectorAll('#titleFrame img').length,
      display: getComputedStyle(document.querySelector('#titleFrame')).display,
      xss: window.__overlayXss === true,
    };
  });

  expect(result.text).toBe('<img src=x onerror="window.__overlayXss = true">Titre');
  expect(result.images).toBe(0);
  expect(result.xss).toBe(false);
  expect(result.display).toBe('none');
  expect(result.css).toContain('color: rgb(18, 52, 86)');
  expect(result.css).not.toContain('display');
  expect(result.css).not.toContain('url(');
});


test('le contenu exporté respecte séparément compteur et date', async ({ page }) => {
  const combinations = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.updateNbCaches(12);
    app.updateCurrentDate(new Date(2026, 6, 20));
    const snapshot = (caches, date) => {
      app.options.infos.numberOfCaches.display = caches;
      app.options.infos.currentDate.display = date;
      app.syncOverlayVisibility();
      return {
        text: app.getOverlayTextContent().infos,
        cacheHidden: document.querySelector('#spanNbCaches').hidden,
        separatorHidden: document.querySelector('#spanInfosSep').hidden,
        dateHidden: document.querySelector('#spanCurrentDate').hidden,
      };
    };
    return [snapshot(false, false), snapshot(true, false), snapshot(false, true), snapshot(true, true)];
  });

  expect(combinations).toEqual([
    { text: '', cacheHidden: true, separatorHidden: true, dateHidden: true },
    { text: '12', cacheHidden: false, separatorHidden: true, dateHidden: true },
    { text: '20/07/2026', cacheHidden: true, separatorHidden: true, dateHidden: false },
    // Séparateur point médian, identique au DOM (#spanInfosSep).
    { text: '12 · 20/07/2026', cacheHidden: false, separatorHidden: false, dateHidden: false },
  ]);
});


test('le modèle à balises pilote la ligne Infos du mode principal', async ({ page }) => {
  // Un champ rempli prend la main sur les cases ; la ligne affichée est celle
  // lue par le rendu vidéo (getOverlayTextContent) — même source de vérité.
  const result = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.numberOfCaches.display = true;
    app.options.infos.currentDate.display = true;
    app.metadata.numberOfCaches = 48;
    app.updateNbCaches(12);
    app.updateCurrentDate(new Date(2026, 6, 20));

    const spans = () => ({
      caches: document.querySelector('#spanNbCaches').hidden,
      sep: document.querySelector('#spanInfosSep').hidden,
      date: document.querySelector('#spanCurrentDate').hidden,
      template: document.querySelector('#spanInfosTemplate').hidden,
    });

    const before = { spans: spans(), infos: app.getOverlayTextContent().infos };

    app.setMainInfosTemplate('Caches : {trouvees}/{total} ({pct}) — {date}');
    const during = {
      text: document.querySelector('#spanInfosTemplate').textContent,
      spans: spans(),
      infos: app.getOverlayTextContent().infos,
    };

    app.updateNbCaches(24);
    const afterCount = document.querySelector('#spanInfosTemplate').textContent;

    // Champ vidé : les cases reprennent la main.
    app.setMainInfosTemplate('');
    const after = { spans: spans(), infos: app.getOverlayTextContent().infos };

    // Balise d'un autre mode : littérale, comme en Évolution.
    app.setMainInfosTemplate('{actives} {nom} caches');
    const literal = document.querySelector('#spanInfosTemplate').textContent;
    app.setMainInfosTemplate('');

    return { before, during, afterCount, after, literal };
  });

  expect(result.before.infos).toBe('12 · 20/07/2026');
  expect(result.before.spans.template).toBe(true);

  expect(result.during.text).toBe('Caches : 12/48 (25 %) — 20/07/2026');
  expect(result.during.spans).toEqual({ caches: true, sep: true, date: true, template: false });
  expect(result.during.infos).toBe('Caches : 12/48 (25 %) — 20/07/2026');

  // La ligne suit les valeurs affichées : compteur à 24 → 50 %.
  expect(result.afterCount).toBe('Caches : 24/48 (50 %) — 20/07/2026');

  expect(result.after.spans).toEqual({ caches: false, sep: false, date: false, template: true });
  expect(result.after.infos).toBe('24 · 20/07/2026');

  expect(result.literal).toBe('{actives} {nom} caches');
});


test('l’Overlay Infos réserve dès le départ la largeur du compteur final', async ({ page }) => {
  const boxes = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = false;
    app.options.infos.numberOfCaches.display = true;
    app.options.infos.currentDate.display = true;
    app.metadata.numberOfCaches = 123456;
    app.updateCurrentDate(new Date(2026, 6, 21));
    app.changeInfosCssValues([
      'padding: 8px',
      'font: 20px Arial',
      'color: #ff0000',
      'background: #ff0000',
      'border: 0',
      'box-shadow: none',
    ].join(';'));

    const renderBox = (count) => {
      app.updateNbCaches(count);
      const canvas = document.createElement('canvas');
      canvas.width = 420;
      canvas.height = 120;
      app.addOverlaysToCanvas(canvas.getContext('2d'), canvas.width, canvas.height, 1);
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let maxX = -1;
      let minY = canvas.height;
      let maxY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (!pixels[(y * canvas.width + x) * 4 + 3]) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      return { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
    };

    return { initial: renderBox(0), final: renderBox(123456) };
  });

  expect(boxes.initial.width).toBe(boxes.final.width);
  expect(boxes.initial.height).toBe(boxes.final.height);
  expect(boxes.initial.height).toBeLessThan(50);
  expect(boxes.initial.maxX).toBe(boxes.final.maxX);
  expect(boxes.initial.maxX).toBeLessThan(420);
});


test('la cartouche Infos ne bouge pas quand le compteur grandit', async ({ page }) => {
  // La boîte est ancrée à droite : sans largeur réservée, elle s'élargissait vers
  // la gauche à chaque chiffre gagné, et la date se décalait avec elle.
  const rects = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = false;
    app.options.infos.numberOfCaches.display = true;
    app.options.infos.currentDate.display = true;
    document.getElementById('infosFrame').style.cssText = '';
    app.metadata.numberOfCaches = 123456;
    app.syncOverlayVisibility();
    app.updateCurrentDate(new Date(2026, 6, 21));

    const measures = [];
    for (const count of [0, 7, 88, 999, 11111, 123456]) {
      app.updateNbCaches(count);
      const box = document.getElementById('infosFrame').getBoundingClientRect();
      const date = document.getElementById('spanCurrentDate').getBoundingClientRect();
      measures.push({
        count,
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
        dateLeft: Math.round(date.left),
      });
    }
    return measures;
  });

  for (const measure of rects) {
    expect(measure, `compteur à ${measure.count}`).toEqual({ ...rects[0], count: measure.count });
  }
});


test('l’assistant simple conserve les propriétés CSS avancées', async ({ page }) => {
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.changeTitleCssValues([
      'color: #ffffff',
      'font-size: 18px',
      'letter-spacing: 3px',
      'text-transform: uppercase',
      'background: linear-gradient(135deg, #112233 0%, #445566 100%)',
      'border-left: 4px dashed #abcdef',
    ].join(';'));
    window.gcCssAssistantSyncFromTextareas();
  });

  await page.locator('#gcCssFontSize').fill('24');
  await page.locator('#gcCssFontSize').dispatchEvent('input');
  const css = await page.locator('#inputTitleCss').inputValue();

  expect(css).toContain('font-size: 24px');
  expect(css).toContain('letter-spacing: 3px');
  expect(css).toContain('text-transform: uppercase');
  expect(css).toContain('linear-gradient');
  expect(css).toContain('border-left: 4px dashed rgb(171, 205, 239)');
});


test('le renderer Canvas restitue gradient, opacité et retour à la ligne', async ({ page }) => {
  const metrics = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame(
      'Un très long titre overlay doit revenir proprement à la ligne dans une vidéo étroite sans sortir du canvas',
    );
    app.changeTitleCssValues([
      'position: absolute',
      'top: 8px',
      'left: 8px',
      'right: auto',
      'padding: 10px',
      'font: bold 20px Arial',
      'color: #ffffff',
      'background: linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)',
      'opacity: 0.5',
      'letter-spacing: 1px',
      'border: 2px dashed #ffffff',
    ].join(';'));
    // Le cadre est masqué tant qu'aucune base n'est chargée, donc de taille
    // nulle ici. Le renderer se cale désormais sur la boîte CSS réelle (il
    // n'agrandit plus la boîte à partir du texte mesuré) : sans cet affichage,
    // il ne resterait que le texte, sans fond dégradé à mesurer.
    document.getElementById('titleFrame').style.display = 'block';

    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    let redDominant = 0;
    let blueDominant = 0;
    let maxAlpha = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const r = pixels[offset];
        const b = pixels[offset + 2];
        const a = pixels[offset + 3];
        if (!a) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        maxAlpha = Math.max(maxAlpha, a);
        if (r > b + 20) redDominant += 1;
        if (b > r + 20) blueDominant += 1;
      }
    }
    return { minX, maxX, minY, maxY, redDominant, blueDominant, maxAlpha };
  });

  expect(metrics.minX).toBeGreaterThanOrEqual(0);
  expect(metrics.maxX).toBeLessThan(420);
  expect(metrics.minY).toBeGreaterThanOrEqual(0);
  expect(metrics.maxY - metrics.minY).toBeGreaterThan(60);
  expect(metrics.redDominant).toBeGreaterThan(100);
  expect(metrics.blueDominant).toBeGreaterThan(100);
  expect(metrics.maxAlpha).toBeGreaterThanOrEqual(120);
  expect(metrics.maxAlpha).toBeLessThanOrEqual(140);
});


test('le texte Canvas suit la boîte de contenu CSS de la preview', async ({ page }) => {
  const samples = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    const containerRect = document.getElementById('mapWithFrames').getBoundingClientRect();
    const render = (textAlign) => {
      const text = 'AVATAR 2026';
      app.updateTitleFrame(text);
      app.changeTitleCssValues([
        'position:absolute', 'top:10px', 'left:10px', 'width:240px', 'height:80px',
        'padding:12px 20px', `text-align:${textAlign}`,
        'font:600 22px/1.25 Arial', 'letter-spacing:2px', 'color:rgb(0,0,0)',
        'background:rgb(255,0,0)', 'border:6px solid rgb(0,0,255)',
        'box-shadow:none', 'border-radius:0',
      ].join(';'));
      const frame = document.getElementById('titleFrame');
      frame.style.display = 'block';
      const range = document.createRange();
      range.selectNodeContents(frame);
      const textRect = range.getBoundingClientRect();
      const style = getComputedStyle(frame);
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const tm = probe.measureText(text);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(containerRect.width);
      canvas.height = Math.round(containerRect.height);
      const ctx = canvas.getContext('2d');
      app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          const r = pixels[offset];
          const g = pixels[offset + 1];
          const b = pixels[offset + 2];
          const a = pixels[offset + 3];
          if (a < 128 || r > 80 || g > 80 || b > 80) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      return {
        textAlign,
        expectedLeft: textRect.left - containerRect.left - tm.actualBoundingBoxLeft,
        expectedTop: textRect.top - containerRect.top
          + tm.fontBoundingBoxAscent - tm.actualBoundingBoxAscent,
        actual: { minX, minY, maxX, maxY },
      };
    };
    return ['left', 'center', 'right'].map(render);
  });
  for (const metrics of samples) {
    expect(metrics.actual.maxX, metrics.textAlign).toBeGreaterThan(metrics.actual.minX);
    expect(metrics.actual.maxY, metrics.textAlign).toBeGreaterThan(metrics.actual.minY);
    // 3 px : la position du premier pixel « assez sombre » dépend du lissage
    // des polices, qui diffère d'un système à l'autre — mesuré 1,0 à 1,2 px
    // sous Windows, 2 px sous Linux (CI). Reste bien en deçà du décalage que
    // ce test surveille (texte calé sur la bordure au lieu de la boîte de
    // contenu, soit des dizaines de pixels).
    expect(Math.abs(metrics.actual.minX - metrics.expectedLeft), metrics.textAlign).toBeLessThanOrEqual(3);
    expect(Math.abs(metrics.actual.minY - metrics.expectedTop), metrics.textAlign).toBeLessThanOrEqual(3);
  }
});


test('un overlay masqué dans la preview ne se dessine pas dans la vidéo', async ({ page }) => {
  // visibility n'est pas filtrée par l'assainissement (seuls display et url()
  // le sont) : un utilisateur peut donc masquer la boîte par CSS. Le rendu
  // vidéo doit suivre la preview — la boîte DOM est la source de vérité.
  const painted = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame('Titre masqué');
    app.changeTitleCssValues([
      'position:absolute', 'top:10px', 'left:10px', 'padding:8px',
      'font:20px Arial', 'color:rgb(0,0,0)', 'background:rgb(255,0,0)',
      'visibility:hidden',
    ].join(';'));
    // Contournement dbReady identique aux autres tests : la boîte resterait
    // sinon display:none et le test ne distinguerait plus les deux causes.
    document.getElementById('titleFrame').style.display = 'block';

    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]) count += 1;
    }
    return count;
  });
  expect(painted).toBe(0);
});


test('une hauteur de boîte modifiée hors des API invalide le cache', async ({ page }) => {
  // Les chemins officiels (updateTitleFrame, change*CssValues, resize fenêtre)
  // invalident le cache. Mais la boîte peut changer de taille sans eux — ici
  // une mutation directe du style, comme le ferait un wrap inattendu. Seul le
  // ResizeObserver garantit alors que la géométrie mesurée ne reste pas périmée.
  const result = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame('Titre');
    app.changeTitleCssValues('position:absolute; top:10px; left:10px; font:20px Arial;');
    document.getElementById('titleFrame').style.display = 'block';

    // Force la construction du cache à la géométrie initiale.
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 120;
    app.addOverlaysToCanvas(canvas.getContext('2d'), canvas.width, canvas.height, 1);
    const revBefore = app.getOverlayCacheRevision();

    // Mutation directe : n'appelle aucun chemin d'invalidation explicite.
    document.getElementById('titleFrame').style.fontSize = '60px';
    await new Promise(resolve => setTimeout(resolve, 100));
    return { revBefore, revAfter: app.getOverlayCacheRevision() };
  });
  expect(result.revAfter).toBeGreaterThan(result.revBefore);
});


test('les couleurs nommées remplissent les pastilles de l’assistant', async ({ page }) => {
  // normalizeColorToHex ne savait décoder que #hex et rgb() : une couleur
  // nommée (red, rebeccapurple) ou une fonction CSS (hsl) retombait en
  // « non géré ». Le style calculé les convertit désormais en rgb().
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.changeTitleCssValues('color: rebeccapurple; text-shadow: 1px 1px red;');
    window.gcCssAssistantSyncFromTextareas();
  });
  const values = await page.evaluate(() => ({
    text: document.getElementById('gcCssTextColor').value,
    shadowEnable: document.getElementById('gcCssTextShadowEnable').checked,
    shadow: document.getElementById('gcCssTextShadowColor').value,
  }));
  expect(values.text).toBe('#663399');
  expect(values.shadowEnable).toBe(true);
  expect(values.shadow).toBe('#ff0000');
});


test('le renderer Canvas applique text-shadow au texte', async ({ page }) => {
  // text-shadow n'est pas filtré par l'assainissement : la preview le montre,
  // la vidéo doit donc le dessiner. Ombre nette rouge décalée à droite d'un
  // texte noir sur fond transparent : seuls les pixels d'ombre sont rouges.
  const metrics = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame('X');
    app.changeTitleCssValues([
      'position:absolute', 'top:10px', 'left:10px', 'padding:8px',
      'font:bold 40px Arial', 'color:rgb(0,0,0)',
      'background-color:rgba(255,255,255,0)', 'border:none', 'box-shadow:none',
      'text-shadow:12px 0px 0px rgb(255,0,0)',
    ].join(';'));
    document.getElementById('titleFrame').style.display = 'block';

    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let redDominant = 0;
    let darkCount = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (!a) continue;
      if (r > 180 && g < 100 && b < 100) redDominant += 1;
      if (r < 80 && g < 80 && b < 80) darkCount += 1;
    }
    return { redDominant, darkCount };
  });
  expect(metrics.darkCount).toBeGreaterThan(0);
  expect(metrics.redDominant).toBeGreaterThan(50);
});


test('les ombres multiples sont dessinées et les inset ignorées', async ({ page }) => {
  // Le canvas ne gère qu'une ombre par tracé : une liste CSS est repeinte
  // ombre par ombre. `inset` ne peut pas être creusé en canvas 2D — elle est
  // ignorée plutôt que dessinée vers l'extérieur.
  const metrics = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame('X');
    app.changeTitleCssValues([
      'position:absolute', 'top:10px', 'left:10px', 'padding:8px',
      'font:bold 40px Arial', 'color:rgb(0,0,0)',
      'background-color:rgba(255,255,255,0)', 'border:none',
      // Deux ombres de texte opposées + une ombre de boîte « creusante ».
      'text-shadow: -16px 0px 0px rgb(255,0,0), 16px 0px 0px rgb(0,0,255)',
      'box-shadow: inset 0px 40px 0px rgb(0,255,0)',
    ].join(';'));
    document.getElementById('titleFrame').style.display = 'block';

    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const boxRect = document.getElementById('titleFrame').getBoundingClientRect();
    const containerRect = document.getElementById('mapWithFrames').getBoundingClientRect();
    const boxBottom = Math.ceil(boxRect.bottom - containerRect.top);

    let red = 0, blue = 0, below = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const o = (y * canvas.width + x) * 4;
        if (!pixels[o + 3]) continue;
        if (pixels[o] > 200 && pixels[o + 1] < 80 && pixels[o + 2] < 80) red += 1;
        if (pixels[o + 2] > 200 && pixels[o] < 80 && pixels[o + 1] < 80) blue += 1;
        // L'ombre inset verte ne doit rien déborder sous la boîte.
        if (y > boxBottom + 1) below += 1;
      }
    }
    return { red, blue, below };
  });
  expect(metrics.red).toBeGreaterThan(50);
  expect(metrics.blue).toBeGreaterThan(50);
  expect(metrics.below).toBe(0);
});


test('un grand compteur reste sur une seule ligne dans le rendu Canvas', async ({ page }) => {
  const metrics = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = false;
    app.options.infos.numberOfCaches.display = true;
    app.options.infos.currentDate.display = true;
    app.metadata.numberOfCaches = 123456789;
    app.updateNbCaches(123456789);
    app.updateCurrentDate(new Date(2026, 11, 31));
    app.changeInfosCssValues([
      'position:absolute', 'top:10px', 'right:10px', 'width:150px',
      'padding:6px 8px', 'white-space:nowrap',
      'font:500 20px/24px Arial', 'letter-spacing:1px', 'text-align:right',
      'color:rgb(0,0,0)', 'background:rgb(255,0,0)',
      'border:2px solid rgb(0,0,255)', 'box-shadow:none', 'border-radius:0',
    ].join(';'));
    const frame = document.getElementById('infosFrame');
    frame.style.display = 'grid';
    const containerRect = document.getElementById('mapWithFrames').getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(containerRect.width);
    canvas.height = Math.round(containerRect.height);
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minY = canvas.height;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const a = pixels[offset + 3];
        if (a < 128 || r > 80 || g > 80 || b > 80) continue;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return {
      whiteSpace: getComputedStyle(frame).whiteSpace,
      frameTop: frameRect.top - containerRect.top,
      frameBottom: frameRect.bottom - containerRect.top,
      minY,
      maxY,
    };
  });

  expect(metrics.whiteSpace).toBe('nowrap');
  expect(metrics.minY).toBeGreaterThanOrEqual(Math.floor(metrics.frameTop) - 1);
  expect(metrics.maxY).toBeLessThanOrEqual(Math.ceil(metrics.frameBottom) + 1);
});


test('les champs d’ombre acceptent la saisie en mode avancé', async ({ page }) => {
  // Régression : le parseur d'ombres attendait les longueurs en tête alors que
  // style.cssText sérialise la couleur en tête (rgb(...) Xpx Ypx Zpx). La
  // resync qui suit chaque frappe réécrivait X avec la valeur de Y — il était
  // impossible de remplir les champs.
  await page.locator('a[href="#style"]').click();
  await page.locator('a[href="#tabTitles"]').click();
  await page.locator('#gcCssTabShadow').click();

  // Mode Simple : « Activer » seul produit une ombre visible — les champs
  // masqués portent des défauts (0 / 2 / 4 px) au lieu de 0px 0px 0px.
  await page.locator('#gcCssTextShadowEnable').check();
  await expect(page.locator('#gcCssTextShadowX')).toHaveValue('0');
  await expect(page.locator('#gcCssTextShadowY')).toHaveValue('2');
  await expect(page.locator('#gcCssTextShadowBlur')).toHaveValue('4');
  let css = await page.locator('#inputTitleCss').inputValue();
  expect(css).toMatch(/text-shadow:[^;]*\d+px[^;]*\d+px/);

  // Mode Avancé : chaque frappe doit persister — avant la correction, le
  // champ retombait à la valeur de Y dès que le CSS était relu.
  await page.locator('#infosModeAdvanced').click();
  const textShadowX = page.locator('#gcCssTextShadowX');
  await expect(textShadowX).toBeVisible();
  await textShadowX.fill('7');
  await expect(textShadowX).toHaveValue('7');
  css = await page.locator('#inputTitleCss').inputValue();
  expect(css).toMatch(/text-shadow:[^;]*\b7px\b/);

  // box-shadow souffrait du même défaut (le regex exigeait couleur en queue) :
  // la valeur saisie doit elle aussi persister.
  await page.locator('#gcCssBoxShadowEnable').check();
  const boxShadowX = page.locator('#gcCssShadowX');
  await boxShadowX.fill('9');
  await expect(boxShadowX).toHaveValue('9');
  css = await page.locator('#inputTitleCss').inputValue();
  expect(css).toMatch(/box-shadow:[^;]*\b9px\b/);
});


test('overflow:hidden rogne le texte au bord du cartouche', async ({ page }) => {
  // La preview clippe le contenu à la padding-box quand overflow n'est pas
  // visible ; la vidéo doit faire pareil — sans clip, un texte nowrap trop
  // long était peint par-dessus padding et bordure, jusqu'au bord du canvas.
  const metrics = await page.evaluate(async () => {
    const app = await import('/static/js/index.js');
    app.options.infos.title.display = true;
    app.options.infos.numberOfCaches.display = false;
    app.options.infos.currentDate.display = false;
    app.updateTitleFrame('Titre très long qui déborde nettement du cartouche');
    app.changeTitleCssValues([
      'position:absolute', 'top:10px', 'left:10px',
      'width:120px', 'padding:4px', 'white-space:nowrap', 'overflow:hidden',
      'font:20px Arial', 'color:rgb(0,0,0)',
      'background-color:rgba(255,255,255,0)', 'border:none', 'box-shadow:none',
    ].join(';'));
    document.getElementById('titleFrame').style.display = 'block';

    const boxRect = document.getElementById('titleFrame').getBoundingClientRect();
    const containerRect = document.getElementById('mapWithFrames').getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(containerRect.width);
    canvas.height = Math.round(containerRect.height);
    const ctx = canvas.getContext('2d');
    app.addOverlaysToCanvas(ctx, canvas.width, canvas.height, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const boxRight = Math.ceil(boxRect.right - containerRect.left);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const o = (y * canvas.width + x) * 4;
        if (pixels[o + 3] < 128 || pixels[o] > 80 || pixels[o + 1] > 80 || pixels[o + 2] > 80) continue;
        if (x > boxRight + 1) outside += 1;
        else inside += 1;
      }
    }
    return { inside, outside };
  });
  expect(metrics.inside).toBeGreaterThan(0);
  expect(metrics.outside).toBe(0);
});
