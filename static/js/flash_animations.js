/**
 * Module d'animation pour les effets de flash des points de géocaching
 */

// Configuration des animations de flash
export const FLASH_ANIMATIONS = {
    none: {
        name: "Aucun",
        description: "Pas d'effet de flash"
    },
    circle: {
        name: "Cercle",
        description: "Cercle expansif"
    },
    star: {
        name: "Étoile",
        description: "Étoile à 5 branches"
    },
    sparkle: {
        name: "Scintillement",
        description: "Étincelle brillante à 4 branches"
    },
    square: {
        name: "Carré",
        description: "Carré expansif"
    },
    triangle: {
        name: "Triangle",
        description: "Triangle expansif"
    },
    diamond: {
        name: "Losange",
        description: "Losange expansif"
    },

};

/**
 * Classe pour gérer les animations de flash
 */
export class FlashAnimationManager {
    constructor(map, layer) {
        this.map = map;
        this.layer = layer;
        this.activeAnimations = new Map();
        this.animationFrameId = null;
    }

    /**
     * Démarre une animation de flash pour un point spécifique
     */
    startFlash(feature, options = {}) {
        const {
            mode = 'circle',
            duration = 1000,
            size = 50,
            color = '#ffffff',
            intensity = 0.8
        } = options;

        // Créer l'élément d'animation
        const animationElement = this.createAnimationElement(feature, mode, {size, color, intensity});

        if (!animationElement) return;

        // Positionner l'animation sur la carte
        const geometry = feature.getGeometry();
        const coordinates = geometry.getCoordinates();
        const pixel = this.map.getPixelFromCoordinate(coordinates);

        animationElement.style.left = `${pixel[0] - size/2}px`;
        animationElement.style.top = `${pixel[1] - size/2}px`;
        animationElement.style.width = `${size}px`;
        animationElement.style.height = `${size}px`;

        // Ajouter à la carte
        const mapContainer = this.map.getTargetElement();
        mapContainer.appendChild(animationElement);

        // Animer
        this.animateFlash(animationElement, duration);

        // Nettoyer après l'animation
        setTimeout(() => {
            if (animationElement.parentNode) {
                animationElement.parentNode.removeChild(animationElement);
            }
        }, duration);
    }

    /**
     * Crée l'élément DOM pour l'animation
     */
    createAnimationElement(feature, mode, options) {
        const {size, color, intensity} = options;
        const element = document.createElement('div');

        element.className = `flash-animation flash-${mode}`;
        element.style.position = 'absolute';
        element.style.pointerEvents = 'none';
        element.style.zIndex = '1000';
        element.style.opacity = intensity;

        switch (mode) {
            case 'circle':
                element.style.borderRadius = '50%';
                element.style.backgroundColor = color;
                element.style.border = `2px solid ${this.adjustColor(color, -30)}`;
                break;

            case 'star':
                element.innerHTML = this.createStarSVG(size, color);
                break;

            case 'square':
                element.style.backgroundColor = color;
                element.style.border = `2px solid ${this.adjustColor(color, -30)}`;
                break;

            case 'triangle':
                element.style.width = '0';
                element.style.height = '0';
                element.style.borderLeft = `${size/2}px solid transparent`;
                element.style.borderRight = `${size/2}px solid transparent`;
                element.style.borderBottom = `${size}px solid ${color}`;
                break;

            case 'diamond':
                element.style.transform = 'rotate(45deg)';
                element.style.backgroundColor = color;
                element.style.border = `2px solid ${this.adjustColor(color, -30)}`;
                break;

            case 'heart':
                element.innerHTML = this.createHeartSVG(size, color);
                break;

            case 'pulse':
                element.style.borderRadius = '50%';
                element.style.border = `3px solid ${color}`;
                element.style.backgroundColor = 'transparent';
                break;

            case 'ring':
                element.style.borderRadius = '50%';
                element.style.border = `4px solid ${color}`;
                element.style.backgroundColor = 'transparent';
                element.style.boxShadow = `0 0 20px ${color}`;
                break;

            case 'spiral':
                element.innerHTML = this.createSpiralSVG(size, color);
                break;

            default:
                return null;
        }

        return element;
    }

