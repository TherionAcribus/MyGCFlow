// Géométrie des formes « shape » des styles WebGLPoints, partagée par les
// caches posées (ownerShapeStyle) et les points DNF (dnfShapeStyle) : à
// 'circle-radius' égal un triangle ou un carré paraît plus petit qu'un
// cercle — chaque forme a son facteur, pour un encombrement voisin.
// 'same' n'y figure pas : elle prend la forme des trouvailles au moment de
// la construction du style.
export const SHAPE_GEOMETRY = {
    triangle: { points: 3, radius: 1.4, angle: 0 },
    square: { points: 4, radius: 1.3, angle: Math.PI / 4 },
    diamond: { points: 4, radius: 1.5, angle: 0 },
    star: { points: 5, radius: 1.9, radius2: 0.85, angle: 0 },
};
