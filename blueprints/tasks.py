from flask import Blueprint, jsonify, request
from flask_cors import cross_origin

from task_manager import task_manager

tasks_bp = Blueprint('tasks', __name__)


@tasks_bp.route('/tasks/<task_id>', methods=['GET'])
@cross_origin()
def get_task_status(task_id: str):
    status = task_manager.get(task_id)
    if status is None:
        return jsonify({'error': 'Task not found'}), 404

    include_result = request.args.get('include_result', 'true').lower() != 'false'
    data = status.to_dict(include_result=include_result and status.state == "finished")
    return jsonify(data)