    /**
     * Anime l'effet de flash
     */
    animateFlash(element, duration) {
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Animation d'échelle (agrandissement)
            const scale = 1 + (progress * 2);
            element.style.transform = `scale(${scale})`;

            // Animation d'opacité (fondu)
            const opacity = (1 - progress) * 0.8;
            element.style.opacity = opacity;

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        requestAnimationFrame(animate);
    }

    /**
     * Crée un SVG d'étoile
     */
    createStarSVG(size, color) {
        const center = size / 2;
        const outerRadius = size / 2;
        const innerRadius = size / 4;

        let points = [];
        for (let i = 0; i < 10; i++) {
            const angle = (i * Math.PI) / 5;
            const radius = i % 2 === 0 ? outerRadius : innerRadius;
            const x = center + radius * Math.sin(angle);
            const y = center - radius * Math.cos(angle);
            points.push(`${x},${y}`);
        }

        return `
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
                <polygon points="${points.join(' ')}" fill="${color}" stroke="${this.adjustColor(color, -30)}" stroke-width="2"/>
            </svg>
        `;
    }

    /**
     * Crée un SVG de cœur
     */
    createHeartSVG(size, color) {
        const scale = size / 100;
        return `
            <svg width="${size}" height="${size}" viewBox="0 0 100 100">
                <path d="M50,85 C20,60 5,40 5,25 C5,15 15,5 25,5 C35,5 45,15 50,25 C55,15 65,5 75,5 C85,5 95,15 95,25 C95,40 80,60 50,85 Z"
                      fill="${color}" stroke="${this.adjustColor(color, -30)}" stroke-width="2"/>
            </svg>
        `;
    }

    /**
     * Crée un SVG de spirale
     */
    createSpiralSVG(size, color) {
        const center = size / 2;
        let path = `M ${center} ${center}`;

        for (let i = 0; i <= 360; i += 10) {
            const angle = (i * Math.PI) / 180;
            const radius = (i / 360) * (size / 2);
            const x = center + radius * Math.cos(angle);
            const y = center + radius * Math.sin(angle);
            path += ` L ${x} ${y}`;
        }

        return `
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
                <path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
            </svg>
        `;
    }

    /**
     * Ajuste la couleur (éclaircit ou assombrit)
     */
    adjustColor(color, amount) {
        const usePound = color[0] === '#';
        const col = usePound ? color.slice(1) : color;

        const num = parseInt(col, 16);
        let r = (num >> 16) + amount;
        let g = (num >> 8 & 0x00FF) + amount;
        let b = (num & 0x0000FF) + amount;

        r = r > 255 ? 255 : r < 0 ? 0 : r;
        g = g > 255 ? 255 : g < 0 ? 0 : g;
        b = b > 255 ? 255 : b < 0 ? 0 : b;

        return (usePound ? '#' : '') + (r << 16 | g << 8 | b).toString(16);
    }

    /**
     * Nettoie toutes les animations actives
     */
    cleanup() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }

        // Supprimer tous les éléments d'animation restants
        const animations = document.querySelectorAll('.flash-animation');
        animations.forEach(animation => {
            if (animation.parentNode) {
                animation.parentNode.removeChild(animation);
            }
        });

        this.activeAnimations.clear();
    }
}

/**
 * Fonction utilitaire pour déclencher un flash
 */
export function triggerFlash(map, layer, feature, options = {}) {
    const flashManager = new FlashAnimationManager(map, layer);
    flashManager.startFlash(feature, options);

    // Nettoyer après un délai
    setTimeout(() => {
        flashManager.cleanup();
    }, options.duration || 1000);
}
