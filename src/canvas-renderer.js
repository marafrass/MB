/**
 * Canvas Renderer for Murder Board
 * Handles all visual rendering of items, connections, and grid
 */

import { MurderBoardData } from './data-model.js';

export class CanvasRenderer {
  constructor(canvas, scene) {
    this.canvas = canvas;
    this.scene = scene;
    this.ctx = canvas.getContext('2d');
    
    // Enable high-quality rendering
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    
    this.selectedItem = null;
    this.selectedItems = []; // Array of selected item IDs
    this.hoveredItem = null;
    this.hoveredConnection = null; // Track hovered connection
    this.connectionPreview = null;
    this.connectionPreviewMode = false; // Track if connection preview is active
    this.connectionTargetItem = null; // Track the target item for pulsing
    this.draggedItem = null; // Track item being dragged
    this.itemSize = 40; // Size of item squares in pixels
    this.padding = 20; // Padding around text
    this.isDirty = false; // Track if canvas needs redraw
    this.animationFrameId = null; // Track animation frame request
    this.boxSelectRect = null; // Box selection rectangle { x1, y1, x2, y2 }
    // Initialize showCenter from scene flags, default to true if not set
    const savedState = scene.getFlag('murder-board', 'showCenter');
    this.showCenter = savedState !== undefined ? savedState : true;
    
    // Performance optimizations
    this.textMeasureCache = new Map(); // Cache text measurements to avoid repeated calls
    this.patternCache = new Map(); // Cache canvas patterns for textures
    this.imageLoadingSet = new Set(); // Track which images are currently loading to prevent duplicate requests
    
    // Viewport/Camera system
    this.camera = {
      x: 0,
      y: 0,
      zoom: 1,
    };

    // Image preset dimensions based on long-edge sizing
    // Specify only the long edge, other dimension computed based on image aspect ratio
    // Post-it note is 40px (2x2 inches) - reference scale
    // Polaroid: 65px long edge
    // Small: 4x6 inches = 80x120px (120px long edge)
    // Medium: 4x7 inches = 80x140px (140px long edge)
    // Large: 8x10 inches = 160x200px (200px long edge)
    // XL: 11x14 inches = 220x280px (280px long edge)
    // XXL: 16x20 inches = 320x400px (400px long edge)
    this.imagePresets = {
      portrait: { longEdge: 65, borderWidth: 1.5, isPolaroid: true, bottomMargin: 15 },   // Polaroid: 65px long edge
      small: { longEdge: 120, borderWidth: 1.5 },     // Small: 4x6 inches
      medium: { longEdge: 140, borderWidth: 1.5 },    // Medium: 4x7 inches
      large: { longEdge: 200, borderWidth: 1.5 },     // Large: 8x10 inches
      xl: { longEdge: 280, borderWidth: 1.5 },        // XL: 11x14 inches
      xxl: { longEdge: 400, borderWidth: 1.5 },       // XXL: 16x20 inches
    };

    // Document preset styles for different paper types
    this.documentPresets = {
      blank: {
        name: 'Blank',
        borderColor: '#333333',
        borderWidth: 2,
        hasLines: false,
        hasGrid: false,
        backgroundColor: '#FFFFFF',
        marginLeft: 20,
        marginRight: 10,
      },
      looseleaf: {
        name: 'Loose Leaf',
        borderColor: '#CCCCCC',
        borderWidth: 1.5,
        hasLines: true,
        hasGrid: false,
        lineColor: '#ADD8E6',
        lineSpacing: 6,
        marginLeft: 20,
        marginRight: 10,
        marginLineColor: '#FF9999',
        backgroundColor: '#FFFFFF',
        drawMarginHoles: true,
      },
      grid: {
        name: 'Grid Paper',
        borderColor: '#333333',
        borderWidth: 1.5,
        hasLines: false,
        hasGrid: true,
        gridColor: '#D0D0D0',
        gridSize: 3,
        backgroundColor: '#FFFFFF',
        marginLeft: 20,
        marginRight: 10,
      },
      legal: {
        name: 'Legal Pad',
        borderColor: '#8B6F47',
        borderWidth: 2,
        hasLines: true,
        hasGrid: false,
        lineColor: '#ADD8E6',
        lineSpacing: 6,
        marginLeft: 20,
        marginRight: 10,
        marginLineColor: '#FF9999',
        backgroundColor: '#FFFF99',
        drawMarginHoles: false,
      },
      spiral: {
        name: 'Spiral Notebook',
        borderColor: '#2C2C2C',
        borderWidth: 1.5,
        hasLines: true,
        hasGrid: false,
        lineColor: '#E8E8E8',
        lineSpacing: 7,
        marginLeft: 20,
        marginRight: 10,
        marginLineColor: '#FF9999',
        backgroundColor: '#FAFAFA',
        hasSpiral: true,
      },
    };

    // Document effects - visual effects that can be applied on top of documents
    this.documentEffects = {
      none: {
        name: 'None',
        apply: () => {} // No effect
      },
      crumpled: {
        name: 'Crumpled',
        apply: (x, y, width, height, ctx, scene, intensity = 1, seed = 50) => {
          this._applyEffect_Crumpled(x, y, width, height, ctx, scene, intensity, seed);
        }
      },
      torn: {
        name: 'Torn',
        apply: (x, y, width, height, ctx, scene, intensity = 1, seed = 50) => {
          this._applyEffect_Torn(x, y, width, height, ctx, scene, intensity, seed);
        }
      },
      burned: {
        name: 'Burned',
        apply: (x, y, width, height, ctx, scene, intensity = 1, seed = 50) => {
          this._applyEffect_Burned(x, y, width, height, ctx, scene, intensity, seed);
        }
      },
    };

    // Document size presets
    this.documentSizes = {
      small: { width: 60, height: 60 },
      medium: { width: 100, height: 120 },
      large: { width: 140, height: 180 },
      xlarge: { width: 200, height: 260 },
    };

    // Image cache to store loaded images
    this.imageCache = new Map();

    // Text layout cache to avoid recalculating text wrapping on every frame
    this.textLayoutCache = new Map();
  }

  /**
   * Get board data from scene
   * @returns {Object} Board data
   */
  _getBoardData() {
    return MurderBoardData.getBoardData(this.scene);
  }

  /**
   * Main draw function - uses requestAnimationFrame for optimization
   */
  draw() {
    // For initial render, draw immediately
    if (this.animationFrameId === null && !this.isDirty) {
      this._performDraw();
      return;
    }
    
    // Mark canvas as needing redraw
    this.isDirty = true;
    
    // Cancel any pending animation frame
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    // Schedule redraw on next frame
    this.animationFrameId = requestAnimationFrame(() => {
      this._performDraw();
      this.animationFrameId = null;
      this.isDirty = false;
    });
  }

  /**
   * Refresh the canvas - alias for draw()
   */
  refresh() {
    this.draw();
  }

  /**
   * Convert world coordinates to screen coordinates
   * Takes into account camera position and zoom
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @returns {Object} Screen coordinates {x, y}
   */
  _toScreenCoords(worldX, worldY) {
    const screenX = (worldX + this.camera.x) * this.camera.zoom;
    const screenY = (worldY + this.camera.y) * this.camera.zoom;
    return { x: screenX, y: screenY };
  }

  /**
   * Check if an item is within the visible viewport
   * Helps with frustum culling to avoid drawing off-screen items
   * @param {number} x - Item world X position
   * @param {number} y - Item world Y position
   * @param {number} width - Item width (approximate for culling)
   * @param {number} height - Item height (approximate for culling)
   * @returns {boolean} True if item is visible in viewport
   */
  _isItemInViewport(x, y, width = 40, height = 40) {
    // Calculate visible world bounds based on camera and canvas size
    const visibleWorldLeft = -this.camera.x / this.camera.zoom;
    const visibleWorldTop = -this.camera.y / this.camera.zoom;
    const visibleWorldRight = visibleWorldLeft + (this.canvas.width / this.camera.zoom);
    const visibleWorldBottom = visibleWorldTop + (this.canvas.height / this.camera.zoom);
    
    // Add margin to cull items that are slightly off-screen
    const margin = 100;
    
    // Check if item bounds intersect with visible area
    const itemLeft = x - width / 2 - margin;
    const itemRight = x + width / 2 + margin;
    const itemTop = y - height / 2 - margin;
    const itemBottom = y + height / 2 + margin;
    
    return !(itemRight < visibleWorldLeft || 
             itemLeft > visibleWorldRight || 
             itemBottom < visibleWorldTop || 
             itemTop > visibleWorldBottom);
  }

