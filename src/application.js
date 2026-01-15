/**
 * Murder Board Application - ApplicationV2 Implementation
 * Renders the main board interface with canvas rendering
 */

import { MurderBoardData } from './data-model.js';
import { emitSocketMessage } from './socket-handler.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MurderBoardApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'murder-board-app',
    tag: 'div',
    classes: ['murder-board-window'],
    window: {
      icon: 'fas fa-clipboard-list',
      title: 'MURDER_BOARD.Controls.OpenBoard',
      resizable: true,
      draggable: true,
    },
    position: {
      width: 1000,
      height: 700,
    },
    actions: {
      'new-board': MurderBoardApplication.prototype._onNewBoard,
      'board-selector-settings': MurderBoardApplication.prototype._onBoardSelectorSettings,
      'toggle-connect': MurderBoardApplication.prototype._onToggleConnect,
      'board-settings': MurderBoardApplication.prototype._onBoardSettings,
      'center-canvas': MurderBoardApplication.prototype._onCenterCanvas,
      'toggle-fullscreen': MurderBoardApplication.prototype._onToggleFullscreen,
      'export-board': MurderBoardApplication.prototype._onExportBoard,
      'import-board': MurderBoardApplication.prototype._onImportBoard,
    },
  };

  static PARTS = {
    body: {
      template: 'modules/murder-board/templates/murder-board.hbs',
      scrollable: [],
    },
  };

  /**
   * Constructor
   * @param {Object} options - Application options
   */
  constructor(options = {}) {
    const scene = options.scene || game.scenes.active;
    // Use scene ID to create a consistent window ID
    const sceneId = scene?.id || 'default';
    const windowId = `murder-board-app-${sceneId}`;
    
    super({
      ...options,
      id: windowId,
      position: {
        width: 1000,
        height: 700,
      },
    });
    this.scene = scene;
    this.canvas = null;
    this.renderer = null;
    this.isDragging = false;
    this.selectedItems = []; // Array of selected item IDs (multi-select)
    this.connectMode = false;
    this.connectionFrom = null;
    this.dragStart = { x: 0, y: 0 };
    this.dragUpdateTimeout = null; // For debouncing drag updates
    this.dragItemStartPos = { x: 0, y: 0 }; // Track item's starting position during drag
    this.dragStartPositions = new Map(); // Track starting positions of all selected items
    this.dragOverItem = null; // Track item being dragged over (for connections)
    this.cameraUpdateTimeout = null; // For debouncing camera state saves
    
    // Panning state
    this.isPanning = false;
    this.isRightClickPanning = false; // Track if we're in right-click panning state
    this.rightClickPanned = false; // Track if right-click actually resulted in a pan
    this.panStartX = 0;
    this.panStartY = 0;
    this.panStartCameraX = 0;
    this.panStartCameraY = 0;
    
    // Drag box selection
    this.isBoxSelecting = false;
    this.boxSelectStart = { x: 0, y: 0 };
    this.boxSelectCurrent = { x: 0, y: 0 };
    
    // Resizing
    this.isResizing = false;
    this.resizeItemId = null;
    this.resizeHandle = null; // 'nw', 'ne', 'sw', 'se'
    this.resizeStart = { x: 0, y: 0 };
    this.resizeStartDimensions = { width: 0, height: 0 };
  }

  /**
   * Helper method to show notifications respecting suppress settings
   * @param {string} message - Notification message
   * @param {string} type - Notification type ('info', 'warn', 'error')
   */
  _notify(message, type = 'info') {
    if (!game.settings.get('murder-board', 'suppressNotifications')) {
      ui.notifications[type](message);
    }
  }

  /**
   * Build a compact color picker section for context menus
   * @param {string} label - Label for the color picker (e.g., "Note Color")
   * @param {Array} colors - Array of color objects with hex and label
   * @param {string} currentColor - Currently selected color hex
   * @param {string} buttonClass - CSS class for the color buttons
   * @returns {string} HTML string for the color picker section
   * @private
   */
  _buildCompactColorPicker(label, colors, currentColor, buttonClass = 'murder-board-color-swatch') {
    let html = `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
    html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">${label}</div>`;
    html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
    
    for (let color of colors) {
      const isSelected = color.hex.toUpperCase() === currentColor.toUpperCase();
      html += `
        <button class="${buttonClass} ${isSelected ? 'selected' : ''}" data-color="${color.hex}"
                style="flex: 1; min-width: 30px; height: 30px; padding: 0; background: ${color.hex}; border: ${isSelected ? '3px solid var(--mb-secondary)' : '2px solid var(--mb-border)'};"
                title="${color.label}">
        </button>
      `;
    }
    html += `</div></div>`;
    return html;
  }

  /**
   * Get available fonts for item dialogs and context menus
   * @returns {Array} Array of font objects with value and label
   * @private
   */
  _getAvailableFonts() {
    const fonts = [];

    // Get custom fonts from game.settings (user-uploaded fonts)
    try {
      const customFontGroups = game.settings.get('core', 'fonts');
      
      if (customFontGroups && typeof customFontGroups === 'object') {
        for (const [groupName, groupData] of Object.entries(customFontGroups)) {
          // Each custom font group has a 'fonts' array with actual font definitions
          if (groupData.fonts && Array.isArray(groupData.fonts)) {
            for (const fontDef of groupData.fonts) {
              fonts.push({
                value: fontDef.name || groupName,
                label: fontDef.label || fontDef.name || groupName,
                family: fontDef.family || fontDef.name || groupName
              });
            }
          } else {
            // Fallback if structure is different
            fonts.push({
              value: groupName,
              label: groupData.label || groupName,
              family: groupData.family || groupName
            });
          }
        }
      }
    } catch (error) {
      // Silent fail, continue to core fonts
    }

    // Get core fonts from CONFIG.fontDefinitions
    if (CONFIG.fontDefinitions) {
      for (const [fontKey, fontDef] of Object.entries(CONFIG.fontDefinitions)) {
        fonts.push({
          value: fontKey,
          label: fontDef.label || fontKey,
          family: fontDef.family || fontKey
        });
      }
    }

    // Fallback to common web fonts if no fonts are available at all
    if (fonts.length === 0) {
      return [
        { value: 'Arial', label: 'Arial (Clean)', family: 'Arial' },
        { value: 'Georgia', label: 'Georgia (Serif)', family: 'Georgia' },
        { value: 'Courier New', label: 'Courier (Monospace)', family: 'Courier New' },
        { value: 'Comic Sans MS', label: 'Comic Sans (Casual)', family: 'Comic Sans MS' },
        { value: 'Caveat', label: 'Caveat (Handwriting)', family: 'Caveat' },
        { value: 'Permanent Marker', label: 'Permanent Marker (Marker)', family: 'Permanent Marker' },
        { value: 'Reenie Beanie', label: 'Reenie Beanie (Sketch)', family: 'Reenie Beanie' }
      ];
    }

    return fonts;
  }

  /**
   * Get context data for the template
   * @param {Object} options - Preparation options
   * @returns {Object} Context data
   */
  async _prepareContext(options) {
    const boardData = MurderBoardData.getGlobalBoardData();

    // Get all available boards globally, filtered by view permissions
    const allBoards = MurderBoardData.getGlobalBoards();
    const currentBoardId = MurderBoardData.getGlobalCurrentBoardId();
    
    const availableBoards = allBoards
      .filter(board => MurderBoardData.canUserViewBoard(board.id))
      .map(board => ({
        id: board.id,
        name: board.name || 'Untitled Board',
        isActive: board.id === currentBoardId,
      }));

    return {
      boardType: boardData.boardType,
      itemCount: boardData.items.length,
      connectionCount: boardData.connections.length,
      availableBoards: availableBoards,
    };
  }

  /**
   * First render - maximize window to fill screen
   * @param {Object} context - Render context
   * @param {Object} options - Render options
   */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    
    // Store reference to this app globally for debugging
    if (!globalThis.murderBoardDebug.activeApp) {
      globalThis.murderBoardDebug.activeApp = this;
    }
    
    // Set window to fill entire screen (like fullscreen button does)
    this.setPosition({
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  /**
   * Close handler - clean up event listeners and drag state
   */
  async _onClose(options) {
    try {
      // Clear the global reference when closing
      if (globalThis.murderBoardDebug.activeApp === this) {
        globalThis.murderBoardDebug.activeApp = null;
      }
      
      // Save window position before closing to game settings
      if (this.position && this.scene) {
        const allPositions = game.settings.get('murder-board', 'windowPositions') || {};
        allPositions[this.scene.id] = {
          width: this.position.width,
          height: this.position.height,
          left: this.position.left,
          top: this.position.top,
        };
        await game.settings.set('murder-board', 'windowPositions', allPositions);
      }
      
      // Save camera state
      if (this.renderer) {
        await MurderBoardData.setCameraState(this.scene, this.renderer.camera);
      }
      
      // Clean up all pending drag states and timeouts
      this._cleanupDragState();
      
      // Remove event listeners if they were bound
      if (this.element) {
        const container = this.element;
        if (this._boundMouseDown) container.removeEventListener('mousedown', this._boundMouseDown);
        if (this._boundMouseMove) container.removeEventListener('mousemove', this._boundMouseMove);
        if (this._boundMouseUp) container.removeEventListener('mouseup', this._boundMouseUp);
        if (this._boundContextMenu) container.removeEventListener('contextmenu', this._boundContextMenu, { capture: true });
        if (this._boundWheel) container.removeEventListener('wheel', this._boundWheel);
        if (this._boundDoubleClick) container.removeEventListener('dblclick', this._boundDoubleClick);
        if (this._boundDragOver) container.removeEventListener('dragover', this._boundDragOver);
        if (this._boundDragLeave) container.removeEventListener('dragleave', this._boundDragLeave);
        if (this._boundDrop) container.removeEventListener('drop', this._boundDrop);
      }
      
      // Remove global listeners
      if (this._boundWindowMouseUp) window.removeEventListener('mouseup', this._boundWindowMouseUp);
      if (this._boundKeyDown) document.removeEventListener('keydown', this._boundKeyDown);
      if (this._boundKeyUp) document.removeEventListener('keyup', this._boundKeyUp);
      if (this._boundWindowResize) window.removeEventListener('resize', this._boundWindowResize);
    } catch (error) {
      console.error('Murder Board | Error in _onClose:', error);
    }

    // Always remove any lingering context menus to prevent rendering artifacts (do this after try/catch)
    try {
      document.querySelectorAll('.murder-board-context-menu').forEach(menu => {
        menu.style.display = 'none';
        menu.style.visibility = 'hidden';
        menu.remove();
      });
    } catch (e) {
      // Silently fail if menu cleanup has issues
    }

    // Call parent close
    await super._onClose(options);
  }

  /**
   * Render callback - set up canvas after HTML renders
   * @param {object} context - Render context
   * @param {object} options - Render options
   */
  async _onRender(context, options) {
    // Store reference to this application for item dialogs
    game.murderBoard.mainBoard = this;

    // Note: Board initialization is no longer needed - boards are now stored globally
    // and are available from any scene

    // Get canvas element
    this.canvas = this.element.querySelector('#murder-board-canvas');
    if (!this.canvas) {
      console.error('Murder Board | Canvas element not found');
      return;
    }

    // Remove any title attribute that might show unwanted tooltips when hovering
    this.canvas.removeAttribute('title');

    // Import renderer
    const { CanvasRenderer } = await import('./canvas-renderer.js');
    this.renderer = new CanvasRenderer(this.canvas, this.scene);
    
    // Set fixed canvas size and draw
    this._resizeCanvas();
    this.renderer.draw();

    // Restore camera position and zoom from last session
    const cameraState = MurderBoardData.getCameraState(this.scene);
    
    // On first load (x: 0, y: 0, zoom: 1), center the view on the canvas
    if (cameraState.x === 0 && cameraState.y === 0 && cameraState.zoom === 1) {
      // Center camera on canvas middle
      const canvasWidth = this.renderer.canvas.width;
      const canvasHeight = this.renderer.canvas.height;
      this.renderer.camera.x = canvasWidth / 2;
      this.renderer.camera.y = canvasHeight / 2;
      this.renderer.camera.zoom = 1;
    } else {
      // Restore previous camera state
      this.renderer.camera.x = cameraState.x;
      this.renderer.camera.y = cameraState.y;
      this.renderer.camera.zoom = cameraState.zoom;
    }

    // Attach event listeners
    this._attachEventListeners();
    
    // Attach board selector listener
    const boardSelector = this.element.querySelector('#board-selector');
    if (boardSelector) {
      boardSelector.addEventListener('change', (e) => this._onBoardSelected(e));
    }
    
    // Redraw with restored camera state
    this.renderer.draw();
  }

  /**
   * ApplicationV2 lifecycle: Called when window is repositioned/resized
   * @param {Object} position - New position object
   */
  _onPosition(position) {
    const oldWidth = this.position ? this.position.width : undefined;
    const oldHeight = this.position ? this.position.height : undefined;
    super._onPosition(position);
    
    // Resize canvas if window dimensions changed
    if (position.width !== oldWidth || position.height !== oldHeight) {
      if (this.canvas && this.renderer) {
        // _resizeCanvas() now handles the draw() call internally
        this._resizeCanvas();
      }
    }
  }

  /**
   * Override insert to ensure element is properly set up for dragging
   * @param {HTMLElement} element - The element to insert
   */
  _insertElement(element) {
    super._insertElement(element);
  }

  /**
   * Handle window resize from ApplicationV2
   * Called when the window is resized
   */
  _onWindowReposition() {
    if (this.canvas && this.renderer) {
      this._resizeCanvas();
      this.renderer.draw();
    }
  }

  /**
   * Set canvas size to fill entire wrapper
   */
  _resizeCanvas() {
    if (!this.canvas || !this.canvas.parentElement) return;
    
    const wrapper = this.canvas.parentElement;
    const wrapperWidth = wrapper.offsetWidth;
    const wrapperHeight = wrapper.offsetHeight;
    
    // Get device pixel ratio for high-DPI support (fixes dead pixels on Retina/4K)
    const dpr = window.devicePixelRatio || 1;
    
    // Set canvas resolution (internal pixel count) using device pixel ratio
    this.canvas.width = wrapperWidth * dpr;
    this.canvas.height = wrapperHeight * dpr;
    
    // Set canvas CSS display size to fill wrapper
    this.canvas.style.width = wrapperWidth + 'px';
    this.canvas.style.height = wrapperHeight + 'px';
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';
    
    // Scale canvas context to account for device pixel ratio
    if (this.renderer && this.renderer.ctx) {
      this.renderer.ctx.scale(dpr, dpr);
    }
    
    // Force immediate redraw after resize to prevent dead pixels
    if (this.renderer) {
      this.renderer.draw();
    }
  }

  /**
   * Attach event listeners to canvas
   */
  _attachEventListeners() {
    // Since canvas has pointer-events: none to allow window dragging,
    // we need to attach listeners to the parent container instead
    const container = this.canvas.parentElement;
    
    // Remove any title attribute from the container as well
    container.removeAttribute('title');
    
    // Bind handlers once to enable removal later and ensure proper cleanup
    this._boundMouseDown = this._onCanvasMouseDown.bind(this);
    this._boundMouseMove = this._onCanvasMouseMove.bind(this);
    this._boundMouseUp = this._onCanvasMouseUp.bind(this);
    this._boundContextMenu = this._onCanvasContextMenu.bind(this);
    this._boundWheel = this._onCanvasWheel.bind(this);
    this._boundDoubleClick = this._onCanvasDoubleClick.bind(this);
    this._boundWindowMouseUp = this._onWindowMouseUp.bind(this);
    
    container.addEventListener('mousedown', this._boundMouseDown);
    container.addEventListener('mousemove', this._boundMouseMove);
    container.addEventListener('mouseup', this._boundMouseUp);
    container.addEventListener('contextmenu', this._boundContextMenu, { capture: true });
    container.addEventListener('wheel', this._boundWheel, { passive: false });
    container.addEventListener('dblclick', this._boundDoubleClick);
    
    // Add window-level mouseup to catch releases outside canvas (critical for drag cleanup)
    window.addEventListener('mouseup', this._boundWindowMouseUp);
    
    // Add drag-and-drop listeners (always needed for item picker drag-and-drop)
    this._boundDragOver = this._onCanvasDragOver.bind(this);
    this._boundDragLeave = this._onCanvasDragLeave.bind(this);
    this._boundDrop = this._onCanvasDrop.bind(this);
    container.addEventListener('dragover', this._boundDragOver);
    container.addEventListener('dragleave', this._boundDragLeave);
    container.addEventListener('drop', this._boundDrop);

    // Attach keyboard listener to document (more reliable than container)
    this._boundKeyDown = this._onCanvasKeyDown.bind(this);
    document.addEventListener('keydown', this._boundKeyDown);

    this._boundWindowResize = this._onWindowResize.bind(this);
    window.addEventListener('resize', this._boundWindowResize);

    // Track middle-click pan state
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panStartCameraX = 0;
    this.panStartCameraY = 0;

    // Track zoom focus state
    this.focusedItemId = null;
    this.focusCameraState = null;
    this.isAnimatingZoom = false;

    // Track pressed keys to prevent repeated keydown firing
    this.pressedKeys = new Set();
    this._boundKeyUp = this._onCanvasKeyUp.bind(this);
    document.addEventListener('keyup', this._boundKeyUp);
  }

  /**
   * Handle window mouse up (catches releases outside canvas)
   * This is critical for ensuring drag state is cleaned up even if mouse leaves canvas
   * @param {MouseEvent} event
   */
  _onWindowMouseUp(event) {
    // Only process if we're actively in a drag operation
    if (!this.isDragging && !this.isPanning && !this.isBoxSelecting) {
      return;
    }

    try {
      // Force cleanup of all drag states
      this._cleanupDragState();
      
      if (this.renderer) {
        this.renderer.draw();
      }
    } catch (error) {
      console.error('Murder Board | Error in window mouse up:', error);
      // Force cleanup even if error occurred
      this._cleanupDragState();
    }
  }

  /**
   * Clean up all drag-related state
   * Called on drag end or error to ensure all flags are properly reset
   */
  _cleanupDragState() {
    // Clear all pending timeout handlers
    if (this.dragUpdateTimeout) {
      clearTimeout(this.dragUpdateTimeout);
      this.dragUpdateTimeout = null;
    }
    if (this.cameraUpdateTimeout) {
      clearTimeout(this.cameraUpdateTimeout);
      this.cameraUpdateTimeout = null;
    }

    // Reset all drag flags
    this.isDragging = false;
    this.isPanning = false;
    this.isRightClickPanning = false;
    this.rightClickPanned = false;
    this.isBoxSelecting = false;
    this.isResizing = false;
    this.isRotating = false;
    this.isDraggingLabel = false;
    this.resizeItemId = null;
    this.resizeHandle = null;
    this.dragOverItem = null;
    this.draggedConnectionId = null;
    
    // Reset renderer state
    if (this.renderer) {
      this.renderer.draggedItem = null;
      this.renderer.draggedConnectionLabel = null;
      this.renderer.boxSelectRect = null;
      this.renderer.setHighlight(null);
      this.renderer.setHoverItem(null);
      this.renderer.connectionPreviewMode = false;
      this.renderer.connectionTargetItem = null;
      this.renderer.clearConnectionPreview();
    }
  }

  /**
   * Check if a point is over a resize handle for a text item
   * @param {Object} item - The text item
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @returns {string|null} Handle type ('nw', 'ne', 'sw', 'se') or null
   * @private
   */
  _getResizeHandleAtPoint(item, x, y) {
    // Resize handles are now drawn in screen space (12px fixed size)
    // So we need to detect them in screen space too
    const itemX = item.x;
    const itemY = item.y;
    
    // Get dimensions - use renderer method if available (which uses migrated data)
    let itemWidth, itemHeight;
    
    // Try to use the renderer's dimension calculation first (has migrated data)
    if (this.renderer && this.renderer._getItemDimensions) {
      const dims = this.renderer._getItemDimensions(item);
      itemWidth = dims.width;
      itemHeight = dims.height;
    } else {
      // Fallback to manual calculation
      if (item.type === 'Note') {
        itemWidth = item.data?.width || 40;
        itemHeight = item.data?.height || 40;
      } else if (item.type === 'Image') {
        itemWidth = item.data?.width || 80;
        itemHeight = item.data?.height || 80;
      } else if (item.type === 'Document') {
        itemWidth = item.data?.width || 120;
        itemHeight = item.data?.height || 140;
      } else if (item.type === 'Text') {
        itemWidth = item.data?.width || this.renderer.itemSize;
        itemHeight = item.data?.height || this.renderer.itemSize;
      } else {
        itemWidth = item.data?.width || this.renderer.itemSize;
        itemHeight = item.data?.height || this.renderer.itemSize;
      }
    }
    
    const rotation = item.rotation || 0;
    const handleSize = 12; // Screen space handle size (fixed, not zoomed)
    const tolerance = handleSize / 2 + 2; // Match the visual handle size

    // Convert world coordinates to screen coordinates
    const screenX = this.renderer.camera.x + itemX * this.renderer.camera.zoom;
    const screenY = this.renderer.camera.y + itemY * this.renderer.camera.zoom;
    const screenWidth = itemWidth * this.renderer.camera.zoom;
    const screenHeight = itemHeight * this.renderer.camera.zoom;

    // Calculate rotated corner positions in screen space
    const centerX = screenX + screenWidth / 2;
    const centerY = screenY + screenHeight / 2;
    const cos = Math.cos(rotation * Math.PI / 180);
    const sin = Math.sin(rotation * Math.PI / 180);

    // Corner positions relative to center
    const corners = [
      { relX: -screenWidth / 2, relY: -screenHeight / 2, type: 'nw' }, // Top-left
      { relX: screenWidth / 2, relY: -screenHeight / 2, type: 'ne' }, // Top-right
      { relX: -screenWidth / 2, relY: screenHeight / 2, type: 'sw' }, // Bottom-left
      { relX: screenWidth / 2, relY: screenHeight / 2, type: 'se' }, // Bottom-right
    ];

    // Transform corners by rotation
    const rotatedCorners = corners.map(corner => {
      const rotatedX = corner.relX * cos - corner.relY * sin;
      const rotatedY = corner.relX * sin + corner.relY * cos;
      return {
        pos: { x: centerX + rotatedX, y: centerY + rotatedY },
        type: corner.type
      };
    });

    for (const corner of rotatedCorners) {
      const distance = Math.sqrt(
        Math.pow(x - corner.pos.x, 2) + 
        Math.pow(y - corner.pos.y, 2)
      );
      if (distance <= tolerance) {
        return corner.type;
      }
    }
    
    // Check rotation handle (circular, above the item)
    const rotateHandleDistance = 30;
    const rotateHandleSize = 14;
    const topRelX = 0;
    const topRelY = -screenHeight / 2 - rotateHandleDistance;
    const rotatedTopX = topRelX * cos - topRelY * sin;
    const rotatedTopY = topRelX * sin + topRelY * cos;
    const rotateHandleX = centerX + rotatedTopX;
    const rotateHandleY = centerY + rotatedTopY;
    
    const rotateDistance = Math.sqrt(
      Math.pow(x - rotateHandleX, 2) + 
      Math.pow(y - rotateHandleY, 2)
    );
    if (rotateDistance <= rotateHandleSize / 2 + 2) {
      return 'rotate';
    }

    return null;
  }

  /**
   * Handle canvas mouse down
   * @param {MouseEvent} event
   */
  _onCanvasMouseDown(event) {
    try {
      // Ignore clicks on toolbar or buttons
      if (event.target.closest('.murder-board-toolbar') || 
          event.target.closest('.murder-board-btn') ||
          event.target.closest('button') ||
          event.target.closest('menu')) {
        return;
      }

      if (!this.renderer) {
        return;
      }

      // If any previous drag state is still active, clean it up first
      if (this.isDragging || this.isPanning || this.isBoxSelecting) {
        this._cleanupDragState();
      }

      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Right-click to pan (or context menu - track it to decide on release)
      if (event.button === 2) {
        event.preventDefault();
        event.stopPropagation();
        this.isRightClickPanning = true;
        this.panStartX = x;
        this.panStartY = y;
        this.panStartCameraX = this.renderer.camera.x;
        this.panStartCameraY = this.renderer.camera.y;
        return false;
      }

      // Check if clicking on a resize handle for selected text items
      if (this.selectedItems.length === 1) {
        const selectedItemId = this.selectedItems[0];
        const boardData = MurderBoardData.getGlobalBoardData();
        // Apply migrations to ensure items have correct dimensions
        this.renderer._migrateOldItemData(boardData);
        const selectedItem = boardData.items.find(i => i.id === selectedItemId);
        
        if (selectedItem) {
          const resizeHandle = this._getResizeHandleAtPoint(selectedItem, x, y);
          if (resizeHandle) {
            // Check if it's the rotation handle
            if (resizeHandle === 'rotate') {
              this.isRotating = true;
              this.rotateItemId = selectedItemId;
              this.rotateStart = { x, y };
              this.rotateStartAngle = selectedItem.rotation || 0;
              this.rotatingItem = selectedItem; // Cache reference to avoid recalculation
              
              // Calculate center of item in screen space and lock it
              const { width: itemWidth, height: itemHeight } = this.renderer._getItemDimensions(selectedItem);
              const screenX = this.renderer.camera.x + selectedItem.x * this.renderer.camera.zoom;
              const screenY = this.renderer.camera.y + selectedItem.y * this.renderer.camera.zoom;
              const screenWidth = itemWidth * this.renderer.camera.zoom;
              const screenHeight = itemHeight * this.renderer.camera.zoom;
              this.rotateCenterX = screenX + screenWidth / 2;
              this.rotateCenterY = screenY + screenHeight / 2;
              return;
            }
            
            // Start resizing (works for all item types)
            this.isResizing = true;
            this.resizeItemId = selectedItemId;
            this.resizeHandle = resizeHandle;
            this.resizeStart = { x, y };
            
            // Get default dimensions based on item type
            let defaultWidth = 40, defaultHeight = 40;
            if (selectedItem.type === 'Note') {
              defaultWidth = 40;
              defaultHeight = 40;
            } else if (selectedItem.type === 'Image') {
              defaultWidth = 80;
              defaultHeight = 80;
            } else if (selectedItem.type === 'Document') {
              defaultWidth = 120;
              defaultHeight = 140;
            } else if (selectedItem.type === 'Text') {
              defaultWidth = this.renderer.itemSize;
              defaultHeight = this.renderer.itemSize;
            } else {
              defaultWidth = this.renderer.itemSize;
              defaultHeight = this.renderer.itemSize;
            }
            
            this.resizeStartDimensions = {
              width: selectedItem.data?.width || defaultWidth,
              height: selectedItem.data?.height || defaultHeight
            };
            this.resizeStartPosition = {
              x: selectedItem.x || 0,
              y: selectedItem.y || 0
            };
            return;
          }
        }
      }

      // Check if clicking on an item
      const item = this.renderer.getItemAtPoint(x, y);

      if (item) {
        // Check permissions before allowing drag
        if (!MurderBoardData.canUserEdit(this.scene)) {
          this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
          return;
        }
        
        // Handle modifier keys for multi-select
        const isAdditive = event.ctrlKey || event.metaKey || event.shiftKey;
        
        if (!isAdditive && !this.selectedItems.includes(item.id)) {
          // Single click on unselected item
          this._selectItem(item.id, false);
        } else if (isAdditive) {
          // Ctrl/Shift click - toggle selection
          this._selectItem(item.id, true);
        }
        
        // Start dragging (can be for moving or for connecting)
        this.isDragging = true;
        this.dragStart = { x, y };
        this.dragItemStartPos = { x: item.x, y: item.y }; // Save first item's current position
        
        // Save starting positions of all selected items and any items in their groups
        this.dragStartPositions.clear();
        const boardData = MurderBoardData.getGlobalBoardData();
        const itemsToTrack = new Set(this.selectedItems);
        
        // If any selected item is in a group, add all items in that group
        this.selectedItems.forEach(selectedId => {
          const itemData = boardData.items.find(i => i.id === selectedId);
          if (itemData && itemData.groupId) {
            // Add all items in this group
            boardData.items.forEach(grpItem => {
              if (grpItem.groupId === itemData.groupId) {
                itemsToTrack.add(grpItem.id);
              }
            });
          }
        });
        
        // Now save positions of all tracked items
        itemsToTrack.forEach(trackedId => {
          const itemData = boardData.items.find(i => i.id === trackedId);
          if (itemData) {
            this.dragStartPositions.set(trackedId, { x: itemData.x, y: itemData.y });
          }
        });
        
        this.dragOverItem = null; // Track if dragging over another item
        this.renderer.draggedItem = item.id; // Bring item to front while dragging
      } else {
        // Empty space clicked - start box select or clear selection
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
          this._selectItem(null, false); // Clear selection
        }
        
        // Start box select
        this.isBoxSelecting = true;
        this.boxSelectStart = { x, y };
        this.boxSelectCurrent = { x, y };
      }

      this.renderer.draw();
    } catch (error) {
      console.error('Murder Board | Error in mouse down:', error);
      // Ensure cleanup on error
      this._cleanupDragState();
    }
  }

  /**
   * Handle canvas mouse move
   * @param {MouseEvent} event
   */
  _onCanvasMouseMove(event) {
    try {
      // Ignore moves over toolbar
      if (event.target.closest('.murder-board-toolbar')) {
        return;
      }

      if (!this.renderer) return;

      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Handle rotation
      if (this.isRotating && this.rotatingItem) {
        // Calculate angle from center to current mouse position
        const dx = x - this.rotateCenterX;
        const dy = y - this.rotateCenterY;
        const currentAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        // Calculate angle from center to start position
        const startDx = this.rotateStart.x - this.rotateCenterX;
        const startDy = this.rotateStart.y - this.rotateCenterY;
        const startAngle = Math.atan2(startDy, startDx) * 180 / Math.PI;
        
        // Calculate rotation delta
        const angleDelta = currentAngle - startAngle;
        let newRotation = (this.rotateStartAngle + angleDelta) % 360;
        if (newRotation < 0) newRotation += 360;
        
        // Snap to 15 degree increments if shift is held
        if (event.shiftKey) {
          newRotation = Math.round(newRotation / 15) * 15;
        }
        
        // Update cached item rotation directly (avoid recalculation)
        this.rotatingItem.rotation = newRotation;
        
        // Use requestAnimationFrame to throttle draw calls during rotation
        if (!this.rotationDrawPending) {
          this.rotationDrawPending = true;
          requestAnimationFrame(() => {
            this.renderer.draw();
            this.rotationDrawPending = false;
          });
        }
        return;
      }
      
      // Handle right-click panning (convert to isPanning when dragging)
      if (this.isRightClickPanning) {
        const panDeltaX = x - this.panStartX;
        const panDeltaY = y - this.panStartY;
        // If movement exceeds threshold, treat as pan
        if (Math.abs(panDeltaX) > 5 || Math.abs(panDeltaY) > 5) {
          this.isPanning = true;
          this.rightClickPanned = true; // Mark that we actually panned
        }
      }

      // Handle panning
      if (this.isPanning && this.isRightClickPanning) {
        const panDeltaX = x - this.panStartX;
        const panDeltaY = y - this.panStartY;
        this.renderer.camera.x = this.panStartCameraX + panDeltaX;
        this.renderer.camera.y = this.panStartCameraY + panDeltaY;
        
        // Throttle draw calls during panning
        if (!this.panDrawPending) {
          this.panDrawPending = true;
          requestAnimationFrame(() => {
            this.renderer.draw();
            this.panDrawPending = false;
          });
        }
        return;
      }

      // Handle box select
      if (this.isBoxSelecting) {
        this.boxSelectCurrent = { x, y };
        this.renderer.boxSelectRect = {
          x1: this.boxSelectStart.x,
          y1: this.boxSelectStart.y,
          x2: x,
          y2: y
        };
        
        // Throttle draw calls during box selection
        if (!this.boxSelectDrawPending) {
          this.boxSelectDrawPending = true;
          requestAnimationFrame(() => {
            this.renderer.draw();
            this.boxSelectDrawPending = false;
          });
        }
        return;
      }

      // Handle resizing
      if (this.isResizing && this.resizeItemId) {
        const deltaX = x - this.resizeStart.x;
        const deltaY = y - this.resizeStart.y;
        
        const boardData = MurderBoardData.getGlobalBoardData();
        // Apply migrations to ensure items have correct dimensions
        this.renderer._migrateOldItemData(boardData);
        const item = boardData.items.find(i => i.id === this.resizeItemId);
        if (item) {
          const zoomedDeltaX = deltaX / this.renderer.camera.zoom;
          const zoomedDeltaY = deltaY / this.renderer.camera.zoom;
          
          // Calculate the four corners of the original item
          const originalLeft = this.resizeStartPosition.x;
          const originalRight = this.resizeStartPosition.x + this.resizeStartDimensions.width;
          const originalTop = this.resizeStartPosition.y;
          const originalBottom = this.resizeStartPosition.y + this.resizeStartDimensions.height;
          
          // Dragged corner follows the mouse, opposite corner stays locked
          let newLeft = originalLeft;
          let newRight = originalRight;
          let newTop = originalTop;
          let newBottom = originalBottom;
          
          switch (this.resizeHandle) {
            case 'nw': // Top-left dragged, bottom-right locked
              newLeft = originalLeft + zoomedDeltaX;
              newTop = originalTop + zoomedDeltaY;
              break;
            case 'ne': // Top-right dragged, bottom-left locked
              newRight = originalRight + zoomedDeltaX;
              newTop = originalTop + zoomedDeltaY;
              break;
            case 'sw': // Bottom-left dragged, top-right locked
              newLeft = originalLeft + zoomedDeltaX;
              newBottom = originalBottom + zoomedDeltaY;
              break;
            case 'se': // Bottom-right dragged, top-left locked
              newRight = originalRight + zoomedDeltaX;
              newBottom = originalBottom + zoomedDeltaY;
              break;
          }
          
          // Calculate new dimensions and position from the corners
          let newWidth = Math.abs(newRight - newLeft);
          let newHeight = Math.abs(newBottom - newTop);
          let newX = Math.min(newLeft, newRight);
          let newY = Math.min(newTop, newBottom);
          
          // Ensure minimum size and handle type-specific constraints
          // For Image items, maintain aspect ratio based on actual image dimensions if available
          if (item.type === 'Image') {
            if (item.data?.imageUrl && this.renderer.imageCache.has(item.data.imageUrl)) {
              const cachedImg = this.renderer.imageCache.get(item.data.imageUrl);
              if (cachedImg) {
                const imgAspect = cachedImg.width / cachedImg.height;
                // Constrain to aspect ratio - user can resize either dimension, other adjusts automatically
                // We'll use whichever changed more to determine the primary resize direction
                const widthChange = Math.abs(newWidth - this.resizeStartDimensions.width);
                const heightChange = Math.abs(newHeight - this.resizeStartDimensions.height);
                
                if (widthChange > heightChange) {
                  // Width changed more, constrain height based on width
                  newHeight = newWidth / imgAspect;
                } else {
                  // Height changed more, constrain width based on height
                  newWidth = newHeight * imgAspect;
                }
                
                // Adjust position to keep the dragged corner in place when aspect ratio forces adjustment
                const widthDiff = newWidth - (newRight - newLeft);
                const heightDiff = newHeight - (newBottom - newTop);
                
                if (this.resizeHandle === 'nw') {
                  newLeft -= widthDiff;
                  newTop -= heightDiff;
                } else if (this.resizeHandle === 'ne') {
                  newRight += widthDiff;
                  newTop -= heightDiff;
                } else if (this.resizeHandle === 'sw') {
                  newLeft -= widthDiff;
                  newBottom += heightDiff;
                } else if (this.resizeHandle === 'se') {
                  newRight += widthDiff;
                  newBottom += heightDiff;
                }
                
                newX = Math.min(newLeft, newRight);
                newY = Math.min(newTop, newBottom);
              }
            }
            // Apply minimum size for all images (cached or not)
            newWidth = Math.max(newWidth, 30);
            newHeight = Math.max(newHeight, 30);
          } else if (item.type === 'Note') {
            newWidth = Math.max(newWidth, 20);
            newHeight = Math.max(newHeight, 20);
          } else if (item.type === 'Document') {
            newWidth = Math.max(newWidth, 40);
            newHeight = Math.max(newHeight, 40);
          } else {
            newWidth = Math.max(newWidth, 30);
            newHeight = Math.max(newHeight, 30);
          }
          
          // Update item data
          if (!item.data) item.data = {};
          item.data.width = newWidth;
          item.data.height = newHeight;
          item._migrationApplied = true;  // Mark as migrated so migration won't delete these dimensions
          item.x = newX;
          item.y = newY;
          
          // Update the cached board data immediately for visual feedback (no save yet)
          if (this.renderer._currentBoardData) {
            const cachedItem = this.renderer._currentBoardData.items.find(i => i.id === this.resizeItemId);
            if (cachedItem) {
              cachedItem.x = newX;
              cachedItem.y = newY;
              cachedItem.data = { ...cachedItem.data, ...item.data };
              cachedItem._migrationApplied = true;
            }
          }
          
          // Throttle draw calls during resizing
          if (!this.resizeDrawPending) {
            this.resizeDrawPending = true;
            requestAnimationFrame(() => {
              this.renderer.draw();
              this.resizeDrawPending = false;
            });
          }
        }
        return;
      }

      if (this.isDragging && this.selectedItems.length > 0) {
        // Calculate total delta from drag start IN SCREEN SPACE
        const screenDeltaX = x - this.dragStart.x;
        const screenDeltaY = y - this.dragStart.y;
        
        // Convert screen delta to world delta using current zoom
        const worldDeltaX = screenDeltaX / this.renderer.camera.zoom;
        const worldDeltaY = screenDeltaY / this.renderer.camera.zoom;

        // Check if dragging over another item (for connection creation with first selected item)
        // Use exact item dimensions for connection hitbox detection
        let itemAtCursor = this.renderer.getItemAtPoint(x, y, 0);
        const firstSelectedId = this.selectedItems[0];
        const firstSelectedItem = firstSelectedId ? MurderBoardData.getItem(this.scene, firstSelectedId) : null;
        
        // Explicitly exclude the dragged item from being detected as a target
        if (itemAtCursor && itemAtCursor.id === firstSelectedId) {
          itemAtCursor = null;
        }
        
        // Determine if we can create a connection
        let canConnect = false;
        if (itemAtCursor && this.selectedItems.length === 1) {
          // Both items must accept connections
          const targetAccepts = itemAtCursor.acceptsConnections !== false;
          const sourceAccepts = firstSelectedItem && firstSelectedItem.acceptsConnections !== false;
          canConnect = targetAccepts && sourceAccepts;
        }

        const boardData = MurderBoardData.getGlobalBoardData();

        if (canConnect) {
          // Over another item with single selection - highlight for connection AND move the item
          this.dragOverItem = itemAtCursor.id;
          this.renderer.setHighlight(firstSelectedId);
          this.renderer.setHoverItem(this.dragOverItem);
          // Set connection preview to show where connection will go
          this.renderer.setConnectionPreview(firstSelectedId, x, y);
          this.renderer.connectionPreviewMode = true;
          // Store target item for pulsing
          this.renderer.connectionTargetItem = this.dragOverItem;
          // Cursor feedback
          this.canvas.parentElement.style.cursor = 'copy';
          
          // Still move the dragged item for preview while dragging toward connection target
          const itemIndex = boardData.items.findIndex(i => i.id === firstSelectedId);
          if (itemIndex !== -1) {
            const item = boardData.items[itemIndex];
            const startPos = this.dragStartPositions.get(firstSelectedId);
            if (startPos) {
              item.x = startPos.x + worldDeltaX;
              item.y = startPos.y + worldDeltaY;
            }
          }

          // Update connection label positions to follow their connections
          // (but skip this if we're dragging a label item itself)
          const isDraggingLabel = boardData.connections.some(c => c.labelItemId === firstSelectedId);
          if (!isDraggingLabel) {
            this._updateConnectionLabelPositions(boardData.items, boardData.connections);
          }

          // Debounce scene flag updates - only update every 50ms during drag
          if (this.dragUpdateTimeout) {
            clearTimeout(this.dragUpdateTimeout);
          }
          
          this.dragUpdateTimeout = setTimeout(() => {
            this._updateBoardItems(boardData.items);
            this.dragUpdateTimeout = null;
          }, 50);
        } else {
          // Multi-select or normal drag - move all selected items
          // Clear connection preview if we were in one
          if (this.dragOverItem !== null) {
            this.renderer.connectionPreviewMode = false;
            this.renderer.connectionTargetItem = null;
            this.renderer.clearConnectionPreview();
          }
          this.dragOverItem = null;
          this.canvas.parentElement.style.cursor = 'move';
          
          // Determine all items to move (including grouped items)
          const itemsToMove = new Set(this.selectedItems);
          
          // For each selected item, if it's in a group, add all other items in that group
          const boardData = MurderBoardData.getGlobalBoardData();
          this.selectedItems.forEach(selectedId => {
            const selectedItem = boardData.items.find(i => i.id === selectedId);
            if (selectedItem && selectedItem.groupId) {
              // Add all items in this group
              boardData.items.forEach(item => {
                if (item.groupId === selectedItem.groupId) {
                  itemsToMove.add(item.id);
                }
              });
            }
          });
          
          // Update all items to move, maintaining their relative positions
          itemsToMove.forEach(itemId => {
            const itemIndex = boardData.items.findIndex(i => i.id === itemId);
            if (itemIndex !== -1) {
              const item = boardData.items[itemIndex];
              const startPos = this.dragStartPositions.get(itemId);
              if (startPos) {
                // Move item from its starting position + world delta
                item.x = startPos.x + worldDeltaX;
                item.y = startPos.y + worldDeltaY;
              }
            }
          });

          // Update connection label positions to follow their connections
          // (but skip this if we're dragging a label item itself)
          const isDraggingLabel = boardData.connections.some(c => c.labelItemId === firstSelectedId);
          if (!isDraggingLabel) {
            this._updateConnectionLabelPositions(boardData.items, boardData.connections);
          }

          // Don't save during drag - only update visual position
          // Final save happens on mouse up for better performance
        }

        // Throttle draw calls during dragging
        if (!this.dragDrawPending) {
          this.dragDrawPending = true;
          requestAnimationFrame(() => {
            this.renderer.draw();
            this.dragDrawPending = false;
          });
        }
      }

      // Highlight item under cursor (if not dragging)
      if (!this.isDragging && !this.isBoxSelecting) {
        const item = this.renderer.getItemAtPoint(x, y);
        this.renderer.setHoverItem(item?.id || null);
        
        // Check for hovered connection if no item is hovered
        if (!item) {
          const connection = this.renderer.getConnectionAtPoint(x, y);
          this.renderer.setHoverConnection(connection || null);
        } else {
          this.renderer.setHoverConnection(null);
        }
        
        // Throttle draw calls for hover effects
        if (!this.hoverDrawPending) {
          this.hoverDrawPending = true;
          requestAnimationFrame(() => {
            this.renderer.draw();
            this.hoverDrawPending = false;
          });
        }
      }
    } catch (error) {
      console.error('Murder Board | Error in mouse move:', error);
    }
  }

  /**
   * Handle canvas mouse up
   * @param {MouseEvent} event
   */
  async _onCanvasMouseUp(event) {
    try {
      // Ignore mouseup over toolbar
      if (event.target.closest('.murder-board-toolbar')) {
        return;
      }

      if (!this.renderer) return;

      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      // Handle rotation end
      if (this.isRotating) {
        const boardData = MurderBoardData.getGlobalBoardData();
        const item = boardData.items.find(i => i.id === this.rotateItemId);
        if (item) {
          await MurderBoardData.updateItem(this.scene, item.id, { rotation: item.rotation });
          await MurderBoardData.saveGlobalBoardData(boardData);
          
          // Emit socket message
          if (this.socketHandler) {
            this.socketHandler.emitSocketMessage({
              action: 'updateItem',
              sceneId: this.scene.id,
              itemId: item.id,
              itemData: { rotation: item.rotation },
              userId: game.user.id
            });
          }
        }
        
        this.isRotating = false;
        this.rotateItemId = null;
        this.rotatingItem = null;
        this.rotateStart = null;
        this.rotateStartAngle = null;
        this.rotateCenterX = null;
        this.rotateCenterY = null;
        this.rotationDrawPending = false;
        this.renderer.draw();
        return;
      }

      // Handle right-click release (either pan end or show context menu)
      if (this.isRightClickPanning) {
        this.isRightClickPanning = false;
        
        // If we were panning, stop and save
        if (this.isPanning) {
          this.isPanning = false;
          this._debouncedSaveCameraState();
          this.renderer.draw();
          return;
        }
        
        // Right-click without drag - show context menu on mouseup (not in contextmenu event)
        // The contextmenu event will fire after this, and we'll suppress it since rightClickPanned is false
        
        // Clear all rendering state before showing menu
        if (this.renderer) {
          this.renderer.setHoverItem(null);
          this.renderer.setHoverConnection(null);
          this.renderer.connectionPreviewMode = false;
          this.renderer.connectionTargetItem = null;
          this.renderer.clearConnectionPreview();
          this.renderer.draw();
        }
        
        const item = this.renderer.getItemAtPoint(x, y);
        if (item) {
          this._showContextMenu(item, event.clientX, event.clientY);
        } else {
          const connection = this.renderer.getConnectionAtPoint(x, y);
          if (connection) {
            this._showConnectionMenu(connection, event.clientX, event.clientY);
          } else {
            this._showCreationMenu(x, y, event.clientX, event.clientY);
          }
        }
        return;
      }

      // Stop panning (legacy middle-click - kept for backwards compatibility if needed)
      if (this.isPanning) {
        this.isPanning = false;
        // Save camera state after panning
        this._debouncedSaveCameraState();
        this.renderer.draw();
        return;
      }

      // Stop box select
      if (this.isBoxSelecting) {
        this.isBoxSelecting = false;
        this.renderer.boxSelectRect = null;
        
        // Select items in box
        const isAdditive = event.ctrlKey || event.metaKey || event.shiftKey;
        this._selectItemsInBox(
          this.boxSelectStart.x,
          this.boxSelectStart.y,
          this.boxSelectCurrent.x,
          this.boxSelectCurrent.y,
          isAdditive
        );
        
        this.renderer.draw();
        return;
      }

      // Stop resizing
      if (this.isResizing) {
        this.isResizing = false;
        
        // Save the final resized dimensions to database
        if (this.resizeItemId && this.renderer._currentBoardData) {
          const item = this.renderer._currentBoardData.items.find(i => i.id === this.resizeItemId);
          if (item) {
            // Save without awaiting to avoid blocking the UI
            MurderBoardData.updateItem(this.scene, this.resizeItemId, { 
              x: item.x, 
              y: item.y, 
              data: item.data, 
              _migrationApplied: item._migrationApplied 
            }).catch(err => console.error('Failed to save resize:', err));
          }
        }
        
        this.resizeItemId = null;
        this.resizeHandle = null;
        this.renderer.draw();
        return;
      }

      if (this.isDragging && this.selectedItems.length > 0) {
        const firstSelectedId = this.selectedItems[0];
        
        // Reset cursor
        this.canvas.parentElement.style.cursor = 'default';
        
        // Check if released over another item (connection - only for single selection)
        if (this.dragOverItem && this.selectedItems.length === 1) {
          // Create connection
          try {
            const fromItem = MurderBoardData.getItem(this.scene, firstSelectedId);
            const toItem = MurderBoardData.getItem(this.scene, this.dragOverItem);
            
            if (!fromItem || !toItem) {
              throw new Error('One or both items were not found');
            }
            
            await MurderBoardData.addConnection(this.scene, firstSelectedId, this.dragOverItem);
            this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionCreated'));
            
            // Emit socket message
            if (!game.user.isGM) {
              emitSocketMessage('addConnection', {
                sceneId: this.scene.id,
                fromId: firstSelectedId,
                toId: this.dragOverItem,
              });
            }

            // Reset item to original position (don't save the drag)
            const boardData = MurderBoardData.getGlobalBoardData();
            const item = boardData.items.find(i => i.id === firstSelectedId);
            if (item) {
              item.x = this.dragItemStartPos.x;
              item.y = this.dragItemStartPos.y;
              await this._updateBoardItems(boardData.items);
            }
          } catch (error) {
            console.error('Murder Board | Connection creation failed:', error);
            // Provide more helpful error messages
            let errorMsg = error.message;
            if (errorMsg.includes('does not accept connections') || errorMsg.includes('reject')) {
              errorMsg = 'One or both items reject connections. Right-click to toggle connection mode.';
            } else if (errorMsg.includes('do not exist') || errorMsg.includes('not found')) {
              errorMsg = 'Could not connect items. Make sure both items still exist.';
            } else if (errorMsg.includes('from item to itself')) {
              errorMsg = 'Cannot connect an item to itself.';
            }
            this._notify(errorMsg, 'error');
            // Reset item to original position on connection creation failure
            const boardData = MurderBoardData.getGlobalBoardData();
            const item = boardData.items.find(i => i.id === firstSelectedId);
            if (item) {
              item.x = this.dragItemStartPos.x;
              item.y = this.dragItemStartPos.y;
              await this._updateBoardItems(boardData.items);
            }
          }
        } else {
          // Check if any item was actually moved
          const boardData = MurderBoardData.getGlobalBoardData();
          const firstItem = boardData.items.find(i => i.id === firstSelectedId);
          
          if (firstItem) {
            const itemMoved = firstItem.x !== this.dragItemStartPos.x || firstItem.y !== this.dragItemStartPos.y;
            
            if (itemMoved) {
              // Items were already updated during mousemove - just reorder them to front
              const reorderedItems = [];
              const selectedIds = new Set(this.selectedItems);
              
              // Keep non-selected items in original order
              boardData.items.forEach(item => {
                if (!selectedIds.has(item.id)) {
                  reorderedItems.push(item);
                }
              });
              
              // Add selected items to end (bringing to front)
              this.selectedItems.forEach(selectedId => {
                const item = boardData.items.find(i => i.id === selectedId);
                if (item) {
                  reorderedItems.push(item);
                }
              });
              
              // Save reordered items
              await this._updateBoardItems(reorderedItems);
              
              // Update label offsets for any connection labels that were moved
              this.selectedItems.forEach(selectedId => {
                this._updateConnectionLabelOffset(selectedId);
              });
              
              // Emit socket message for multiplayer sync (only if player, GM updates directly)
              if (!game.user.isGM) {
                emitSocketMessage('updateItems', {
                  sceneId: this.scene.id,
                  items: reorderedItems,
                });
              }
            }
          }
        }
      }

      // Clean up ALL drag state to ensure consistency
      this._cleanupDragState();
      
      this.renderer.draw();
    } catch (error) {
      console.error('Murder Board | Error in mouse up:', error);
      // Force cleanup even on error to prevent stuck states
      this._cleanupDragState();
      if (this.renderer) {
        this.renderer.draw();
      }
    }
  }

  /**
   * Handle canvas right-click
   * @param {MouseEvent} event
   */
  _onCanvasContextMenu(event) {
    // Ignore right-clicks on toolbar or buttons
    if (event.target.closest('.murder-board-toolbar') || 
        event.target.closest('.murder-board-btn') ||
        event.target.closest('button') ||
        event.target.closest('menu')) {
      return false;
    }
    
    // If we performed an actual pan with right-click drag, suppress the context menu
    if (this.rightClickPanned) {
      this.rightClickPanned = false;
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    
    // Always prevent default and stop propagation for right-clicks on canvas
    event.preventDefault();
    event.stopPropagation();
    return false;
  }

  /**
   * Update menu display to reflect current item state (selected colors, values, etc.)
   * @param {string} itemId - Item ID
   * @private
   */
  _updateMenuDisplay(itemId) {
    const menuDiv = document.querySelector('.murder-board-context-menu');
    if (!menuDiv) return; // Menu not open

    const item = MurderBoardData.getItem(this.scene, itemId);
    if (!item) return;

    // Update fastener buttons - mark current fastener as selected
    const fastenerBtns = menuDiv.querySelectorAll('.murder-board-fastener-btn');
    const currentFastener = item.data?.fastenerType || 'pushpin';
    fastenerBtns.forEach(btn => {
      if (btn.dataset.fastener === currentFastener) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update color buttons for documents
    const docColorBtns = menuDiv.querySelectorAll('.murder-board-doc-color-btn');
    docColorBtns.forEach(btn => {
      if (btn.dataset.color === item.color) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update color buttons for notes
    const noteColorBtns = menuDiv.querySelectorAll('.murder-board-note-color-btn');
    noteColorBtns.forEach(btn => {
      if (btn.dataset.color === item.color) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update font color buttons
    const fontColorBtns = menuDiv.querySelectorAll('.murder-board-font-color-btn');
    const currentTextColor = item.data?.textColor || '#000000';
    fontColorBtns.forEach(btn => {
      if (btn.dataset.color === currentTextColor) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update shadow buttons
    const shadowBtns = menuDiv.querySelectorAll('.murder-board-shadow-btn');
    const currentShadow = item.data?.shadow || 'default';
    shadowBtns.forEach(btn => {
      if (btn.dataset.shadow === currentShadow) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update border color buttons
    const borderBtns = menuDiv.querySelectorAll('.murder-board-border-btn');
    const currentBorder = item.data?.borderColor || 'white';
    borderBtns.forEach(btn => {
      if (btn.dataset.border === currentBorder) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update effect buttons
    const effectBtns = menuDiv.querySelectorAll('.murder-board-doc-effect-btn');
    const currentEffect = item.data?.effect || 'none';
    effectBtns.forEach(btn => {
      if (btn.dataset.effect === currentEffect) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    // Update font select dropdown
    const fontDropdown = menuDiv.querySelector('#font-select-dropdown');
    if (fontDropdown) {
      fontDropdown.value = item.data?.font || 'Arial';
    }

    // Update font size slider
    const fontSizeSlider = menuDiv.querySelector('#font-size-slider');
    if (fontSizeSlider) {
      fontSizeSlider.value = item.data?.fontSize || 14;
      const fontSizeValue = menuDiv.querySelector('#font-size-value');
      if (fontSizeValue) {
        fontSizeValue.textContent = (item.data?.fontSize || 14) + 'px';
      }
    }

    // Update effect intensity slider
    const intensitySlider = menuDiv.querySelector('#effect-intensity-slider');
    if (intensitySlider) {
      intensitySlider.value = item.data?.effectIntensity || 1;
      const intensityValue = menuDiv.querySelector('#effect-intensity-value');
      if (intensityValue) {
        intensityValue.textContent = (item.data?.effectIntensity || 1).toFixed(1);
      }
    }

    // Update effect seed slider
    const seedSlider = menuDiv.querySelector('#effect-seed-slider');
    if (seedSlider) {
      seedSlider.value = item.data?.effectSeed || 50;
      const seedValue = menuDiv.querySelector('#effect-seed-value');
      if (seedValue) {
        seedValue.textContent = (item.data?.effectSeed || 50);
      }
    }

    // Update z-index display if present
    const zindexDisplay = menuDiv.querySelector('#zindex-value');
    if (zindexDisplay) {
      zindexDisplay.textContent = (item.zIndex || 0).toFixed(1);
    }

    // Update connection acceptance toggle state if present
    const connectionToggle = menuDiv.querySelector('.murder-board-connection-toggle-btn');
    if (connectionToggle) {
      const accepts = item.acceptsConnections !== false;
      if (accepts) {
        connectionToggle.classList.add('selected');
      } else {
        connectionToggle.classList.remove('selected');
      }
    }
  }

  /**
   * Show context menu for item
   * @param {Object} item - Item object
   * @param {number} x - Screen X position
   * @param {number} y - Screen Y position
   */
  _showContextMenu(item, x, y) {
    try {
      // Check if user can edit
      const canEdit = MurderBoardData.canUserEdit(this.scene);
      if (!canEdit) {
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
        return;
      }

      const itemId = item.id;
      const self = this;
      const isMultiSelect = this.selectedItems.length > 1;

      // Create menu items
      const menuItems = [
        {
          label: game.i18n.localize('MURDER_BOARD.UI.Edit'),
          icon: 'fas fa-edit',
          callback: () => {
            try {
              self._editItem(itemId);
            } catch (error) {
              console.error('Murder Board | Error editing item:', error);
              this._notify('Error editing item', 'error');
            }
          },
          hidden: true, // Always hide - use context menu-based editing instead
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.Duplicate'),
          icon: 'fas fa-copy',
          callback: () => {
            try {
              self._duplicateItem(itemId);
            } catch (error) {
              console.error('Murder Board | Error duplicating item:', error);
              this._notify('Error duplicating item', 'error');
            }
          },
          hidden: isMultiSelect, // Hide duplicate for multi-select
        },
        {
          label: isMultiSelect ? `Delete ${this.selectedItems.length} Items` : game.i18n.localize('MURDER_BOARD.UI.Delete'),
          icon: 'fas fa-trash',
          callback: () => {
            try {
              if (isMultiSelect) {
                self._deleteMultipleItems(self.selectedItems);
              } else {
                self._deleteItem(itemId);
              }
            } catch (error) {
              console.error('Murder Board | Error deleting item:', error);
              this._notify('Error deleting item', 'error');
            }
          },
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.BringToFront') || 'Bring to Front',
          icon: 'fas fa-arrow-up',
          callback: () => {
            try {
              self._bringToFront(itemId);
            } catch (error) {
              console.error('Murder Board | Error bringing item to front:', error);
              this._notify('Error bringing item to front', 'error');
            }
          },
          hidden: isMultiSelect, // Hide for multi-select
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.BringForward') || 'Bring Forward',
          icon: 'fas fa-chevron-up',
          callback: () => {
            try {
              self._bringForward(itemId);
            } catch (error) {
              console.error('Murder Board | Error bringing item forward:', error);
              this._notify('Error bringing item forward', 'error');
            }
          },
          hidden: isMultiSelect, // Hide for multi-select
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.SendBackward') || 'Send Backward',
          icon: 'fas fa-chevron-down',
          callback: () => {
            try {
              self._sendBackward(itemId);
            } catch (error) {
              console.error('Murder Board | Error sending item backward:', error);
              this._notify('Error sending item backward', 'error');
            }
          },
          hidden: isMultiSelect, // Hide for multi-select
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.SendToBack') || 'Send to Back',
          icon: 'fas fa-arrow-down',
          callback: () => {
            try {
              self._sendToBack(itemId);
            } catch (error) {
              console.error('Murder Board | Error sending item to back:', error);
              this._notify('Error sending item to back', 'error');
            }
          },
          hidden: isMultiSelect, // Hide for multi-select
        },
        {
          label: isMultiSelect ? `Group ${this.selectedItems.length} Items` : 'Add to Group',
          icon: 'fas fa-object-group',
          callback: () => {
            try {
              if (isMultiSelect && self.selectedItems.length >= 2) {
                self._createGroup();
              }
            } catch (error) {
              console.error('Murder Board | Error grouping items:', error);
              this._notify('Error grouping items', 'error');
            }
          },
          hidden: !isMultiSelect || this.selectedItems.length < 2, // Show only for multi-select with 2+ items
        },
        {
          label: 'Ungroup',
          icon: 'fas fa-object-ungroup',
          callback: () => {
            try {
              // Check if this item is part of a group
              if (item.groupId) {
                self._ungroup(item.groupId);
              }
            } catch (error) {
              console.error('Murder Board | Error ungrouping:', error);
              this._notify('Error ungrouping', 'error');
            }
          },
          hidden: isMultiSelect || !item.groupId, // Show only for single grouped items
        },
        {
          label: 'Group to Front',
          icon: 'fas fa-arrow-up',
          callback: () => {
            try {
              if (item.groupId) {
                self._bringGroupToFront(item.groupId);
              }
            } catch (error) {
              console.error('Murder Board | Error bringing group to front:', error);
              this._notify('Error bringing group to front', 'error');
            }
          },
          hidden: isMultiSelect || !item.groupId, // Show only for single grouped items
        },
        {
          label: 'Group to Back',
          icon: 'fas fa-arrow-down',
          callback: () => {
            try {
              if (item.groupId) {
                self._sendGroupToBack(item.groupId);
              }
            } catch (error) {
              console.error('Murder Board | Error sending group to back:', error);
              this._notify('Error sending group to back', 'error');
            }
          },
          hidden: isMultiSelect || !item.groupId, // Show only for single grouped items
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.EditText') || 'Edit Text',
          icon: 'fas fa-pen-to-square',
          callback: () => {
            try {
              self._editItemContent(itemId);
            } catch (error) {
              console.error('Murder Board | Error editing item content:', error);
              this._notify('Error editing item', 'error');
            }
          },
          hidden: isMultiSelect || (item.type !== 'Text' && item.type !== 'Note' && item.type !== 'Document'),
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.EditImage') || 'Edit Image',
          icon: 'fas fa-image',
          callback: () => {
            try {
              self._editImageUrl(itemId);
            } catch (error) {
              console.error('Murder Board | Error editing image:', error);
              this._notify('Error editing image', 'error');
            }
          },
          hidden: isMultiSelect || item.type !== 'Image',
        },
      ];

      // Create custom context menu HTML
      let html = '<div class="murder-board-context-menu" style="min-width: 150px;">';
      
      // Add z-index control buttons at the top (if not multi-select)
      if (!isMultiSelect) {
        const currentZIndex = item.zIndex || 0;
        html += `<div class="murder-board-zindex-controls" style="display: flex; gap: 4px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(0,0,0,0.2); align-items: center;">`;
        
        // Bring to Front button
        const bringToFrontIdx = menuItems.findIndex(m => m.label.includes('Bring to Front'));
        html += `<button class="murder-board-zindex-btn" data-callback="${bringToFrontIdx}" title="Bring to Front">
          <i class="fas fa-arrow-up"></i>
        </button>`;
        
        // Bring Forward button
        const bringForwardIdx = menuItems.findIndex(m => m.label.includes('Bring Forward'));
        html += `<button class="murder-board-zindex-btn" data-callback="${bringForwardIdx}" title="Bring Forward">
          <i class="fas fa-chevron-up"></i>
        </button>`;
        
        // Send Backward button
        const sendBackwardIdx = menuItems.findIndex(m => m.label.includes('Send Backward'));
        html += `<button class="murder-board-zindex-btn" data-callback="${sendBackwardIdx}" title="Send Backward">
          <i class="fas fa-chevron-down"></i>
        </button>`;
        
        // Send to Back button
        const sendToBackIdx = menuItems.findIndex(m => m.label.includes('Send to Back'));
        html += `<button class="murder-board-zindex-btn" data-callback="${sendToBackIdx}" title="Send to Back">
          <i class="fas fa-arrow-down"></i>
        </button>`;
        
        // Z-index display
        html += `<div class="murder-board-zindex-display" style="margin-left: auto; padding: 0 8px; font-size: 12px; color: var(--mb-secondary); font-weight: bold; white-space: nowrap;">
          Z: <span id="zindex-value">${currentZIndex.toFixed(1)}</span>
        </div>`;
        
        html += `</div>`;
      }
      
      // Add edit buttons section - collect first
      let editItemsHtmlEarly = '';
      for (let menuItem of menuItems) {
        if (!menuItem.hidden && menuItem.label.includes('Edit')) {
          editItemsHtmlEarly += `
            <button class="murder-board-menu-item" data-callback="${menuItems.indexOf(menuItem)}">
              <i class="${menuItem.icon}"></i>
              ${menuItem.label}
            </button>
          `;
        }
      }
      
      // Add edit section right after z-index if it exists
      if (editItemsHtmlEarly) {
        html += `<div style="display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--mb-dialog-input-border);">`;
        html += editItemsHtmlEarly;
        html += `</div>`;
      }
      
      let menuItemsHtml = ''; // Store menu items to add at the end
      let groupItemsHtml = ''; // Store group items separately
      let editItemsHtml = ''; // Store edit buttons (Edit Text, Edit Image)
      let connectionToggleHtml = ''; // Store connection toggle button
      
      // Add connection toggle as icon-only button (for non-multi-select)
      if (!isMultiSelect) {
        const acceptsConnections = item.acceptsConnections !== false;
        connectionToggleHtml = `
          <button class="murder-board-connection-toggle-btn ${acceptsConnections ? 'active' : ''}" data-item-id="${itemId}"
                  title="${acceptsConnections ? 'Accepting Connections' : 'Rejecting Connections'}"
                  style="width: 32px; padding: 6px;">
            <i class="fas ${acceptsConnections ? 'fa-link' : 'fa-link-slash'}"></i>
          </button>
        `;
      }
      
      // Collect menu items HTML (excluding z-index items for single select)
      for (let menuItem of menuItems) {
        if (!menuItem.hidden && !menuItem.label.includes('Bring') && !menuItem.label.includes('Send') && !menuItem.label.includes('Group') && menuItem.label !== 'Ungroup' && !menuItem.label.includes('Edit')) {
          menuItemsHtml += `
            <button class="murder-board-menu-item" data-callback="${menuItems.indexOf(menuItem)}">
              <i class="${menuItem.icon}"></i>
              ${menuItem.label}
            </button>
          `;
        } else if (!menuItem.hidden && (menuItem.label.includes('Group') || menuItem.label === 'Ungroup')) {
          // Collect group-related items to a separate section
          groupItemsHtml += `
            <button class="murder-board-menu-item" data-callback="${menuItems.indexOf(menuItem)}">
              <i class="${menuItem.icon}"></i>
              ${menuItem.label}
            </button>
          `;
        } else if (!menuItem.hidden && menuItem.label.includes('Edit')) {
          // Collect edit buttons to their own section
          editItemsHtml += `
            <button class="murder-board-menu-item" data-callback="${menuItems.indexOf(menuItem)}">
              <i class="${menuItem.icon}"></i>
              ${menuItem.label}
            </button>
          `;
        }
      }
      
      // Add group items on their own line if any exist
      if (groupItemsHtml) {
        html += `<div style="display: flex; gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.2);">
          ${groupItemsHtml}
        </div>`;
      }
      
      // Add bulk fastener options for multi-select if any selected items are Image or Document
      if (isMultiSelect) {
        const hasImageOrDoc = this.selectedItems.some(id => {
          const itm = MurderBoardData.getItem(this.scene, id);
          return itm && (itm.type === 'Image' || itm.type === 'Document');
        });

        if (hasImageOrDoc) {
          const fastenerTypes = [
            { id: 'none', icon: 'fas fa-ban', label: 'None' },
            { id: 'pushpin', icon: 'fas fa-thumbtack', label: 'Pin' },
            { id: 'tape-top', icon: 'fas fa-rectangle-landscape', label: 'Tape' },
            { id: 'tape-all-corners', icon: 'fas fa-expand', label: 'Tape 4' },
            { id: 'tape-top-bottom', icon: 'fas fa-plus', label: 'Tape 2' },
          ];
          html += `<div class="murder-board-context-section">`;
          html += `<div class="murder-board-context-section-label">Fastener (All)</div>`;
          
          for (let fastener of fastenerTypes) {
            html += `
              <button class="murder-board-fastener-btn murder-board-bulk-fastener" data-fastener="${fastener.id}"
                      title="${fastener.label}">
                <i class="${fastener.icon}" style="display: block; margin-bottom: 2px; font-size: 14px;"></i>
              </button>
            `;
          }
          html += `</div>`;
        }
      } else {
        // Add fastener type buttons for Image and Document items (connection toggle moved to bottom)
        if (item.type === 'Image' || item.type === 'Document') {
          const fastenerTypes = [
            { id: 'none', icon: 'fas fa-ban', label: 'None' },
            { id: 'pushpin', icon: 'fas fa-thumbtack', label: 'Pin' },
            { id: 'tape-top', icon: 'fas fa-rectangle-landscape', label: 'Tape' },
            { id: 'tape-all-corners', icon: 'fas fa-expand', label: 'Tape 4' },
            { id: 'tape-top-bottom', icon: 'fas fa-plus', label: 'Tape 2' },
          ];
          const currentFastener = item.data?.fastenerType || 'pushpin';
          html += `<div class="murder-board-context-section">`;
          
          for (let fastener of fastenerTypes) {
            const isSelected = currentFastener === fastener.id;
            html += `
              <button class="murder-board-fastener-btn ${isSelected ? 'selected' : ''}" data-fastener="${fastener.id}"
                      title="${fastener.label}">
                <i class="${fastener.icon}" style="display: block; margin-bottom: 2px; font-size: 14px;"></i>
              </button>
            `;
          }
          html += `</div>`;
        }
      }

      // Add paper type buttons for Document items
      if (item.type === 'Document') {
        const paperTypes = [
          { id: 'blank', label: 'Blank' },
          { id: 'looseleaf', label: 'Loose Leaf' },
          { id: 'grid', label: 'Grid' },
          { id: 'legal', label: 'Legal' },
          { id: 'spiral', label: 'Spiral' },
        ];
        const currentPaper = item.data?.preset || 'blank';
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Type</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let paperType of paperTypes) {
          const isSelected = currentPaper === paperType.id;
          html += `
            <button class="murder-board-paper-btn ${isSelected ? 'selected' : ''}" data-paper="${paperType.id}"
                    title="${paperType.label}">
              ${paperType.label}
            </button>
          `;
        }
        html += `</div></div>`;
      }

      // Add effects buttons for Documents
      if (item.type === 'Document') {
        const documentEffects = [
          { id: 'none', label: 'None' },
          { id: 'crumpled', label: 'Crumpled' },
          { id: 'torn', label: 'Torn' },
          { id: 'burned', label: 'Burned' },
        ];
        const currentEffect = item.data?.effect || 'none';
        const currentIntensity = item.data?.effectIntensity || 1;
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Effect</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let effect of documentEffects) {
          const isSelected = currentEffect === effect.id;
          html += `
            <button class="murder-board-doc-effect-btn ${isSelected ? 'selected' : ''}" data-effect="${effect.id}"
                    title="${effect.label}">
              ${effect.label}
            </button>
          `;
        }
        html += `</div>`;
        
        // Add intensity slider (only show if effect is not 'none')
        if (currentEffect !== 'none') {
          const currentSeed = item.data?.effectSeed || 50;
          html += `
            <div style="width: 100%; margin-top: 8px; padding: 8px; box-sizing: border-box; border-top: 1px solid var(--mb-border);">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <label style="font-size: 11px; color: var(--mb-text); white-space: nowrap;">Intensity:</label>
                <span id="effect-intensity-value" style="font-size: 11px; color: var(--mb-text); font-weight: bold; min-width: 25px;">${(currentIntensity).toFixed(1)}</span>
              </div>
              <input type="range" id="effect-intensity-slider" class="murder-board-effect-slider"
                     min="1" max="4" value="${currentIntensity}" step="0.1"
                     style="width: 100%; cursor: pointer;">
              
              <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; margin-bottom: 6px;">
                <label style="font-size: 11px; color: var(--mb-text); white-space: nowrap;">Seed:</label>
                <span id="effect-seed-value" style="font-size: 11px; color: var(--mb-text); font-weight: bold; min-width: 25px;">${currentSeed}</span>
              </div>
              <input type="range" id="effect-seed-slider" class="murder-board-effect-slider"
                     min="0" max="100" value="${currentSeed}" step="1"
                     style="width: 100%; cursor: pointer;">
            </div>
          `;
        }
        html += `</div>`;

        // Add color swatches for Documents
        const documentColors = [
          { hex: '#FFFEF5', label: 'Cream' },
          { hex: '#F5F5F0', label: 'Off-White' },
          { hex: '#EBE8E0', label: 'Beige' },
          { hex: '#E8DCC8', label: 'Tan' },
          { hex: '#D9D0C4', label: 'Light Brown' },
          { hex: '#F0E8E0', label: 'Taupe' },
          { hex: '#E0E0E0', label: 'Light Grey' },
          { hex: '#D0D0D0', label: 'Grey' },
        ];
        
        const currentDocColor = item.color || '#FFFEF5';
        html += this._buildCompactColorPicker('Color', documentColors, currentDocColor, 'murder-board-doc-color-btn');
      }

      // Add size buttons for Image items
      if (item.type === 'Image') {
        // Add border color buttons for Image items
        const borderColors = [
          { id: 'white', label: 'White', color: '#ffffff' },
          { id: 'black', label: 'Black', color: '#000000' },
          { id: 'none', label: 'None', color: 'transparent' },
        ];
        const currentBorder = item.data?.borderColor || 'white';
        html += `<div style="padding: 8px 12px; border-bottom: 1px solid #eee; display: flex; gap: 4px; flex-wrap: wrap;">`;
        
        for (let borderOpt of borderColors) {
          const isSelected = currentBorder === borderOpt.id;
          html += `
            <button class="murder-board-border-btn ${isSelected ? 'selected' : ''}" data-border="${borderOpt.id}"
                    title="${borderOpt.label}">
              <div style="width: 16px; height: 16px; margin: 0 auto 2px; border: 2px solid ${borderOpt.color === 'transparent' ? '#999' : borderOpt.color}; background: ${borderOpt.color === 'transparent' ? 'transparent' : borderOpt.color}; border-radius: 2px;"></div>
              <span style="font-size: 9px;">${borderOpt.label}</span>
            </button>
          `;
        }
        html += `</div>`;
      }

      // Add note color and font color swatches for Note items
      if (item.type === 'Note') {
        const noteColors = [
          { hex: '#FFFF00', label: 'Yellow' },
          { hex: '#FF9999', label: 'Red' },
          { hex: '#99CCFF', label: 'Blue' },
          { hex: '#99FF99', label: 'Green' },
          { hex: '#FFCC99', label: 'Orange' },
          { hex: '#FF99FF', label: 'Pink' },
          { hex: '#CCFFFF', label: 'Cyan' },
          { hex: '#FFFFFF', label: 'White' },
        ];
        
        const currentNoteColor = item.color || '#FFFF00';
        html += this._buildCompactColorPicker('Note', noteColors, currentNoteColor, 'murder-board-note-color-btn');
      }

      // Add font color swatches for Note and Text items
      if (item.type === 'Note' || item.type === 'Text') {
        const fontColors = [
          { hex: '#000000', label: 'Black' },
          { hex: '#333333', label: 'Dark Gray' },
          { hex: '#FFFFFF', label: 'White' },
          { hex: '#FF0000', label: 'Red' },
          { hex: '#0000FF', label: 'Blue' },
          { hex: '#00AA00', label: 'Green' },
          { hex: '#AA00AA', label: 'Purple' },
          { hex: '#FF8800', label: 'Orange' },
        ];
        
        const currentFontColor = (item.data && item.data.textColor) || '#000000';
        const fontLabel = item.type === 'Text' ? 'Text' : 'Font';
        html += this._buildCompactColorPicker(fontLabel, fontColors, currentFontColor, 'murder-board-font-color-btn');
      }

      // Attach click handlers for menu items
      const shadowOptions = [
        { id: 'none', label: 'No Shadow' },
        { id: 'default', label: 'Shadow' },
      ];
      const currentShadow = item.data?.shadow || 'default';
      html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
      html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Shadow</div>`;
      html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
      for (let shadowOpt of shadowOptions) {
        const isSelected = currentShadow === shadowOpt.id;
        html += `
          <button class="murder-board-shadow-btn ${isSelected ? 'selected' : ''}" data-shadow="${shadowOpt.id}"
                  title="${shadowOpt.label}">
            ${shadowOpt.label}
          </button>
        `;
      }
      html += `</div></div>`;

      // Add font select dropdown for Note, Text, and Document items (not Image, since it doesn't display text)
      if (item.type === 'Note' || item.type === 'Text' || item.type === 'Document') {
        const currentFont = item.data?.font || 'Arial';
        const availableFonts = this._getAvailableFonts();
        
        html += `<div class="murder-board-context-section" style="padding: 8px 12px; border-bottom: 1px solid var(--mb-border);">`;
        html += `<select id="font-select-dropdown" class="murder-board-font-select" style="width: 100%; padding: 4px; border: 1px solid var(--mb-dialog-input-border); border-radius: 3px; background: var(--mb-dialog-input-bg); color: var(--mb-text); font-size: 11px; cursor: pointer;">`;
        
        for (let fontOption of availableFonts) {
          const isSelected = fontOption.value === currentFont;
          html += `<option value="${fontOption.value}" ${isSelected ? 'selected' : ''}>${fontOption.label}</option>`;
        }
        
        html += `</select>`;
        html += `</div>`;
      }
      
      // Add menu items at the end (Connection Toggle, Duplicate, Delete)
      html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--mb-dialog-input-border);">`;
      html += connectionToggleHtml; // Add connection toggle first on the left
      html += menuItemsHtml;
      html += `</div></div>`;

      // Create a temporary div container for the context menu
      const menuDiv = document.createElement('div');
      menuDiv.innerHTML = html;
      menuDiv.style.position = 'fixed';
      menuDiv.style.left = x + 'px';
      menuDiv.style.top = y + 'px';
      menuDiv.style.zIndex = '10000';
      
      // Close any existing context menus before opening a new one
      document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
      
      document.body.appendChild(menuDiv);

      // Force color swatch styles to appear by using setProperty (bypasses CSS !important)
      const colorSwatchBtns = menuDiv.querySelectorAll('[class*="color-btn"]');
      colorSwatchBtns.forEach(btn => {
        const style = btn.getAttribute('style');
        if (style && style.includes('background')) {
          // Extract the background color from the inline style
          const bgMatch = style.match(/background:\s*([^;]+)/);
          if (bgMatch) {
            const bgColor = bgMatch[1].trim();
            btn.style.setProperty('background', bgColor, 'important');
          }
          // Extract the border from the inline style
          const borderMatch = style.match(/border:\s*([^;]+)/);
          if (borderMatch) {
            const border = borderMatch[1].trim();
            btn.style.setProperty('border', border, 'important');
          }
        }
      });

      // Attach fastener button handlers
      const fastenerBtns = menuDiv.querySelectorAll('.murder-board-fastener-btn');
      fastenerBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fastenerType = btn.dataset.fastener;
          
          if (isMultiSelect) {
            // Bulk fastener change for all selected items (that support fasteners)
            self._bulkSetFastener(self.selectedItems, fastenerType);
          } else {
            // Single item fastener change
            // Get fresh item data to avoid stale closures
            const freshItem = MurderBoardData.getItem(self.scene, itemId);
            if (!freshItem) {
              console.error(`Murder Board | Fastener handler: Item not found for ID ${itemId}`);
              return;
            }
            
            console.log(`Murder Board | Setting fastener on item ${itemId}:`, {
              currentType: freshItem.data?.fastenerType,
              newType: fastenerType,
              itemData: freshItem.data,
            });
            
            MurderBoardData.updateItem(self.scene, itemId, {
              data: {
                ...freshItem.data,
                fastenerType: fastenerType,
              },
            }).then((updatedItem) => {
              console.log(`Murder Board | Fastener update completed:`, {
                itemId,
                updatedItem,
              });
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    fastenerType: fastenerType,
                  },
                },
              });
              self.renderer.draw();
              // Update menu display to show new state
              self._updateMenuDisplay(itemId);
            }).catch(err => {
              console.error(`Murder Board | Fastener update failed:`, err);
              self._notify(`Error updating fastener: ${err.message}`, 'error');
            });
          }
        });
      });

      // Attach connection acceptance toggle handler
      const connectionToggleBtn = menuDiv.querySelector('.murder-board-connection-toggle-btn');
      if (connectionToggleBtn) {
        connectionToggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Get fresh item data each time (not stale closure reference)
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          
          const currentState = freshItem.acceptsConnections !== false;
          const newState = !currentState;
          
          // Update button UI immediately and robustly for live feedback
          if (newState) {
            connectionToggleBtn.classList.add('active');
            connectionToggleBtn.title = 'Accepting Connections';
            connectionToggleBtn.innerHTML = '<i class="fas fa-link"></i>';
          } else {
            connectionToggleBtn.classList.remove('active');
            connectionToggleBtn.title = 'Rejecting Connections';
            connectionToggleBtn.innerHTML = '<i class="fas fa-link-slash"></i>';
          }
          
          MurderBoardData.updateItem(self.scene, itemId, {
            acceptsConnections: newState,
          }).then(() => {
            emitSocketMessage('updateItem', {
              sceneId: self.scene.id,
              itemId: itemId,
              updates: {
                acceptsConnections: newState,
              },
            });
            self.renderer.draw();
          });
        });
      }

      // Attach paper type button handlers for Document items
      const paperBtns = menuDiv.querySelectorAll('.murder-board-paper-btn');
      paperBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const paperType = btn.dataset.paper;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              preset: paperType,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    preset: paperType,
                  },
                },
              });
            }
            self.renderer.draw();
          });
        });
      });

      // Attach size button handlers for Image items
      // Attach document size button handlers for Document items
      const docSizeBtns = menuDiv.querySelectorAll('.murder-board-doc-size-btn');
      docSizeBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const documentSize = btn.dataset.size;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              size: documentSize,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    size: documentSize,
                  },
                },
              });
            }
            self.renderer.draw();
          });
        });
      });

      // Attach document color button handlers for Document items
      const docColorBtns = menuDiv.querySelectorAll('.murder-board-doc-color-btn');
      docColorBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const docColor = btn.dataset.color;
          MurderBoardData.updateItem(self.scene, itemId, {
            color: docColor,
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: { color: docColor },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach document effect button handlers for Document items
      const docEffectBtns = menuDiv.querySelectorAll('.murder-board-doc-effect-btn');
      docEffectBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const effect = btn.dataset.effect;
          
          // Get intensity and seed values
          const intensitySlider = menuDiv.querySelector('#effect-intensity-slider');
          const seedSlider = menuDiv.querySelector('#effect-seed-slider');
          const intensity = intensitySlider ? parseFloat(intensitySlider.value) : 1;
          const seed = seedSlider ? parseInt(seedSlider.value) : 50;
          
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              effect: effect,
              effectIntensity: intensity,
              effectSeed: seed,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    effect: effect,
                    effectIntensity: intensity,
                    effectSeed: seed,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach effect intensity slider handler
      const intensitySlider = menuDiv.querySelector('#effect-intensity-slider');
      if (intensitySlider) {
        intensitySlider.addEventListener('input', (e) => {
          e.stopPropagation();
          const intensity = parseFloat(e.target.value);
          
          // Update display value with one decimal place
          const valueDisplay = menuDiv.querySelector('#effect-intensity-value');
          if (valueDisplay) {
            valueDisplay.textContent = intensity.toFixed(1);
          }
          
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          
          // Get current seed value from slider (might have been changed)
          const seedSlider = menuDiv.querySelector('#effect-seed-slider');
          const currentSeed = seedSlider ? parseInt(seedSlider.value) : (freshItem.data?.effectSeed || 50);
          
          // Save intensity to item, preserving seed value
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              effectIntensity: intensity,
              effectSeed: currentSeed,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    effectIntensity: intensity,
                    effectSeed: currentSeed,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      }

      // Attach effect seed slider handler
      const seedSlider = menuDiv.querySelector('#effect-seed-slider');
      if (seedSlider) {
        seedSlider.addEventListener('input', (e) => {
          e.stopPropagation();
          const seed = parseInt(e.target.value);
          
          // Update display value
          const valueDisplay = menuDiv.querySelector('#effect-seed-value');
          if (valueDisplay) {
            valueDisplay.textContent = seed;
          }
          
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          
          // Get current intensity value from slider (might have been changed)
          const intensitySlider = menuDiv.querySelector('#effect-intensity-slider');
          const currentIntensity = intensitySlider ? parseFloat(intensitySlider.value) : (freshItem.data?.effectIntensity || 1);
          
          // Save seed to item, preserving intensity value
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              effectIntensity: currentIntensity,
              effectSeed: seed,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    effectIntensity: currentIntensity,
                    effectSeed: seed,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      }

      // Attach border color button handlers for Image items
      const borderBtns = menuDiv.querySelectorAll('.murder-board-border-btn');
      borderBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const borderColor = btn.dataset.border;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              borderColor: borderColor,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    borderColor: borderColor,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach note color button handlers for Note items
      const noteColorBtns = menuDiv.querySelectorAll('.murder-board-note-color-btn');
      noteColorBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const noteColor = btn.dataset.color;
          MurderBoardData.updateItem(self.scene, itemId, {
            color: noteColor,
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: { color: noteColor },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach font color button handlers for Note items
      const fontColorBtns = menuDiv.querySelectorAll('.murder-board-font-color-btn');
      fontColorBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fontColor = btn.dataset.color;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              textColor: fontColor,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    textColor: fontColor,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach shadow button handlers
      const shadowBtns = menuDiv.querySelectorAll('.murder-board-shadow-btn');
      shadowBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const shadowOption = btn.dataset.shadow;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              shadow: shadowOption,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    shadow: shadowOption,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      });

      // Attach font select dropdown handler
      const fontSelectDropdown = menuDiv.querySelector('#font-select-dropdown');
      if (fontSelectDropdown) {
        // Prevent clicks from closing the context menu
        fontSelectDropdown.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
        fontSelectDropdown.addEventListener('click', (e) => {
          e.stopPropagation();
        });
        
        fontSelectDropdown.addEventListener('change', (e) => {
          e.stopPropagation();
          const selectedFont = e.target.value;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              font: selectedFont,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    font: selectedFont,
                  },
                },
              });
            }
            self.renderer.draw();
            self._updateMenuDisplay(itemId);
          });
        });
      }

      // Attach click handlers for menu items
      const items = menuDiv.querySelectorAll('.murder-board-menu-item');
      items.forEach((element) => {
        element.addEventListener('click', (e) => {
          e.stopPropagation();
          const callbackIndex = parseInt(element.dataset.callback);
          if (menuItems[callbackIndex] && menuItems[callbackIndex].callback) {
            menuItems[callbackIndex].callback();
          }
          menuDiv.remove();
        });
      });

      // Attach click handlers for z-index buttons (keep menu open)
      const zindexBtns = menuDiv.querySelectorAll('.murder-board-zindex-btn');
      zindexBtns.forEach((element) => {
        element.addEventListener('click', (e) => {
          e.stopPropagation();
          const callbackIndex = parseInt(element.dataset.callback);
          if (menuItems[callbackIndex] && menuItems[callbackIndex].callback) {
            menuItems[callbackIndex].callback();
          }
          // Update z-index display after the operation completes
          setTimeout(() => {
            const updatedItem = MurderBoardData.getItem(self.scene, itemId);
            if (updatedItem) {
              const zindexDisplay = menuDiv.querySelector('#zindex-value');
              if (zindexDisplay) {
                zindexDisplay.textContent = (updatedItem.zIndex || 0).toFixed(1);
              }
            }
          }, 50);
          // Don't close menu - allows rapid adjustments
        });
      });

      // Remove menu when clicking elsewhere - close ALL context menus
      const closeMenu = (e) => {
        if (!menuDiv.contains(e.target)) {
          // Close all context menus, not just this one
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('click', closeMenu);
          // Redraw canvas to clear any artifacts
          if (self.renderer) {
            self.renderer.draw();
          }
        }
      };
      document.addEventListener('click', closeMenu);

      // Also close on escape key
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          // Close all context menus
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('keydown', closeOnEscape);
          document.removeEventListener('click', closeMenu);
          // Redraw canvas to clear any artifacts
          if (self.renderer) {
            self.renderer.draw();
          }
        }
      };
      document.addEventListener('keydown', closeOnEscape);
    } catch (error) {
      console.error('Murder Board | Error in _showContextMenu:', error);
    }
  }

  /**
   * Duplicate an item
   * @param {string} itemId - Item ID to duplicate
   */
  async _duplicateItem(itemId) {
    const boardData = MurderBoardData.getGlobalBoardData();
    const item = boardData.items.find(i => i.id === itemId);
    
    if (!item) {
      this._notify('Item not found', 'error');
      return;
    }

    // Create a copy of the item with new ID and offset position
    const newItem = structuredClone(item);
    newItem.id = foundry.utils.randomID();
    newItem.x = item.x + 20;
    newItem.y = item.y + 20;

    const success = await MurderBoardData.addItem(this.scene, newItem);

    if (success) {
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('addItem', {
          sceneId: this.scene.id,
          item: newItem,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemDuplicated'));
    }
  }

  /**
   * Show creation menu for empty space
   * @param {number} screenX - Screen X position
   * @param {number} screenY - Screen Y position
   * @param {number} pageX - Page X position for menu placement
   * @param {number} pageY - Page Y position for menu placement
   */
  _showCreationMenu(screenX, screenY, pageX, pageY) {
    try {
      // Close any existing context menus before showing a new one
      document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
      
      // Check if user can edit
      if (!MurderBoardData.canUserEdit(this.scene)) {
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
        return;
      }

      // Convert screen coordinates to world coordinates
      const worldCoords = this.renderer.screenToWorld(screenX, screenY);
      const self = this;

      // Create menu items
      const menuItems = [
        {
          label: game.i18n.localize('MURDER_BOARD.UI.AddNote'),
          icon: 'fas fa-sticky-note',
          callback: () => {
            try {
              self._createItemAtLocation('Note', worldCoords.x, worldCoords.y);
            } catch (error) {
              console.error('Murder Board | Error creating note:', error);
              this._notify('Error creating note', 'error');
            }
          },
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.AddText'),
          icon: 'fas fa-font',
          callback: () => {
            try {
              self._createItemAtLocation('Text', worldCoords.x, worldCoords.y);
            } catch (error) {
              console.error('Murder Board | Error creating text:', error);
              this._notify('Error creating text', 'error');
            }
          },
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.AddImage'),
          icon: 'fas fa-image',
          callback: () => {
            try {
              self._createItemAtLocation('Image', worldCoords.x, worldCoords.y);
            } catch (error) {
              console.error('Murder Board | Error creating image:', error);
              this._notify('Error creating image', 'error');
            }
          },
        },
        {
          label: game.i18n.localize('MURDER_BOARD.UI.AddDocument'),
          icon: 'fas fa-tag',
          callback: () => {
            try {
              self._createItemAtLocation('Document', worldCoords.x, worldCoords.y);
            } catch (error) {
              console.error('Murder Board | Error creating document:', error);
              this._notify('Error creating document', 'error');
            }
          },
        },
      ];

      // Create custom context menu HTML
      let html = '<div class="murder-board-context-menu">';
      for (let i = 0; i < menuItems.length; i++) {
        const menuItem = menuItems[i];
        html += `
          <div class="murder-board-menu-item" data-index="${i}">
            <i class="${menuItem.icon}"></i>
            <span>${menuItem.label}</span>
          </div>
        `;
      }
      html += '</div>';

      // Create a temporary div container for the creation menu
      const menuDiv = document.createElement('div');
      menuDiv.innerHTML = html;
      menuDiv.style.position = 'fixed';
      menuDiv.style.left = pageX + 'px';
      menuDiv.style.top = pageY + 'px';
      menuDiv.style.zIndex = '10000';
      
      document.body.appendChild(menuDiv);

      // Attach click handlers
      const items = menuDiv.querySelectorAll('.murder-board-menu-item');
      items.forEach((element) => {
        element.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(element.dataset.index);
          const menuItem = menuItems[index];
          if (menuItem && menuItem.callback) {
            menuItem.callback();
          }
          menuDiv.remove();
        });
      });

      // Remove menu when clicking elsewhere - close ALL context menus
      const closeMenu = (e) => {
        if (!menuDiv.contains(e.target)) {
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('click', closeMenu);
          // Redraw canvas to clear any artifacts
          if (this.renderer) {
            this.renderer.draw();
          }
        }
      };
      document.addEventListener('click', closeMenu);

      // Also close on escape key
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('keydown', closeOnEscape);
          document.removeEventListener('click', closeMenu);
          // Redraw canvas to clear any artifacts
          if (this.renderer) {
            this.renderer.draw();
          }
        }
      };
      document.addEventListener('keydown', closeOnEscape);
    } catch (error) {
      console.error('Murder Board | Error in _showCreationMenu:', error);
    }
  }

  /**
   * Show context menu for connection
   * @param {Object} connection - Connection object
   * @param {number} pageX - Page X position for menu placement
   * @param {number} pageY - Page Y position for menu placement
   */
  _showConnectionMenu(connection, pageX, pageY) {
    try {
      // Check if user can edit
      const canEdit = MurderBoardData.canUserEdit(this.scene);
      if (!canEdit) {
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
        return;
      }

      const self = this;

      // Color palette for connections
      const colors = [
        { id: 'red', hex: '#FF0000', label: 'Red' },
        { id: 'orange', hex: '#FF8800', label: 'Orange' },
        { id: 'yellow', hex: '#FFFF00', label: 'Yellow' },
        { id: 'green', hex: '#00CC00', label: 'Green' },
        { id: 'blue', hex: '#0088FF', label: 'Blue' },
        { id: 'purple', hex: '#8800FF', label: 'Purple' },
        { id: 'pink', hex: '#FF0088', label: 'Pink' },
        { id: 'black', hex: '#000000', label: 'Black' },
      ];

      const currentColor = connection.color || '#FF0000';

      // Create custom context menu HTML - use class-based styling
      let html = '<div class="murder-board-context-menu" style="left: ' + pageX + 'px; top: ' + pageY + 'px;">';
      
      // Add color swatches using compact color picker
      const colorSwatches = colors.map(c => ({ hex: c.hex, label: c.label }));
      html += this._buildCompactColorPicker('Color', colorSwatches, currentColor, 'murder-board-connection-color-btn');
      // Add create label option (only if no label exists)
      const hasLabel = connection.labelItemId ? true : false;
      if (!hasLabel) {
        html += `
          <div class="murder-board-context-create-label-btn" style="padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; color: #fff; background: #333; border-bottom: 1px solid #444;"
               onmouseover="this.style.backgroundColor='#444'" 
               onmouseout="this.style.backgroundColor='#333'">
            <i class="fas fa-plus" style="color: #fff;"></i>
            <span>Create Label</span>
          </div>
        `;
      }

      // Add width slider for 1-10 range
      const currentWidth = connection.width || 5;
      html += `<div style="padding: 12px; border-bottom: 1px solid #444;">`;
      html += `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="color: #fff; font-size: 12px; flex: 0 0 50px;">Size:</span>
        <input type="range" class="murder-board-connection-width-slider" 
               data-connection-id="${connection.id}" 
               min="1" max="10" step="1" value="${currentWidth}"
               style="flex: 1; cursor: pointer; height: 6px;">
        <span class="murder-board-width-value" style="color: #fff; font-size: 12px; font-weight: bold; flex: 0 0 30px; text-align: right;">${currentWidth}</span>
      </div>`;
      html += `<p style="color: #aaa; font-size: 10px; margin: 0;">Thin (1) to Thick (10)</p>`;
      html += `</div>`;

      // Add delete button
      html += `
        <div class="murder-board-context-delete-btn" style="padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; color: #fff; background: #333;"
             onmouseover="this.style.backgroundColor='#444'" 
             onmouseout="this.style.backgroundColor='#333'">
          <i class="fas fa-trash" style="color: #fff;"></i>
          <span>${game.i18n.localize('MURDER_BOARD.UI.Delete')}</span>
        </div>
      `;
      html += '</div>';

      // Create a temporary div container - only set positioning, let CSS handle styling
      const menuDiv = document.createElement('div');
      menuDiv.innerHTML = html;
      
      document.body.appendChild(menuDiv);

      // Force color swatch styles to appear by using setProperty (bypasses CSS !important)
      const colorSwatchBtns = menuDiv.querySelectorAll('[class*="color-btn"]');
      colorSwatchBtns.forEach(btn => {
        const style = btn.getAttribute('style');
        if (style && style.includes('background')) {
          // Extract the background color from the inline style
          const bgMatch = style.match(/background:\s*([^;]+)/);
          if (bgMatch) {
            const bgColor = bgMatch[1].trim();
            btn.style.setProperty('background', bgColor, 'important');
          }
          // Extract the border from the inline style
          const borderMatch = style.match(/border:\s*([^;]+)/);
          if (borderMatch) {
            const border = borderMatch[1].trim();
            btn.style.setProperty('border', border, 'important');
          }
        }
      });

      // Store references to handlers for proper cleanup
      const handlers = [];

      // Attach color button handlers
      const colorBtns = menuDiv.querySelectorAll('.murder-board-connection-color-btn');
      colorBtns.forEach((btn) => {
        const handler = (e) => {
          e.stopPropagation();
          const newColor = btn.dataset.color;
          self._updateConnectionColor(connection.id, newColor);
        };
        btn.addEventListener('click', handler);
        handlers.push({ element: btn, event: 'click', handler });
      });

      // Attach width button handlers
      const widthBtns = menuDiv.querySelectorAll('.murder-board-connection-width-btn');
      widthBtns.forEach((btn) => {
        const handler = (e) => {
          e.stopPropagation();
          const newWidth = parseInt(btn.dataset.width);
          self._updateConnectionWidth(connection.id, newWidth);
        };
        btn.addEventListener('click', handler);
        handlers.push({ element: btn, event: 'click', handler });
      });

      // Attach width slider handlers
      const widthSlider = menuDiv.querySelector('.murder-board-connection-width-slider');
      const widthValueDisplay = menuDiv.querySelector('.murder-board-width-value');
      if (widthSlider && widthValueDisplay) {
        const handler = (e) => {
          e.stopPropagation();
          const newWidth = parseInt(e.target.value);
          widthValueDisplay.textContent = newWidth;
          self._updateConnectionWidth(connection.id, newWidth);
        };
        widthSlider.addEventListener('input', handler);
        handlers.push({ element: widthSlider, event: 'input', handler });
      }

      // Attach delete button handler
      const deleteBtn = menuDiv.querySelector('.murder-board-context-delete-btn');
      if (deleteBtn) {
        const handler = (e) => {
          e.stopPropagation();
          self._deleteConnection(connection.id);
          self._cleanupConnectionMenu(menuDiv, handlers, closeMenu, closeOnEscape);
        };
        deleteBtn.addEventListener('click', handler);
        handlers.push({ element: deleteBtn, event: 'click', handler });
      }

      // Attach edit label button handler
      const createLabelBtn = menuDiv.querySelector('.murder-board-context-create-label-btn');
      if (createLabelBtn) {
        const handler = (e) => {
          e.stopPropagation();
          self._createConnectionLabel(connection.id);
          self._cleanupConnectionMenu(menuDiv, handlers, closeMenu, closeOnEscape);
        };
        createLabelBtn.addEventListener('click', handler);
        handlers.push({ element: createLabelBtn, event: 'click', handler });
      }

      // Remove menu when clicking elsewhere - close ALL context menus
      const closeMenu = (e) => {
        if (!menuDiv.contains(e.target)) {
          self._cleanupConnectionMenu(menuDiv, handlers, closeMenu, closeOnEscape);
        }
      };
      document.addEventListener('click', closeMenu);

      // Also close on escape key
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          self._cleanupConnectionMenu(menuDiv, handlers, closeMenu, closeOnEscape);
        }
      };
      document.addEventListener('keydown', closeOnEscape);
    } catch (error) {
      console.error('Murder Board | Error in _showConnectionMenu:', error);
    }
  }

  /**
   * Clean up connection context menu and event listeners
   * @param {HTMLElement} menuDiv - The menu div to remove
   * @param {Array} handlers - Array of handler objects to remove
   * @param {Function} closeMenu - Close menu click handler to remove
   * @param {Function} closeOnEscape - Close on escape handler to remove
   * @private
   */
  _cleanupConnectionMenu(menuDiv, handlers, closeMenu, closeOnEscape) {
    try {
      // Remove all event listeners to prevent memory leaks
      handlers.forEach(({ element, event, handler }) => {
        try {
          element.removeEventListener(event, handler);
        } catch (e) {
          // Silently ignore errors from individual listener removal
        }
      });

      // Remove document-level listeners
      try {
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('keydown', closeOnEscape);
      } catch (e) {
        // Silently ignore errors
      }

      // Hide the menu immediately to prevent rendering artifacts
      if (menuDiv && menuDiv.parentNode) {
        menuDiv.style.display = 'none';
        menuDiv.style.visibility = 'hidden';
        menuDiv.style.pointerEvents = 'none';
        menuDiv.style.opacity = '0';
      }

      // Clear any remaining menu divs and remove from DOM
      document.querySelectorAll('.murder-board-context-menu').forEach(menu => {
        try {
          menu.style.display = 'none';
          menu.style.visibility = 'hidden';
          menu.style.pointerEvents = 'none';
          menu.style.opacity = '0';
          menu.remove();
        } catch (e) {
          // Silently ignore errors
        }
      });

      // Force a canvas redraw to clear any rendering artifacts
      if (this.renderer && this.canvas) {
        // Clear the canvas completely before redraw
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        // Redraw the canvas
        this.renderer.draw();
      }
    } catch (error) {
      console.error('Murder Board | Error in _cleanupConnectionMenu:', error);
    }
  }

  /**
   * Show color picker for connection
   * @param {Object} connection - Connection object
   */
  _showConnectionColorPicker(connection) {
    try {
      const currentColor = connection.color || '#FF0000';
      const dialog = new ConnectionColorPickerDialog(this, connection);
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error in _showConnectionColorPicker:', error);
      this._notify('Error picking color', 'error');
    }
  }

  /**
   * Update connection color
   * @param {string} connectionId - Connection ID
   * @param {string} color - New color
   */
  async _updateConnectionColor(connectionId, color) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const connection = boardData.connections.find(c => c.id === connectionId);

      if (connection) {
        connection.color = color;
        await this._updateBoardConnections(boardData.connections);

        // Emit socket message for multiplayer sync
        if (!game.user.isGM) {
          emitSocketMessage('updateConnection', {
            sceneId: this.scene.id,
            connectionId: connectionId,
            updates: { color: color },
          });
        }

        this.renderer.draw();
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionUpdated'));
      }
    } catch (error) {
      console.error('Murder Board | Error updating connection color:', error);
      this._notify('Error updating connection color', 'error');
    }
  }

  /**
   * Update connection width
   * @param {string} connectionId - Connection ID
   * @param {number} width - Connection line width
   */
  async _updateConnectionWidth(connectionId, width) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const connection = boardData.connections.find(c => c.id === connectionId);

      if (connection) {
        connection.width = width;
        await this._updateBoardConnections(boardData.connections);

        // Emit socket message for multiplayer sync
        if (!game.user.isGM) {
          emitSocketMessage('updateConnection', {
            sceneId: this.scene.id,
            connectionId: connectionId,
            updates: { width: width },
          });
        }

        this.renderer.draw();
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionUpdated'));
      }
    } catch (error) {
      console.error('Murder Board | Error updating connection width:', error);
      this._notify('Error updating connection width', 'error');
    }
  }

  /**
   * Update the offset of a connection label after it's been repositioned
   * @param {string} labelItemId - The ID of the label text item
   */
  _updateConnectionLabelOffset(labelItemId) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const labelItem = boardData.items.find(i => i.id === labelItemId);
      
      if (!labelItem) return;
      
      // Find the connection this label belongs to
      const connection = boardData.connections.find(c => c.labelItemId === labelItemId);
      
      if (!connection) return;
      
      // Get the connected items
      const fromItem = boardData.items.find(i => i.id === connection.fromItem);
      const toItem = boardData.items.find(i => i.id === connection.toItem);
      
      if (!fromItem || !toItem) return;
      
      // Calculate connection midpoint
      const centerFrom = {
        x: fromItem.x + (fromItem.data?.width || 40) / 2,
        y: fromItem.y + (fromItem.data?.height || 40) / 2
      };
      const centerTo = {
        x: toItem.x + (toItem.data?.width || 40) / 2,
        y: toItem.y + (toItem.data?.height || 40) / 2
      };
      
      const midX = (centerFrom.x + centerTo.x) / 2;
      const midY = (centerFrom.y + centerTo.y) / 2;
      
      // Get label center position
      const labelWidth = labelItem.data?.width || 120;
      const labelHeight = labelItem.data?.height || 50;
      const labelCenterX = labelItem.x + labelWidth / 2;
      const labelCenterY = labelItem.y + labelHeight / 2;
      
      // Calculate the offset from midpoint to label position
      const offsetX = labelCenterX - midX;
      const offsetY = labelCenterY - midY;
      
      // Save the offset to the connection
      connection.labelOffsetX = offsetX;
      connection.labelOffsetY = offsetY;
      
      // Persist the changes
      MurderBoardData.saveGlobalBoardData(boardData).catch(err => 
        console.error('Failed to save label offset:', err)
      );
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('updateConnection', {
          sceneId: this.scene.id,
          connectionId: connection.id,
          updates: { 
            labelOffsetX: offsetX,
            labelOffsetY: offsetY
          }
        });
      }
    } catch (error) {
      console.error('Murder Board | Error updating label offset:', error);
    }
  }

  /**
   * Update positions of connection label text items based on their connection midpoints
   * Call this whenever items involved in connections are moved
   * @param {Array} items - Array of all items on the board
   * @param {Array} connections - Array of all connections
   */
  _updateConnectionLabelPositions(items, connections) {
    if (!connections || connections.length === 0) return;
    
    let labelsUpdated = false;
    
    connections.forEach(connection => {
      if (!connection.labelItemId) return; // Skip connections without labels
      
      const fromItem = items.find(i => i.id === connection.fromItem);
      const toItem = items.find(i => i.id === connection.toItem);
      const labelItem = items.find(i => i.id === connection.labelItemId);
      
      if (!fromItem || !toItem || !labelItem) return;
      
      // Calculate connection midpoint
      const centerFrom = {
        x: fromItem.x + (fromItem.data?.width || 40) / 2,
        y: fromItem.y + (fromItem.data?.height || 40) / 2
      };
      const centerTo = {
        x: toItem.x + (toItem.data?.width || 40) / 2,
        y: toItem.y + (toItem.data?.height || 40) / 2
      };
      
      const midX = (centerFrom.x + centerTo.x) / 2;
      const midY = (centerFrom.y + centerTo.y) / 2;
      
      // Apply any stored offset from manual positioning
      const offsetX = connection.labelOffsetX || 0;
      const offsetY = connection.labelOffsetY || 0;
      
      // Position label at midpoint + offset (centered)
      const labelWidth = labelItem.data?.width || 120;
      const labelHeight = labelItem.data?.height || 50;
      labelItem.x = (midX + offsetX) - labelWidth / 2;
      labelItem.y = (midY + offsetY) - labelHeight / 2;
      
      labelsUpdated = true;
    });
    
    return labelsUpdated;
  }

  /**
   * Create a Text item label for a connection
   * @param {string} connectionId - Connection ID
   */
  async _createConnectionLabel(connectionId) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const connection = boardData.connections.find(c => c.id === connectionId);
      
      if (!connection) return;
      
      // Check if label already exists
      if (connection.labelItemId) {
        this._notify('This connection already has a label', 'warn');
        return;
      }
      
      // Get the two items to calculate midpoint
      const fromItem = boardData.items.find(i => i.id === connection.fromItem);
      const toItem = boardData.items.find(i => i.id === connection.toItem);
      
      if (!fromItem || !toItem) {
        this._notify('Could not find connected items', 'error');
        return;
      }
      
      // Calculate connection midpoint
      const centerFrom = {
        x: fromItem.x + (fromItem.data?.width || 40) / 2,
        y: fromItem.y + (fromItem.data?.height || 40) / 2
      };
      const centerTo = {
        x: toItem.x + (toItem.data?.width || 40) / 2,
        y: toItem.y + (toItem.data?.height || 40) / 2
      };
      
      const midX = (centerFrom.x + centerTo.x) / 2;
      const midY = (centerFrom.y + centerTo.y) / 2;
      
      // Get board default font and color settings
      const defaultFont = boardData.defaultFont || 'Arial';
      const defaultFontColor = boardData.defaultFontColor || '#000000';
      
      // Create a Text item at the midpoint
      const labelItem = {
        id: foundry.utils.randomID(),
        type: 'Text',
        label: 'Connection Label',
        x: midX - 60, // Center the text (approximate width)
        y: midY - 25, // Center the text (approximate height)
        color: '#000000',
        acceptsConnections: false, // Connection labels should not accept connections by default
        data: {
          text: 'Label',
          fontSize: 14,
          font: defaultFont,
          width: 120,
          height: 50,
          textColor: defaultFontColor
        }
      };
      
      // Add the text item to the board
      boardData.items.push(labelItem);
      
      // Link the label item to the connection
      connection.labelItemId = labelItem.id;
      
      // Save changes
      await this._updateBoardItems(boardData.items);
      await this._updateBoardConnections(boardData.connections);
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('addItem', {
          sceneId: this.scene.id,
          item: labelItem
        });
        emitSocketMessage('updateConnection', {
          sceneId: this.scene.id,
          connectionId: connectionId,
          updates: { labelItemId: labelItem.id }
        });
      }
      
      this.renderer.draw();
      this._notify('Label created. Edit the text item to customize the label');
    } catch (error) {
      console.error('Murder Board | Error creating connection label:', error);
      this._notify('Error creating connection label', 'error');
    }
  }

  /**
   * Edit connection label via dialog (opens Text item editor)
   * @param {string} connectionId - Connection ID
   */
  async _editConnectionLabel(connectionId) {
    const boardData = MurderBoardData.getGlobalBoardData();
    const connection = boardData.connections.find(c => c.id === connectionId);
    
    if (!connection || !connection.labelItemId) return;
    
    // Import and open QuickTextItemDialog in edit mode for the label Text item
    const { QuickTextItemDialog } = await import('./item-dialogs.js');
    const dialog = new QuickTextItemDialog(this.scene, connection.labelItemId);
    dialog.render(true);
  }

  /**
   * Delete a connection
   * @param {string} connectionId - Connection ID
   */
  async _deleteConnection(connectionId) {
    try {
      await MurderBoardData.deleteConnection(this.scene, connectionId);

      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('deleteConnection', {
          sceneId: this.scene.id,
          connectionId: connectionId,
        });
      }

      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionDeleted'));
    } catch (error) {
      console.error('Murder Board | Error deleting connection:', error);
      this._notify('Error deleting connection', 'error');
    }
  }

  /**
   * Handle canvas wheel (zoom)
   * @param {WheelEvent} event
   */
  _onCanvasWheel(event) {
    // Ignore wheel events over toolbar
    if (event.target.closest('.murder-board-toolbar')) {
      return;
    }

    event.preventDefault();
    if (!this.renderer) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // CTRL+SHIFT+wheel to fine-tune rotation by 1 degree
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
      // Find item at mouse position
      const item = this.renderer.getItemAtPoint(x, y);
      if (item) {
        const rotationDelta = event.deltaY > 0 ? -1 : 1; // Negative deltaY = scroll up = rotate right
        const newRotation = (item.rotation || 0) + rotationDelta;
        
        // Update item rotation
        MurderBoardData.updateItem(this.scene, item.id, {
          rotation: newRotation % 360, // Normalize to 0-360
        }).then(() => {
          // Emit socket message for multiplayer sync
          if (!game.user.isGM) {
            emitSocketMessage('updateItem', {
              sceneId: this.scene.id,
              itemId: item.id,
              updates: { rotation: newRotation % 360 },
            });
          }
          
          this.renderer.draw();
        });
      }
      return;
    }

    // CTRL+wheel to rotate items by 10 degrees
    if (event.ctrlKey || event.metaKey) {
      // Find item at mouse position
      const item = this.renderer.getItemAtPoint(x, y);
      if (item) {
        const rotationDelta = event.deltaY > 0 ? -10 : 10; // Negative deltaY = scroll up = rotate right
        const newRotation = (item.rotation || 0) + rotationDelta;
        
        // Update item rotation
        MurderBoardData.updateItem(this.scene, item.id, {
          rotation: newRotation % 360, // Normalize to 0-360
        }).then(() => {
          // Emit socket message for multiplayer sync
          if (!game.user.isGM) {
            emitSocketMessage('updateItem', {
              sceneId: this.scene.id,
              itemId: item.id,
              updates: { rotation: newRotation % 360 },
            });
          }
          
          this.renderer.draw();
        });
      }
      return;
    }

    // Normal wheel: Zoom in/out based on wheel direction
    const zoomDelta = event.deltaY > 0 ? -0.1 : 0.1;
    this.renderer.zoom(zoomDelta, x, y);
    this.renderer.draw();

    // Save camera state after zooming
    this._debouncedSaveCameraState();
  }

  /**
   * Handle canvas double-click for focus zoom
   * @param {MouseEvent} event
   */
  _onCanvasDoubleClick(event) {
    if (!this.renderer) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Check if clicking on an item
    const item = this.renderer.getItemAtPoint(x, y);

    if (item) {
      // Check if this is an actor item and open the sheet
      if (item.data?.actorUuid) {
        this._openActorSheet(item.data.actorUuid);
        return;
      }

      // Check if this is a journal item and open the journal
      if (item.data?.journalUuid) {
        this._openJournal(item.data.journalUuid);
        return;
      }

      // Check if this is an item and open the item sheet
      if (item.data?.itemUuid) {
        this._openItemSheet(item.data.itemUuid);
        return;
      }

      // Default behavior: Toggle focus zoom
      if (this.focusedItemId === item.id) {
        // Double-click same item - zoom out
        this._zoomOutFromFocus();
      } else {
        // Double-click new item - zoom in
        this._zoomInOnItem(item);
      }
    }
  }

  /**
   * Open an actor's character sheet
   * @param {string} actorUuid - The actor UUID
   * @private
   */
  async _openActorSheet(actorUuid) {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor && actor.sheet) {
        actor.sheet.render(true);
      }
    } catch (error) {
      console.error('Murder Board | Error opening actor sheet:', error);
      this._notify('Could not open actor sheet', 'warn');
    }
  }

  /**
   * Open a journal entry
   * @param {string} journalUuid - The journal UUID
   * @private
   */
  async _openJournal(journalUuid) {
    try {
      const journal = await fromUuid(journalUuid);
      if (journal && journal.sheet) {
        journal.sheet.render(true);
      }
    } catch (error) {
      console.error('Murder Board | Error opening journal:', error);
      this._notify('Could not open journal', 'warn');
    }
  }

  /**
   * Open an item's sheet
   * @param {string} itemUuid - The item UUID
   * @private
   */
  async _openItemSheet(itemUuid) {
    try {
      const item = await fromUuid(itemUuid);
      if (item && item.sheet) {
        item.sheet.render(true);
      }
    } catch (error) {
      console.error('Murder Board | Error opening item sheet:', error);
      this._notify('Could not open item sheet', 'warn');
    }
  }

  /**
   * Zoom in and center on a specific item
   * @param {Object} item - Item to focus on
   */
  _zoomInOnItem(item) {
    if (this.isAnimatingZoom) return;

    // Save current camera state to restore later
    if (!this.focusCameraState) {
      this.focusCameraState = {
        x: this.renderer.camera.x,
        y: this.renderer.camera.y,
        zoom: this.renderer.camera.zoom,
      };
    }

    this.focusedItemId = item.id;
    const targetZoom = 4;

    // Get item size for better framing
    let itemWidth = this.renderer.itemSize;
    let itemHeight = this.renderer.itemSize;

    if (item.type === 'Image') {
      const preset = item.data?.preset || 'medium';
      const presetConfig = this.renderer.imagePresets[preset];
      if (presetConfig && item.data?.imageUrl && this.renderer.imageCache.has(item.data.imageUrl)) {
        const cachedImg = this.renderer.imageCache.get(item.data.imageUrl);
        if (cachedImg) {
          const imgAspect = cachedImg.width / cachedImg.height;
          const { longEdge } = presetConfig;
          if (imgAspect >= 1) {
            itemWidth = longEdge;
            itemHeight = longEdge / imgAspect;
          } else {
            itemHeight = longEdge;
            itemWidth = longEdge * imgAspect;
          }
        }
      }
    } else if (item.type === 'Document') {
      const size = item.data?.size || 'medium';
      const sizeConfig = this.renderer.documentSizes[size];
      if (sizeConfig) {
        itemWidth = sizeConfig.width;
        itemHeight = sizeConfig.height;
      }
    }

    // Calculate item center in world coordinates
    const itemCenterX = item.x + itemWidth / 2;
    const itemCenterY = item.y + itemHeight / 2;

    // Calculate camera position to center item on screen at target zoom
    // camera.x and camera.y are the offsets applied to the canvas context
    // To center an item: screenCenter = cameraOffset + (itemWorldPos * zoom)
    // Solving for cameraOffset: cameraOffset = screenCenter - (itemWorldPos * zoom)
    const targetX = this.canvas.width / 2 - itemCenterX * targetZoom;
    const targetY = this.canvas.height / 2 - itemCenterY * targetZoom;

    // Animate zoom
    this._animateZoom(
      this.renderer.camera.x,
      this.renderer.camera.y,
      this.renderer.camera.zoom,
      targetX,
      targetY,
      targetZoom,
      600
    );
  }

  /**
   * Zoom out from focused item
   */
  _zoomOutFromFocus() {
    if (this.isAnimatingZoom || !this.focusCameraState) return;

    const state = this.focusCameraState;
    this._animateZoom(
      this.renderer.camera.x,
      this.renderer.camera.y,
      this.renderer.camera.zoom,
      state.x,
      state.y,
      state.zoom,
      600
    );

    this.focusedItemId = null;
    this.focusCameraState = null;
  }

  /**
   * Animate camera zoom and pan
   * @param {number} startX - Starting camera X
   * @param {number} startY - Starting camera Y
   * @param {number} startZoom - Starting zoom level
   * @param {number} endX - Target camera X
   * @param {number} endY - Target camera Y
   * @param {number} endZoom - Target zoom level
   * @param {number} duration - Animation duration in ms
   */
  _animateZoom(startX, startY, startZoom, endX, endY, endZoom, duration = 600) {
    this.isAnimatingZoom = true;
    const startTime = Date.now();

    const animate = () => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-in-out cubic
      const easeProgress = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      this.renderer.camera.x = startX + (endX - startX) * easeProgress;
      this.renderer.camera.y = startY + (endY - startY) * easeProgress;
      this.renderer.camera.zoom = startZoom + (endZoom - startZoom) * easeProgress;

      this.renderer.draw();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.isAnimatingZoom = false;
        this._debouncedSaveCameraState();
      }
    };

    requestAnimationFrame(animate);
  }

  /**
   * Handle keyboard events on canvas
   * @param {KeyboardEvent} event
   */
  async _onCanvasKeyDown(event) {
    // Don't trigger if user is typing in an input field
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
      return;
    }

    // Check if the Murder Board window is currently visible/focused
    // Use the element to check if it's in the DOM and visible
    if (!this.element || !this.element.closest('body')) {
      return;
    }

    // Create unique key identifier for combo (e.g., "ctrl+d")
    const keyId = this._getKeyComboId(event);
    
    // Prevent repeated firing while key is held - only process first press
    if (this.pressedKeys.has(keyId)) {
      return;
    }
    
    // Mark key as pressed
    this.pressedKeys.add(keyId);

    // Handle CTRL+C - create connection between 2 selected items
    if ((event.key === 'c' || event.key === 'C') && event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      await this._createConnectionBetweenSelected();
      return;
    }

    // Handle CTRL+D - duplicate selected items
    if ((event.key === 'd' || event.key === 'D') && event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      await this._duplicateSelectedItems();
      return;
    }

    // Handle CTRL+G - toggle group/ungroup selected items
    if ((event.key === 'g' || event.key === 'G') && event.ctrlKey) {
      event.preventDefault();
      await this._toggleGroupSelectedItems();
      return;
    }

    // Handle G key - toggle group borders
    if ((event.key === 'g' || event.key === 'G') && !event.ctrlKey) {
      event.preventDefault();
      if (this.renderer) {
        this.renderer.showGroupBorders = !this.renderer.showGroupBorders;
        this.renderer.draw();
        const status = this.renderer.showGroupBorders ? 'enabled' : 'disabled';
        this._notify(`Group borders ${status}`, 'info');
      }
      return;
    }

    // Handle Delete key - only if renderer is ready
    if (event.key !== 'Delete' || !this.renderer) {
      return;
    }

    // Check if there are selected items
    if (this.selectedItems.length === 0) {
      return;
    }

    // Prevent default delete behavior
    event.preventDefault();

    // Check permissions
    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    // Delete selected items without confirmation
    await this._deleteSelectedItems();
  }

  /**
   * Handle keyboard key up events to track key releases
   * @param {KeyboardEvent} event
   */
  _onCanvasKeyUp(event) {
    // Remove key from pressed keys set when released
    const keyId = this._getKeyComboId(event);
    this.pressedKeys.delete(keyId);
  }

  /**
   * Get a unique identifier for a key combination
   * @param {KeyboardEvent} event
   * @returns {string} Unique key combo identifier (e.g., "ctrl+d")
   */
  _getKeyComboId(event) {
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const alt = event.altKey;
    
    let combo = [];
    if (ctrl) combo.push('ctrl');
    if (shift) combo.push('shift');
    if (alt) combo.push('alt');
    combo.push(key);
    
    return combo.join('+');
  }

  /**
   * Create a connection between two selected items (Ctrl+Shift+C hotkey)
   * @returns {Promise<void>}
   */
  async _createConnectionBetweenSelected() {
    // Check if we have exactly 2 items selected
    if (this.selectedItems.length !== 2) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.SelectTwoItems') || 'Please select exactly 2 items to create a connection', 'warn');
      return;
    }

    // Check permissions
    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    try {
      const fromItemId = this.selectedItems[0];
      const toItemId = this.selectedItems[1];

      // Add the connection to the data model
      const connectionId = await MurderBoardData.addConnection(this.scene, fromItemId, toItemId);

      if (!connectionId) {
        throw new Error('Failed to create connection');
      }

      // Broadcast to other clients
      if (!game.user.isGM) {
        emitSocketMessage('addConnection', {
          sceneId: this.scene.id,
          fromId: fromItemId,
          toId: toItemId,
        });
      }

      // Refresh the renderer
      this.renderer.refresh();
      this.renderer.draw();

      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionCreated') || 'Connection created', 'info');
    } catch (error) {
      console.error('Murder Board | Error creating connection:', error);
      this._notify(error.message || 'Failed to create connection', 'error');
    }
  }

  /**
   * Duplicate selected items with an offset (Ctrl+Shift+D hotkey)
   * @returns {Promise<void>}
   */
  async _duplicateSelectedItems() {
    // Check if we have items selected
    if (this.selectedItems.length === 0) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.SelectItems') || 'Please select items to duplicate', 'warn');
      return;
    }

    // Check permissions
    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const newItemIds = [];
      const offset = { x: 20, y: 20 }; // Offset duplicates to avoid overlap

      // Duplicate each selected item
      for (const itemId of this.selectedItems) {
        const originalItem = boardData.items.find(item => item.id === itemId);
        if (!originalItem) {
          console.warn(`Murder Board | Item not found: ${itemId}`);
          continue;
        }

        // Create duplicate with offset position
        const duplicate = {
          id: foundry.utils.randomID(),
          type: originalItem.type,
          label: originalItem.label || '',
          x: originalItem.x + offset.x,
          y: originalItem.y + offset.y,
          color: originalItem.color || '#FFFFFF',
          rotation: originalItem.rotation || 0,
          data: { ...originalItem.data },
          acceptsConnections: originalItem.acceptsConnections !== false,
          createdAt: new Date().toISOString(),
        };

        boardData.items.push(duplicate);
        newItemIds.push(duplicate.id);
      }

      // Save the updated board
      await MurderBoardData.saveGlobalBoardData(boardData);

      // Broadcast to other clients
      if (!game.user.isGM) {
        emitSocketMessage('duplicateItems', {
          itemIds: this.selectedItems,
          offset: offset,
        });
      }

      // Update selection to new items and refresh
      this.selectedItems = newItemIds;
      if (this.renderer) {
        this.renderer.selectedItems = newItemIds;
        this.renderer.refresh();
        this.renderer.draw();
      }

      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemsDuplicated') || `Duplicated ${newItemIds.length} item(s)`, 'info');
    } catch (error) {
      console.error('Murder Board | Error duplicating items:', error);
      this._notify(error.message || 'Failed to duplicate items', 'error');
    }
  }

  /**
   * Handle drag over canvas for drag-and-drop
   * @param {DragEvent} event
   */
  _onCanvasDragOver(event) {
    event.preventDefault();
    
    // Check if this is an item type from the picker or file/document drop
    const itemType = event.dataTransfer.types.includes('application/murder-board-item-type');
    const hasFiles = event.dataTransfer.types.includes('Files');
    const hasText = event.dataTransfer.types.includes('text/plain');
    
    if (itemType || hasFiles || hasText) {
      event.dataTransfer.dropEffect = 'copy';
      
      // Visual feedback: highlight the canvas
      if (!this.canvas.parentElement.classList.contains('drag-over')) {
        this.canvas.parentElement.classList.add('drag-over');
      }
    }
  }

  /**
   * Handle drag leave canvas
   * @param {DragEvent} event
   */
  _onCanvasDragLeave(event) {
    // Only remove highlight if leaving the container entirely
    if (event.target === this.canvas.parentElement) {
      this.canvas.parentElement.classList.remove('drag-over');
    }
  }

  /**
   * Handle drop event on canvas for drag-and-drop image upload and Foundry documents
   * Supports dragging: Files, Actors, Items, Images, Journals
   * @param {DragEvent} event
   */
  async _onCanvasDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    
    // Remove visual feedback
    this.canvas.parentElement.classList.remove('drag-over');
    
    // Check permissions - must be able to edit board
    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    try {
      // Get drop position in world coordinates
      const rect = this.canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const worldCoords = this.renderer.screenToWorld(screenX, screenY);

      // Check if this is an item type drop from the picker
      const itemType = event.dataTransfer.getData('application/murder-board-item-type');
      if (itemType) {
        // Create item at drop location with defaults
        await this._createItemAtLocation(itemType, worldCoords.x, worldCoords.y);
        return;
      }

      // First, check for Foundry document drops (actor, item, image, journal)
      const dropData = event.dataTransfer.getData('text/plain');
      if (dropData) {
        try {
          const data = JSON.parse(dropData);
          await this._handleFoundryDocumentDrop(data, worldCoords);
          if (this.renderer) this.renderer.draw();
          return;
        } catch (parseError) {
          // Not valid JSON, continue to file handling
        }
      }

      // Fall back to file upload handling
      const uploadEnabled = game.settings.get('murder-board', 'enableDragDropUpload');
      if (!uploadEnabled) {
        return;
      }

      const files = event.dataTransfer.files;
      if (!files || files.length === 0) {
        return;
      }

      // Security: Check upload limit per user to prevent abuse
      const MAX_FILES_PER_DROP = 10;
      if (files.length > MAX_FILES_PER_DROP) {
        this._notify(
          game.i18n.format('MURDER_BOARD.Notifications.TooManyFiles', { max: MAX_FILES_PER_DROP }),
          'warn'
        );
        return;
      }

      // Allowed image MIME types
      const ALLOWED_TYPES = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/svg+xml',
      ];

      // Maximum file size: 10MB
      const MAX_FILE_SIZE = 10 * 1024 * 1024;

      // Process each dropped file
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Security: Validate file type against whitelist
        if (!ALLOWED_TYPES.includes(file.type)) {
          this._notify(
            game.i18n.format('MURDER_BOARD.Notifications.InvalidFileType', { type: file.type || 'unknown' }),
            'warn'
          );
          continue;
        }

        // Security: Validate file size
        if (file.size > MAX_FILE_SIZE) {
          this._notify(
            game.i18n.format('MURDER_BOARD.Notifications.FileTooLarge', { filename: file.name, max: '10MB' }),
            'warn'
          );
          continue;
        }

        // Security: Validate file size is not zero (prevent empty file attacks)
        if (file.size === 0) {
          this._notify(
            game.i18n.format('MURDER_BOARD.Notifications.EmptyFile', { filename: file.name }),
            'warn'
          );
          continue;
        }

        // Upload file to murder-board-uploads/{boardId}
        const boardData = MurderBoardData.getGlobalBoardData();
        const uploadPath = `murder-board-uploads/${boardData.id}`;
        
        try {
          // Ensure the board folder exists before uploading
          try {
            await foundry.applications.apps.FilePicker.implementation.createDirectory('data', uploadPath);
          } catch (error) {
            // Folder may already exist or other error - continue silently
            // (createDirectory errors are expected if folder exists)
          }
          
          const response = await foundry.applications.apps.FilePicker.implementation.upload('data', uploadPath, file);
          const uploadedPath = response.path;

          // Security: Validate the uploaded path is within the allowed directory
          if (!uploadedPath.startsWith('murder-board-uploads/')) {
            console.warn('Murder Board | Security: Uploaded file path is outside allowed directory:', uploadedPath);
            this._notify(
              game.i18n.localize('MURDER_BOARD.Notifications.SecurityError'),
              'error'
            );
            continue;
          }

          // Offset each item slightly if multiple files dropped at once
          const xOffset = (i * 30) - ((files.length - 1) * 15);
          const yOffset = (i * 30) - ((files.length - 1) * 15);

          // Create image item with sanitized filename
          const sanitizedFilename = file.name.split('.')[0]
            .substring(0, 100) // Limit filename length
            .replace(/[<>:"/\\|?*]/g, ''); // Remove invalid filename characters

          const newItem = {
            id: foundry.utils.randomID(),
            type: 'Image',
            label: sanitizedFilename || 'Image',
            x: worldCoords.x + xOffset,
            y: worldCoords.y + yOffset,
            color: '#FFFFFF',
            rotation: 0,
            data: {
              imageUrl: uploadedPath,
              preset: 'medium',
              borderColor: 'white',
              fastenerType: 'pushpin',
              shadow: 'drop',
            },
          };

          // Add item to board
          const success = await MurderBoardData.addItem(this.scene, newItem);
          
          if (success && !game.user.isGM) {
            // Only broadcast to GM if we're not the GM (GM added it locally)
            emitSocketMessage('addItem', {
              sceneId: this.scene.id,
              item: newItem,
            });
          }
        } catch (uploadError) {
          console.error('Murder Board | Error uploading file:', uploadError);
          this._notify(game.i18n.format('MURDER_BOARD.Notifications.UploadError', { filename: file.name }), 'error');
        }
      }

      // Redraw canvas
      if (this.renderer) {
        this.renderer.draw();
      }

      this._notify(game.i18n.format('MURDER_BOARD.Notifications.ImagesUploaded', { count: files.length }), 'info');
    } catch (error) {
      console.error('Murder Board | Error in drop handler:', error);
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.DropError'), 'error');
    }
  }

  /**
   * Handle dropping of Foundry documents (Actors, Items, Images, Journals)
   * @param {Object} data - Drop data from dataTransfer
   * @param {Object} worldCoords - Canvas world coordinates { x, y }
   * @private
   */
  async _handleFoundryDocumentDrop(data, worldCoords) {
    try {
      // Determine document type and UUID
      const uuid = data.uuid;
      if (!uuid) return;

      // Resolve the UUID to get the actual document
      const document = await fromUuid(uuid);
      if (!document) {
        console.warn('Murder Board | Could not resolve UUID:', uuid);
        return;
      }

      let itemCreated = false;
      let createdItem = null;

      // Handle Actors
      if (document.documentName === 'Actor') {
        createdItem = await this._createItemFromActor(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle Items
      else if (document.documentName === 'Item') {
        createdItem = await this._createItemFromItem(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle JournalEntries
      else if (document.documentName === 'JournalEntry') {
        createdItem = await this._createItemFromJournal(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle JournalEntryPages
      else if (document.documentName === 'JournalEntryPage') {
        createdItem = await this._createItemFromJournalPage(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle Macros that contain images
      else if (document.documentName === 'Macro' && document.img) {
        createdItem = await this._createItemFromMacroImage(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle Scenes
      else if (document.documentName === 'Scene') {
        createdItem = await this._createItemFromScene(document, worldCoords);
        itemCreated = !!createdItem;
      }
      // Handle generic images by UUID (from Compendium images)
      else if (data.type === 'image') {
        createdItem = await this._createItemFromImage(document, worldCoords);
        itemCreated = !!createdItem;
      }

      if (itemCreated && createdItem) {
        // Add item to board
        const success = await MurderBoardData.addItem(this.scene, createdItem);
        
        if (success && !game.user.isGM) {
          // Broadcast to GM
          emitSocketMessage('addItem', {
            sceneId: this.scene.id,
            item: createdItem,
          });
        }

        if (success) {
          this._notify(game.i18n.format('MURDER_BOARD.Notifications.ItemCreated', { name: createdItem.label }), 'info');
        }
      }
    } catch (error) {
      console.error('Murder Board | Error handling document drop:', error);
    }
  }

  /**
   * Create an image item from an Actor
   * @param {Actor} actor - The actor document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromActor(actor, worldCoords) {
    try {
      const actorName = actor.name || 'Unknown Actor';
      const actorImg = actor.img;

      // If actor has no image, return null
      if (!actorImg) {
        return null;
      }

      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Image',
        label: actorName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        rotation: 0,
        data: {
          imageUrl: actorImg,
          preset: 'medium',
          borderColor: 'white',
          fastenerType: 'pushpin',
          shadow: 'drop',
          actorUuid: actor.uuid, // Store actor UUID for future reference
        },
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from actor:', error);
      return null;
    }
  }

  /**
   * Create a note item from an Item
   * @param {Item} item - The item document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromItem(item, worldCoords) {
    try {
      const itemName = item.name || 'Unknown Item';
      const itemType = item.type || 'Generic';
      const boardData = MurderBoardData.getGlobalBoardData();
      const defaultFont = boardData.defaultFont || 'Arial';
      const defaultFontColor = boardData.defaultFontColor || '#000000';

      // If the item has an image, create an Image item
      if (item.img) {
        const newMurderBoardItem = {
          id: foundry.utils.randomID(),
          type: 'Image',
          label: itemName,
          x: worldCoords.x,
          y: worldCoords.y,
          acceptsConnections: true,
          data: {
            imageUrl: item.img,
            preset: 'medium', // Default preset
            borderColor: 'white',
            fastenerType: 'pushpin',
          },
        };
        return newMurderBoardItem;
      }

      // Otherwise, create a Note item with item details
      const newMurderBoardItem = {
        id: foundry.utils.randomID(),
        type: 'Note',
        label: itemName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#87CEEB', // Sky blue for items
        data: {
          text: `**${itemName}**\n\nType: ${itemType}\n\nItem: ${item.uuid}`,
          font: defaultFont,
          textColor: defaultFontColor,
          fontSize: 14,
          itemUuid: item.uuid, // Store UUID to open sheet on double-click
        },
      };

      return newMurderBoardItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from item:', error);
      return null;
    }
  }

  /**
   * Create a document item from a Journal Entry
   * @param {JournalEntry} journal - The journal document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromJournal(journal, worldCoords) {
    try {
      const journalName = journal.name || 'Unknown Journal';
      
      // Try to extract text content from the journal
      let journalContent = '';
      if (journal.pages && journal.pages.length > 0) {
        const firstPage = journal.pages[0];
        if (firstPage.text && firstPage.text.content) {
          journalContent = firstPage.text.content.substring(0, 500); // Limit to 500 chars
        }
      }

      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Document',
        label: journalName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        data: {
          text: journalContent || `Journal Entry: ${journalName}`,
          documentType: 'blank',
          paperColor: '#FFFFFF',
          paperSize: 'medium',
          effects: 'none',
          effectsIntensity: 1,
          journalUuid: journal.uuid,
        },
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from journal:', error);
      return null;
    }
  }

  /**
   * Create a document item from a Journal Entry Page
   * @param {JournalEntryPage} page - The journal page document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromJournalPage(page, worldCoords) {
    try {
      const pageName = page.name || 'Unknown Page';
      const parentJournal = page.parent;
      const journalName = parentJournal?.name || 'Unknown Journal';

      // Try to extract text content from the page
      let pageContent = '';
      
      // In Foundry v12+, page text is stored in page.text.content
      let rawContent = null;
      if (page.text && typeof page.text === 'object' && page.text.content) {
        rawContent = page.text.content;
      } else if (page.text && typeof page.text === 'string') {
        // If page.text is a string directly
        rawContent = page.text;
      } else if (page.content) {
        rawContent = page.content;
      }
      
      if (rawContent) {
        // Create a temporary div to parse HTML content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = rawContent;
        // Get text content without HTML tags
        pageContent = tempDiv.innerText || tempDiv.textContent || '';
        // Remove excessive whitespace while preserving line breaks
        pageContent = pageContent.replace(/\n\n\n+/g, '\n\n').trim();
      }

      // Check if the page has an image
      if (page.src) {
        // If page has an image, create an Image item
        const newItem = {
          id: foundry.utils.randomID(),
          type: 'Image',
          label: pageName,
          x: worldCoords.x,
          y: worldCoords.y,
          acceptsConnections: true,
          data: {
            imageUrl: page.src,
            preset: 'medium',
            borderColor: 'white',
            fastenerType: 'pushpin',
          },
        };
        return newItem;
      }

      // Otherwise, create a Document item with page content
      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Document',
        label: pageName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        data: {
          text: pageContent || `Journal Page: ${pageName}`,
          documentType: 'blank',
          paperColor: '#FFFFFF',
          paperSize: 'medium',
          effects: 'none',
          effectsIntensity: 1,
          journalUuid: page.uuid,
        },
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from journal page:', error);
      return null;
    }
  }

  /**
   * Create an image item from a Macro with an image
   * @param {Macro} macro - The macro document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromMacroImage(macro, worldCoords) {
    try {
      if (!macro.img) return null;

      const macroName = macro.name || 'Unknown Macro';
      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Image',
        label: macroName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        rotation: 0,
        data: {
          imageUrl: macro.img,
          preset: 'medium',
          borderColor: 'white',
          fastenerType: 'pushpin',
          shadow: 'drop',
        },
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from macro:', error);
      return null;
    }
  }

  /**
   * Create an image item from a Scene
   * @param {Scene} scene - The scene document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromScene(scene, worldCoords) {
    try {
      const sceneName = scene.name || 'Unknown Scene';
      
      // Try to get the scene image: background image > configured thumbnail > default
      let sceneImg = null;
      
      // Try background image first
      if (scene.background?.src) {
        sceneImg = scene.background.src;
      } 
      // Try configured thumbnail
      else if (scene.thumb) {
        sceneImg = scene.thumb;
      }
      // Try img property
      else if (scene.img) {
        sceneImg = scene.img;
      }
      // If no image available, cannot create item
      else {
        return null;
      }

      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Image',
        label: sceneName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        rotation: 0,
        data: {
          imageUrl: sceneImg,
          preset: 'medium',
          borderColor: 'white',
          fastenerType: 'pushpin',
          shadow: 'drop',
          sceneUuid: scene.uuid, // Store scene UUID for future reference
        },
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from scene:', error);
      return null;
    }
  }

  /**
   * Create an image item from a generic image document
   * @param {Object} imageDoc - The image document
   * @param {Object} worldCoords - Canvas coordinates { x, y }
   * @returns {Object|null} The created item object
   * @private
   */
  async _createItemFromImage(imageDoc, worldCoords) {
    try {
      const imageName = imageDoc.name || 'Image';
      const imageUrl = imageDoc.img || imageDoc.path || imageDoc.url;

      if (!imageUrl) return null;

      // Load image to get actual dimensions for proper aspect ratio
      let width = 80;
      let height = 80;
      
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          img.onload = () => {
            // Scale image to reasonable size (max 200px on longest side)
            const maxSize = 200;
            const aspect = img.width / img.height;
            if (aspect > 1) {
              width = Math.min(img.width, maxSize);
              height = width / aspect;
            } else {
              height = Math.min(img.height, maxSize);
              width = height * aspect;
            }
            resolve();
          };
          img.onerror = reject;
          img.src = imageUrl;
        });
      } catch (error) {
        // If image fails to load, use default size
        console.warn('Murder Board | Failed to load image for dimensions:', error);
      }

      const newItem = {
        id: foundry.utils.randomID(),
        type: 'Image',
        label: imageName,
        x: worldCoords.x,
        y: worldCoords.y,
        color: '#FFFFFF',
        rotation: 0,
        data: {
          imageUrl: imageUrl,
          preset: 'medium',
          borderColor: 'white',
          fastenerType: 'pushpin',
          shadow: 'drop',
          width: width,
          height: height,
        },
        _migrationApplied: true,  // Mark as migrated so migration won't delete dimensions
      };

      return newItem;
    } catch (error) {
      console.error('Murder Board | Error creating item from image:', error);
      return null;
    }
  }

  /**
   * Delete all currently selected items
   * @private
   */
  async _deleteSelectedItems() {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      
      // Delete items and their associated connections
      for (const itemId of this.selectedItems) {
        // Remove item
        await MurderBoardData.deleteItem(this.scene, itemId);
        
        // Clean up any connections that reference this item as a label
        await this._cleanupDeletedLabel(itemId);
        
        // Remove any connections involving this item
        const connections = MurderBoardData.getConnections(this.scene);
        const connectionsToDelete = connections.filter(
          conn => conn.fromItem === itemId || conn.toItem === itemId
        );
        
        for (const conn of connectionsToDelete) {
          await MurderBoardData.deleteConnection(this.scene, conn.id);
        }
      }

      // Clear selection
      this._selectItem(null, false);

      // Emit socket message for multiplayer sync (only if not GM, since GM already deleted locally)
      if (!game.user.isGM) {
        for (const itemId of this.selectedItems) {
          emitSocketMessage('deleteItem', {
            sceneId: this.scene.id,
            itemId: itemId
          });
        }
      }

      // Notify user
      const count = this.selectedItems.length;
      const message = count === 1
        ? game.i18n.localize('MURDER_BOARD.Notifications.ItemDeleted')
        : game.i18n.format('MURDER_BOARD.Notifications.ItemsDeleted', { count });
      this._notify(message, 'info');

      // Redraw
      this.renderer.draw();
    } catch (error) {
      console.error('Murder Board | Error deleting items:', error);
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.DeleteError'), 'error');
    }
  }

  _selectItem(itemId, additive = false) {
    if (!additive) {
      this.selectedItems = itemId ? [itemId] : [];
    } else {
      if (this.selectedItems.includes(itemId)) {
        this.selectedItems = this.selectedItems.filter(id => id !== itemId);
      } else {
        this.selectedItems.push(itemId);
      }
    }
    
    // Update renderer with all selected items
    if (this.renderer) {
      this.renderer.selectedItem = this.selectedItems[0] || null; // For compatibility
      this.renderer.selectedItems = this.selectedItems;
      
      // If any selected item is in a group, highlight the entire group
      let highlightedGroupId = null;
      if (this.selectedItems.length > 0) {
        const boardData = MurderBoardData.getGlobalBoardData();
        const firstSelectedItem = boardData.items.find(i => i.id === this.selectedItems[0]);
        if (firstSelectedItem && firstSelectedItem.groupId) {
          highlightedGroupId = firstSelectedItem.groupId;
        }
      }
      this.renderer.highlightedGroupId = highlightedGroupId;
      
      // Trigger canvas redraw to show highlights
      this.renderer.draw();
    }
  }

  /**
   * Select multiple items within a box (screen coordinates)
   * @param {number} x1 - Start X
   * @param {number} y1 - Start Y
   * @param {number} x2 - End X
   * @param {number} y2 - End Y
   * @param {boolean} additive - If true, add to selection; if false, replace
   */
  _selectItemsInBox(x1, y1, x2, y2, additive = false) {
    // Normalize box coordinates
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    // Get items within box
    const boardData = MurderBoardData.getGlobalBoardData();
    const selectedIds = [];

    boardData.items.forEach(item => {
      // Get item dimensions using same logic as renderer
      const { width: itemWidth, height: itemHeight } = this.renderer._getItemDimensions(item);
      
      // Convert item world position to screen space
      const screenX = item.x * this.renderer.camera.zoom + this.renderer.camera.x;
      const screenY = item.y * this.renderer.camera.zoom + this.renderer.camera.y;
      
      // Scale item dimensions by zoom
      const scaledWidth = itemWidth * this.renderer.camera.zoom;
      const scaledHeight = itemHeight * this.renderer.camera.zoom;
      
      // Check if item is within box
      if (screenX < maxX && screenX + scaledWidth > minX &&
          screenY < maxY && screenY + scaledHeight > minY) {
        selectedIds.push(item.id);
      }
    });

    // Update selection
    if (additive) {
      selectedIds.forEach(id => {
        if (!this.selectedItems.includes(id)) {
          this.selectedItems.push(id);
        }
      });
    } else {
      this.selectedItems = selectedIds;
    }

    // Update renderer
    if (this.renderer) {
      this.renderer.selectedItem = this.selectedItems[0] || null;
      this.renderer.selectedItems = this.selectedItems;
    }
  }

  /**
   * Handle window resize
   */
  _onWindowResize() {
    if (this.canvas && this.renderer) {
      this._resizeCanvas();
      this.renderer.draw();
    }
  }

  /**
   * Action: Add item
   */
  async _onAddItem() {
    try {
      // Check permissions
      if (!MurderBoardData.canUserEdit(this.scene)) {
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
        return;
      }

      // Show item type selection using custom ApplicationV2 dialog
      const dialog = new ItemTypeSelectionDialog(this);
      dialog.render(true);
    } catch (error) {
      this._notify('Error adding item', 'error');
    }
  }

  /**
   * Create an item with default values
   * @param {string} type - Item type (Note, Text, Image, Document)
   */
  async _createItemWithDefaults(type) {
    try {
      const board = MurderBoardData.getGlobalBoardData();
      
      // Center position on canvas
      const centerX = this.renderer.canvas.width / 2;
      const centerY = this.renderer.canvas.height / 2;

      const defaultFontStyle = board.defaultFont || 'Arial';

      // For images, open file picker immediately before creating item
      if (type === 'Image') {
        return await this._createImageWithFilePicker(centerX, centerY);
      }

      // For notes and text, open creation dialog immediately
      if (type === 'Note') {
        return await this._createNoteWithDialog(centerX, centerY);
      }

      if (type === 'Text') {
        return await this._createTextWithDialog(centerX, centerY);
      }

      if (type === 'Document') {
        return await this._createDocumentWithDialog(centerX, centerY);
      }

      let itemData = {
        type: type,
        label: `New ${type}`,
        x: centerX,
        y: centerY,
        color: type === 'Document' ? '#FFFEF5' : '#FFFFFF',
        acceptsConnections: true,
        data: {},
      };

      // Set type-specific defaults (for Document)
      if (type === 'Document') {
        itemData.data = {
          preset: 'blank',
          font: defaultFontStyle,
          size: 'medium',
          effect: 'none',
          effectIntensity: 1,
          effectSeed: 50,
        };
      }

      await MurderBoardData.addItem(this.scene, itemData);

      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('addItem', {
          sceneId: this.scene.id,
          itemData: itemData,
        });
      }

      if (this.renderer) {
        this.renderer.refresh();
        this.renderer.draw();
      }

      this._notify(`${type} created. Use context menu to customize.`, 'info');
    } catch (error) {
      console.error('Murder Board | Error creating item:', error);
      this._notify(`Error creating ${type}`, 'error');
    }
  }

  /**
   * Create a note item and immediately open quick dialog for text entry
   * @param {number} x - X position
   * @param {number} y - Y position
   * @private
   */
  async _createNoteWithDialog(x, y) {
    try {
      const { QuickNoteItemDialog } = await import('./item-dialogs.js');
      
      // Open quick note dialog in creation mode with prefilled coordinates
      const dialog = new QuickNoteItemDialog(this.scene, null, {
        prefilledCoords: { x, y },
      });
      
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error creating note with dialog:', error);
      this._notify('Error creating note', 'error');
    }
  }

  /**
   * Create a text item and immediately open quick dialog for text entry
   * @param {number} x - X position
   * @param {number} y - Y position
   * @private
   */
  async _createTextWithDialog(x, y) {
    try {
      const { QuickTextItemDialog } = await import('./item-dialogs.js');
      
      // Open quick text dialog in creation mode with prefilled coordinates
      const dialog = new QuickTextItemDialog(this.scene, null, {
        prefilledCoords: { x, y },
      });
      
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error creating text with dialog:', error);
      this._notify('Error creating text', 'error');
    }
  }

  /**
   * Create an image item and immediately prompt for image selection
   * @param {number} x - X position
   * @param {number} y - Y position
   * @private
   */
  async _createImageWithFilePicker(x, y) {
    try {
      // Get board config
      const board = MurderBoardData.getGlobalBoardData();
      const defaultFontStyle = board.defaultFont || 'Arial';

      // Create file picker
      const filePicker = new foundry.applications.apps.FilePicker.implementation({
        type: 'imageBrowser',
        callback: async (path) => {
          // Load image synchronously first to get dimensions AND cache it
          let width = 80;
          let height = 80;
          let cachedImage = null;
          
          await new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              cachedImage = img;  // Store the loaded image
              // Calculate dimensions with aspect ratio
              const maxSize = 200;
              const aspect = img.width / img.height;
              if (aspect > 1) {
                width = Math.min(img.width, maxSize);
                height = width / aspect;
              } else {
                height = Math.min(img.height, maxSize);
                width = height * aspect;
              }
              console.log(`Detected image dimensions: ${width}x${height}`);
              resolve();
            };
            img.onerror = () => {
              console.warn('Failed to load image for dimensions');
              resolve();
            };
            img.src = path;
          });
          
          // NOW create item with the actual dimensions we detected
          const itemData = {
            type: 'Image',
            label: 'Image',
            x: x,
            y: y,
            color: '#FFFFFF',
            acceptsConnections: true,
            data: {
              imageUrl: path,
              borderColor: '#000000',
              fastenerType: 'pushpin',
              width: width,
              height: height,
            },
            _migrationApplied: true,
          };

          const createdItem = await MurderBoardData.addItem(this.scene, itemData);
          const itemId = createdItem.id;
          
          // Cache the image so the renderer uses it immediately
          if (cachedImage && this.renderer) {
            this.renderer.imageCache.set(path, cachedImage);
          }

          // Emit socket message for multiplayer sync
          if (!game.user.isGM) {
            emitSocketMessage('addItem', {
              sceneId: this.scene.id,
              itemData: itemData,
            });
          }

          if (this.renderer) {
            this.renderer.refresh();
            this.renderer.draw();
          }

          this._notify('Image created', 'info');
        },
      });

      filePicker.browse();
    } catch (error) {
      console.error('Murder Board | Error creating image with file picker:', error);
      this._notify('Error creating image', 'error');
    }
  }

  /**
   * Create a document item and immediately open quick dialog for text entry
   * @param {number} x - X position
   * @param {number} y - Y position
   * @private
   */
  async _createDocumentWithDialog(x, y) {
    try {
      const worldX = (x - this.renderer.camera.x) / this.renderer.camera.zoom;
      const worldY = (y - this.renderer.camera.y) / this.renderer.camera.zoom;

      const { QuickDocumentItemDialog } = await import('./item-dialogs.js');
      const dialog = new QuickDocumentItemDialog(this.scene, null, {
        prefilledCoords: { x: worldX, y: worldY }
      });
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error creating document with dialog:', error);
      this._notify('Error creating document', 'error');
    }
  }

  /**
   * Create an item at a specific location (for drag-drop)
   * @param {string} type - Item type
   * @param {number} x - World X coordinate
   * @param {number} y - World Y coordinate
   */
  async _createItemAtLocation(type, x, y) {
    try {
      // For images, open file picker immediately before creating item
      if (type === 'Image') {
        return await this._createImageWithFilePicker(x, y);
      }

      // For notes and text, open creation dialog immediately
      if (type === 'Note') {
        return await this._createNoteWithDialog(x, y);
      }

      if (type === 'Text') {
        return await this._createTextWithDialog(x, y);
      }

      if (type === 'Document') {
        return await this._createDocumentWithDialog(x, y);
      }

      const board = MurderBoardData.getGlobalBoardData();
      const defaultFontStyle = board.defaultFont || 'Arial';

      let itemData = {
        type: type,
        label: `New ${type}`,
        x: x,
        y: y,
        color: type === 'Document' ? '#FFFEF5' : '#FFFFFF',
        acceptsConnections: true,
        data: {},
      };

      // Set type-specific defaults (for Document)
      if (type === 'Document') {
        itemData.data = {
          preset: 'blank',
          font: defaultFontStyle,
          size: 'medium',
          effect: 'none',
          effectIntensity: 1,
          effectSeed: 50,
        };
      }

      await MurderBoardData.addItem(this.scene, itemData);

      if (!game.user.isGM) {
        emitSocketMessage('addItem', {
          sceneId: this.scene.id,
          itemData: itemData,
        });
      }

      if (this.renderer) {
        this.renderer.refresh();
        this.renderer.draw();
      }
    } catch (error) {
      console.error('Murder Board | Error creating item at location:', error);
      this._notify(`Error creating ${type}`, 'error');
    }
  }

  /**
   * Action: Toggle connection mode
   */
  _onToggleConnect() {
    this.connectMode = !this.connectMode;
    const indicator = this.element.querySelector('#mode-indicator');

    if (indicator) {
      indicator.textContent = this.connectMode ? 'Connection Mode' : '';
    }

    if (!this.connectMode) {
      this.connectionFrom = null;
      this.renderer?.clearConnectionPreview();
      this.renderer?.draw();
    }
  }

  /**
   * Action: Clear board
   */
  async _onClearBoard() {
    const confirmed = await Dialog.confirm({
      title: 'Clear Board',
      content: '<p>Are you sure you want to delete all items and connections?</p>',
    });

    if (confirmed) {
      await MurderBoardData.clearBoard(this.scene);
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('clearBoard', {
          sceneId: this.scene.id,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.BoardCleared'));
    }
  }

  /**
   * Center canvas on world origin (0, 0)
   */
  _onCenterCanvas() {
    if (!this.renderer) return;
    
    // Center the world origin (0, 0) on the canvas
    this.renderer.camera.x = this.canvas.width / 2;
    this.renderer.camera.y = this.canvas.height / 2;
    this.renderer.draw();
  }

  /**
   * Toggle fullscreen mode
   */
  _onToggleFullscreen() {
    const windowElement = this.element;
    if (!windowElement) return;

    // Check if already fullscreen
    const isFullscreen = windowElement.classList.contains('murder-board-fullscreen');
    
    if (isFullscreen) {
      // Exit fullscreen
      windowElement.classList.remove('murder-board-fullscreen');
      // Restore previous position/size from stored data
      const storedPosition = this.position;
      if (storedPosition) {
        this.setPosition(storedPosition);
      }
    } else {
      // Enter fullscreen - store current position
      const currentPosition = {
        top: this.position.top,
        left: this.position.left,
        width: this.position.width,
        height: this.position.height,
      };
      this._previousPosition = currentPosition;
      
      // Maximize window
      windowElement.classList.add('murder-board-fullscreen');
      this.setPosition({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      });
    }
    
    // Resize canvas
    if (this.canvas && this.renderer) {
      this._resizeCanvas();
      this.renderer.draw();
    }
  }

  /**
   * Toggle visibility of the center point
   */

  /**
   * Open board settings dialog
   */
  async _onBoardSettings() {
    // Only GMs can manage permissions
    if (!game.user.isGM) {
      this._notify('Only GMs can manage board settings', 'warn');
      return;
    }

    const boardData = MurderBoardData.getGlobalBoardData();
    const permissions = MurderBoardData.getPermissions(this.scene);
    
    // Build player list for permissions
    let playerOptions = '';
    game.users.forEach(user => {
      if (!user.isGM) {
        const isRestricted = permissions.restrictedPlayers?.includes(user.id);
        playerOptions += `<option value="${user.id}" ${isRestricted ? 'selected' : ''}>${user.name}</option>`;
      }
    });
    
    const dialog = new BoardSettingsDialog(this, this.scene);
    dialog.render(true);

    
    dialog.render(true);
  }

  /**
   * Edit an item (placeholder for Task 8)
   * @param {string} itemId
   */
  async _editItem(itemId) {
    const item = MurderBoardData.getItem(this.scene, itemId);
    if (item) {
      this._openItemDialog(item.type, itemId);
    }
  }

  /**
   * Edit item content (text or image URL) via proper dialog
   * Uses the same dialogs as "Add" for consistency
   * @param {string} itemId
   */
  async _editItemContent(itemId) {
    const item = MurderBoardData.getItem(this.scene, itemId);
    if (!item) {
      this._notify('Item not found', 'error');
      return;
    }

    // Use proper ApplicationV2 dialogs instead of custom inline dialogs
    if (item.type === 'Text') {
      const { QuickTextItemDialog } = await import('./item-dialogs.js');
      const dialog = new QuickTextItemDialog(this.scene, itemId);
      dialog.render(true);
    } else if (item.type === 'Note') {
      const { QuickNoteItemDialog } = await import('./item-dialogs.js');
      const dialog = new QuickNoteItemDialog(this.scene, itemId);
      dialog.render(true);
    } else if (item.type === 'Image') {
      const { ImageItemDialog } = await import('./item-dialogs.js');
      const dialog = new ImageItemDialog(this.scene, itemId);
      dialog.render(true);
    } else if (item.type === 'Document') {
      const { QuickDocumentItemDialog } = await import('./item-dialogs.js');
      const dialog = new QuickDocumentItemDialog(this.scene, itemId);
      dialog.render(true);
    } else {
      this._notify('This item type does not support editing', 'warn');
      return;
    }
  }

  /**
   * Open file picker to edit an image item's URL
   * @param {string} itemId - The image item ID
   */
  async _editImageUrl(itemId) {
    const item = MurderBoardData.getItem(this.scene, itemId);
    if (!item || item.type !== 'Image') {
      this._notify('Item not found or is not an image', 'error');
      return;
    }

    const self = this;
    const filePicker = new foundry.applications.apps.FilePicker.implementation({
      type: 'imageBrowser',
      callback: async (path) => {
        // Load image to get dimensions
        let width = item.data?.width || 80;
        let height = item.data?.height || 80;
        
        await new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            // Preserve aspect ratio
            const maxSize = 200;
            const aspect = img.width / img.height;
            if (aspect > 1) {
              width = Math.min(img.width, maxSize);
              height = width / aspect;
            } else {
              height = Math.min(img.height, maxSize);
              width = height * aspect;
            }
            resolve();
          };
          img.onerror = () => {
            console.warn('Failed to load image for dimensions');
            resolve();
          };
          img.src = path;
        });

        // Update the item with new image URL and dimensions
        await MurderBoardData.updateItem(self.scene, itemId, {
          data: {
            ...item.data,
            imageUrl: path,
            width: width,
            height: height,
          },
        });

        // Emit socket message for multiplayer sync
        if (!game.user.isGM) {
          emitSocketMessage('updateItem', {
            sceneId: self.scene.id,
            itemId: itemId,
            updates: {
              data: {
                ...item.data,
                imageUrl: path,
                width: width,
                height: height,
              },
            },
          });
        }

        if (self.renderer) {
          self.renderer.refresh();
          self.renderer.draw();
        }

        self._notify('Image updated', 'info');
      },
    });

    filePicker.browse();
  }

  /**
   * Delete an item
   * @param {string} itemId
   */
  async _deleteItem(itemId) {
    const success = await MurderBoardData.deleteItem(this.scene, itemId);

    if (success) {
      // Clean up any connections that reference this item as a label
      console.log(`Murder Board | Deleting item ${itemId}, cleaning up labels...`);
      await this._cleanupDeletedLabel(itemId);

      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('deleteItem', {
          sceneId: this.scene.id,
          itemId: itemId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemDeleted'));
    }
  }

  /**
   * Delete multiple items at once
   * @param {string[]} itemIds - Array of item IDs to delete
   */
  async _deleteMultipleItems(itemIds) {
    let deleteCount = 0;
    for (const itemId of itemIds) {
      const success = await MurderBoardData.deleteItem(this.scene, itemId);
      if (success) {
        // Clean up any connections that reference this item as a label
        await this._cleanupDeletedLabel(itemId);

        if (!game.user.isGM) {
          emitSocketMessage('deleteItem', {
            sceneId: this.scene.id,
            itemId: itemId,
          });
        }
        deleteCount++;
      }
    }

    if (deleteCount > 0) {
      this.selectedItems = []; // Clear selection
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(`${deleteCount} item(s) deleted`);
    }
  }

  /**
   * Clean up connection label references when a label item is deleted
   * @param {string} deletedItemId - The ID of the deleted item
   */
  async _cleanupDeletedLabel(deletedItemId) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      const connections = boardData.connections || [];
      
      console.log(`Murder Board | Checking ${connections.length} connections for label references to ${deletedItemId}`);
      
      // Find and update all connections that reference this label
      const updatedConnections = connections.map(connection => {
        if (connection.labelItemId === deletedItemId) {
          console.log(`Murder Board | Found connection ${connection.id} with label ${deletedItemId}, clearing...`);
          return {
            ...connection,
            labelItemId: null,
            labelOffsetX: 0,
            labelOffsetY: 0,
          };
        }
        return connection;
      });
      
      // Check if anything changed
      const changed = updatedConnections.some((conn, idx) => conn !== connections[idx]);
      
      if (changed) {
        console.log(`Murder Board | Saving updated connections...`);
        boardData.connections = updatedConnections;
        await MurderBoardData.saveGlobalBoardData(boardData);
        
        // Broadcast to other clients
        const affectedConnections = updatedConnections.filter((conn, idx) => conn !== connections[idx]);
        if (!game.user.isGM) {
          for (const connection of affectedConnections) {
            emitSocketMessage('updateConnection', {
              sceneId: this.scene.id,
              connectionId: connection.id,
              updates: {
                labelItemId: null,
                labelOffsetX: 0,
                labelOffsetY: 0,
              },
            });
          }
        }
      } else {
        console.log(`Murder Board | No connections found with label reference to ${deletedItemId}`);
      }
    } catch (error) {
      console.error('Murder Board | Error in _cleanupDeletedLabel:', error);
    }
  }

  /**
   * Bring an item to the front
   * @param {string} itemId - The item ID
   */
  async _bringToFront(itemId) {
    try {
      const success = await MurderBoardData.bringToFront(this.scene, itemId);
      
      if (!success) {
        this._notify('Item not found or already at front', 'warn');
        return;
      }
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('bringToFront', {
          sceneId: this.scene.id,
          itemId: itemId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.BroughtToFront') || 'Brought to front');
    } catch (error) {
      console.error('Murder Board | Error in _bringToFront:', error);
      this._notify('Error bringing item to front: ' + error.message, 'error');
    }
  }

  /**
   * Bring an item forward one layer
   * @param {string} itemId - The item ID
   */
  async _bringForward(itemId) {
    try {
      const success = await MurderBoardData.bringForward(this.scene, itemId);
      
      if (!success) {
        this._notify('Item not found or already at front', 'warn');
        return;
      }
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('bringForward', {
          sceneId: this.scene.id,
          itemId: itemId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.BroughtForward') || 'Brought forward');
    } catch (error) {
      console.error('Murder Board | Error in _bringForward:', error);
      this._notify('Error bringing item forward: ' + error.message, 'error');
    }
  }

  /**
   * Send an item backward one layer
   * @param {string} itemId - The item ID
   */
  async _sendBackward(itemId) {
    try {
      const success = await MurderBoardData.sendBackward(this.scene, itemId);
      
      if (!success) {
        this._notify('Item not found or already at back', 'warn');
        return;
      }
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('sendBackward', {
          sceneId: this.scene.id,
          itemId: itemId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.SentBackward') || 'Sent backward');
    } catch (error) {
      console.error('Murder Board | Error in _sendBackward:', error);
      this._notify('Error sending item backward: ' + error.message, 'error');
    }
  }

  /**
   * Send an item to the back
   * @param {string} itemId - The item ID
   */
  async _sendToBack(itemId) {
    try {
      const success = await MurderBoardData.sendToBack(this.scene, itemId);
      
      if (!success) {
        this._notify('Item not found or already at back', 'warn');
        return;
      }
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('sendToBack', {
          sceneId: this.scene.id,
          itemId: itemId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.SentToBack') || 'Sent to back');
    } catch (error) {
      console.error('Murder Board | Error in _sendToBack:', error);
      this._notify('Error sending item to back: ' + error.message, 'error');
    }
  }

  /**
   * Toggle group/ungroup for selected items
   * If all selected items are in the same group, ungroup them
   * If selected items are not grouped, create a new group
   */
  async _toggleGroupSelectedItems() {
    if (this.selectedItems.length === 0) {
      this._notify('Select items to group or ungroup', 'warn');
      return;
    }

    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    // Get board data to check group status of selected items
    const boardData = MurderBoardData.getGlobalBoardData();
    const selectedItemsData = boardData.items.filter(item => this.selectedItems.includes(item.id));
    
    // Check if all selected items are in the same group
    const groupIds = new Set(selectedItemsData.map(item => item.groupId).filter(Boolean));
    
    if (groupIds.size === 1) {
      // All selected items are in the same group - ungroup them
      const groupId = Array.from(groupIds)[0];
      await this._ungroup(groupId);
    } else if (groupIds.size === 0) {
      // No selected items are grouped - create a new group
      if (this.selectedItems.length < 2) {
        this._notify('Select at least 2 items to create a group', 'warn');
        return;
      }
      await this._createGroup();
    } else {
      // Selected items are in different groups - not allowed
      this._notify('Cannot group items that are already in different groups', 'warn');
    }
  }

  /**
   * Create a group from selected items
   */
  async _createGroup() {
    if (this.selectedItems.length < 2) {
      this._notify('Select at least 2 items to create a group', 'warn');
      return;
    }

    try {
      const groupId = await MurderBoardData.createGroup(this.selectedItems);
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('createGroup', {
          itemIds: this.selectedItems,
        });
      }
      
      // Clear selection and refresh
      this.selectedItems = [];
      this.renderer.selectedItems = [];
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.GroupCreated') || 'Group created');
    } catch (error) {
      console.error('Murder Board | Error creating group:', error);
      this._notify(error.message || 'Failed to create group', 'error');
    }
  }

  /**
   * Ungroup items - removes group and returns items to individual z-index
   * @param {string} groupId - The group ID to ungroup
   */
  async _ungroup(groupId) {
    try {
      if (!groupId) {
        this._notify('No group selected', 'error');
        return;
      }

      const success = await MurderBoardData.ungroup(groupId);
      
      if (!success) {
        this._notify('Group not found', 'error');
        return;
      }
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('ungroup', {
          groupId: groupId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.GroupDissolved') || 'Group dissolved');
    } catch (error) {
      console.error('Murder Board | Error ungrouping:', error);
      this._notify('Failed to ungroup: ' + error.message, 'error');
    }
  }

  /**
   * Bring a group to front
   * @param {string} groupId - The group ID
   */
  async _bringGroupToFront(groupId) {
    try {
      await MurderBoardData.bringGroupToFront(groupId);
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('bringGroupToFront', {
          groupId: groupId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.GroupBroughtToFront') || 'Group brought to front');
    } catch (error) {
      console.error('Murder Board | Error bringing group to front:', error);
      this._notify('Failed to bring group to front', 'error');
    }
  }

  /**
   * Send a group to back
   * @param {string} groupId - The group ID
   */
  async _sendGroupToBack(groupId) {
    try {
      await MurderBoardData.sendGroupToBack(groupId);
      
      // Emit socket message for multiplayer sync
      if (!game.user.isGM) {
        emitSocketMessage('sendGroupToBack', {
          groupId: groupId,
        });
      }
      
      this.renderer.refresh();
      this.renderer.draw();
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.GroupSentToBack') || 'Group sent to back');
    } catch (error) {
      console.error('Murder Board | Error sending group to back:', error);
      this._notify('Failed to send group to back', 'error');
    }
  }

  /**
   * Bulk set fastener type for all selected items (gracefully handles non-Image/Document types)
   * @param {string[]} itemIds - Array of item IDs to update
   * @param {string} fastenerType - Fastener type to set
   */
  async _bulkSetFastener(itemIds, fastenerType) {
    let updateCount = 0;
    for (const itemId of itemIds) {
      const item = MurderBoardData.getItem(this.scene, itemId);
      
      // Only update items that support fasteners (Image and Document types)
      if (item && (item.type === 'Image' || item.type === 'Document')) {
        await MurderBoardData.updateItem(this.scene, itemId, {
          data: {
            ...item.data,
            fastenerType: fastenerType,
          },
        });

        emitSocketMessage('updateItem', {
          sceneId: this.scene.id,
          itemId: itemId,
          updates: {
            data: {
              ...item.data,
              fastenerType: fastenerType,
            },
          },
        });
        updateCount++;
      }
    }

    if (updateCount > 0) {
      this.renderer.draw();
      this._notify(`Fastener type updated for ${updateCount} item(s)`);
    }
  }

  /**
   * Export board data as JSON file
   */
  async _onExportBoard() {
    try {
      const data = MurderBoardData.exportBoard(this.scene);
      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `murder-board-${this.scene.name}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.BoardExported'));
    } catch (error) {
      console.error('Error exporting board:', error);
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ExportFailed'), 'error');
    }
  }

  /**
   * Import board data from JSON file
   * ALWAYS creates a new board for imported content
   */
  async _onImportBoard() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      
      input.onchange = async (e) => {
        try {
          const file = e.target.files[0];
          if (!file) {
            console.log('Murder Board | Import cancelled by user');
            return resolve();
          }
          
          console.log('Murder Board | Importing file:', file.name);
          
          // Read file using FileReader for better browser compatibility
          const text = await new Promise((fileResolve, fileReject) => {
            const reader = new FileReader();
            reader.onload = (event) => fileResolve(event.target.result);
            reader.onerror = (error) => fileReject(error);
            reader.readAsText(file);
          });
          
          const data = JSON.parse(text);
          console.log('Murder Board | Parsed JSON data:', data);
          
          // Validate data structure
          if (!data.items || !Array.isArray(data.items)) {
            throw new Error('Invalid board data format: items must be an array');
          }
          
          if (!Array.isArray(data.connections)) {
            throw new Error('Invalid board data format: connections must be an array');
          }
          
          // Create a NEW board for the imported content
          const boardId = foundry.utils.randomID();
          const fileName = file.name.replace('.json', '');
          const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          
          const newBoard = {
            id: boardId,
            sceneId: this.scene.id,
            name: data.name ? `${data.name} - Imported ${dateStr}` : `Imported - ${fileName}`,
            boardType: data.boardType || 'whiteboard',
            defaultConnectionColor: data.defaultConnectionColor || MurderBoardData.getDefaultConnectionColorForBoardType(data.boardType || 'whiteboard'),
            items: data.items,
            connections: data.connections,
            camera: { x: 0, y: 0, zoom: 1 },
          };
          
          // Copy optional board settings
          if (data.canvasColor) newBoard.canvasColor = data.canvasColor;
          if (data.backgroundImage) newBoard.backgroundImage = data.backgroundImage;
          if (data.backgroundScale !== undefined) newBoard.backgroundScale = data.backgroundScale;
          
          console.log('Murder Board | Creating new board:', boardId, 'with', data.items.length, 'items and', data.connections.length, 'connections');
          
          // Add to global boards
          await MurderBoardData.createGlobalBoard(newBoard);
          await MurderBoardData.setGlobalCurrentBoardId(boardId);
          
          // Create the board folder for storing images
          try {
            const parentPath = 'murder-board-uploads';
            try {
              await foundry.applications.apps.FilePicker.implementation.createDirectory('data', parentPath);
            } catch (error) {
              // Ignore EEXIST errors (directory already exists)
              if (error.code !== 'EEXIST' && !error.message?.includes('EEXIST')) {
                throw error;
              }
            }
            
            const boardFolderPath = `murder-board-uploads/${boardId}`;
            await foundry.applications.apps.FilePicker.implementation.createDirectory('data', boardFolderPath);
          } catch (error) {
            console.warn('Murder Board | Could not create board folder:', error?.message || error);
            // Don't block board creation if folder creation fails
          }
          
          // Emit socket message for multiplayer sync
          if (!game.user.isGM) {
            console.log('Murder Board | Emitting importBoard socket message');
            emitSocketMessage('importBoard', {
              sceneId: this.scene.id,
              boardId: boardId,
            });
          }
          
          this._notify(game.i18n.format('MURDER_BOARD.Notifications.BoardImported', { name: newBoard.name }));
          console.log('Murder Board | Import completed successfully, new board created:', boardId);
          
          // Re-render to show the new board
          await this.render();
          
          // Force canvas redraw after render completes
          requestAnimationFrame(() => {
            if (this.renderer) {
              console.log('Murder Board | Forcing canvas redraw after import');
              this.renderer.needsRedraw = true;
              this.renderer.draw();
            }
          });
          
          resolve();
        } catch (error) {
          console.error('Murder Board | Error importing board:', error);
          this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ImportFailed') + ': ' + error.message, 'error');
          resolve();
        }
      };
      
      input.oncancel = () => {
        console.log('Murder Board | File picker cancelled');
        resolve();
      };
      
      input.onerror = (error) => {
        console.error('Murder Board | File picker error:', error);
        resolve();
      };
      
      input.click();
    });
  }

  /**
   * Update board items - handles both GM and player updates via socket
   * @param {Array} items - Updated items array
   */
  async _updateBoardItems(items) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      boardData.items = items;
      await MurderBoardData.saveGlobalBoardData(boardData);
    } catch (error) {
      console.error('Murder Board | Error updating board items:', error);
    }
  }

  /**
   * Update board connections - handles both GM and player updates via socket
   * @param {Array} connections - Updated connections array
   */
  async _updateBoardConnections(connections) {
    try {
      const boardData = MurderBoardData.getGlobalBoardData();
      boardData.connections = connections;
      await MurderBoardData.saveGlobalBoardData(boardData);
    } catch (error) {
      console.error('Murder Board | Error updating board connections:', error);
    }
  }

  /**
   * Debounced camera state save (called after pan/zoom)
   */
  _debouncedSaveCameraState() {
    if (this.cameraUpdateTimeout) {
      clearTimeout(this.cameraUpdateTimeout);
    }

    this.cameraUpdateTimeout = setTimeout(() => {
      if (this.renderer && this.scene) {
        MurderBoardData.saveCameraState(this.scene, this.renderer.camera);
      }
      this.cameraUpdateTimeout = null;
    }, 500); // Save 500ms after last pan/zoom action
  }

  /**
   * Handle board selection from dropdown
   */
  async _onBoardSelected(event) {
    const selectedBoardId = event.target.value;
    const boardSelect = event.target;
    
    // Update the display text
    const selectedOption = boardSelect.querySelector(`option[value="${selectedBoardId}"]`);
    const displaySpan = boardSelect.parentElement.querySelector('.board-selector-display');
    if (selectedOption && displaySpan) {
      displaySpan.textContent = selectedOption.textContent;
    }
    
    // Switch to the selected board globally
    await MurderBoardData.setGlobalCurrentBoardId(selectedBoardId);
    
    // Refresh the application to show new board
    await this.render();
  }

  /**
   * Action: Create new board
   */
  async _onNewBoard() {
    if (!game.user.isGM) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    // Create a new board with unique ID
    const boardId = foundry.utils.randomID();
    const boardType = game.settings.get('murder-board', 'defaultBoardType');
    
    // Create new board
    const newBoard = {
      id: boardId,
      sceneId: this.scene.id,
      name: `Board ${MurderBoardData.getGlobalBoards().length + 1}`,
      boardType: boardType,
      defaultConnectionColor: MurderBoardData.getDefaultConnectionColorForBoardType(boardType),
      items: [],
      connections: [],
      camera: { x: 0, y: 0, zoom: 1 },
    };
    
    // Add to global boards
    await MurderBoardData.createGlobalBoard(newBoard);
    await MurderBoardData.setGlobalCurrentBoardId(boardId);
    
    // Create the board folder for storing images
    try {
      // First ensure parent directory exists
      const parentPath = 'murder-board-uploads';
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', parentPath);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      
      const boardFolderPath = `murder-board-uploads/${boardId}`;
      await foundry.applications.apps.FilePicker.implementation.createDirectory('data', boardFolderPath);
    } catch (error) {
      console.warn('Murder Board | Could not create board folder:', error?.message || error);
      // Don't block board creation if folder creation fails
    }
    
    ui.notifications.info('New board created');
    await this.render();
  }

  /**
   * Action: Board selector settings (same as board settings)
   */
  async _onBoardSelectorSettings() {
    return this._onBoardSettings();
  }

  /**
   * Close handler
   */
  async _onClose() {
    // Save camera state before closing
    if (this.renderer && this.scene) {
      await MurderBoardData.saveCameraState(this.scene, this.renderer.camera);
    }
    // Clean up event listeners if needed
    super._onClose();
  }
}

/**
 * Custom Item Type Selection Dialog - breaks free from Foundry default styling
 */
class ItemTypeSelectionDialog extends foundry.applications.api.ApplicationV2 {
  constructor(parentApp, options = {}) {
    super(options);
    this.parentApp = parentApp;
  }

  static DEFAULT_OPTIONS = {
    id: 'murder-board-item-type-dialog',
    tag: 'div',
    classes: ['murder-board-item-type-dialog'],
    window: {
      icon: 'fas fa-plus',
      title: 'MURDER_BOARD.Controls.AddItem',
      resizable: false,
    },
    position: {
      width: 350,
      height: 'auto',
    },
  };

  async _prepareContext(options) {
    return {
      noteLabel: game.i18n.localize('MURDER_BOARD.ItemTypes.Note'),
      textLabel: game.i18n.localize('MURDER_BOARD.ItemTypes.Text'),
      imageLabel: game.i18n.localize('MURDER_BOARD.ItemTypes.Image'),
      documentLabel: game.i18n.localize('MURDER_BOARD.ItemTypes.Document'),
    };
  }

  async _onRender(context, options) {
    // Attach button handlers
    this.element.querySelectorAll('[data-type]').forEach(button => {
      // Click handler - creates item directly with defaults
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        const type = button.dataset.type;
        await this.parentApp._createItemWithDefaults(type);
        this.close();
      });

      // Drag handler - allows dragging to canvas
      button.addEventListener('dragstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const type = button.dataset.type;
        // Store the item type in the drag data
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', type);
        e.dataTransfer.setData('application/murder-board-item-type', type);
        // Set a drag image
        const dragImage = new Image();
        dragImage.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" fill="%23333" rx="4"/%3E%3Ctext x="16" y="20" text-anchor="middle" fill="white" font-size="14" font-family="Arial"%3E%2B%3C/text%3E%3C/svg%3E';
        e.dataTransfer.setDragImage(dragImage, 16, 16);
      });

      // Make button draggable
      button.setAttribute('draggable', 'true');
    });
  }

  get template() {
    return 'modules/murder-board/templates/item-type-selection.hbs';
  }
}

/**
 * Connection Color Picker Dialog - breaks free from Foundry default styling
 */
class ConnectionColorPickerDialog extends HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(parentApp, connection, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.connection = connection;
  }

  static DEFAULT_OPTIONS = {
    id: 'murder-board-color-picker-dialog',
    tag: 'div',
    classes: ['murder-board-color-picker-dialog'],
    window: {
      icon: 'fas fa-palette',
      title: 'Connection Color',
      resizable: false,
    },
    position: {
      width: 300,
      height: 'auto',
    },
  };

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/color-picker-dialog.hbs',
    },
  };

  async _prepareContext(options) {
    return {
      currentColor: this.connection.color || '#ff0000',
      connectionColors: [
        { value: '#FF0000', label: 'Red', title: 'Red' },
        { value: '#00AA00', label: 'Green', title: 'Green' },
        { value: '#0066FF', label: 'Blue', title: 'Blue' },
        { value: '#FFFF00', label: 'Yellow', title: 'Yellow' },
        { value: '#FFA500', label: 'Orange', title: 'Orange' },
        { value: '#9933FF', label: 'Purple', title: 'Purple' },
        { value: '#000000', label: 'Black', title: 'Black' },
        { value: '#FFFFFF', label: 'White', title: 'White' },
      ],
      recentColors: window.game.murderBoard.ColorManager.getColorPalette(),
    };
  }

  async _onRender(context, options) {
    // Attach button handlers
    const content = this.element.querySelector('.window-content');
    if (!content) return;

    const saveBtn = content.querySelector('[data-action="save"]');
    const cancelBtn = content.querySelector('[data-action="cancel"]');

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const selectedColor = content.querySelector('input[name="connectionColor"]:checked');
        if (selectedColor) {
          const colorValue = selectedColor.value;
          window.game.murderBoard.ColorManager.addColorToPalette(colorValue);
          this.parentApp._updateConnectionColor(this.connection.id, colorValue);
          this.close();
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }
  }
}

/**
 * Board Settings Dialog - breaks free from Foundry default styling
 */
class BoardSettingsDialog extends HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(parentApp, scene, options = {}) {
    super(options);
    this.parentApp = parentApp;
    this.scene = scene;
  }

  static DEFAULT_OPTIONS = {
    id: 'murder-board-settings-dialog',
    tag: 'div',
    classes: ['murder-board-settings-dialog'],
    window: {
      icon: 'fas fa-cog',
      title: 'Board Settings',
      resizable: false,
    },
    position: {
      width: 500,
      height: 600,
    },
  };

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/board-settings-dialog.hbs',
    },
  };

  async _prepareContext(options) {
    const boardData = MurderBoardData.getGlobalBoardData();
    const permissions = MurderBoardData.getPermissions(this.scene);

    let playerPermissionTable = '';
    game.users.forEach((user) => {
      if (!user.isGM) {
        const isRestrictedEdit = permissions.restrictedPlayers?.includes(user.id);
        const isRestrictedView = permissions.restrictedViewers?.includes(user.id);
        
        // For the table, we want to show "NOT restricted" (can view/edit) as checked
        const canView = !isRestrictedView;
        const canEdit = !isRestrictedEdit && canView; // Can only edit if can view
        
        playerPermissionTable += `
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
            <td style="padding: 8px;">${user.name}</td>
            <td style="text-align: center; padding: 8px;">
              <input type="checkbox" class="permission-view" name="permission-view" value="${user.id}" ${canView ? 'checked' : ''} />
            </td>
            <td style="text-align: center; padding: 8px;">
              <input type="checkbox" class="permission-edit" name="permission-edit" value="${user.id}" ${canEdit ? 'checked' : ''} ${!canView ? 'disabled' : ''} />
            </td>
          </tr>
        `;
      }
    });

    // Color options (for both canvas and connections)
    const colorOptions = [
      { value: '#FF0000', label: 'Red' },
      { value: '#FF8800', label: 'Orange' },
      { value: '#FFFF00', label: 'Yellow' },
      { value: '#00CC00', label: 'Green' },
      { value: '#0088FF', label: 'Blue' },
      { value: '#8800FF', label: 'Purple' },
      { value: '#FF0088', label: 'Pink' },
      { value: '#000000', label: 'Black' },
      { value: '#FFFFFF', label: 'White' },
    ];

    return {
      boardName: boardData.name || '',
      playerPermissionTable: playerPermissionTable,
      canDeleteBoard: MurderBoardData.getGlobalBoards().length > 1,
      defaultConnectionColor: boardData.defaultConnectionColor || '#000000',
      defaultConnectionSize: boardData.defaultConnectionSize || 5,
      canvasColor: boardData.canvasColor || MurderBoardData.getDefaultCanvasColorForBoardType(boardData.boardType || 'whiteboard'),
      connectionColors: colorOptions,
      backgroundImage: boardData.backgroundImage || '',
      backgroundMode: boardData.backgroundMode || 'content',
      backgroundScale: boardData.backgroundScale || 1.0,
      recentColors: window.game.murderBoard.ColorManager.getColorPalette(),
      defaultFont: boardData.defaultFont || 'Arial',
      defaultFontColor: boardData.defaultFontColor || '#000000',
      availableFonts: this.parentApp._getAvailableFonts(),
    };
  }

  async _onRender(context, options) {
    // Attach button handlers - query from the content element
    const content = this.element.querySelector('.window-content');
    if (!content) return;

    // Set the select value based on data attribute
    const boardTypeSelect = content.querySelector('#board-type');
    if (boardTypeSelect) {
      const currentType = boardTypeSelect.dataset.current;
      if (currentType) {
        boardTypeSelect.value = currentType;
      }
    }

    const saveBtn = content.querySelector('[data-action="save"]');
    const deleteBtn = content.querySelector('[data-action="delete"]');
    const cancelBtn = content.querySelector('[data-action="cancel"]');

    if (saveBtn) {
      saveBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await this._handleSave();
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await this._handleDelete();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }

    // Add toggle button handlers for permissions table
    const toggleViewAll = content.querySelector('#toggle-view-all');
    const toggleViewNone = content.querySelector('#toggle-view-none');
    const toggleEditAll = content.querySelector('#toggle-edit-all');
    const toggleEditNone = content.querySelector('#toggle-edit-none');

    if (toggleViewAll) {
      toggleViewAll.addEventListener('click', (e) => {
        e.preventDefault();
        content.querySelectorAll('input.permission-view').forEach(checkbox => {
          checkbox.checked = true;
          checkbox.disabled = false;
        });
        // Also enable corresponding edit checkboxes
        content.querySelectorAll('input.permission-edit').forEach(checkbox => {
          checkbox.disabled = false;
        });
      });
    }
    if (toggleViewNone) {
      toggleViewNone.addEventListener('click', (e) => {
        e.preventDefault();
        content.querySelectorAll('input.permission-view').forEach(checkbox => {
          checkbox.checked = false;
        });
        // Also uncheck and disable corresponding edit checkboxes
        content.querySelectorAll('input.permission-edit').forEach(checkbox => {
          checkbox.checked = false;
          checkbox.disabled = true;
        });
      });
    }
    if (toggleEditAll) {
      toggleEditAll.addEventListener('click', (e) => {
        e.preventDefault();
        content.querySelectorAll('input.permission-edit:not(:disabled)').forEach(checkbox => {
          checkbox.checked = true;
        });
      });
    }
    if (toggleEditNone) {
      toggleEditNone.addEventListener('click', (e) => {
        e.preventDefault();
        content.querySelectorAll('input.permission-edit:not(:disabled)').forEach(checkbox => {
          checkbox.checked = false;
        });
      });
    }

    // Add event listeners to sync view/edit permissions
    content.querySelectorAll('input.permission-view').forEach(viewCheckbox => {
      viewCheckbox.addEventListener('change', (e) => {
        // Find the corresponding edit checkbox in the same row
        const row = viewCheckbox.closest('tr');
        const editCheckbox = row.querySelector('input.permission-edit');
        
        if (!e.target.checked) {
          // If view is unchecked, uncheck and disable edit
          editCheckbox.checked = false;
          editCheckbox.disabled = true;
        } else {
          // If view is checked, enable edit (but don't change its state)
          editCheckbox.disabled = false;
        }
      });
    });

    // Initialize file pickers for background image
    this._initializeFilePickers();

    // Initialize color pickers
    this._initializeColorPickersInDialog(content);

    // Background scale slider handler
    const backgroundScaleInput = content.querySelector('#background-scale');
    const scaleValueDisplay = content.querySelector('#scale-value');

    if (backgroundScaleInput && scaleValueDisplay) {
      backgroundScaleInput.addEventListener('input', (e) => {
        scaleValueDisplay.textContent = parseFloat(e.target.value).toFixed(1);
      });
    }

    // Connection size slider handler
    const connectionSizeInput = content.querySelector('#connection-size');
    const sizeValueDisplay = content.querySelector('#size-value');

    if (connectionSizeInput && sizeValueDisplay) {
      connectionSizeInput.addEventListener('input', (e) => {
        sizeValueDisplay.textContent = e.target.value;
      });
    }
  }

  async _handleSave() {
    const content = this.element.querySelector('.window-content');
    if (!content) return;

    const boardName = content.querySelector('#board-name')?.value;
    
    // Extract from table: "can view" checked means NOT restricted
    const uncheckedViewCheckboxes = content.querySelectorAll('input.permission-view:not(:checked)');
    const restrictedViewers = Array.from(uncheckedViewCheckboxes).map(cb => cb.value);
    
    // Extract from table: "can edit" checked means NOT restricted
    const uncheckedEditCheckboxes = content.querySelectorAll('input.permission-edit:not(:checked)');
    const restrictedPlayers = Array.from(uncheckedEditCheckboxes).map(cb => cb.value);
    
    // Auto-determine allow flags: if any restrictions exist, set to true (allow players, then restrict specific ones)
    // If all are allowed, set to true. If all are restricted, set to false.
    const allPlayers = Array.from(content.querySelectorAll('input.permission-edit')).map(cb => cb.value);
    const allowPlayersToEdit = restrictedPlayers.length < allPlayers.length; // true if at least one can edit
    
    const allViewers = Array.from(content.querySelectorAll('input.permission-view')).map(cb => cb.value);
    const allowPlayersToView = restrictedViewers.length < allViewers.length; // true if at least one can view
    
    // Get connection color (radio or hidden input)
    let defaultConnectionColor = content.querySelector('input[name="connection-color"]:checked')?.value;
    if (!defaultConnectionColor) {
      const hiddenConnectionColor = content.querySelector('input[name="connection-color"][type="hidden"]');
      defaultConnectionColor = hiddenConnectionColor?.value;
    }
    
    // Get canvas color (radio or hidden input)
    let canvasColor = content.querySelector('input[name="canvas-color"]:checked')?.value;
    if (!canvasColor) {
      const hiddenCanvasColor = content.querySelector('input[name="canvas-color"][type="hidden"]');
      canvasColor = hiddenCanvasColor?.value;
    }
    
    const backgroundImage = content.querySelector('#background-image')?.value?.trim() || null;

    // Get default font from the select
    const defaultFont = content.querySelector('select[name="default-font"]')?.value || 'Arial';

    const boardData = MurderBoardData.getGlobalBoardData();
    
    // Get default font color (radio button or hidden input from custom color picker)
    let defaultFontColor = content.querySelector('input[name="default-font-color"]:checked')?.value;
    if (!defaultFontColor) {
      const hiddenFontColor = content.querySelector('input[name="default-font-color"][type="hidden"]');
      defaultFontColor = hiddenFontColor?.value;
    }
    
    // Fall back to current board value if nothing extracted
    if (!defaultFontColor) {
      defaultFontColor = boardData.defaultFontColor || '#000000';
    }
    
    console.log('Murder Board | Saving board settings. defaultFontColor:', defaultFontColor);
    console.log('Murder Board | Current boardData.id:', boardData.id);
    console.log('Murder Board | Current boardData keys:', Object.keys(boardData));
    
    boardData.name = boardName;
    boardData.canvasColor = canvasColor;
    boardData.backgroundImage = backgroundImage;
    boardData.backgroundScale = parseFloat(content.querySelector('#background-scale')?.value) || 1.0;
    boardData.defaultConnectionSize = parseInt(content.querySelector('#connection-size')?.value) || 5;
    boardData.defaultFont = defaultFont;
    boardData.defaultFontColor = defaultFontColor;
    
    console.log('Murder Board | Board data after setting defaults:', boardData.defaultFont, boardData.defaultFontColor);
    console.log('Murder Board | boardData object:', JSON.stringify({defaultFont: boardData.defaultFont, defaultFontColor: boardData.defaultFontColor}));
    
    // Add to color palette for future use
    if (defaultFontColor) {
      window.game.murderBoard.ColorManager.addColorToPalette(defaultFontColor);
    }
    
    // Set permissions directly on board data
    boardData.permissions = {
      allowPlayersToEdit,
      restrictedPlayers,
      allowPlayersToView,
      restrictedViewers,
    };
    
    if (defaultConnectionColor) {
      boardData.defaultConnectionColor = defaultConnectionColor;
      window.game.murderBoard.ColorManager.addColorToPalette(defaultConnectionColor);
    }
    if (canvasColor) {
      window.game.murderBoard.ColorManager.addColorToPalette(canvasColor);
    }

    await MurderBoardData.saveGlobalBoardData(boardData);

    console.log('Murder Board | After save, checking if defaultFontColor persisted...');
    const checkBoardData = MurderBoardData.getGlobalBoardData();
    console.log('Murder Board | Reloaded boardData.defaultFontColor:', checkBoardData.defaultFontColor);

    // Refresh UI
    await this.parentApp.render();
    
    // Wait for browser to paint, then ensure canvas is properly sized
    // Use multiple animation frames to allow layout to fully settle
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.parentApp && this.parentApp._resizeCanvas) {
          this.parentApp._resizeCanvas();
        }
        if (this.parentApp && this.parentApp.renderer) {
          this.parentApp.renderer.handleSettingsChange();
          this.parentApp.renderer.draw();
        }
      });
    });
    
    this.close();
  }

  async _handleDelete() {
    const boardData = MurderBoardData.getGlobalBoardData();
    const allBoards = MurderBoardData.getGlobalBoards();

    if (allBoards.length <= 1) {
      ui.notifications.warn('Cannot delete the only board');
      return;
    }

    // Confirmation dialog using ApplicationV2
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Board' },
      content: `<p>Are you sure you want to delete "${boardData.name || 'Untitled Board'}"? This cannot be undone.</p>`,
      rejectClose: false,
      modal: true,
    });

    if (confirmed) {
      try {
        await MurderBoardData.deleteGlobalBoard(boardData.id);
        ui.notifications.info('Board deleted');
        // Close the settings dialog and wait for it
        await this.close();
        // Small delay to ensure dialog is fully closed
        await new Promise(resolve => setTimeout(resolve, 100));
        // Then refresh the parent app to update board selector and canvas
        await this.parentApp.render();
      } catch (error) {
        console.error('Murder Board | Error deleting board:', error);
        ui.notifications.error('Failed to delete board: ' + error.message);
      }
    }
  }

  /**
   * Handle background image file picker
   */
  async _pickBackgroundImage() {
    const backgroundImageInput = this.element.querySelector('#background-image');
    if (!backgroundImageInput) return;

    // Open Foundry's file picker
    const fp = new foundry.applications.apps.FilePicker({
      type: 'image',
      current: backgroundImageInput.value || '',
      callback: (path) => {
        backgroundImageInput.value = path;
      },
      top: this.position.top + 40,
      left: this.position.left + 10,
    });
    fp.browse();
  }

  /**
   * Initialize file pickers for background image
   * @private
   */
  _initializeFilePickers() {
    const filePickerBtns = this.element.querySelectorAll('.file-picker-btn');
    filePickerBtns.forEach(btn => {
      btn.addEventListener('click', (e) => this._handleFilePickerClick(e));
    });
  }

  /**
   * Handle file picker button click
   * @param {Event} event - The click event
   * @private
   */
  async _handleFilePickerClick(event) {
    event.preventDefault();
    event.stopPropagation();
    
    const fileType = event.currentTarget.dataset.fileType || 'image';
    const inputField = event.currentTarget.closest('.file-input-wrapper')?.querySelector('input[type="text"]');
    
    if (!inputField) {
      console.warn('Murder Board | Input field not found');
      return;
    }
    
    try {
      // Determine which file picker to use based on hosting platform
      let activeSource = 'data';
      
      if (typeof ForgeVTT !== 'undefined' && ForgeVTT.usingTheForge) {
        // Use The Forge file picker
        const pickerOptions = {
          type: 'image',
          activeSource: 'forgevtt',
          callback: (path) => {
            inputField.value = path;
            inputField.dispatchEvent(new Event('change', { bubbles: true }));
          },
        };
        const picker = new ForgeVTT_FilePicker(pickerOptions);
        picker.browse();
        return;
      } else if (typeof globalThis.Sqyre !== 'undefined') {
        // Sqyre hosting detected
        activeSource = 'sqyre';
      }
      
      // Standard Foundry file picker (also works for Sqyre with activeSource)
      const pickerOptions = {
        type: 'imageBrowser',
        activeSource: activeSource,
        callback: (path) => {
          inputField.value = path;
          inputField.dispatchEvent(new Event('change', { bubbles: true }));
        },
      };
      const picker = new foundry.applications.apps.FilePicker.implementation(pickerOptions);
      picker.browse();
    } catch (error) {
      console.error('Murder Board | Error opening file picker:', error);
      ui.notifications.error('Failed to open file picker');
    }
  }

  /**
   * Initialize color pickers in the dialog
   * Handles both preset colors and custom color input
   */
  _initializeColorPickersInDialog(container) {
    const colorInputs = container.querySelectorAll('.color-picker-input');
    
    colorInputs.forEach(input => {
      const fieldName = input.dataset.fieldName;
      if (!fieldName) return;

      const form = container.querySelector('form') || this.element;
      if (!form) return;

      // When user changes custom color picker, uncheck radio buttons and update the hidden field
      input.addEventListener('input', (e) => {
        const colorValue = e.target.value.toUpperCase();

        // Uncheck all radio buttons for this field
        const radios = form.querySelectorAll(`input[name="${fieldName}"][type="radio"]`);
        radios.forEach(radio => {
          radio.checked = false;
        });

        // Create or update hidden field to hold custom color value
        let hiddenInput = form.querySelector(`input[name="${fieldName}"][type="hidden"]`);
        if (!hiddenInput) {
          hiddenInput = document.createElement('input');
          hiddenInput.type = 'hidden';
          hiddenInput.name = fieldName;
          form.appendChild(hiddenInput);
        }
        hiddenInput.value = colorValue;
      });

      // Sync color picker display to selected radio button on load
      const checkedRadio = form.querySelector(`input[name="${fieldName}"][type="radio"]:checked`);
      if (checkedRadio && checkedRadio.value) {
        input.value = checkedRadio.value;
      }
    });
  }

  /**
   * Show board information (items, connections, settings)
   * Logs to console for easy inspection
   * @public
   */
  showBoardInfo() {
    const boardData = MurderBoardData.getGlobalBoardData();
    
    const info = {
      'Board Name': boardData.name,
      'Board ID': boardData.id,
      'Board Type': boardData.boardType,
      'Item Count': boardData.items.length,
      'Connection Count': boardData.connections.length,
      'Group Count': boardData.groups?.length || 0,
      'Canvas Color': boardData.canvasColor,
      'Default Connection Color': boardData.defaultConnectionColor,
      'Default Connection Size': boardData.defaultConnectionSize,
      'Camera Position': `X: ${boardData.camera?.x || 0}, Y: ${boardData.camera?.y || 0}`,
      'Camera Zoom': boardData.camera?.zoom || 1,
    };

    console.log('%c=== Murder Board Info ===', 'color: #ff6b6b; font-weight: bold; font-size: 14px;');
    console.table(info);
    console.log('Full Board Data:', boardData);
  }

  /**
   * Show detailed board diagnostics
   * Includes item and connection details
   * @public
   */
  showBoardDiagnostics() {
    const boardData = MurderBoardData.getGlobalBoardData();
    
    console.log('%c=== Murder Board Diagnostics ===', 'color: #4ecdc4; font-weight: bold; font-size: 14px;');
    
    // Board level info
    console.log('%cBoard Summary:', 'font-weight: bold; color: #95e1d3;');
    console.log(`Name: ${boardData.name} (ID: ${boardData.id})`);
    console.log(`Type: ${boardData.boardType}`);
    console.log(`Items: ${boardData.items.length} | Connections: ${boardData.connections.length} | Groups: ${boardData.groups?.length || 0}`);
    
    // Items breakdown
    if (boardData.items.length > 0) {
      console.log('%cItems:', 'font-weight: bold; color: #f38181;');
      const itemsByType = {};
      boardData.items.forEach(item => {
        if (!itemsByType[item.type]) itemsByType[item.type] = [];
        itemsByType[item.type].push(item);
      });
      
      Object.entries(itemsByType).forEach(([type, items]) => {
        console.log(`  ${type}: ${items.length} item(s)`);
        console.table(items.map(i => ({
          'ID': i.id,
          'Label': i.label,
          'X': i.x,
          'Y': i.y,
          'Color': i.color,
          'GroupId': i.groupId || 'none',
        })));
      });
    } else {
      console.log('%cNo items on this board', 'color: #999; font-style: italic;');
    }
    
    // Connections breakdown
    if (boardData.connections.length > 0) {
      console.log('%cConnections:', 'font-weight: bold; color: #aa96da;');
      console.table(boardData.connections.map(c => ({
        'ID': c.id,
        'From': c.fromItem,
        'To': c.toItem,
        'Color': c.color,
        'Label': c.label || '(none)',
      })));
    } else {
      console.log('%cNo connections on this board', 'color: #999; font-style: italic;');
    }
    
    // Groups breakdown
    if (boardData.groups && boardData.groups.length > 0) {
      console.log('%cGroups:', 'font-weight: bold; color: #fcbad3;');
      console.table(boardData.groups.map(g => ({
        'ID': g.id,
        'Item Count': g.itemIds?.length || 0,
        'Color': g.color || 'none',
      })));
    }
    
    // Camera state
    console.log('%cCamera State:', 'font-weight: bold; color: #a8dadc;');
    console.table({
      'X Position': boardData.camera?.x || 0,
      'Y Position': boardData.camera?.y || 0,
      'Zoom Level': boardData.camera?.zoom || 1,
    });
    
    console.log('%cFull Board Data:', 'font-weight: bold; color: #e0aaff;');
    console.log(boardData);
  }

}


