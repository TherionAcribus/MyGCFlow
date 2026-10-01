"""Mode Évolution : apparition et disparition des caches d'une zone.

Page /evolution (même interface que le mode principal, onglet Données propre)
et API des bases nommées : création, import de CSV en tâche de fond, données
en colonnes pour l'affichage, détails d'une cache pour la popup.
"""

import os
import re
import tempfile
import unicodedata

from flask import (Blueprint, Response, current_app, jsonify, make_response,
                   request, stream_with_context)
from flask_babel import force_locale, gettext as _

import evolution_store as store
import paths
from .core import render_app_page
from evolution_csv import CsvFormatError, FileReport, read_header
from localization import get_locale
from task_manager import TaskAlreadyRunning, task_manager

evolution_bp = Blueprint('evolution', __name__)

TASK_TYPE_EVOLUTION_IMPORT = 'evolution_import'
# Au-delà, le fichier n'est vraisemblablement pas un export de caches (un
# export de 500 000 caches pèse ~180 Mo).
MAX_CSV_BYTES = 500 * 1024 * 1024
ALLOWED_EXTENSIONS = ('.csv', '.txt')


def _db_path():
    return current_app.config.get('EVOLUTION_DB_PATH') or paths.evolution_database_path()


def _column_label(field: str) -> str:
    return {
        'gc_code': _('GC code'),
        'latitude': _('Latitude'),
        'longitude': _('Longitude'),
        'placed': _('Date de placement'),
    }.get(field, field)


def _store_error(exc: store.EvolutionStoreError):
    messages = {
        'not-found': (_('Base introuvable'), 404),
        'cache-not-found': (_('Cache introuvable dans cette base'), 404),
        'name-empty': (_('Le nom de la base est obligatoire'), 400),
        'name-too-long': (_('Le nom de la base est trop long (%(max)s caractères au plus)',
                            max=store.NAME_MAX_LENGTH), 400),
        'name-taken': (_('Une base porte déjà ce nom'), 409),
    }
    message, code = messages.get(exc.code, (str(exc), 400))
    return jsonify({'success': False, 'error': exc.code, 'message': message}), code


def _import_running():
    return task_manager.get_active(TASK_TYPE_EVOLUTION_IMPORT)


@evolution_bp.route('/evolution')
def evolution_page():
    return render_app_page('evolution')


@evolution_bp.route('/api/evolution/datasets', methods=['GET'])
def list_datasets():
    running = _import_running()
    return jsonify({
        'datasets': store.list_datasets(_db_path()),
        'import_task_id': running.id if running else None,
    })


@evolution_bp.route('/api/evolution/datasets', methods=['POST'])
def create_dataset():
    data = request.get_json(silent=True) or {}
    try:
        dataset = store.create_dataset(_db_path(), data.get('name'))
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'dataset': dataset}), 201


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>', methods=['GET'])
def get_dataset(dataset_id):
    try:
        dataset = store.get_dataset(_db_path(), dataset_id)
        imports = store.list_imports(_db_path(), dataset_id)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return jsonify({'dataset': dataset, 'imports': imports})


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>', methods=['PATCH'])
def rename_dataset(dataset_id):
    data = request.get_json(silent=True) or {}
    try:
        dataset = store.rename_dataset(_db_path(), dataset_id, data.get('name'))
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return jsonify({'success': True, 'dataset': dataset})


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>', methods=['DELETE'])
def delete_dataset(dataset_id):
    if _import_running():
        return jsonify({'success': False, 'error': 'import-running',
                        'message': _('Un import est en cours : réessayez une fois terminé')}), 409
    try:
        store.delete_dataset(_db_path(), dataset_id)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return jsonify({'success': True})


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>/export.csv', methods=['GET'])
def export_dataset(dataset_id):
    # Sauvegarde / portage : le CSV fusionné est produit en flux (les bases
    # peuvent dépasser 100 000 caches) et se ré-importe tel quel. Pas de
    # blocage pendant un import : le journal WAL donne un instantané cohérent.
    db_path = _db_path()
    try:
        dataset = store.get_dataset(db_path, dataset_id)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return Response(
        stream_with_context(store.export_csv(str(db_path), dataset_id)),
        mimetype='text/csv',
        headers={'Content-Disposition':
                 f'attachment; filename="{_export_filename(dataset["name"])}"'},
    )


