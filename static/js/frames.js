// GESTION DES FRAMES d'INFORMATIONS ET DE TITRE
import * as pkg from './index.js';
import { reservedInfosText } from './infos_reserve.mjs';
import { MAIN_INFO_TAGS, renderInfosTemplate, reservedInfosTemplateText } from './infos_template.mjs';
import { isLifecyclePage, isMainPage } from './app_mode.mjs';
import { lifecycleEngine } from './lifecycle_engine.mjs';
import { ownerPointOptions } from './owner_model.mjs';

// Modèle de la ligne d'infos du mode principal : texte libre avec balises
// {date}, {trouvees}, {total}, {pct} (infos_template de settings.json).
// Une chaîne vide — la valeur par défaut — laisse les cases à cocher piloter
// la ligne, comme avant l'introduction du modèle. Même normalisation que le
// modèle Évolution (une seule ligne, 200 caractères).
let mainInfosTemplate = normalizeMainInfosTemplate(window.userSettings?.infos_template);

function normalizeMainInfosTemplate(value) {
    return String(value ?? '').replace(/\r\n|[\r\n]/g, ' ').slice(0, 200);
}

export function mainInfosTemplateText() {
    return mainInfosTemplate;
}

// Modèle rempli → il prend la main sur les cases nombre de caches / date.
// Garde TDZ comme safeEvolutionTemplate ci-dessus : initUIElements peut
// appeler syncOverlayVisibility pendant l'évaluation des modules, avant que
// mainInfosTemplate soit initialisé — un modèle alors « inactif » est le bon
// repli (les cases pilotent la ligne).
function mainTemplateActive() {
    try {
        return isMainPage() && mainInfosTemplate.trim() !== '';
    } catch (_) {
        return false;
    }
}

// Champ « Ligne d'informations » de l'onglet Infos (ui.js). Le contenu, la
// réserve de largeur et la visibilité suivent immédiatement.
export function setMainInfosTemplate(value) {
    const next = normalizeMainInfosTemplate(value);
    if (next === mainInfosTemplate) return;
    mainInfosTemplate = next;
    updateInfosReserve();
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
    syncOverlayVisibility();
    refreshMainInfosLine();
}

// Compose la ligne depuis les valeurs affichées — mêmes sources que les spans
// classiques, lus dans le DOM (date et compteur y sont tenus à jour par
// l'animation comme au repos).
export function refreshMainInfosLine() {
    if (!mainTemplateActive()) return;
    const span = document.getElementById('spanInfosTemplate');
    if (!span) return;
    const foundText = document.getElementById('spanNbCaches')?.textContent ?? '';
    const total = Math.max(0, Number(pkg.metadata?.numberOfCaches) || 0);
    const found = Math.max(0, Number.parseInt(foundText, 10) || 0);
    const text = renderInfosTemplate(mainInfosTemplate, {
        date: document.getElementById('spanCurrentDate')?.textContent ?? '',
        trouvees: foundText,
        total: String(total),
        pct: `${total > 0 ? Math.round(found * 100 / total) : 0} %`,
    }, MAIN_INFO_TAGS);
    if (span.textContent !== text) span.textContent = text;
}

export function displayFrames(){
    const optionsTitre = pkg.options.infos?.title;
    updateTitleFrame(optionsTitre?.text);
    syncOverlayVisibility();
}

// Lecture du modèle des pages « cycle de vie » (Évolution, Mes poses) avec
// garde TDZ : syncOverlayVisibility peut tourner pendant l'évaluation des
// modules (initUIElements), avant que le module de la page ait enregistré son
// moteur et initialisé ses exports — cf. hasAnimationData (ui.js).
function safeLifecycleTemplate() {
    try { return lifecycleEngine()?.infosTemplate?.() ?? ''; } catch (_) { return ''; }
}

