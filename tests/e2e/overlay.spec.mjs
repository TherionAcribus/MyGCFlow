import { expect, test } from '@playwright/test';


async function openReadyApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gcmapReady === true);

  // La base du runtime de test est vide tant qu'aucune autre spec n'a chargé de
  // GPX : la modale de première utilisation s'ouvre alors (de façon asynchrone)
  // et son backdrop intercepte les clics sur les onglets. Sans ce renvoi, ces
  // tests ne passaient que dans l'ordre où une spec antérieure avait peuplé la
  // base — cf. le même traitement dans profile-style-state.spec.mjs.
  const firstUse = page.locator('#modal_first_use');
  await firstUse.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await firstUse.isVisible()) {
    await firstUse.locator('[data-bs-dismiss="modal"]').click();
    await firstUse.waitFor({ state: 'hidden' });
  }

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
  await page.locator('#cbDisplayTitle').uncheck();
  await page.locator('#gcCssTargetInfos').click();
  await page.locator('#cbDisplayNumberofCaches').uncheck();
  await page.locator('#cbDisplayCurrentDate').uncheck();

  await expect(page.locator('#titleFrame')).toBeHidden();
  await expect(page.locator('#infosFrame')).toBeHidden();
  await expect(page.locator('#titleFrame')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#infosFrame')).toHaveAttribute('aria-hidden', 'true');

  await page.locator('a[href="#animation"]').click();
  await page.locator('#btnFullscreenMode').click();
  await expect(page.locator('main')).toHaveClass(/fullscreen-mode/);
  await expect(page.locator('#titleFrame')).toBeHidden();
  await expect(page.locator('#infosFrame')).toBeHidden();
});


test('le texte est littéral et le CSS importé ne peut pas forcer la visibilité', async ({ page }) => {
  await page.locator('a[href="#style"]').click();
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
