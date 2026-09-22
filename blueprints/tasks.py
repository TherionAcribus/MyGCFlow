from flask import Blueprint, jsonify, request

from task_manager import task_manager
from bdd import TASK_TYPE_GEOJSON, geojson_cache

tasks_bp = Blueprint('tasks', __name__)


@tasks_bp.route('/tasks/<task_id>', methods=['GET'])
def get_task_status(task_id: str):
    status = task_manager.get(task_id)
    if status is None:
        return jsonify({'error': 'Task not found'}), 404

    include_result = request.args.get('include_result', 'true').lower() != 'false'
    data = status.to_dict(include_result=False)
    
    # Si le résultat est demandé et que la tâche est terminée
    if include_result and status.state == "finished" and status.result:
        # Pour les tâches GeoJSON, reconstruire le résultat depuis le cache
        if status.type == TASK_TYPE_GEOJSON and "cache_ref" in status.result:
            cache_ref = status.result["cache_ref"]
            metadata = status.result.get("metadata")
            
            # Récupérer le GeoJSON depuis le cache
            geojson = None
            if cache_ref["type"] == "base":
                cached = geojson_cache.get_base_dataset_if_current(cache_ref["db_mtime"])
                if cached:
                    geojson, _ = cached
            else:  # filtered
                cached = geojson_cache.get_filtered_if_current(
                    cache_ref["selected_values"], 
                    cache_ref["db_mtime"]
                )
                if cached:
                    geojson, _ = cached
            
            # Construire le résultat complet
            if geojson is not None:
                data["result"] = {
                    "geojson": geojson,
                    "metadata": metadata
                }
            else:
                # Cache expiré ou invalidé - indiquer que le résultat n'est plus disponible
                data["result"] = {
                    "error": "Cache expired",
                    "metadata": metadata
                }
        else:
            # Pour les autres types de tâches, retourner le résultat tel quel
            data["result"] = status.result
    
    return jsonify(data)