// Source de vérité unique pour la visibilité des overlays. Le CSS utilisateur
// ne doit jamais pouvoir contredire les cases à cocher / options du profil.
export function syncOverlayVisibility(){
    const opts = pkg.options?.infos;
    if (!opts) return;

    // Sans base chargée, aucun overlay : un titre/compteur seul sur une carte
    // vide ne donne aucune information utile et chevauche l'état vide.
    const dbReady = pkg.hasDatabase?.() ?? true;
    const titleFrame = document.getElementById("titleFrame");
    const infosFrame = document.getElementById("infosFrame");
    const showTitle = dbReady && opts.title?.display === true;
    // Pages « cycle de vie » : la ligne d'infos est un modèle libre — un modèle
    // vide masque la cartouche quelles que soient les cases du profil (elles
    // ne sont pas proposées sur ces pages). Mode principal : un modèle rempli
    // prend la main sur les cases ; vide, ce sont les cases qui décident.
    const showInfos = dbReady && (isLifecyclePage()
        ? safeLifecycleTemplate().trim() !== ''
        : (mainTemplateActive() || opts.numberOfCaches?.display === true || opts.currentDate?.display === true));

    if (titleFrame) {
        titleFrame.style.display = showTitle ? "block" : "none";
        titleFrame.setAttribute('aria-hidden', showTitle ? 'false' : 'true');
    }
    if (infosFrame) {
        // grid (et non block) : la boîte superpose la ligne visible et le doublon
        // de réserve, qui lui donne sa largeur (cf. updateInfosReserve).
        infosFrame.style.display = showInfos ? "grid" : "none";
        infosFrame.setAttribute('aria-hidden', showInfos ? 'false' : 'true');
    }
    updateInfosSpansVisibility();
    syncMapLegend();
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
    // Mêmes conditions pour les panneaux de stats (base absente…), et la
    // police héritée de #infosFrame a pu changer avec son style.
    try { pkg.syncStatsPanelsVisibility?.(); } catch(_) {}
    // Les images suivent la même règle (base chargée) et contournent les
    // cartouches, dont la taille a pu changer.
    try { pkg.syncImagePanelsVisibility?.(); } catch(_) {}
}

