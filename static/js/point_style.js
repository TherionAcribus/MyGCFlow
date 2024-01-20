const colorExpression = generateColorExpression(colorMapping);

const interiorStyle = {
    symbol: {
        symbolType: 'circle',
        size: 10,
        color: colorExpression
    }
};

const exteriorStyle = {
    symbol: {
        symbolType: 'circle',
        size: 12,
        color: 'black'  // ou utilisez getBorderColor() si vous avez une logique spécifique
    }
};

let borderLayer = new ol.layer.WebGLPointsLayer({
    source: vectorSource,
    style: exteriorStyle,
});
map.addLayer(borderLayer);


let innerCircleLayer = new ol.layer.WebGLPointsLayer({
    source: vectorSource,
    style: interiorStyle,
});
map.addLayer(innerCircleLayer);



function generateColorExpression(colorMapping) {
    const expression = ['case'];
    for (const [type, color] of Object.entries(colorMapping)) {
      expression.push(['==', ['get', 'type'], type]);
      expression.push(color);
    }
    expression.push([0, 0, 0]);  // couleur par défaut (noir) si aucune correspondance n'est trouvée
    return expression;
  }