  /**
   * Perform the actual drawing
   * @private
   */
  _performDraw() {
    // Clear canvas first
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Save canvas state for transforms
    this.ctx.save();

    // Apply camera transformations (translate then scale)
    this.ctx.translate(this.camera.x, this.camera.y);
    this.ctx.scale(this.camera.zoom, this.camera.zoom);

    // Draw background with optional texture (in world coordinates so it pans/zooms)
    this._drawBackground();

    // Get board data
    const boardData = this._getBoardData();

    // Draw connections first (so they appear behind items)
    this._drawConnections(boardData.connections, boardData.items);

    // Draw items
    this._drawItems(boardData.items);
    
    // Draw connection preview if active
    if (this.connectionPreview && this.connectionPreviewMode) {
      const from = this.connectionPreview.from;
      const to = this.connectionPreview.to;
      
      // Draw glowing source item indicator
      this.ctx.fillStyle = 'rgba(100, 200, 255, 0.15)';
      this.ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
      this.ctx.lineWidth = 3 / this.camera.zoom;
      this.ctx.beginPath();
      this.ctx.arc(from.x, from.y, 35 / this.camera.zoom, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      
      // Draw main connection line with gradient
      const gradient = this.ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      gradient.addColorStop(0, 'rgba(100, 200, 255, 0.8)');
      gradient.addColorStop(1, 'rgba(100, 150, 255, 0.4)');
      
      this.ctx.strokeStyle = gradient;
      this.ctx.lineWidth = 3 / this.camera.zoom;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(to.x, to.y);
      this.ctx.stroke();
      
      // Draw arrow head at end
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const arrowSize = 15 / this.camera.zoom;
      const arrowX = to.x - Math.cos(angle) * arrowSize;
      const arrowY = to.y - Math.sin(angle) * arrowSize;
      
      this.ctx.fillStyle = 'rgba(100, 200, 255, 0.8)';
      this.ctx.beginPath();
      this.ctx.moveTo(to.x, to.y);
      this.ctx.lineTo(arrowX + Math.sin(angle) * (arrowSize * 0.5), arrowY - Math.cos(angle) * (arrowSize * 0.5));
      this.ctx.lineTo(arrowX - Math.sin(angle) * (arrowSize * 0.5), arrowY + Math.cos(angle) * (arrowSize * 0.5));
      this.ctx.closePath();
      this.ctx.fill();
      
      // Draw target zone highlight (larger circle at cursor)
      this.ctx.fillStyle = 'rgba(100, 200, 255, 0.1)';
      this.ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
      this.ctx.lineWidth = 2 / this.camera.zoom;
      this.ctx.beginPath();
      this.ctx.arc(to.x, to.y, 40 / this.camera.zoom, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      
      // Draw pulsing dot at cursor for feedback
      const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
      this.ctx.fillStyle = `rgba(100, 200, 255, ${0.4 + pulse * 0.4})`;
      this.ctx.beginPath();
      this.ctx.arc(to.x, to.y, (8 + pulse * 5) / this.camera.zoom, 0, Math.PI * 2);
      this.ctx.fill();
    }
    
    // Draw box select rectangle (in screen space, not world space)
    if (this.boxSelectRect) {
      this.ctx.restore(); // Restore to draw in screen space
      
      const { x1, y1, x2, y2 } = this.boxSelectRect;
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      
      // Fill with semi-transparent blue
      this.ctx.fillStyle = 'rgba(100, 150, 255, 0.2)';
      this.ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      
      // Stroke with solid blue
      this.ctx.strokeStyle = 'rgba(100, 150, 255, 0.8)';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      
      // Re-apply camera transforms for crosshair
      this.ctx.save();
      this.ctx.translate(this.camera.x, this.camera.y);
      this.ctx.scale(this.camera.zoom, this.camera.zoom);
    }
    
    // Draw center crosshair at world origin (0, 0) - moves with camera
    if (this.showCenter) {
      this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
      this.ctx.lineWidth = 3 / this.camera.zoom; // 3px wide, scaled by zoom
      const crossSize = 20;
      
      // Horizontal line
      this.ctx.beginPath();
      this.ctx.moveTo(-crossSize, 0);
      this.ctx.lineTo(crossSize, 0);
      this.ctx.stroke();
      
      // Vertical line
      this.ctx.beginPath();
      this.ctx.moveTo(0, -crossSize);
      this.ctx.lineTo(0, crossSize);
      this.ctx.stroke();
    }

    // Restore canvas state
    this.ctx.restore();
  }  /**
   * Get background color based on canvas color setting
   * @returns {string} Color value
   */
  _getBackgroundColor() {
    const boardData = this._getBoardData();
    // Use the custom canvas color, or fall back to board type default
    return boardData.canvasColor || '#f5f5f5';
  }

  /**
   * Load and cache a background image
   * @param {string} imagePath - Path to the background image
   * @returns {Promise<HTMLImageElement|null>} Loaded image or null
   * @private
   */
  async _loadBackgroundImage(imagePath) {
    if (!imagePath) return null;

    const cacheKey = `bg_${imagePath}`;

    // Check if already loading/loaded
    if (this.imageCache.has(cacheKey)) {
      const cached = this.imageCache.get(cacheKey);
      // If it's a promise, wait for it; if it's an image, return it
      return cached instanceof Promise ? await cached : cached;
    }

    // Start loading the image
    const img = new Image();
    const loadPromise = new Promise((resolve, reject) => {
      img.onload = () => {
        // Replace promise with actual image in cache
        this.imageCache.set(cacheKey, img);
        resolve(img);
        // Trigger redraw when image loads
        this.draw();
      };
      img.onerror = () => {
        // On error, cache null
        this.imageCache.set(cacheKey, null);
        resolve(null);
      };
      img.src = imagePath;
    });

    // Cache the promise initially
    this.imageCache.set(cacheKey, loadPromise);

    return loadPromise;
  }

  /**
   * Draw background with solid color or custom image
   * @private
   */
  _drawBackground() {
    const boardData = this._getBoardData();
    const boardType = boardData.boardType || 'whiteboard';

    // Check for custom background image
    if (boardData.backgroundImage) {
      const cacheKey = `bg_${boardData.backgroundImage}`;
      const cachedImg = this.imageCache.get(cacheKey);

      if (cachedImg instanceof HTMLImageElement && cachedImg.complete && cachedImg.naturalWidth > 0) {
        // Image is loaded and valid, draw it in world coordinates
        this._drawBackgroundImage(cachedImg);
      } else {
        // Image not loaded yet, failed to load, or invalid - draw solid color background
        this._drawSolidBackground();

        // Start loading if not already loading and not failed
        if (!(cachedImg instanceof Promise) && cachedImg !== null) {
          this._loadBackgroundImage(boardData.backgroundImage);
        }
      }
    } else {
      // No custom background image - use solid color
      this._drawSolidBackground();
    }
  }

  /**
   * Draw solid color background
   * @private
   */
  _drawSolidBackground() {
    const boardData = this._getBoardData();
    const boardType = boardData.boardType || 'whiteboard';

    // For solid backgrounds, we need to fill the visible world area
    // Since we're in world coordinates now, we need to calculate the visible area
    const visibleWidth = this.canvas.width / this.camera.zoom;
    const visibleHeight = this.canvas.height / this.camera.zoom;
    const visibleX = -this.camera.x / this.camera.zoom;
    const visibleY = -this.camera.y / this.camera.zoom;

    this.ctx.fillStyle = this._getBackgroundColor();
    this.ctx.fillRect(visibleX, visibleY, visibleWidth, visibleHeight);

    // Draw legal pad header if applicable (in world coordinates)
    if (boardType === 'legal') {
      this._drawLegalPadHeader();
    }

    // Draw frayed edge if applicable (spiral notebook)
    if (boardType === 'spiral') {
      this._drawFrayedEdge();
    }
  }

  /**
   * Draw a background image centered at canvas center (0,0)
   * @param {HTMLImageElement} img - The background image to draw
   * @private
   */
  _drawBackgroundImage(img) {
    const boardData = this._getBoardData();
    const scale = boardData.backgroundScale || 1.0;

    // First, draw the solid background color behind the image
    const visibleWidth = this.canvas.width / this.camera.zoom;
    const visibleHeight = this.canvas.height / this.camera.zoom;
    const visibleX = -this.camera.x / this.camera.zoom;
    const visibleY = -this.camera.y / this.camera.zoom;

    this.ctx.fillStyle = this._getBackgroundColor();
    this.ctx.fillRect(visibleX, visibleY, visibleWidth, visibleHeight);

    // Then draw the image on top at its actual dimensions scaled by the scale slider
    const scaledWidth = img.naturalWidth * scale;
    const scaledHeight = img.naturalHeight * scale;

    // Center at canvas center (0,0 in world coordinates)
    const drawX = -scaledWidth / 2;
    const drawY = -scaledHeight / 2;

    this.ctx.drawImage(img, drawX, drawY, scaledWidth, scaledHeight);
  }

  /**
   * Draw background image covering the current viewport
   * @param {HTMLImageElement} img - The background image to draw
   * @private
   */
  /**
   * Draw legal pad header bar
   * @private
   */
  _drawLegalPadHeader() {
    const headerHeight = 40;
    
    // Header background gradient (brown leather look)
    const gradient = this.ctx.createLinearGradient(0, 0, 0, headerHeight);
    gradient.addColorStop(0, '#A0804A');
    gradient.addColorStop(0.5, '#8B6F47');
    gradient.addColorStop(1, '#7A5E38');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, this.canvas.width, headerHeight);

    // Header shadow
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    this.ctx.fillRect(0, headerHeight - 2, this.canvas.width, 2);

    // "Legal Pad" text
    this.ctx.font = 'bold 16px Georgia, serif';
    this.ctx.fillStyle = '#F5F5DC';
    this.ctx.textAlign = 'left';
    this.ctx.fillText('Legal Pad', 20, headerHeight - 12);

    // "Wide" or similar text on right
    this.ctx.font = 'italic 12px Georgia, serif';
    this.ctx.fillStyle = '#D4AF9A';
    this.ctx.textAlign = 'right';
    this.ctx.fillText('Tops', this.canvas.width - 20, headerHeight - 12);
  }

  /**
   * Draw frayed/torn edge on left side (spiral notebook effect)
   * @private
   */
  _drawFrayedEdge() {
    const frayWidth = 8; // Width of the frayed area
    const frayHeight = 3; // Height of individual frays
    
    this.ctx.save();
    
    // Create a jagged/frayed edge pattern using random lines
    this.ctx.strokeStyle = 'rgba(200, 200, 200, 0.4)';
    this.ctx.lineWidth = 1;
    
    // Draw vertical frays on the left edge
    for (let y = 0; y < this.canvas.height; y += frayHeight) {
      const frayLength = Math.random() * frayWidth + 2;
      const startX = Math.random() * 2;
      
      this.ctx.beginPath();
      this.ctx.moveTo(startX, y);
      this.ctx.lineTo(frayLength, y + frayHeight * 0.5);
      this.ctx.stroke();
    }
    
    // Add spiral holes (semi-circles) on the left edge
    const holeRadius = 5;
    const holeSpacing = 20;
    const holeOffsetX = 5;
    
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0)'; // Transparent
    this.ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
    this.ctx.lineWidth = 1;
    
    for (let y = 20; y < this.canvas.height - 20; y += holeSpacing) {
      // Draw semi-circle holes (open to the left, like spiral binding)
      this.ctx.beginPath();
      this.ctx.arc(holeOffsetX, y, holeRadius, Math.PI / 2, Math.PI * 1.5);
      this.ctx.stroke();
      
      // Fill with shadow for depth
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      this.ctx.fill();
    }
    
    // Add a subtle shadow/depth along the torn edge
    const shadowGradient = this.ctx.createLinearGradient(0, 0, frayWidth, 0);
    shadowGradient.addColorStop(0, 'rgba(100, 100, 100, 0.15)');
    shadowGradient.addColorStop(1, 'rgba(100, 100, 100, 0)');
    this.ctx.fillStyle = shadowGradient;
    this.ctx.fillRect(0, 0, frayWidth, this.canvas.height);
    
    this.ctx.restore();
  }

  /**
   * Draw all connections
   * @param {Array} connections - Connection array
   * @param {Array} items - Item array
   */
  _drawConnections(connections, items) {
    connections.forEach(connection => {
      const fromItem = items.find(i => i.id === connection.fromItem);
      const toItem = items.find(i => i.id === connection.toItem);

      if (fromItem && toItem) {
        const isHovered = this.hoveredConnection && 
          this.hoveredConnection.fromItem === connection.fromItem && 
          this.hoveredConnection.toItem === connection.toItem;
        // Use connection's width if set, otherwise use default thickness of 2
        const thickness = connection.width || 2;
        this._drawConnection(fromItem, toItem, connection.color, thickness, connection.label, isHovered);
      }
    });
  }