// Légende optionnelle (options.infos.legend.display, case « Afficher la
// légende » de l'onglet Informations) : une ligne par famille hors
// trouvailles affichée — DNF, caches posées — rien si aucune n'est visible
// ou sans base chargée. Repeinte dans la vidéo par overlay_canvas.js via
// les mêmes éléments DOM ; un changement d'affichage DNF/posées y passe
// aussi (applyChange de dnf_data.js / owner_data.js).
export function syncMapLegend() {
    const legend = document.getElementById('mapLegend');
    if (!legend) return;
    const offered = (pkg.hasDatabase?.() ?? true) && isMainPage()
        && pkg.options?.infos?.legend?.display === true;
    const rows = {
        legendDnfRow: offered && pkg.isDnfDisplayEnabled?.() === true,
        legendOwnerRow: offered && pkg.isOwnerDisplayEnabled?.() === true,
    };
    for (const [id, show] of Object.entries(rows)) {
        const row = document.getElementById(id);
        if (!row) continue;
        row.hidden = !show;
        // Le `hidden` doit aussi porter sur les éléments enfants : le cache
        // vidéo (overlay_canvas.js) lit leur display calculé — celui d'un
        // enfant de ligne masquée reste « inline » et il serait peint en
        // haut à gauche du canvas.
        for (const child of row.querySelectorAll('[id]')) child.hidden = !show;
    }
    // La pastille « cache posée » reprend la couleur de contour du thème.
    const sym = document.getElementById('legendOwnerSym');
    if (sym) sym.style.color = ownerPointOptions(pkg.options?.point?.owner).borderColor;
    const visible = rows.legendDnfRow || rows.legendOwnerRow;
    legend.style.display = visible ? 'block' : 'none';
    legend.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

// Affiche/masque nombre de caches, date et le séparateur "-" selon les options.
// Le "-" n'est visible que si les deux infos sont affichées.
// En mode Évolution, la ligne vient du modèle à balises (#spanInfosTemplate) ;
// les trois spans classiques restent alimentés en arrière-plan (la date sert
// de source à la balise {date}) mais jamais affichés.
export function updateInfosSpansVisibility(){
    const opts = pkg.options.infos;
    const spanCaches = document.getElementById("spanNbCaches");
    const spanDate = document.getElementById("spanCurrentDate");
    const spanSep = document.getElementById("spanInfosSep");
    const spanTemplate = document.getElementById("spanInfosTemplate");
    if (isLifecyclePage()) {
        for (const span of [spanCaches, spanSep, spanDate]) {
            if (span) {
                span.hidden = true;
                span.style.display = "none";
            }
        }
        if (spanTemplate) {
            const showTemplate = safeLifecycleTemplate().trim() !== '';
            spanTemplate.hidden = !showTemplate;
            spanTemplate.style.display = showTemplate ? "inline" : "none";
        }
        updateInfosReserve();
        return;
    }
    // options.infos reste {} jusqu'à l'application du premier profil (initUIElements
    // appelle déjà syncOverlayVisibility) : mêmes ?. que syncOverlayVisibility.
    // Un modèle rempli masque les spans classiques comme en mode Évolution ;
    // ils restent alimentés en arrière-plan (leurs valeurs sont celles des
    // balises {date} et {trouvees}).
    const templateOn = mainTemplateActive();
    const showCaches = !templateOn && opts.numberOfCaches?.display === true;
    const showDate = !templateOn && opts.currentDate?.display === true;
    if (spanCaches) {
        spanCaches.hidden = !showCaches;
        spanCaches.style.display = showCaches ? "inline" : "none";
    }
    if (spanDate) {
        spanDate.hidden = !showDate;
        spanDate.style.display = showDate ? "inline" : "none";
    }
    if (spanSep) {
        const showSeparator = showCaches && showDate;
        spanSep.hidden = !showSeparator;
        spanSep.style.display = showSeparator ? "inline" : "none";
    }
    if (spanTemplate) {
        spanTemplate.hidden = !templateOn;
        spanTemplate.style.display = templateOn ? "inline" : "none";
    }
    refreshMainInfosLine();
    updateInfosReserve();
}

// Fige la largeur de la cartouche d'infos sur le plus grand contenu à venir.
// Sans cela, la boîte — ancrée à droite — s'élargit vers la gauche dès que le
// compteur gagne un chiffre, et son bord bouge pendant toute l'animation.
// Le doublon est invisible mais occupe la même case de grille que la ligne
// affichée : c'est lui qui impose la largeur (cf. static/css/infos.css).
export function updateInfosReserve(){
    const reserve = document.getElementById("spanInfosReserve");
    if (!reserve) return;
    const opts = pkg.options?.infos;
    // Garde TDZ : updateInfosReserve peut tourner pendant l'évaluation des
    // modules (initUIElements → syncOverlayVisibility), avant que bdd.js et
    // infos_reserve.mjs aient initialisé leurs exports let/const — même garde
    // que hasAnimationData dans ui.js. La réserve est une optimisation de
    // largeur : elle sera recalculée au premier affichage réel.
    let text;
    try {
        const meta = pkg.metadata;
        // Pages « cycle de vie » : réserve par balise du modèle — chaque
        // compteur prend sa valeur maximale (meta.tagMaxes : pic d'actives,
        // totaux des cumuls…), la date la plus large.
        const engine = isLifecyclePage() ? lifecycleEngine() : null;
        text = engine
            ? reservedInfosTemplateText(engine.infosTemplate?.(), {
                ...(meta?.tagMaxes || {}),
                total: meta?.numberOfCaches,
            }, engine.infosTags)
            : mainTemplateActive()
            ? reservedInfosTemplateText(mainInfosTemplate, {
                // Le compteur ne dépasse jamais le total de la sélection ;
                // {pct} plafonne à « 100 % ».
                trouvees: meta?.numberOfCaches,
                total: meta?.numberOfCaches,
                pct: '100 %',
            }, MAIN_INFO_TAGS)
            : reservedInfosText({
                showCount: opts?.numberOfCaches?.display === true,
                showDate: opts?.currentDate?.display === true,
                currentValue: document.getElementById("spanNbCaches")?.textContent,
                // Le compteur ne dépasse jamais le total de la sélection.
                finalValue: meta?.numberOfCaches,
            });
    } catch (e) {
        return;
    }
    if (reserve.textContent === text) return;
    reserve.textContent = text;
    // La largeur de la boîte vient de changer : la géométrie mise en cache pour
    // le rendu vidéo n'est plus valable.
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}


// -------------------- INFOS -------------------

// Affiche le nombre de caches + date après Filtre ou 1er Chargement
export function updateInfosFrameAfterReadBdd(metadata){
    updateNbCaches(metadata.numberOfCaches);
    updateCurrentDate(metadata.endDate);
}

// creation Frame Infos. Peut importe qui envoie la demande de création, on l'affiche si pas affiché
export function createInfosFrame(){
    syncOverlayVisibility();
}

// destruction Frame Infos. La demande est gérée par l'ui si toutes les checkbox sont desactivees
export function destroyInfosFrame(){
    const infosFrame = document.getElementById("infosFrame");
    if (infosFrame) infosFrame.style.display = "none";
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// mise à jour du nombre de caches
export function updateNbCaches(nbCaches){
    const spanNbCaches = document.getElementById("spanNbCaches");
    if (spanNbCaches) spanNbCaches.textContent = nbCaches ?? 0;
    refreshMainInfosLine();
    updateInfosReserve();
}

// mise à jour de la date
export function updateCurrentDate(currentDate){
    currentDate = formatDate(currentDate);
    const spanCurrentDate = document.getElementById("spanCurrentDate");
    if (spanCurrentDate) spanCurrentDate.textContent = currentDate;
    refreshMainInfosLine();
    updateInfosReserve();
}

// formatage date selon la préférence de format (jj/mm/aaaa ou mm/jj/aaaa)
function formatDate(date) {
    if (!date) return '--/--/----';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '--/--/----';
    return pkg.formatDateDisplay(d) || '--/--/----';
}

// Changement css via formulaire
export function changeInfosCssValues(userCss){
    const infosFrame = document.getElementById("infosFrame"); 
    if (!infosFrame) return;
    const cleaned = sanitizeOverlayCss(userCss);
    // Appliquer le CSS
    infosFrame.style.cssText = cleaned;
    syncCssTextarea('inputInfosCss', cleaned);
    syncOverlayVisibility();
    return cleaned;
}


// -------------------- TITRE -------------------

// creation Titre
export function createTitleFrame(){
    syncOverlayVisibility();
}

// destruction Titre
export function destroyTitleFrame(){
    const titleFrame = document.getElementById("titleFrame"); 
    if (titleFrame) titleFrame.style.display = "none";
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// mise à jour du titre
export function updateTitleFrame(title){
    const titleFrame = document.getElementById("titleFrame"); 
    if (titleFrame) titleFrame.textContent = title == null ? '' : String(title).slice(0, 500);
    try { pkg.invalidateOverlayCache?.(); } catch(_) {}
}

// Changement css via formulaire
export function changeTitleCssValues(userCss){
    const titleFrame = document.getElementById("titleFrame"); 
    if (!titleFrame) return;
    const cleaned = sanitizeOverlayCss(userCss);
    // Appliquer le CSS
    titleFrame.style.cssText = cleaned;
    syncCssTextarea('inputTitleCss', cleaned);
    syncOverlayVisibility();
    return cleaned;
}

// Les profils sont importables : on limite le CSS à des déclarations locales.
// display reste réservé au contrôleur et url() éviterait des requêtes externes
// invisibles lors du chargement d'un profil tiers.
export function sanitizeOverlayCss(css) {
    const declarations = extractCssDeclarations(css);
    if (!declarations || typeof document === 'undefined') return declarations;
    const probe = document.createElement('div');
    probe.style.cssText = declarations;
    for (const prop of Array.from(probe.style)) {
        const value = probe.style.getPropertyValue(prop);
        if (prop.toLowerCase() === 'display' || /url\s*\(/i.test(value)) {
            probe.style.removeProperty(prop);
        }
    }
    return probe.style.cssText.trim();
}

function syncCssTextarea(id, css) {
    const textarea = document.getElementById(id);
    if (textarea && textarea.value !== css) textarea.value = css;
}

// Utilitaire: extrait uniquement les déclarations CSS (retire sélecteurs et accolades)
function extractCssDeclarations(css) {
    if (!css || typeof css !== 'string') return '';
    let text = css.trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        text = text.substring(first + 1, last);
    }
    // Nettoyage des espaces superflus en début de ligne
    text = text.replace(/^\s+/gm, '');
    return text.trim();
}


