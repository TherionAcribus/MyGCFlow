

/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/


/**
 * AUTO-GENERATED FILE. DO NOT MODIFY.
 */
(function(root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['exports', 'echarts'], factory);
    } else if (
        typeof exports === 'object' &&
        typeof exports.nodeName !== 'string'
    ) {
        // CommonJS
        factory(exports, require('echarts/lib/echarts'));
    } else {
        // Browser globals
        factory({}, root.echarts);
    }
})(this, function(exports, echarts) {


/**
 * Language: German.
 */

var localeObj = {
    time: {
        month: [
            'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
            'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
        ],
        monthAbbr: [
            'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
            'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'
        ],
        dayOfWeek: [
            'Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'
        ],
        dayOfWeekAbbr: [
            'So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'
        ]
    },
    legend: {
        selector: {
            all: 'Alle',
            inverse: 'Invertiert'
        }
    },
    toolbox: {
        brush: {
            title: {
                rect: 'Rechteckauswahl',
                polygon: 'Lassoauswahl',
                lineX: 'Horizontale Auswahl',
                lineY: 'Vertikale Auswahl',
                keep: 'Auswahl beibehalten',
                clear: 'Auswahl löschen'
            }
        },
        dataView: {
            title: 'Datenansicht',
            lang: ['Datenansicht', 'Schließen', 'Aktualisieren']
        },
        dataZoom: {
            title: {
                zoom: 'Zoom',
                back: 'Zoom zurücksetzen'
            }
        },
        magicType: {
            title: {
                line: 'Zu Linie wechseln',
                bar: 'Zu Balken wechseln',
                stack: 'Stapeln',
                tiled: 'Kachel'
            }
        },
        restore: {
            title: 'Wiederherstellen'
        },
        saveAsImage: {
            title: 'Als Bild speichern',
            lang: ['Rechtsklick zum Speichern des Bildes']
        }
    },
    series: {
        typeNames: {
            pie: 'Tortendiagramm',
            bar: 'Balkendiagramm',
            line: 'Liniendiagramm',
            scatter: 'Streudiagramm',
            effectScatter: 'Streudiagramm mit Welleneffekt',
            radar: 'Radardiagramm',
            tree: 'Baumdiagramm',
            treemap: 'Baumkarte',
            boxplot: 'Boxplot',
            candlestick: 'Candlestick-Diagramm',
            k: 'K-Linien-Diagramm',
            heatmap: 'Heatmap',
            map: 'Karte',
            parallel: 'Parallelkoordinaten',
            lines: 'Liniendiagramm',
            graph: 'Beziehungsgraph',
            sankey: 'Sankey-Diagramm',
            funnel: 'Trichterdiagramm',
            gauge: 'Messgerät',
            pictorialBar: 'Piktogramm-Balkendiagramm',
            themeRiver: 'Themenfluss-Diagramm',
            sunburst: 'Sunburst-Diagramm',
            custom: 'Benutzerdefiniertes Diagramm',
            chart: 'Diagramm'
        }
    },
    aria: {
        general: {
            withTitle: 'Dies ist ein Diagramm über "{title}"',
            withoutTitle: 'Dies ist ein Diagramm'
        },
        series: {
            single: {
                prefix: '',
                withName: ' mit dem Typ {seriesType} namens {seriesName}.',
                withoutName: ' mit dem Typ {seriesType}.'
            },
            multiple: {
                prefix: '. Es besteht aus {seriesCount} Serien.',
                withName: ' Die {seriesId} Serie ist ein {seriesType}, die {seriesName} darstellt.',
                withoutName: ' Die {seriesId} Serie ist ein {seriesType}.',
                separator: {
                    middle: '',
                    end: ''
                }
            }
        },
        data: {
            allData: 'Die Daten sind: ',
            partialData: 'Die ersten {displayCnt} Elemente sind: ',
            withName: 'Die Daten für {name} sind {value}',
            withoutName: '{value}',
            separator: {
                middle: ', ',
                end: '. '
            }
        }
    }
};

    echarts.registerLocale('DE', localeObj);

});