  /**
   * Draw single connection line between two items
   * @param {Object} fromItem - Source item
   * @param {Object} toItem - Target item
   * @param {string} color - Line color
   * @param {number} thickness - Line thickness
   * @param {string} label - Connection label
   * @param {boolean} isHovered - Whether connection is hovered
   */
  _drawConnection(fromItem, toItem, color, thickness, label, isHovered = false) {
    const centerFrom = this._getItemCenter(fromItem);
    const centerTo = this._getItemCenter(toItem);
    
    // Offset endpoints to halfway between top and middle of items
    const { height: heightFrom } = this._getItemDimensions(fromItem);
    const { height: heightTo } = this._getItemDimensions(toItem);
    const offsetFrom = heightFrom / 4;
    const offsetTo = heightTo / 4;
    
    const from = { x: centerFrom.x, y: centerFrom.y - offsetFrom };
    const to = { x: centerTo.x, y: centerTo.y - offsetTo };

    // Calculate distance for sag amount (longer distance = more sag)
    const distance = Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2));
    const sagAmount = Math.min(distance * 0.15, 100); // Sag downward (gravity)
    
    // Control points for curved bezier path - sag DOWNWARD (positive Y, like gravity)
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    
    const cp1x = from.x + (to.x - from.x) * 0.25;
    const cp1y = from.y + (to.y - from.y) * 0.25 + sagAmount * 0.5;
    const cp2x = to.x - (to.x - from.x) * 0.25;
    const cp2y = to.y - (to.y - from.y) * 0.25 + sagAmount * 0.5;

    // Draw shadow beneath (darker, offset down)
    this._drawConnectionShadow(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness);

    // Draw main curved line with thickness variation and color grain
    this._drawConnectionWithVariation(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness, isHovered);

    // Draw glow effect if hovered (based on board type)
    if (isHovered) {
      this._drawConnectionGlowCurved(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness);
    }

    // Draw label if present
    if (label) {
      // Position label at a point along the curve (around 50%)
      const t = 0.5;
      const mt = 1 - t;
      const labelX = mt*mt*mt * from.x + 3*mt*mt*t * cp1x + 3*mt*t*t * cp2x + t*t*t * to.x;
      const labelY = mt*mt*mt * from.y + 3*mt*mt*t * cp1y + 3*mt*t*t * cp2y + t*t*t * to.y;
      // Offset label slightly above to avoid overlap with line
      this._drawText(label, labelX, labelY - 15, '#000000', 'center', 12);
    }
  }

  /**
   * Draw shadow beneath connection for depth effect
   */
  _drawConnectionShadow(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness) {
    const shadowOffsetY = thickness * 0.6; // Bring shadow closer
    const shadowColor = '#000000'; // Black shadow as base
    
    this.ctx.strokeStyle = this._hexToRgba(shadowColor, 0.3);
    this.ctx.lineWidth = thickness + 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y + shadowOffsetY);
    this.ctx.bezierCurveTo(cp1x, cp1y + shadowOffsetY, cp2x, cp2y + shadowOffsetY, to.x, to.y + shadowOffsetY);
    this.ctx.stroke();
  }

  /**
   * Draw main line with thickness variation and color grain
   */
  _drawConnectionWithVariation(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness, isHovered) {
    // Sample the curve at multiple points for thickness variation and color grain
    const samples = 20;
    const baseWidth = isHovered ? thickness * 1.5 : thickness;
    
    for (let i = 0; i < samples; i++) {
      const t = i / samples;
      const tNext = (i + 1) / samples;
      
      // Calculate position on curve
      const mt = 1 - t;
      const mtNext = 1 - tNext;
      const x1 = mt*mt*mt * from.x + 3*mt*mt*t * cp1x + 3*mt*t*t * cp2x + t*t*t * to.x;
      const y1 = mt*mt*mt * from.y + 3*mt*mt*t * cp1y + 3*mt*t*t * cp2y + t*t*t * to.y;
      const x2 = mtNext*mtNext*mtNext * from.x + 3*mtNext*mtNext*tNext * cp1x + 3*mtNext*tNext*tNext * cp2x + tNext*tNext*tNext * to.x;
      const y2 = mtNext*mtNext*mtNext * from.y + 3*mtNext*mtNext*tNext * cp1y + 3*mtNext*tNext*tNext * cp2y + tNext*tNext*tNext * to.y;
      
      // Vary thickness slightly (thinner at ends, thicker in middle)
      const thicknessVariation = Math.sin(t * Math.PI) * 0.3;
      const lineWidth = baseWidth * (1 + thicknessVariation);
      
      // Add color grain (slight color shifts)
      const grainShift = Math.sin(t * Math.PI * 3) * 0.08;
      const grainColor = this._adjustColorBrightness(color, grainShift);
      
      this.ctx.strokeStyle = grainColor;
      this.ctx.lineWidth = lineWidth;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }
  }

  /**
   * Darken a hex color by a factor
   */
  _darkenColor(hex, factor) {
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) * (1 - factor));
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) * (1 - factor));
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) * (1 - factor));
    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Adjust color brightness by shifting RGB values
   */
  _adjustColorBrightness(hex, amount) {
    const r = Math.max(0, Math.min(255, parseInt(hex.slice(1, 3), 16) + amount * 255));
    const g = Math.max(0, Math.min(255, parseInt(hex.slice(3, 5), 16) + amount * 255));
    const b = Math.max(0, Math.min(255, parseInt(hex.slice(5, 7), 16) + amount * 255));
    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Draw glow effect for hovered curved connection
   * @param {Object} from - Start point
   * @param {Object} to - End point
   * @param {number} cp1x - First control point X
   * @param {number} cp1y - First control point Y
   * @param {number} cp2x - Second control point X
   * @param {number} cp2y - Second control point Y
   * @param {string} color - Line color
   * @param {number} thickness - Line thickness
   * @private
   */
  _drawConnectionGlowCurved(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness) {
    this.ctx.strokeStyle = this._hexToRgba(color, 0.3);
    this.ctx.lineWidth = thickness * 4;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, to.x, to.y);
    this.ctx.stroke();
  }

  /**
   * Draw arrowhead for curved connection
   * @param {Object} from - Start point
   * @param {Object} to - End point
   * @param {number} cp1x - First control point X
   * @param {number} cp1y - First control point Y
   * @param {number} cp2x - Second control point X
   * @param {number} cp2y - Second control point Y
   * @param {string} color - Line color
   * @param {number} thickness - Line thickness
   * @param {boolean} isHovered - Whether connection is hovered
   * @private
   */
  _drawArrowheadCurved(from, to, cp1x, cp1y, cp2x, cp2y, color, thickness, isHovered) {
    // Get the tangent direction at the end of the curve (closer to destination)
    const t = 0.95; // Sample point near the end
    const mt = 1 - t;
    
    // Point on curve at t
    const px = mt*mt*mt * from.x + 3*mt*mt*t * cp1x + 3*mt*t*t * cp2x + t*t*t * to.x;
    const py = mt*mt*mt * from.y + 3*mt*mt*t * cp1y + 3*mt*t*t * cp2y + t*t*t * to.y;
    
    // Tangent direction (derivative of bezier)
    const dt = 0.01;
    const px_next = mt*mt*mt * from.x + 3*mt*mt*(t+dt) * cp1x + 3*mt*(t+dt)*(t+dt) * cp2x + (t+dt)*(t+dt)*(t+dt) * to.x;
    const py_next = mt*mt*mt * from.y + 3*mt*mt*(t+dt) * cp1y + 3*mt*(t+dt)*(t+dt) * cp2y + (t+dt)*(t+dt)*(t+dt) * to.y;
    
    const angle = Math.atan2(py_next - py, px_next - px);
    
    // Draw arrowhead
    const arrowSize = isHovered ? thickness * 3 : thickness * 2.5;
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.moveTo(to.x, to.y);
    this.ctx.lineTo(to.x - arrowSize * Math.cos(angle - 0.4), to.y - arrowSize * Math.sin(angle - 0.4));
    this.ctx.lineTo(to.x - arrowSize * Math.cos(angle + 0.4), to.y - arrowSize * Math.sin(angle + 0.4));
    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw glow effect for hovered connection (board-type specific)
   * @param {Object} from - Start point
   * @param {Object} to - End point
   * @param {string} color - Line color
   * @param {number} thickness - Line thickness
   * @private
   */
  _drawConnectionGlow(from, to, color, thickness) {
    const boardData = this._getBoardData();
    const boardType = boardData.boardType || 'whiteboard';

    // Get glow color based on board type for better visibility
    const glowStyles = {
      'chalkboard': { color: 'rgba(255, 255, 100, 0.6)', blur: 12 },
      'corkboard': { color: 'rgba(255, 200, 100, 0.6)', blur: 12 },
      'whiteboard': { color: 'rgba(100, 200, 255, 0.5)', blur: 10 },
      'blackboard': { color: 'rgba(200, 255, 200, 0.6)', blur: 12 },
    };

    const glowStyle = glowStyles[boardType] || glowStyles['whiteboard'];

    // Draw glow layers
    this.ctx.strokeStyle = glowStyle.color;
    this.ctx.lineWidth = thickness * 4;
    this.ctx.globalAlpha = 0.3;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.lineTo(to.x, to.y);
    this.ctx.stroke();

    // Middle glow layer
    this.ctx.strokeStyle = glowStyle.color;
    this.ctx.lineWidth = thickness * 2.5;
    this.ctx.globalAlpha = 0.5;
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.lineTo(to.x, to.y);
    this.ctx.stroke();

    // Reset global alpha
    this.ctx.globalAlpha = 1.0;
  }

  /**
   * Draw arrowhead at end of connection line
   * @param {Object} from - Start point
   * @param {Object} to - End point
   * @param {string} color - Arrow color
   * @param {number} thickness - Arrow thickness
   * @param {boolean} isHovered - Whether connection is hovered
   */
  _drawArrowhead(from, to, color, thickness, isHovered = false) {
    const headlen = isHovered ? 18 : 15;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.moveTo(to.x, to.y);
    this.ctx.lineTo(to.x - headlen * Math.cos(angle - Math.PI / 6), to.y - headlen * Math.sin(angle - Math.PI / 6));
    this.ctx.lineTo(to.x - headlen * Math.cos(angle + Math.PI / 6), to.y - headlen * Math.sin(angle + Math.PI / 6));
    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * Draw all items
   * Implements frustum culling to skip off-screen items for better performance
   * @param {Array} items - Item array
   */
  _drawItems(items) {
    // Create a Set from selectedItems for O(1) lookup instead of O(n)
    const selectedSet = new Set(this.selectedItems);
    if (this.selectedItem) selectedSet.add(this.selectedItem);

    items.forEach(item => {
      // Frustum culling: skip items that are completely off-screen
      if (!this._isItemInViewport(item.x, item.y, 40, 40)) {
        return; // Skip this item
      }
      
      const isSelected = selectedSet.has(item.id);
      const isHovered = item.id === this.hoveredItem;
      this._drawItem(item, isSelected, isHovered);
    });

    // Draw dragged item last (appears on top) - always draw if being dragged
    if (this.draggedItem) {
      const draggedItemData = items.find(i => i.id === this.draggedItem);
      if (draggedItemData) {
        const isSelected = selectedSet.has(this.draggedItem);
        this._drawItem(draggedItemData, isSelected, false);
      }
    }
  }

  /**
   * Draw single item
   * @param {Object} item - Item object
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   */
  _drawItem(item, selected, hovered) {
    const x = item.x || 0;
    const y = item.y || 0;
    const color = item.color || '#FFFFFF';
    
    // Check if this is one of the connection preview items
    // During drag, use draggedItem as source; otherwise use selectedItem
    const sourceItemId = this.draggedItem || this.selectedItem;
    const isConnectionSource = this.connectionPreviewMode && sourceItemId === item.id;
    const isConnectionTarget = this.connectionPreviewMode && this.connectionTargetItem === item.id;
    const isPulsingForConnection = isConnectionSource || isConnectionTarget;

    // Draw based on item type
    if (item.type === 'Note') {
      this._drawNoteItem(item, x, y, color, selected, hovered, isPulsingForConnection);
    } else if (item.type === 'Image') {
      this._drawImageItem(item, x, y, selected, hovered, isPulsingForConnection);
    } else if (item.type === 'Document') {
      this._drawDocumentItem(item, x, y, color, selected, hovered, isPulsingForConnection);
    } else if (item.type === 'Text') {
      this._drawTextItem(item, x, y, selected, hovered, isPulsingForConnection);
    } else {
      this._drawStandardItem(item, x, y, color, selected, hovered, isPulsingForConnection);
    }
  }

  /**
   * Draw border with selection/hover/pulsing effects
   * Centralizes border styling logic to reduce duplication
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Width
   * @param {number} height - Height
   * @param {boolean} selected - Whether selected
   * @param {boolean} hovered - Whether hovered
   * @param {boolean} isPulsing - Whether pulsing
   * @private
   */
  _drawItemBorder(x, y, width, height, selected, hovered, isPulsing) {
    // Don't draw any border for unselected, unhovered items
    if (!selected && !hovered && !isPulsing) {
      return;
    }
    
    let borderColor = selected ? '#EE5A52' : (hovered ? '#FFD700' : 'rgba(0, 0, 0, 0.2)');
    let borderWidth = selected ? 2 : (hovered ? 1.5 : 1);
    
    if (isPulsing) {
      const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
      borderColor = `rgba(150, 100, 255, ${0.5 + pulse * 0.5})`;
      borderWidth = 3;
    }
    
    this.ctx.strokeStyle = borderColor;
    this.ctx.lineWidth = borderWidth;
    this.ctx.strokeRect(x, y, width, height);
  }

  /**
   * Draw item with rotation applied to canvas context
   * Centralizes rotation/translation logic
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Item width
   * @param {number} height - Item height
   * @private
   */
  _applyItemRotation(item, x, y, width, height) {
    if (!item.rotation) return;
    
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const rotationRad = (item.rotation * Math.PI) / 180;
    
    this.ctx.translate(centerX, centerY);
    this.ctx.rotate(rotationRad);
    this.ctx.translate(-centerX, -centerY);
  }

  /**
   * Draw standard item border (with contrast color for standard items)
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Width
   * @param {number} height - Height
   * @param {string} color - Background color for contrast calculation
   * @param {boolean} selected - Whether selected
   * @param {boolean} hovered - Whether hovered
   * @param {boolean} isPulsing - Whether pulsing
   * @private
   */
  _drawStandardItemBorder(x, y, width, height, color, selected, hovered, isPulsing) {
    let borderColor = selected ? '#EE5A52' : (hovered ? '#FFD700' : '#333333');
    let borderWidth = selected ? 2 : (hovered ? 1.5 : 1);
    
    if (isPulsing) {
      const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
      borderColor = `rgba(150, 100, 255, ${0.5 + pulse * 0.5})`;
      borderWidth = 3;
    }
    
    this.ctx.strokeStyle = borderColor;
    this.ctx.lineWidth = borderWidth;
    this.ctx.strokeRect(x, y, width, height);
  }

  /**
   * Draw a Note item as a realistic post-it note
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string} color - Post-it color
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   * @param {boolean} isPulsing - Whether item is pulsing for connection
   * @private
   */
  _drawNoteItem(item, x, y, color, selected, hovered, isPulsing = false) {
    this.ctx.save();
    
    // Apply rotation
    this._applyItemRotation(item, x, y, this.itemSize, this.itemSize);

    // Draw shadow (rotates with item) unless disabled
    if (item.data?.shadow !== 'none') {
      this._drawItemShadow(x, y);
    }

    // Draw post-it background
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, this.itemSize, this.itemSize);

    // Draw border using centralized helper
    this._drawItemBorder(x, y, this.itemSize, this.itemSize, selected, hovered, isPulsing);

    // Draw text
    const textColor = item.data?.textColor || '#000000';
    const font = item.data?.font || 'Arial';
    
    if (item.label) {
      const textX = x + this.itemSize / 2;
      const textY = y + this.itemSize / 2;
      const maxWidth = this.itemSize - 4;
      this._drawWrappedText(item.label, textX, textY, textColor, 'center', 10, maxWidth, font, this.itemSize - 4);
    }

    this.ctx.restore();
  }

  /**
   * Draw a Text item as simple text without background
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   * @param {boolean} isPulsing - Whether item is pulsing for connection
   * @private
   */
  _drawTextItem(item, x, y, selected, hovered, isPulsing = false) {
    const itemWidth = item.data?.width || this.itemSize;
    const itemHeight = item.data?.height || this.itemSize;

    this.ctx.save();

    // Apply rotation
    this._applyItemRotation(item, x, y, itemWidth, itemHeight);

    // Draw border using centralized helper
    this._drawItemBorder(x, y, itemWidth, itemHeight, selected, hovered, isPulsing);

    // Draw resize handles for selected items
    if (selected) {
      this._drawResizeHandles(x, y, itemWidth, itemHeight, item.rotation || 0);
    }

    // Draw text
    const textColor = item.data?.textColor || '#000000';
    const font = item.data?.font || 'Arial';
    const fontSize = item.data?.fontSize || 14;

    if (item.label) {
      const textX = x + itemWidth / 2;
      const textY = y + itemHeight / 2;
      const maxWidth = itemWidth - 8;
      const maxHeight = itemHeight - 8;
      this._drawWrappedText(item.label, textX, textY, textColor, 'center', fontSize, maxWidth, font, maxHeight);
    }

    this.ctx.restore();
  }

  /**
   * Draw resize handles for resizable items
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Item width
   * @param {number} height - Item height
   * @param {number} rotation - Rotation in degrees (for backwards compatibility, but ignored since context is pre-rotated)
   * @private
   */
  _drawResizeHandles(x, y, width, height, rotation = 0) {
    const handleSize = 6;
    this.ctx.fillStyle = '#EE5A52'; // Red handles to match selection color

    // Since the context is already rotated in _drawTextItem, draw handles at standard positions
    // They will appear rotated because the context transformation includes rotation
    this.ctx.fillRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize); // Top-left
    this.ctx.fillRect(x + width - handleSize/2, y - handleSize/2, handleSize, handleSize); // Top-right
    this.ctx.fillRect(x - handleSize/2, y + height - handleSize/2, handleSize, handleSize); // Bottom-left
    this.ctx.fillRect(x + width - handleSize/2, y + height - handleSize/2, handleSize, handleSize); // Bottom-right
  }

  /**
   * Draw image item with preset size and border options
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   * @private
   */
  _drawImageItem(item, x, y, selected, hovered, isPulsing = false) {
    let preset = item.data?.preset || 'medium';
    let presetConfig = this.imagePresets[preset];
    
    if (!presetConfig) {
      // Fallback to standard item if preset not found
      this._drawStandardItem(item, x, y, '#CCCCCC', selected, hovered, isPulsing);
      return;
    }

    const { longEdge, borderWidth, isPolaroid, bottomMargin } = presetConfig;
    const borderColor = item.data?.borderColor || 'white';
    
    // Determine actual border color
    let borderFillColor = '#FFFFFF'; // white default
    if (borderColor === 'black') {
      borderFillColor = '#000000';
    } else if (borderColor === 'none') {
      borderFillColor = null;
    }

    // Calculate display dimensions based on image aspect ratio
    let width, height;
    if (item.data?.imageUrl && this.imageCache.has(item.data.imageUrl)) {
      const cachedImg = this.imageCache.get(item.data.imageUrl);
      if (cachedImg) {
        const imgAspect = cachedImg.width / cachedImg.height;
        // Determine which dimension is the long edge
        if (imgAspect >= 1) {
          // Landscape: width is long edge
          width = longEdge;
          height = longEdge / imgAspect;
        } else {
          // Portrait: height is long edge
          height = longEdge;
          width = longEdge * imgAspect;
        }
      } else {
        // Default to square if image not loaded yet
        width = longEdge;
        height = longEdge;
      }
    } else {
      // Default to square if no image URL
      width = longEdge;
      height = longEdge;
    }

    // For Polaroid, add extra bottom margin
    let totalHeight = height;
    if (isPolaroid && bottomMargin) {
      totalHeight = height + bottomMargin;
    }

    this.ctx.save();

    // Apply rotation if present
    if (item.rotation) {
      const centerX = x + width / 2;
      const centerY = y + totalHeight / 2;
      const rotationRad = (item.rotation * Math.PI) / 180;
      this.ctx.translate(centerX, centerY);
      this.ctx.rotate(rotationRad);
      this.ctx.translate(-centerX, -centerY);
    }

    // Draw shadow with image dimensions (now rotates with image) - unless shadow is disabled
    if (item.data?.shadow !== 'none') {
      this._drawImageShadow(x, y, width, totalHeight);
    }

    // Draw border if not "none"
    if (borderFillColor !== null) {
      this.ctx.fillStyle = borderFillColor;
      this.ctx.fillRect(x, y, width, totalHeight);
    }

    // Calculate image area (full size if no border, reduced by border width if border exists)
    const hasBorder = borderFillColor !== null;
    const imgX = hasBorder ? x + borderWidth : x;
    const imgY = hasBorder ? y + borderWidth : y;
    const imgWidth = hasBorder ? width - borderWidth * 2 : width;
    const imgHeight = hasBorder ? height - borderWidth * 2 : height;  // Note: use original height, not totalHeight

    // Draw placeholder or image
    if (item.data?.imageUrl) {
      const imageUrl = item.data.imageUrl;
      
      // Check if image is already cached
      if (this.imageCache.has(imageUrl)) {
        const cachedImg = this.imageCache.get(imageUrl);
        if (cachedImg) {
          // Draw cached image
          const imgAspect = cachedImg.width / cachedImg.height;
          const areaAspect = imgWidth / imgHeight;
          let drawWidth, drawHeight, drawX, drawY;

          if (imgAspect > areaAspect) {
            drawWidth = imgWidth;
            drawHeight = imgWidth / imgAspect;
          } else {
            drawHeight = imgHeight;
            drawWidth = imgHeight * imgAspect;
          }

          drawX = imgX + (imgWidth - drawWidth) / 2;
          drawY = imgY + (imgHeight - drawHeight) / 2;

          this.ctx.drawImage(cachedImg, drawX, drawY, drawWidth, drawHeight);
        }
      } else {
        // Load and cache image (only if not already loading)
        if (!this.imageLoadingSet.has(imageUrl)) {
          this.imageLoadingSet.add(imageUrl); // Mark as loading
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            this.imageCache.set(imageUrl, img);
            this.imageLoadingSet.delete(imageUrl); // Mark as no longer loading
            // Mark as dirty to redraw
            this.isDirty = true;
          };
          img.onerror = () => {
            console.warn('Murder Board | Failed to load image:', imageUrl);
            this.imageCache.set(imageUrl, null); // Cache failure to avoid retrying
            this.imageLoadingSet.delete(imageUrl); // Mark as no longer loading
          };
          img.src = imageUrl;
        }

        // Draw placeholder background while loading
        this.ctx.fillStyle = '#E8E8E8';
        this.ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
        this.ctx.fillStyle = '#999999';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText('Loading...', imgX + imgWidth / 2, imgY + imgHeight / 2);
      }
    } else {
      // No image - draw placeholder
      this.ctx.fillStyle = '#F0F0F0';
      this.ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
      this.ctx.fillStyle = '#999999';
      this.ctx.font = '12px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('No Image', imgX + imgWidth / 2, imgY + imgHeight / 2);
    }

    // Draw selection/hover border
    let selectionBorderColor = selected ? '#EE5A52' : '#FFD700';
    let selectionBorderWidth = selected ? 2 : 1.5;
    
    if (isPulsing) {
      const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
      selectionBorderColor = `rgba(150, 100, 255, ${0.5 + pulse * 0.5})`; // Purple pulsing
      selectionBorderWidth = 3;
    }
    
    if (selected || hovered || isPulsing) {
      this.ctx.strokeStyle = selectionBorderColor;
      this.ctx.lineWidth = selectionBorderWidth;
      this.ctx.strokeRect(x - 1, y - 1, width + 2, totalHeight + 2);
    }

    // Draw fasteners before restore so they appear on top
    const fastenerType = item.data?.fastenerType || 'pushpin';
    this._drawFasteners(x, y, width, totalHeight, fastenerType);

    this.ctx.restore();
  }

  /**
   * Draw fasteners on image based on type
   * @param {number} x - Image X position
   * @param {number} y - Image Y position
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {string} fastenerType - Type of fastener (pushpin, tape-top, tape-top-bottom, tape-all-corners)
   * @private
   */
  _drawFasteners(x, y, width, height, fastenerType) {
    const tapeWidth = 14;
    const tapeHeight = 8;
    const tapeOverlap = 4;

    if (fastenerType === 'pushpin') {
      // Draw single pushpin at top center with slight angle
      const pinX = x + width / 2;
      const pinY = y - 4;
      this._drawPushpin(pinX, pinY);
    } else if (fastenerType === 'tape-top') {
      // Draw tape strip at top (overlapping image)
      const tapeX = x + width / 2 - tapeWidth / 2;
      const tapeY = y - tapeOverlap;
      this._drawTape(tapeX, tapeY, tapeWidth, tapeHeight);
    } else if (fastenerType === 'tape-top-bottom') {
      // Draw tape strips at top and bottom (overlapping)
      const topTapeX = x + width / 2 - tapeWidth / 2;
      const topTapeY = y - tapeOverlap;
      this._drawTape(topTapeX, topTapeY, tapeWidth, tapeHeight);
      
      const bottomTapeX = x + width / 2 - tapeWidth / 2;
      const bottomTapeY = y + height - tapeHeight + tapeOverlap;
      this._drawTape(bottomTapeX, bottomTapeY, tapeWidth, tapeHeight);
    } else if (fastenerType === 'tape-all-corners') {
      // Draw tape at all four corners (overlapping)
      this.ctx.save();
      
      const corners = [
        { x: x - tapeWidth / 2 + 2, y: y - tapeHeight / 2 + 2, angle: -0.2 },              // top-left
        { x: x + width - tapeWidth / 2 - 2, y: y - tapeHeight / 2 + 2, angle: 0.2 },      // top-right
        { x: x - tapeWidth / 2 + 2, y: y + height - tapeHeight / 2 - 2, angle: 0.2 },     // bottom-left
        { x: x + width - tapeWidth / 2 - 2, y: y + height - tapeHeight / 2 - 2, angle: -0.2 } // bottom-right
      ];

      corners.forEach(corner => {
        this.ctx.save();
        this.ctx.translate(corner.x + tapeWidth / 2, corner.y + tapeHeight / 2);
        this.ctx.rotate(corner.angle);
        this._drawTape(-tapeWidth / 2, -tapeHeight / 2, tapeWidth, tapeHeight);
        this.ctx.restore();
      });

      this.ctx.restore();
    }
  }

  /**
   * Draw tape fastener
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Tape width
   * @param {number} height - Tape height
   * @private
   */
  _drawTape(x, y, width, height) {
    // Main tape color (tan/beige with slight transparency)
    this.ctx.fillStyle = 'rgba(220, 200, 160, 0.8)';
    this.ctx.fillRect(x, y, width, height);

    // Tape border/edge
    this.ctx.strokeStyle = 'rgba(180, 160, 120, 0.6)';
    this.ctx.lineWidth = 0.5;
    this.ctx.strokeRect(x, y, width, height);

    // Subtle shadow on left edge
    this.ctx.fillStyle = 'rgba(150, 130, 100, 0.2)';
    this.ctx.fillRect(x, y, 1, height);

    // Subtle highlight on right edge
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    this.ctx.fillRect(x + width - 1, y, 1, height);
  }

  /**
   * Draw a pushpin fastener with better design and angle
   * @param {number} x - X position
   * @param {number} y - Y position
   * @private
   */
  _drawPushpin(x, y) {
    this.ctx.save();
    
    // Rotate for slight angle
    this.ctx.translate(x, y);
    this.ctx.rotate(-0.15); // Slight angle (about -8.6 degrees)
    this.ctx.translate(-x, -y);

    // Pin head shadow
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    this.ctx.beginPath();
    this.ctx.arc(x + 0.5, y + 0.5, 3, 0, Math.PI * 2);
    this.ctx.fill();

    // Main pin head (red)
    this.ctx.fillStyle = '#E74C3C';
    this.ctx.beginPath();
    this.ctx.arc(x, y, 3, 0, Math.PI * 2);
    this.ctx.fill();

    // Pin head highlight (shiny top)
    this.ctx.fillStyle = 'rgba(255, 200, 200, 0.5)';
    this.ctx.beginPath();
    this.ctx.arc(x - 1, y - 1, 1.2, 0, Math.PI * 2);
    this.ctx.fill();

    // Pin head dark edge
    this.ctx.strokeStyle = 'rgba(139, 35, 35, 0.6)';
    this.ctx.lineWidth = 0.6;
    this.ctx.beginPath();
    this.ctx.arc(x, y, 3, 0, Math.PI * 2);
    this.ctx.stroke();

    // Pin shaft (tapers down)
    this.ctx.strokeStyle = '#555555';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y + 2.5);
    this.ctx.lineTo(x + 0.25, y + 7);
    this.ctx.stroke();

    // Shaft highlight
    this.ctx.strokeStyle = '#888888';
    this.ctx.lineWidth = 0.4;
    this.ctx.beginPath();
    this.ctx.moveTo(x - 0.5, y + 2.5);
    this.ctx.lineTo(x - 0.25, y + 7);
    this.ctx.stroke();

    // Pin tip
    this.ctx.fillStyle = '#333333';
    this.ctx.beginPath();
    this.ctx.moveTo(x + 0.25, y + 7);
    this.ctx.lineTo(x - 0.25, y + 7);
    this.ctx.lineTo(x, y + 8);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  /**
   * Draw standard item (non-Note)
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string} color - Item color
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   * @private
   */
  /**
   * Draw a Document item with styled paper background
   * @param {Object} item - Item object
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string} color - Document color (used as base color for legal pad)
   * @param {boolean} selected - Whether item is selected
   * @param {boolean} hovered - Whether item is hovered
   * @private
   */
  _drawDocumentItem(item, x, y, color, selected, hovered, isPulsing = false) {
    const preset = item.data?.preset || 'blank';
    const size = item.data?.size || 'medium';
    const rotation = (item.rotation || 0) * (Math.PI / 180); // Convert to radians
    const presetConfig = this.documentPresets[preset];
    const sizeConfig = this.documentSizes[size];

    if (!presetConfig || !sizeConfig) {
      // Fallback to standard item if preset or size not found
      this._drawStandardItem(item, x, y, color, selected, hovered);
      return;
    }

    const { width, height } = sizeConfig;

    this.ctx.save();

    // Apply rotation around center
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    this.ctx.translate(centerX, centerY);
    this.ctx.rotate(rotation);
    this.ctx.translate(-centerX, -centerY);

    // Draw shadow - unless shadow is disabled
    if (item.data?.shadow !== 'none') {
      this._drawDocumentShadow(x, y, width, height);
    }

    // Determine background color
    let backgroundColor = color;
    if (preset === 'legal') {
      backgroundColor = color || '#FFFF89'; // Legal pad yellow - default color
    } else if (preset === 'spiral') {
      backgroundColor = color || '#F5F5F5'; // Light gray for spiral notebook
    } else {
      backgroundColor = color || '#FFFFFF'; // White default
    }

    // Draw background
    this.ctx.fillStyle = backgroundColor;
    this.ctx.fillRect(x, y, width, height);

    // Draw grid pattern if applicable
    if (presetConfig.hasGrid && presetConfig.gridColor) {
      this._drawDocumentGridScalable(x, y, width, height, presetConfig.gridColor, presetConfig.gridSize);
    }

    // Draw lines if applicable
    if (presetConfig.hasLines && presetConfig.lineColor) {
      const drawHoles = presetConfig.drawMarginHoles !== false; // Default true for backwards compatibility
      this._drawDocumentLinesScalable(x, y, width, height, presetConfig.lineColor, presetConfig.lineSpacing, presetConfig.marginLeft || 0, presetConfig.marginLineColor || '#000000', drawHoles);
    }

    // Draw spiral binding if applicable
    if (presetConfig.hasSpiral) {
      this._drawSpiralBindingScalable(x, y, height);
    }

    // Draw document effects if applicable
    const effect = item.data?.effect || 'none';
    const effectIntensity = item.data?.effectIntensity || 1;
    const effectSeed = item.data?.effectSeed || 50;
    if (this.documentEffects[effect]) {
      this.documentEffects[effect].apply(x, y, width, height, this.ctx, this.scene, effectIntensity, effectSeed);
    }

    // Draw border (skip for spiral notebooks)
    if (!presetConfig.hasSpiral) {
      this.ctx.strokeStyle = presetConfig.borderColor || '#000000';
      this.ctx.lineWidth = presetConfig.borderWidth || 2;
      this.ctx.strokeRect(x, y, width, height);
    }

    // Draw text (rotates with document)
    // For Document items, use data.text; otherwise use label
    const displayText = item.type === 'Document' ? (item.data?.text || item.label) : item.label;
    if (displayText) {
      const textX = x + width / 2;
      const textY = y + height / 2;
      const textColor = this._getContrastColor(backgroundColor);
      const margin = presetConfig.marginLeft || 0;
      const font = item.data?.font || 'Arial';
      const marginRight = presetConfig.marginRight || 1;
      // Pass full width, let the function handle margins
      this._drawDocumentTextScalable(displayText, textX, textY, textColor, x, y + 4, width, height - 8, font, margin, marginRight);
    }

    // Draw selection/hover border
    let borderColor = selected ? '#EE5A52' : '#FFD700';
    let borderWidth = selected ? 2 : 1.5;
    
    if (isPulsing) {
      const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
      borderColor = `rgba(150, 100, 255, ${0.5 + pulse * 0.5})`; // Purple pulsing
      borderWidth = 3;
    }
    
    if (selected || hovered || isPulsing) {
      this.ctx.strokeStyle = borderColor;
      this.ctx.lineWidth = borderWidth;
      this.ctx.strokeRect(x - 1, y - 1, width + 2, height + 2);
    }

    // Draw fasteners before restore so they appear on top
    const fastenerType = item.data?.fastenerType || 'pushpin';
    this._drawFasteners(x, y, width, height, fastenerType);

    this.ctx.restore();
  }

  /**
   * Draw shadow for documents
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @private
   */
  _drawDocumentShadow(x, y, width, height) {
    // Outer soft shadow - layered blur effect
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    this.ctx.fillRect(x + 2, y + 3, width, height);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
    this.ctx.fillRect(x + 1.5, y + 2.5, width, height);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
    this.ctx.fillRect(x + 1, y + 2, width, height);

    // Inner shadow highlight (top-left edge)
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }

  /**
   * Apply crumpled effect to document
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {Scene} scene - Scene for seeding
   * @param {number} intensity - Effect intensity (1 = normal, 2+ = more intense)
   * @private
   */
  _applyEffect_Crumpled(x, y, width, height, ctx, scene, intensity = 1, seed = 50) {
    // Save context and create clipping region to keep effect inside bounds
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    
    // Use scene ID combined with user seed for consistent but variable texture
    const sceneSeed = scene?.id?.charCodeAt(0) || 1;
    const combinedSeed = sceneSeed * 1000 + seed;
    const random = (i) => Math.sin(combinedSeed * 12.9898 + i * 78.233) * 43758.5453 % 1;
    
    // Scale effect to fit within document with small margin
    const margin = 2;
    const effectX = x + margin;
    const effectY = y + margin;
    const effectWidth = width - margin * 2;
    const effectHeight = height - margin * 2;
    
    // Draw multiple layers of wrinkle lines for depth
    const layers = 2 + Math.floor(intensity);
    for (let layer = 0; layer < layers; layer++) {
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.02 + layer * 0.01 * intensity})`;
      ctx.lineWidth = 0.5 + layer * 0.3 * intensity;
      
      // More wrinkles for higher intensity
      const lineCount = (15 + Math.floor(random(layer * 1000) * 5)) * intensity;
      for (let i = 0; i < lineCount; i++) {
        const startX = effectX + random(layer * 10000 + i * 100) * effectWidth;
        const startY = effectY + random(layer * 20000 + i * 200) * effectHeight;
        const angle = random(layer * 30000 + i * 300) * Math.PI * 2;
        const length = (15 + random(layer * 40000 + i * 400) * effectWidth * 0.25) * intensity;
        
        const endX = startX + Math.cos(angle) * length;
        const endY = startY + Math.sin(angle) * length;
        
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
    }
    
    // Add triangle-based shadow variations for organic depth and crumpling effect
    const triangleResolution = 12;
    const triangleCount = Math.ceil((effectWidth / triangleResolution) * (effectHeight / triangleResolution) * 1.5) * intensity;
    
    for (let t = 0; t < triangleCount; t++) {
      // Deterministic random positions based on seed
      const baseX = effectX + random(t * 100) * effectWidth;
      const baseY = effectY + random(t * 100 + 1000) * effectHeight;
      
      // Random triangle size (varies with intensity)
      const triangleSize = 4 + random(t * 100 + 2000) * (10 * intensity);
      
      // Generate three random vertices for organic triangles
      const angle1 = random(t * 100 + 3000) * Math.PI * 2;
      const angle2 = random(t * 100 + 4000) * Math.PI * 2;
      const angle3 = random(t * 100 + 5000) * Math.PI * 2;
      
      const p1x = baseX + Math.cos(angle1) * triangleSize;
      const p1y = baseY + Math.sin(angle1) * triangleSize;
      const p2x = baseX + Math.cos(angle2) * triangleSize;
      const p2y = baseY + Math.sin(angle2) * triangleSize;
      const p3x = baseX + Math.cos(angle3) * triangleSize * 0.7;
      const p3y = baseY + Math.sin(angle3) * triangleSize * 0.7;
      
      // Vary opacity for depth effect
      const depth = random(t * 100 + 6000);
      const opacity = (0.02 + depth * 0.06) * intensity;
      
      ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.lineTo(p3x, p3y);
      ctx.closePath();
      ctx.fill();
      
      // Add subtle triangle stroke for edge definition
      if (intensity > 2) {
        ctx.strokeStyle = `rgba(0, 0, 0, ${opacity * 0.5})`;
        ctx.lineWidth = 0.3;
        ctx.stroke();
      }
    }
    
    // Restore context (removes clipping)
    ctx.restore();
  }

  /**
   * Apply torn effect to document
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {Scene} scene - Scene for seeding
   * @param {number} intensity - Effect intensity (1-4)
   * @param {number} seed - Seed for variation (0-100)
   * @private
   */
  _applyEffect_Torn(x, y, width, height, ctx, scene, intensity = 1, seed = 50) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    
    // Use scene ID combined with user seed for consistent but variable texture
    const sceneSeed = scene?.id?.charCodeAt(0) || 1;
    const combinedSeed = sceneSeed * 1000 + seed;
    const random = (i) => Math.sin(combinedSeed * 12.9898 + i * 78.233) * 43758.5453 % 1;
    
    // Draw ragged torn edges - scale damage based on intensity
    const edgeDamage = 4 * intensity;
    const sides = [
      { start: [x, y], end: [x + width, y], axis: 0 }, // Top
      { start: [x + width, y], end: [x + width, y + height], axis: 1 }, // Right
      { start: [x + width, y + height], end: [x, y + height], axis: 0 }, // Bottom
      { start: [x, y + height], end: [x, y], axis: 1 }, // Left
    ];
    
    for (let s = 0; s < sides.length; s++) {
      const side = sides[s];
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      
      const isHorizontal = side.axis === 0;
      const length = isHorizontal ? width : height;
      const stepSize = 5;
      
      for (let i = 0; i <= length; i += stepSize) {
        const t = i / length;
        const damage = random(s * 1000 + i) * edgeDamage;
        
        if (isHorizontal) {
          const px = side.start[0] + (side.end[0] - side.start[0]) * t;
          const py = side.start[1] + damage * (s % 2 === 0 ? 1 : -1);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        } else {
          const px = side.start[0] + damage * (s % 2 === 0 ? 1 : -1);
          const py = side.start[1] + (side.end[1] - side.start[1]) * t;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }
    
    ctx.restore();
  }

  /**
   * Apply burned effect to document
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {Scene} scene - Scene for seeding
   * @param {number} intensity - Effect intensity (1-4)
   * @param {number} seed - Effect seed (0-100) for repeatable variation
   * @private
   */
  _applyEffect_Burned(x, y, width, height, ctx, scene, intensity = 1, seed = 50) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    
    // Use scene ID combined with user seed for consistent but variable texture
    const sceneSeed = scene?.id?.charCodeAt(0) || 1;
    const combinedSeed = sceneSeed * 1000 + seed;
    const random = (i) => Math.sin(combinedSeed * 12.9898 + i * 78.233) * 43758.5453 % 1;
    
    // Add burn marks and darkening - scale based on intensity
    const burnSpots = Math.floor((8 + Math.floor(random(1000) * 4)) * intensity);
    for (let i = 0; i < burnSpots; i++) {
      const bx = x + random(2000 + i * 100) * width;
      const by = y + random(3000 + i * 100) * height;
      const radius = Math.max(1, (3 + random(4000 + i * 100) * 8) * intensity);
      
      // Burn mark gradient - more intense with higher intensity (clamped to 0-1)
      const innerOpacity = Math.min(1, 0.4 * intensity);
      const outerOpacity = Math.min(1, 0.1 * intensity);
      const gradient = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
      gradient.addColorStop(0, `rgba(50, 30, 10, ${innerOpacity})`);
      gradient.addColorStop(1, `rgba(30, 20, 5, ${outerOpacity})`);
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(bx, by, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Add edge darkening (burned edges) - scale based on intensity (clamped to 0-1)
    const edgeOpacity = Math.min(1, 0.15 * intensity);
    const edgeGradient = ctx.createLinearGradient(x, y, x + width, y);
    edgeGradient.addColorStop(0, `rgba(40, 25, 5, ${edgeOpacity})`);
    edgeGradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    edgeGradient.addColorStop(1, `rgba(40, 25, 5, ${edgeOpacity})`);
    ctx.fillStyle = edgeGradient;
    ctx.fillRect(x, y, width, height);
    
    ctx.restore();
  }

  /**
   * Draw scalable grid pattern for document
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @param {string} color - Grid line color
   * @param {number} size - Grid cell size
   * @private
   */
  _drawDocumentGridScalable(x, y, width, height, color, size) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 0.5;

    const marginLeft = 4;
    const marginRight = 4;
    const contentWidth = width - marginLeft - marginRight;

    // Vertical lines
    for (let i = 0; i <= contentWidth; i += size) {
      this.ctx.beginPath();
      this.ctx.moveTo(x + marginLeft + i, y);
      this.ctx.lineTo(x + marginLeft + i, y + height);
      this.ctx.stroke();
    }

    // Horizontal lines
    for (let i = 0; i <= height; i += size) {
      this.ctx.beginPath();
      this.ctx.moveTo(x + marginLeft, y + i);
      this.ctx.lineTo(x + width - marginRight, y + i);
      this.ctx.stroke();
    }
  }

  /**
   * Draw horizontal lines for scalable document
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Document width
   * @param {number} height - Document height
   * @param {string} color - Line color
   * @param {number} spacing - Space between lines
   * @param {number} marginLeft - Left margin where lines start
   * @private
   */
  _drawDocumentLinesScalable(x, y, width, height, color, spacing, marginLeft = 0, marginLineColor = '#000000', drawHoles = true) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 0.5;

    // Get margin right from document preset (if available)
    const marginRight = 4; // Default right margin

    for (let i = spacing; i < height; i += spacing) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, y + i); // Start from left edge
      this.ctx.lineTo(x + width - marginRight, y + i); // Extend across
      this.ctx.stroke();
    }

    // Draw left margin line if present
    if (marginLeft > 0) {
      this.ctx.strokeStyle = marginLineColor;
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(x + marginLeft, y);
      this.ctx.lineTo(x + marginLeft, y + height);
      this.ctx.stroke();

      // Draw three hole punches in the margin (standard US 3-hole punch spacing)
      if (drawHoles) {
        const holeRadius = 1.2;
        const holeX = x + marginLeft / 2; // Center between edge and margin line
        
        // Divide height into thirds for three holes, centered
        const topHole = y + height * 0.25;
        const middleHole = y + height * 0.5;
        const bottomHole = y + height * 0.75;
        
        this.ctx.fillStyle = '#D3D3D3'; // Light gray for holes
        this.ctx.strokeStyle = '#999999';
        this.ctx.lineWidth = 0.5;

        for (let holeY of [topHole, middleHole, bottomHole]) {
          this.ctx.beginPath();
          this.ctx.arc(holeX, holeY, holeRadius, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
        }
      }
    }
  }

  /**
   * Draw spiral binding on left side (scalable)
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} height - Document height
   * @private
   */
  _drawSpiralBindingScalable(x, y, height) {
    const spiralX = x + 2;
    const spiralRadius = 2;
    const spacing = 4;
    const startY = y + 2; // Moved down 2px

    this.ctx.strokeStyle = '#999999';
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = '#AAAAAA';

    for (let i = 0; i < height; i += spacing) {
      this.ctx.beginPath();
      this.ctx.arc(spiralX, startY + i, spiralRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
    }
  }

  /**
   * Draw text on scalable document with wrapping
   * @param {string} text - Text to draw
   * @param {number} cx - Center X
   * @param {number} cy - Center Y
   * @param {string} color - Text color
   * @param {number} x - Left boundary (document left edge)
   * @param {number} y - Top boundary
   * @param {number} width - Full document width
   * @param {number} height - Available height
   * @param {string} fontFamily - Font family to use
   * @param {number} marginLeft - Left margin
   * @param {number} marginRight - Right margin
   * @private
   */
  _drawDocumentTextScalable(text, cx, cy, color, x, y, width, height, fontFamily = 'Arial', marginLeft = 0, marginRight = 1) {
    // Create cache key for this text layout
    const cacheKey = `${text}|${width}|${height}|${fontFamily}|${marginLeft}|${marginRight}`;
    let layout = this.textLayoutCache.get(cacheKey);

    // If layout not cached, calculate it
    if (!layout) {
      layout = this._calculateTextLayout(text, width, height, fontFamily, marginLeft, marginRight);
      this.textLayoutCache.set(cacheKey, layout);
      
      // Limit cache size to prevent memory bloat
      if (this.textLayoutCache.size > 50) {
        const firstKey = this.textLayoutCache.keys().next().value;
        this.textLayoutCache.delete(firstKey);
      }
    }

    // Draw cached text layout with bold weight
    this.ctx.fillStyle = color;
    this.ctx.font = `bold ${layout.fontSize}px ${fontFamily}`;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    const lineHeight = layout.fontSize * 1.2;
    const totalHeight = layout.lines.length * lineHeight;
    let startY = y + (height - totalHeight) / 2;

    layout.lines.forEach((line, index) => {
      const lineY = startY + index * lineHeight;
      this.ctx.fillText(line, x + marginLeft + 2, lineY);
    });
  }

  /**
   * Calculate text layout (line wrapping and font size)
   * @param {string} text - Text to wrap
   * @param {number} width - Full document width
   * @param {number} height - Available height
   * @param {string} fontFamily - Font family
   * @param {number} marginLeft - Left margin
   * @param {number} marginRight - Right margin
   * @returns {Object} Layout object with fontSize and lines array
   * @private
   */
  _calculateTextLayout(text, width, height, fontFamily, marginLeft, marginRight) {
    // Create cache key
    const cacheKey = `${text}|${width}|${height}|${fontFamily}|${marginLeft}|${marginRight}`;
    if (this.textMeasureCache.has(cacheKey)) {
      return this.textMeasureCache.get(cacheKey);
    }

    const maxWidth = Math.max(width - marginLeft - marginRight, 20);
    const maxHeight = height;
    const minFontSize = 2; // Reduced further for 75% scaling
    
    // Scale initial font size based on document size, then scale to 75% (multiply by 0.75)
    // Larger documents get larger starting font size
    // Formula: scale the font size proportionally to document dimensions, then multiply by 0.75
    const sizeRatio = (width + height) / 200; // 200 is reference size for medium document
    let currentSize = Math.max(minFontSize + 1, Math.round((10 * sizeRatio * 0.75) / 2)); // 75% scaling
    
    let lines = [];
    let fits = false;

    // Try decreasing font size until text fits (step by 1 for more precision with smaller sizes)
    while (currentSize >= minFontSize && !fits) {
      this.ctx.fillStyle = '#000000';
      this.ctx.font = `bold ${currentSize}px ${fontFamily}`;
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'top';

      // Split text by line breaks first, then wrap each line by words
      const paragraphs = text.split('\n');
      lines = [];
      
      for (let paragraph of paragraphs) {
        if (!paragraph.trim()) {
          // Empty line - add as-is to preserve spacing
          lines.push('');
          continue;
        }
        
        // Split paragraph into words and wrap
        const words = paragraph.split(' ');
        let currentLine = '';

        for (let word of words) {
          const testLine = currentLine + (currentLine ? ' ' : '') + word;
          const metrics = this.ctx.measureText(testLine);

          if (metrics.width > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }

        if (currentLine) {
          lines.push(currentLine);
        }
      }

      // Check if text fits vertically
      const lineHeight = currentSize * 1.2;
      const totalHeight = lines.length * lineHeight;

      if (totalHeight <= maxHeight) {
        fits = true;
      } else {
        currentSize -= 1; // Decrease by 1 for more granular control with smaller sizes
      }
    }

    const result = {
      fontSize: currentSize,
      lines: lines
    };
    
    // Cache the result (limit cache size to prevent memory issues)
    if (this.textMeasureCache.size > 200) {
      const firstKey = this.textMeasureCache.keys().next().value;
      this.textMeasureCache.delete(firstKey);
    }
    this.textMeasureCache.set(cacheKey, result);
    
    return result;
  }

  _drawStandardItem(item, x, y, color, selected, hovered, isPulsing = false) {
    this.ctx.save();

    // Apply rotation
    this._applyItemRotation(item, x, y, this.itemSize, this.itemSize);

    // Draw shadow (rotates with item) unless disabled
    if (item.data?.shadow !== 'none') {
      this._drawItemShadow(x, y);
    }

    // Draw item rectangle
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, this.itemSize, this.itemSize);

    // Draw border using standard item helper (with contrast color)
    this._drawStandardItemBorder(x, y, this.itemSize, this.itemSize, color, selected, hovered, isPulsing);

    this.ctx.restore();

    // Draw label (not rotated, readable)
    if (item.label) {
      const textX = x + this.itemSize / 2;
      const textY = y + this.itemSize / 2;
      const textColor = this._getContrastColor(color);
      this._drawText(item.label, textX, textY, textColor, 'center', 10, this.itemSize - 4);
    }
  }

  /**
   * Draw shadow for item (depth effect)
   * @param {number} x - Item X position
   * @param {number} y - Item Y position
   * @private
   */
  _drawItemShadow(x, y) {
    // Outer soft shadow - layered blur effect
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    this.ctx.fillRect(x + 2, y + 3, this.itemSize, this.itemSize);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
    this.ctx.fillRect(x + 1.5, y + 2.5, this.itemSize, this.itemSize);
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
    this.ctx.fillRect(x + 1, y + 2, this.itemSize, this.itemSize);

    // Inner shadow highlight (top-left edge)
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x + 0.5, y + 0.5, this.itemSize - 1, this.itemSize - 1);
  }

  /**
   * Draw shadow for images with custom width/height
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @private
   */
  _drawImageShadow(x, y, width, height) {
    // Single-pass shadow for better performance (was multi-pass)
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    this.ctx.fillRect(x + 2, y + 2, width, height);
  }

  /**
   * Get center point of an item
   * @param {Object} item - Item object
   * @returns {Object} Center coordinates
   */
  /**
   * Get the actual dimensions (width, height) of an item based on its type and properties
   * @param {Object} item - The item to calculate dimensions for
   * @returns {Object} Object with width and height
   * @private
   */
  _getItemDimensions(item) {
    const type = item.type;

    if (type === 'Note') {
      // Notes are always square (itemSize x itemSize)
      return { width: this.itemSize, height: this.itemSize };
    } else if (type === 'Image') {
      // Images have variable dimensions based on preset and actual image aspect ratio
      const preset = item.data?.preset || 'medium';
      const presetConfig = this.imagePresets[preset];
      if (!presetConfig) {
        return { width: this.itemSize, height: this.itemSize }; // Fallback
      }

      const { longEdge, isPolaroid, bottomMargin } = presetConfig;
      let width, height;

      if (item.data?.imageUrl && this.imageCache.has(item.data.imageUrl)) {
        const cachedImg = this.imageCache.get(item.data.imageUrl);
        if (cachedImg) {
          const imgAspect = cachedImg.width / cachedImg.height;
          if (imgAspect >= 1) {
            width = longEdge;
            height = longEdge / imgAspect;
          } else {
            height = longEdge;
            width = longEdge * imgAspect;
          }
        } else {
          width = longEdge;
          height = longEdge;
        }
      } else {
        width = longEdge;
        height = longEdge;
      }

      // For Polaroid, add extra bottom margin
      let totalHeight = height;
      if (isPolaroid && bottomMargin) {
        totalHeight = height + bottomMargin;
      }

      return { width, height: totalHeight };
    } else if (type === 'Document') {
      // Documents have fixed dimensions based on size preset
      const size = item.data?.size || 'medium';
      const sizeConfig = this.documentSizes[size];
      if (!sizeConfig) {
        return { width: this.itemSize, height: this.itemSize }; // Fallback
      }
      return { width: sizeConfig.width, height: sizeConfig.height };
    } else if (type === 'Text') {
      // Text items have custom dimensions
      const width = item.data?.width || this.itemSize;
      const height = item.data?.height || this.itemSize;
      return { width, height };
    }

    // Default fallback
    return { width: this.itemSize, height: this.itemSize };
  }

  _getItemCenter(item) {
    // Get actual item dimensions
    const { width, height } = this._getItemDimensions(item);
    
    // Connection endpoint: absolute center of item
    return {
      x: (item.x || 0) + width / 2,
      y: (item.y || 0) + height / 2,
    };
  }

  /**
   * Convert hex color to rgba string
   * @param {string} hex - Hex color code (e.g., '#FF0000')
   * @param {number} alpha - Alpha value (0-1)
   * @returns {string} RGBA color string
   */
  _hexToRgba(hex, alpha = 1) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Get contrasting text color based on background
   * @param {string} bgColor - Background color hex
   * @returns {string} Text color
   */
  _getContrastColor(bgColor) {
    // Simple luminance calculation
    const rgb = parseInt(bgColor.slice(1), 16);
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = (rgb >> 0) & 0xff;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#1a1a1a' : '#FFFFFF';
  }

  /**
   * Draw text on canvas
   * @param {string} text - Text to draw
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {string} color - Text color
   * @param {string} align - Text alignment (left, center, right)
   * @param {number} size - Font size
   * @param {number} maxWidth - Maximum width for text wrapping
   * @param {string} fontFamily - Font family (default: Arial)
   */
  _drawText(text, x, y, color, align = 'left', size = 12, maxWidth = null, fontFamily = 'Arial') {
    this.ctx.fillStyle = color;
    this.ctx.font = `${size}px ${fontFamily}`;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = 'middle';

    if (maxWidth) {
      this.ctx.fillText(text, x, y, maxWidth);
    } else {
      this.ctx.fillText(text, x, y);
    }
  }

  /**
   * Draw text with word wrapping and dynamic font size scaling
   * @param {string} text - Text to draw
   * @param {number} x - X coordinate (center for centered text)
   * @param {number} y - Y coordinate (vertical center)
   * @param {string} color - Text color
   * @param {string} align - Text alignment (left, center, right)
   * @param {number} size - Font size
   * @param {number} maxWidth - Maximum width for wrapping
   * @param {string} fontFamily - Font family (default: Arial)
   */
  _drawWrappedText(text, x, y, color, align = 'left', size = 12, maxWidth = 40, fontFamily = 'Arial', maxHeightParam = null) {
    // Create cache key for wrapped text
    const cacheKey = `wrap|${text}|${maxWidth}|${size}|${fontFamily}|${maxHeightParam}`;
    let lines, currentSize;
    
    if (this.textMeasureCache.has(cacheKey)) {
      const cached = this.textMeasureCache.get(cacheKey);
      lines = cached.lines;
      currentSize = cached.fontSize;
    } else {
      const maxHeight = maxHeightParam || (this.itemSize - 4); // Available height on note
      const minFontSize = 6; // Minimum readable font size
      currentSize = size;
      lines = [];
      let fits = false;

      // Try decreasing font size until text fits (step by 2 for faster convergence)
      while (currentSize >= minFontSize && !fits) {
        this.ctx.fillStyle = color;
        this.ctx.font = `${currentSize}px ${fontFamily}`;
        this.ctx.textAlign = align;
        this.ctx.textBaseline = 'middle';

        // Split text into words and wrap them
        const words = text.split(' ');
        lines = [];
        let currentLine = '';

        for (let word of words) {
          const testLine = currentLine + (currentLine ? ' ' : '') + word;
          const metrics = this.ctx.measureText(testLine);

          if (metrics.width > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        
        if (currentLine) {
          lines.push(currentLine);
        }

        // Check if text fits vertically
        const lineHeight = currentSize * 1.3;
        const totalHeight = lines.length * lineHeight;

        if (totalHeight <= maxHeight) {
          fits = true;
        } else {
          currentSize -= (currentSize > 8 ? 2 : 1); // Decrease by 2 for faster convergence
        }
      }

      // Cache the result
      if (this.textMeasureCache.size > 200) {
        const firstKey = this.textMeasureCache.keys().next().value;
        this.textMeasureCache.delete(firstKey);
      }
      this.textMeasureCache.set(cacheKey, { lines, fontSize: currentSize });
    }

    // Set final font size and draw
    this.ctx.fillStyle = color;
    this.ctx.font = `${currentSize}px ${fontFamily}`;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = 'middle';

    // Calculate starting Y position to center the text block vertically
    const lineHeight = currentSize * 1.3;
    const totalHeight = lines.length * lineHeight;
    // Since textBaseline is 'middle', startY should be the first line's center position
    let startY = y - (totalHeight - lineHeight) / 2;

    // Draw each line
    lines.forEach((line, index) => {
      const lineY = startY + index * lineHeight;
      this.ctx.fillText(line, x, lineY, maxWidth);
    });
  }

  /**
   * Convert screen coordinates to world coordinates
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @returns {Object} World coordinates {x, y}
   */
  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.camera.x) / this.camera.zoom,
      y: (screenY - this.camera.y) / this.camera.zoom,
    };
  }

  /**
   * Pan the camera
   * @param {number} deltaX - Amount to pan X
   * @param {number} deltaY - Amount to pan Y
   */
  pan(deltaX, deltaY) {
    this.camera.x += deltaX;
    this.camera.y += deltaY;
  }

  /**
   * Zoom the camera
   * @param {number} zoomDelta - Amount to change zoom (e.g., 0.1 or -0.1)
   * @param {number} screenX - Screen X coordinate to zoom around
   * @param {number} screenY - Screen Y coordinate to zoom around
   */
  zoom(zoomDelta, screenX = this.canvas.width / 2, screenY = this.canvas.height / 2) {
    // Get world position under mouse before zoom
    const mouseWorldX = (screenX - this.camera.x) / this.camera.zoom;
    const mouseWorldY = (screenY - this.camera.y) / this.camera.zoom;
    
    // Apply zoom
    this.camera.zoom = Math.max(0.1, Math.min(5, this.camera.zoom + zoomDelta));
    
    // Recalculate camera position so the same world point stays under the mouse
    this.camera.x = screenX - mouseWorldX * this.camera.zoom;
    this.camera.y = screenY - mouseWorldY * this.camera.zoom;
  }

  /**
   * Find item at canvas coordinates
   * @param {number} x - Canvas X
   * @param {number} y - Canvas Y
   * @param {number} tolerance - Additional tolerance in pixels (default 0 for exact)
   * @returns {Object|null} Item object or null
   */
  getItemAtPoint(x, y, tolerance = 0) {
    // Convert screen coordinates to world coordinates
    const world = this.screenToWorld(x, y);
    const items = MurderBoardData.getItems(this.scene);
    
    // Scale tolerance by zoom level
    const scaledTolerance = tolerance / this.camera.zoom;

    // Check items in reverse order (drawn last = on top) for proper hit detection
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const itemX = item.x || 0;
      const itemY = item.y || 0;

      // Use same dimension calculation as drawing functions for consistency
      const { width: itemWidth, height: itemHeight } = this._getItemDimensions(item);

      // Add tolerance to hitbox
      const expandedX = itemX - scaledTolerance;
      const expandedY = itemY - scaledTolerance;
      const expandedWidth = itemWidth + (scaledTolerance * 2);
      const expandedHeight = itemHeight + (scaledTolerance * 2);

      // Check if point is within bounds (inclusive)
      if (world.x >= expandedX && world.x < expandedX + expandedWidth && 
          world.y >= expandedY && world.y < expandedY + expandedHeight) {
        return item;
      }
    }

    // Fallback: if exact detection failed and tolerance was 0, try with small fallback tolerance for dragging
    // This helps with edge cases where dimensions might be calculated slightly differently
    if (tolerance === 0) {
      const fallbackTolerance = 3 / this.camera.zoom; // 3 pixel fallback tolerance
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const itemX = item.x || 0;
        const itemY = item.y || 0;

        const { width: itemWidth, height: itemHeight } = this._getItemDimensions(item);

        const expandedX = itemX - fallbackTolerance;
        const expandedY = itemY - fallbackTolerance;
        const expandedWidth = itemWidth + (fallbackTolerance * 2);
        const expandedHeight = itemHeight + (fallbackTolerance * 2);

        if (world.x >= expandedX && world.x < expandedX + expandedWidth && 
            world.y >= expandedY && world.y < expandedY + expandedHeight) {
          return item;
        }
      }
    }

    return null;
  }

  /**
   * Find connection at canvas coordinates (line-to-point distance check)
   * @param {number} x - Canvas X
   * @param {number} y - Canvas Y
   * @param {number} threshold - Click threshold in pixels (default 12)
   * @returns {Object|null} Connection object or null
   */
  getConnectionAtPoint(x, y, threshold = 12) {
    const world = this.screenToWorld(x, y);
    const connections = MurderBoardData.getConnections(this.scene);
    const items = MurderBoardData.getItems(this.scene);

    // Create a map for O(1) item lookup instead of O(n) find() per connection
    const itemMap = new Map(items.map(item => [item.id, item]));

    // Scale threshold by zoom level to account for camera zoom
    const scaledThreshold = threshold / this.camera.zoom;

    for (let conn of connections) {
      const fromItem = itemMap.get(conn.fromItem);
      const toItem = itemMap.get(conn.toItem);

      if (!fromItem || !toItem) continue;

      // Get line endpoints using actual item dimensions (not fixed size)
      const centerFrom = this._getItemCenter(fromItem);
      const centerTo = this._getItemCenter(toItem);
      
      // Offset endpoints to halfway between top and middle of items
      const { height: heightFrom } = this._getItemDimensions(fromItem);
      const { height: heightTo } = this._getItemDimensions(toItem);
      const offsetFrom = heightFrom / 4;
      const offsetTo = heightTo / 4;
      
      const from = { x: centerFrom.x, y: centerFrom.y - offsetFrom };
      const to = { x: centerTo.x, y: centerTo.y - offsetTo };

      // Calculate bezier control points (same as in _drawConnection)
      const distance = Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2));
      const sagAmount = Math.min(distance * 0.15, 100);
      
      const cp1x = from.x + (to.x - from.x) * 0.25;
      const cp1y = from.y + (to.y - from.y) * 0.25 + sagAmount * 0.5;
      const cp2x = to.x - (to.x - from.x) * 0.25;
      const cp2y = to.y - (to.y - from.y) * 0.25 + sagAmount * 0.5;

      // Check distance to bezier curve
      const distance_to_curve = this._distanceToBezierCurve(world.x, world.y, from.x, from.y, cp1x, cp1y, cp2x, cp2y, to.x, to.y);

      if (distance_to_curve <= scaledThreshold) {
        return conn;
      }
    }

    return null;
  }

  /**
   * Calculate distance from point to bezier curve
   * @private
   */
  _distanceToBezierCurve(px, py, x0, y0, x1, y1, x2, y2, x3, y3) {
    let minDist = Infinity;
    
    // Sample the bezier curve at multiple points
    for (let t = 0; t <= 1; t += 0.05) {
      const mt = 1 - t;
      // Cubic bezier formula
      const x = mt*mt*mt * x0 + 3*mt*mt*t * x1 + 3*mt*t*t * x2 + t*t*t * x3;
      const y = mt*mt*mt * y0 + 3*mt*mt*t * y1 + 3*mt*t*t * y2 + t*t*t * y3;
      
      const dist = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
      if (dist < minDist) {
        minDist = dist;
      }
    }
    
    return minDist;
  }

  /**
   * Set selected item
   * @param {string} itemId - Item ID or null
   */
  setSelected(itemId) {
    this.selectedItem = itemId;
  }

  /**
   * Set hovered item
   * @param {string} itemId - Item ID or null
   */
  setHoverItem(itemId) {
    this.hoveredItem = itemId;
  }

  /**
   * Set hovered connection
   * @param {Object} connection - Connection object {fromItem, toItem} or null
   */
  setHoverConnection(connection) {
    this.hoveredConnection = connection;
  }

  /**
   * Set highlight for connection mode
   * @param {string} itemId - Item ID
   */
  setHighlight(itemId) {
    this.selectedItem = itemId;
  }

  /**
   * Clear selection
   */
  clearSelection() {
    this.selectedItem = null;
    this.hoveredItem = null;
    this.hoveredConnection = null;
  }

  /**
   * Set connection preview line
   * @param {string} fromItemId - Source item ID
   * @param {number} screenX - Target screen X
   * @param {number} screenY - Target screen Y
   */
  setConnectionPreview(fromItemId, screenX, screenY) {
    const item = MurderBoardData.getItem(this.scene, fromItemId);
    if (item) {
      // Convert screen coordinates to world coordinates
      const worldCoords = this.screenToWorld(screenX, screenY);
      this.connectionPreview = {
        from: this._getItemCenter(item),
        to: worldCoords,
      };
    }
  }

  /**
   * Clear connection preview
   */
  clearConnectionPreview() {
    this.connectionPreview = null;
  }

  /**
   * Update item position (for drag preview)
   * @param {Object} item - Item with updated coordinates
   */
  updateItem(item) {
    // Items are already updated in memory, just need to redraw
    // This is called during drag operations
  }

  /**
   * Handle board settings changes - refresh and redraw
   */
  async handleSettingsChange() {
    try {
      // Clear caches affected by settings
      this.imageCache.clear();
      this.patternCache.clear();
      this.textMeasureCache.clear();
      
      // Small delay to ensure window has finished resizing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Redraw canvas
      this.draw();
    } catch (error) {
      console.error('Murder Board: Error handling settings change:', error);
      // Try fallback reinitialization
      try {
        this.initializeCanvas();
        this.draw();
      } catch (fallbackError) {
        console.error('Murder Board: Fallback reinitialization failed:', fallbackError);
      }
    }
  }

  /**
   * Ensure canvas context is valid, reinitialize if corrupted
   */
  ensureValidContext() {
    if (!this.ctx || this.ctx.isContextLost()) {
      console.warn('Murder Board: Canvas context lost or invalid, reinitializing...');
      this.initializeCanvas();
      return false; // Indicate context was reinitialized
    }
    return true; // Context is valid
  }

  /**
   * Force complete canvas reset and redraw
   */
  forceRedraw() {
    try {
      // Ensure context is valid first
      if (!this.ensureValidContext()) {
        // Context was reinitialized, caches are already cleared
        this.draw();
        return;
      }
      
      // Clear all caches
      this.imageCache.clear();
      this.patternCache.clear();
      this.textMeasureCache.clear();
      
      // Reset canvas context if needed
      if (this.ctx) {
        // Save current transform state
        this.ctx.save();
        
        // Reset to identity matrix
        this.ctx.resetTransform();
        
        // Clear canvas completely
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Restore transform state
        this.ctx.restore();
      }
      
      // Force redraw
      this.draw();
    } catch (error) {
      console.error('Murder Board: Error during force redraw:', error);
      // Fallback: try reinitializing context
      try {
        this.initializeCanvas();
        this.draw();
      } catch (fallbackError) {
        console.error('Murder Board: Fallback reinitialization also failed:', fallbackError);
      }
    }
  }
}
