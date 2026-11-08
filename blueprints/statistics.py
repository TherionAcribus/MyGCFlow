"""Page « Statistiques » : tableaux de bord de graphiques, sans carte.

Plan et décisions : MyGCFlow_Plan_Statistiques.md ; doc technique :
docs/page-statistiques.md. Les graphiques sont calculés côté navigateur
(modules purs `static/js/chart_*.mjs`) et dessinés par ECharts
(`static/vendor/echarts/`) : le serveur ne sert que la page et, à partir du
lot 1, les données et la sauvegarde des tableaux de bord.
"""

from flask import Blueprint

from .core import render_page

statistics_bp = Blueprint('statistics', __name__)


@statistics_bp.route('/stats')
def stats_page():
    return render_page('stats_page.html', mode='stats')