def _export_filename(name) -> str:
    # Nom ASCII pour Content-Disposition : accents retirés (NFKD), caractères
    # spéciaux remplacés — un filename ASCII dispense du paramètre filename*.
    decomposed = unicodedata.normalize('NFKD', name or '')
    base = ''.join(c for c in decomposed if not unicodedata.combining(c))
    # \w accepte encore des caractères non ASCII (idéogrammes…) : ils sont
    # éliminés par l'encodage pour garder un en-tête purement ASCII.
    slug = re.sub(r'[^\w.-]+', '_', base).encode('ascii', 'ignore').decode('ascii')
    return (slug.strip('_')[:80] or 'zone') + '.csv'


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>/import', methods=['POST'])
def import_csv(dataset_id):
    db_path = _db_path()
    try:
        store.get_dataset(db_path, dataset_id)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)

    uploads = [f for f in request.files.getlist('files') if f and f.filename]
    if not uploads:
        return jsonify({'success': False, 'error': 'no-file', 'message': _('Aucun fichier fourni')}), 400

    saved = []  # (chemin temporaire, nom d'origine)

    def cleanup():
        for tmp_path, _name in saved:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    def reject(error, message):
        cleanup()
        return jsonify({'success': False, 'error': error, 'message': message}), 400

    for upload in uploads:
        # Le nom d'origine ne sert qu'à l'affichage : le fichier est écrit sous
        # un nom temporaire choisi par le serveur.
        filename = os.path.basename(upload.filename.replace('\\', '/'))[:200]
        if not filename.lower().endswith(ALLOWED_EXTENSIONS):
            return reject('extension', _('%(name)s : seuls les fichiers .csv sont acceptés', name=filename))
        fd, tmp_path = tempfile.mkstemp(suffix='.csv')
        os.close(fd)
        saved.append((tmp_path, filename))
        upload.save(tmp_path)
        size = os.path.getsize(tmp_path)
        if size == 0:
            return reject('empty', _('%(name)s : fichier vide', name=filename))
        if size > MAX_CSV_BYTES:
            return reject('too-large', _('%(name)s : fichier trop volumineux (500 Mo au plus)', name=filename))
        # En-tête vérifié tout de suite : un fichier qui n'est pas un export de
        # caches est signalé à l'envoi plutôt qu'à la fin de la tâche.
        try:
            read_header(tmp_path)
        except CsvFormatError as exc:
            columns = ', '.join(_column_label(f) for f in exc.missing)
            return reject('columns', _('%(name)s : colonnes obligatoires absentes (%(columns)s)',
                                       name=filename, columns=columns))

    app_obj = current_app._get_current_object()
    try:
        status = task_manager.submit(
            TASK_TYPE_EVOLUTION_IMPORT, run_evolution_import,
            app_obj, str(db_path), dataset_id, saved, get_locale(),
            exclusive=True,
        )
    except TaskAlreadyRunning:
        cleanup()
        return jsonify({'success': False, 'error': 'import-running',
                        'message': _('Un import est déjà en cours')}), 409

    return jsonify({'success': True, 'task_id': status.id, 'state': status.state}), 202


def run_evolution_import(status, app, db_path, dataset_id, files, locale=None):
    """Tâche de fond : fusionne les fichiers dans la base, dans l'ordre d'envoi.

    Chaque fichier est importé dans sa propre transaction : un fichier en
    erreur n'annule pas les précédents. `locale` est capturée dans la requête
    d'origine (voir bdd.run_import_task).
    """
    try:
        with app.app_context():
            if locale:
                with force_locale(locale):
                    _import_files(status, db_path, dataset_id, files)
            else:
                _import_files(status, db_path, dataset_id, files)
    finally:
        for tmp_path, _name in files:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _import_files(status, db_path, dataset_id, files):
    reports = []
    count = max(1, len(files))
    for index, (tmp_path, filename) in enumerate(files):
        message = _('Import de %(name)s (%(index)s/%(count)s)…', name=filename, index=index + 1, count=count)
        status.set_progress(index / count * 100, message)

        def on_progress(fraction, index=index):
            status.set_progress((index + fraction) / count * 100)

        report = FileReport(filename=filename)
        try:
            store.import_file(db_path, dataset_id, tmp_path, report, on_progress)
            reports.append(report.to_dict())
        except CsvFormatError as exc:
            columns = ', '.join(_column_label(f) for f in exc.missing)
            reports.append({'filename': filename,
                            'error': _('Colonnes obligatoires absentes (%(columns)s)', columns=columns)})
        except store.EvolutionStoreError as exc:
            if exc.code == 'not-found':
                raise RuntimeError(_('Base introuvable'))
            reports.append({'filename': filename, 'error': str(exc)})
        except Exception as exc:  # noqa: BLE001 - un fichier illisible ne doit pas bloquer les suivants
            current_app.logger.exception('Import CSV %s', filename)
            reports.append({'filename': filename, 'error': str(exc)})

    if reports and all('error' in r for r in reports):
        status.set_result({'files': reports})
        status.fail(reports[0]['error'])
        return
    status.set_result({'files': reports, 'dataset': store.get_dataset(db_path, dataset_id)})


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>/data', methods=['GET'])
def dataset_data(dataset_id):
    try:
        dataset, body = store.load_payload(_db_path(), dataset_id)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    response = make_response(body)
    response.mimetype = 'application/json'
    # Faible : Flask-Compress le conserve tel quel sur la réponse compressée.
    # La version du format y figure : une mise à jour du code qui change la
    # charge utile invalide le corps 304 gardé par le navigateur.
    response.set_etag(
        f"evo-{dataset['id']}-{dataset['revision']}-p{store.PAYLOAD_VERSION}", weak=True)
    response.headers['Cache-Control'] = 'no-cache'
    return response.make_conditional(request)


@evolution_bp.route('/api/evolution/datasets/<int:dataset_id>/caches/<code>', methods=['GET'])
def cache_details(dataset_id, code):
    try:
        cache = store.get_cache(_db_path(), dataset_id, code)
    except store.EvolutionStoreError as exc:
        return _store_error(exc)
    return jsonify({'cache': cache})
