/**
 * Murder Board Application - ApplicationV2 Implementation
 * Renders the main board interface with canvas rendering
 */

import { MurderBoardData } from './data-model.js';
import { NoteItemDialog, TextItemDialog, ImageItemDialog, DocumentItemDialog } from './item-dialogs.js';
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
      'toggle-center': MurderBoardApplication.prototype._onToggleCenter,
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
   * Get context data for the template
   * @param {Object} options - Preparation options
   * @returns {Object} Context data
   */
  async _prepareContext(options) {
    const scene = this.scene;
    const boardData = MurderBoardData.getBoardData(scene);

    // Get all available boards from scene flags
    const allBoards = MurderBoardData.getAllBoards(scene) || [];
    const availableBoards = allBoards.map(board => ({
      id: board.id,
      name: board.name || 'Untitled Board',
      isActive: board.id === boardData.id,
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
        if (this._boundContextMenu) container.removeEventListener('contextmenu', this._boundContextMenu);
        if (this._boundWheel) container.removeEventListener('wheel', this._boundWheel);
        if (this._boundDoubleClick) container.removeEventListener('dblclick', this._boundDoubleClick);
        if (this._boundDragOver) container.removeEventListener('dragover', this._boundDragOver);
        if (this._boundDragLeave) container.removeEventListener('dragleave', this._boundDragLeave);
        if (this._boundDrop) container.removeEventListener('drop', this._boundDrop);
      }
      
      // Remove global listeners
      if (this._boundWindowMouseUp) window.removeEventListener('mouseup', this._boundWindowMouseUp);
      if (this._boundKeyDown) document.removeEventListener('keydown', this._boundKeyDown);
      if (this._boundWindowResize) window.removeEventListener('resize', this._boundWindowResize);
    } catch (error) {
      console.error('Murder Board | Error in _onClose:', error);
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

    // Initialize board data if needed
    if (!this.scene.flags['murder-board']) {
      await MurderBoardData.initializeBoard(this.scene);
    }

    // Get canvas element
    this.canvas = this.element.querySelector('#murder-board-canvas');
    if (!this.canvas) {
      console.error('Murder Board | Canvas element not found');
      return;
    }

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
        this._resizeCanvas();
        this.renderer.draw();
        
        // Re-apply position to trigger layout cascade (happens every frame while resizing)
        this.setPosition({
          width: this.position.width,
          height: this.position.height,
          top: this.position.top,
          left: this.position.left,
        });
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
    
    // Set canvas to fill entire wrapper
    this.canvas.width = wrapperWidth;
    this.canvas.height = wrapperHeight;
    
    // Set canvas CSS display size to match
    this.canvas.style.width = wrapperWidth + 'px';
    this.canvas.style.height = wrapperHeight + 'px';
    
    // No centering needed - canvas fills the entire space
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';
  }

  /**
   * Attach event listeners to canvas
   */
  _attachEventListeners() {
    // Since canvas has pointer-events: none to allow window dragging,
    // we need to attach listeners to the parent container instead
    const container = this.canvas.parentElement;
    
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
    container.addEventListener('contextmenu', this._boundContextMenu);
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
    this.isBoxSelecting = false;
    this.isResizing = false;
    this.resizeItemId = null;
    this.resizeHandle = null;
    this.dragOverItem = null;
    
    // Reset renderer state
    if (this.renderer) {
      this.renderer.draggedItem = null;
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
    if (item.type !== 'Text') return null;

    const worldPos = this.renderer.screenToWorld(x, y);
    const itemX = item.x;
    const itemY = item.y;
    const itemWidth = item.data?.width || this.renderer.itemSize;
    const itemHeight = item.data?.height || this.renderer.itemSize;
    const rotation = item.rotation || 0;

    const handleSize = 6;
    const tolerance = handleSize + 4; // Allow more tolerance for rotated items

    // Calculate rotated corner positions
    const centerX = itemX + itemWidth / 2;
    const centerY = itemY + itemHeight / 2;
    const cos = Math.cos(rotation * Math.PI / 180);
    const sin = Math.sin(rotation * Math.PI / 180);

    // Corner positions relative to center
    const corners = [
      { relX: -itemWidth / 2, relY: -itemHeight / 2, type: 'nw' }, // Top-left
      { relX: itemWidth / 2, relY: -itemHeight / 2, type: 'ne' }, // Top-right
      { relX: -itemWidth / 2, relY: itemHeight / 2, type: 'sw' }, // Bottom-left
      { relX: itemWidth / 2, relY: itemHeight / 2, type: 'se' }, // Bottom-right
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
        Math.pow(worldPos.x - corner.pos.x, 2) + 
        Math.pow(worldPos.y - corner.pos.y, 2)
      );
      if (distance <= tolerance) {
        return corner.type;
      }
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

      // Middle-click to pan
      if (event.button === 1) {
        this.isPanning = true;
        this.panStartX = x;
        this.panStartY = y;
        this.panStartCameraX = this.renderer.camera.x;
        this.panStartCameraY = this.renderer.camera.y;
        return;
      }

      // Ignore right-clicks
      if (event.button === 2) {
        return;
      }

      // Check if clicking on a resize handle for selected text items
      if (this.selectedItems.length === 1) {
        const selectedItemId = this.selectedItems[0];
        const boardData = MurderBoardData.getBoardData(this.scene);
        const selectedItem = boardData.items.find(i => i.id === selectedItemId);
        
        if (selectedItem && selectedItem.type === 'Text') {
          const resizeHandle = this._getResizeHandleAtPoint(selectedItem, x, y);
          if (resizeHandle) {
            // Start resizing
            this.isResizing = true;
            this.resizeItemId = selectedItemId;
            this.resizeHandle = resizeHandle;
            this.resizeStart = { x, y };
            this.resizeStartDimensions = {
              width: selectedItem.data?.width || this.renderer.itemSize,
              height: selectedItem.data?.height || this.renderer.itemSize
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
        
        // Save starting positions of all selected items
        this.dragStartPositions.clear();
        this.selectedItems.forEach(selectedId => {
          const boardData = MurderBoardData.getBoardData(this.scene);
          const itemData = boardData.items.find(i => i.id === selectedId);
          if (itemData) {
            this.dragStartPositions.set(selectedId, { x: itemData.x, y: itemData.y });
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

      // Handle panning
      if (this.isPanning) {
        const panDeltaX = x - this.panStartX;
        const panDeltaY = y - this.panStartY;
        this.renderer.camera.x = this.panStartCameraX + panDeltaX;
        this.renderer.camera.y = this.panStartCameraY + panDeltaY;
        this.renderer.draw();
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
        this.renderer.draw();
        return;
      }

      // Handle resizing
      if (this.isResizing && this.resizeItemId) {
        const deltaX = x - this.resizeStart.x;
        const deltaY = y - this.resizeStart.y;
        
        const boardData = MurderBoardData.getBoardData(this.scene);
        const item = boardData.items.find(i => i.id === this.resizeItemId);
        if (item && item.type === 'Text') {
          let newWidth = this.resizeStartDimensions.width;
          let newHeight = this.resizeStartDimensions.height;
          
          // Adjust dimensions based on handle
          switch (this.resizeHandle) {
            case 'nw':
              newWidth = this.resizeStartDimensions.width - deltaX / this.renderer.camera.zoom;
              newHeight = this.resizeStartDimensions.height - deltaY / this.renderer.camera.zoom;
              break;
            case 'ne':
              newWidth = this.resizeStartDimensions.width + deltaX / this.renderer.camera.zoom;
              newHeight = this.resizeStartDimensions.height - deltaY / this.renderer.camera.zoom;
              break;
            case 'sw':
              newWidth = this.resizeStartDimensions.width - deltaX / this.renderer.camera.zoom;
              newHeight = this.resizeStartDimensions.height + deltaY / this.renderer.camera.zoom;
              break;
            case 'se':
              newWidth = this.resizeStartDimensions.width + deltaX / this.renderer.camera.zoom;
              newHeight = this.resizeStartDimensions.height + deltaY / this.renderer.camera.zoom;
              break;
          }
          
          // Ensure minimum size
          newWidth = Math.max(newWidth, 50);
          newHeight = Math.max(newHeight, 30);
          
          // Update item data
          if (!item.data) item.data = {};
          item.data.width = newWidth;
          item.data.height = newHeight;
          
          // Update the item in the scene
          MurderBoardData.updateItem(this.scene, this.resizeItemId, { data: item.data });
          
          this.renderer.draw();
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

        const boardData = MurderBoardData.getBoardData(this.scene);

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
          
          // Update all selected items, maintaining their relative positions
          this.selectedItems.forEach(selectedId => {
            const itemIndex = boardData.items.findIndex(i => i.id === selectedId);
            if (itemIndex !== -1) {
              const item = boardData.items[itemIndex];
              const startPos = this.dragStartPositions.get(selectedId);
              if (startPos) {
                // Move item from its starting position + world delta
                item.x = startPos.x + worldDeltaX;
                item.y = startPos.y + worldDeltaY;
              }
            }
          });

          // Debounce scene flag updates - only update every 50ms during drag
          if (this.dragUpdateTimeout) {
            clearTimeout(this.dragUpdateTimeout);
          }
          
          this.dragUpdateTimeout = setTimeout(() => {
            this._updateBoardItems(boardData.items);
            this.dragUpdateTimeout = null;
          }, 50);
        }

        this.renderer.draw();
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
        
        this.renderer.draw();
      }
    } catch (error) {
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

      // Stop panning
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
            const boardData = MurderBoardData.getBoardData(this.scene);
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
            const boardData = MurderBoardData.getBoardData(this.scene);
            const item = boardData.items.find(i => i.id === firstSelectedId);
            if (item) {
              item.x = this.dragItemStartPos.x;
              item.y = this.dragItemStartPos.y;
              await this._updateBoardItems(boardData.items);
            }
          }
        } else {
          // Check if any item was actually moved
          const boardData = MurderBoardData.getBoardData(this.scene);
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
      return;
    }

    event.preventDefault();
    if (!this.renderer) return;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const item = this.renderer.getItemAtPoint(screenX, screenY);
    if (item) {
      // Right-click on item - show item context menu
      this._showContextMenu(item, event.clientX, event.clientY);
    } else {
      // Check if right-clicking on a connection
      const connection = this.renderer.getConnectionAtPoint(screenX, screenY);
      if (connection) {
        this._showConnectionMenu(connection, event.clientX, event.clientY);
      } else {
        // Right-click on empty space - show creation menu
        this._showCreationMenu(screenX, screenY, event.clientX, event.clientY);
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
          hidden: isMultiSelect, // Hide edit for multi-select
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
      ];

      // Create custom context menu HTML
      let html = '<div class="murder-board-context-menu" style="min-width: 150px;">';
      let menuItemsHtml = ''; // Store menu items to add at the end
      
      // Collect menu items HTML (to add at the bottom later)
      for (let menuItem of menuItems) {
        if (!menuItem.hidden) {
          menuItemsHtml += `
            <button class="murder-board-menu-item" data-callback="${menuItems.indexOf(menuItem)}">
              <i class="${menuItem.icon}"></i>
              ${menuItem.label}
            </button>
          `;
        }
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
        // Connection acceptance toggle for all item types
        const acceptsConnections = item.acceptsConnections !== false;
        html += `<div class="murder-board-context-section">`;
        html += `
          <button class="murder-board-connection-toggle-btn ${acceptsConnections ? 'active' : ''}" data-item-id="${itemId}"
                  title="${acceptsConnections ? 'Rejecting Connections' : 'Accepting Connections'}">
            <i class="fas ${acceptsConnections ? 'fa-link' : 'fa-link-slash'}"></i>
            ${acceptsConnections ? 'Accepting Connections' : 'Rejecting Connections'}
          </button>
        `;
        html += `</div>`;

        // Add fastener type buttons for Image and Document items
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

      // Add size buttons for Document items
      if (item.type === 'Document') {
        const documentSizes = [
          { id: 'small', label: 'Small' },
          { id: 'medium', label: 'Medium' },
          { id: 'large', label: 'Large' },
          { id: 'xlarge', label: 'X-Large' },
        ];
        const currentSize = item.data?.size || 'medium';
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Size</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let size of documentSizes) {
          const isSelected = currentSize === size.id;
          html += `
            <button class="murder-board-doc-size-btn ${isSelected ? 'selected' : ''}" data-size="${size.id}"
                    title="${size.label}">
              ${size.label}
            </button>
          `;
        }
        html += `</div></div>`;

        // Add effects buttons for Documents
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
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Color</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let docColor of documentColors) {
          const isSelected = docColor.hex.toUpperCase() === currentDocColor.toUpperCase();
          html += `
            <button class="murder-board-doc-color-btn ${isSelected ? 'selected' : ''}" data-color="${docColor.hex}"
                    style="flex: 1; min-width: 30px; height: 30px; padding: 0; background: ${docColor.hex}; border: ${isSelected ? '3px solid var(--mb-secondary)' : '2px solid var(--mb-border)'};"
                    title="${docColor.label}">
            </button>
          `;
        }
        html += `</div></div>`;
      }

      // Add size buttons for Image items
      if (item.type === 'Image') {
        const imageSizes = [
          { id: 'portrait', label: 'Polaroid' },
          { id: 'small', label: 'Small' },
          { id: 'medium', label: 'Medium' },
          { id: 'large', label: 'Large' },
          { id: 'xl', label: 'XL' },
          { id: 'xxl', label: 'XXL' },
        ];
        const currentSize = item.data?.preset || 'medium';
        html += `<div class="murder-board-context-section">`;
        
        for (let size of imageSizes) {
          const isSelected = currentSize === size.id;
          html += `
            <button class="murder-board-size-btn ${isSelected ? 'selected' : ''}" data-size="${size.id}"
                    title="${size.label}">
              ${size.label}
            </button>
          `;
        }
        html += `</div>`;

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
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">Note</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let noteColor of noteColors) {
          const isSelected = noteColor.hex.toUpperCase() === currentNoteColor.toUpperCase();
          html += `
            <button class="murder-board-note-color-btn ${isSelected ? 'selected' : ''}" data-color="${noteColor.hex}"
                    style="flex: 1; min-width: 30px; height: 30px; padding: 0; --color-value: ${noteColor.hex}; background: var(--color-value); border: ${isSelected ? '3px solid var(--mb-secondary)' : '2px solid var(--mb-border)'};"
                    title="${noteColor.label}">
            </button>
          `;
        }
        html += `</div></div>`;
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
        html += `<div class="murder-board-context-section" style="display: flex; align-items: center; gap: 8px;">`;
        html += `<div class="murder-board-context-section-label" style="margin-bottom: 0; flex-shrink: 0;">${item.type === 'Text' ? 'Text' : 'Font'}</div>`;
        html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; flex: 1;">`;
        
        for (let fontColor of fontColors) {
          const isSelected = fontColor.hex.toUpperCase() === currentFontColor.toUpperCase();
          html += `
            <button class="murder-board-font-color-btn ${isSelected ? 'selected' : ''}" data-color="${fontColor.hex}"
                    style="flex: 1; min-width: 30px; height: 30px; padding: 0; background: ${fontColor.hex}; border: ${isSelected ? '3px solid var(--mb-secondary)' : '2px solid var(--mb-border)'};"
                    title="${fontColor.label}">
            </button>
          `;
        }
        html += `</div></div>`;
      }

      // Add font size slider for Text items
      if (item.type === 'Text') {
        const currentFontSize = (item.data && item.data.fontSize) || 14;
        html += `<div class="murder-board-context-section" style="padding: 8px 12px; border-bottom: 1px solid var(--mb-border);">`;
        html += `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">`;
        html += `<label style="font-size: 11px; color: var(--mb-text); white-space: nowrap;">Font Size:</label>`;
        html += `<span id="font-size-value" style="font-size: 11px; color: var(--mb-text); font-weight: bold; min-width: 25px;">${currentFontSize}px</span>`;
        html += `</div>`;
        html += `<input type="range" id="font-size-slider" class="murder-board-font-slider"`;
        html += ` min="8" max="72" value="${currentFontSize}" step="1"`;
        html += ` style="width: 100%; cursor: pointer;">`;
        html += `</div>`;
      }
      
      // Add shadow option for all items
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
      
      // Add menu items at the end (Edit, Duplicate, Delete)
      html += `<div style="display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--mb-dialog-input-border);">`;
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
            if (!freshItem) return;
            MurderBoardData.updateItem(self.scene, itemId, {
              data: {
                ...freshItem.data,
                fastenerType: fastenerType,
              },
            }).then(() => {
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
            connectionToggleBtn.innerHTML = '<i class="fas fa-link"></i> Accepting Connections';
          } else {
            connectionToggleBtn.classList.remove('active');
            connectionToggleBtn.title = 'Rejecting Connections';
            connectionToggleBtn.innerHTML = '<i class="fas fa-link-slash"></i> Rejecting Connections';
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
      const sizeBtns = menuDiv.querySelectorAll('.murder-board-size-btn');
      sizeBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sizePreset = btn.dataset.size;
          // Get fresh item data to avoid stale closures
          const freshItem = MurderBoardData.getItem(self.scene, itemId);
          if (!freshItem) return;
          MurderBoardData.updateItem(self.scene, itemId, {
            data: {
              ...freshItem.data,
              preset: sizePreset,
            },
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: {
                    ...freshItem.data,
                    preset: sizePreset,
                  },
                },
              });
            }
            self.renderer.draw();
          });
        });
      });

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
          });
        });
      });

      // Attach font size slider handler for Text items
      const fontSizeSlider = menuDiv.querySelector('#font-size-slider');
      if (fontSizeSlider) {
        fontSizeSlider.addEventListener('input', (e) => {
          e.stopPropagation();
          const fontSize = parseInt(e.target.value);
          
          // Update display value
          const valueDisplay = menuDiv.querySelector('#font-size-value');
          if (valueDisplay) {
            valueDisplay.textContent = fontSize + 'px';
          }
          
          // Calculate new text dimensions to check if we need to resize the bounding box
          const font = item.data?.font || 'Arial';
          const text = item.label || '';
          
          // Create a temporary canvas context to measure text
          const tempCanvas = document.createElement('canvas');
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.font = `${fontSize}px ${font}`;
          
          // Measure text dimensions
          const textMetrics = tempCtx.measureText(text);
          const textWidth = textMetrics.width;
          const textHeight = fontSize * 1.3; // Approximate line height
          
          // Get current bounding box dimensions
          let currentWidth = item.data?.width || this.renderer.itemSize;
          let currentHeight = item.data?.height || this.renderer.itemSize;
          
          // Add padding for the text
          const padding = 16; // 8px on each side
          const neededWidth = textWidth + padding;
          const neededHeight = textHeight + padding;
          
          // Auto-resize if text would exceed current bounds
          let newWidth = currentWidth;
          let newHeight = currentHeight;
          
          if (neededWidth > currentWidth) {
            newWidth = Math.ceil(neededWidth);
          }
          if (neededHeight > currentHeight) {
            newHeight = Math.ceil(neededHeight);
          }
          
          // Save font size and potentially resized dimensions to item
          const updateData = {
            ...item.data,
            fontSize: fontSize,
          };
          
          if (newWidth !== currentWidth) {
            updateData.width = newWidth;
          }
          if (newHeight !== currentHeight) {
            updateData.height = newHeight;
          }
          
          MurderBoardData.updateItem(self.scene, itemId, {
            data: updateData,
          }).then(() => {
            if (!game.user.isGM) {
              emitSocketMessage('updateItem', {
                sceneId: self.scene.id,
                itemId: itemId,
                updates: {
                  data: updateData,
                },
              });
            }
            self.renderer.draw();
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

      // Remove menu when clicking elsewhere - close ALL context menus
      const closeMenu = (e) => {
        if (!menuDiv.contains(e.target)) {
          // Close all context menus, not just this one
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('click', closeMenu);
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
    const boardData = MurderBoardData.getBoardData(this.scene);
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
              self._showItemDialog('note', worldCoords);
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
              self._showItemDialog('text', worldCoords);
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
              self._showItemDialog('image', worldCoords);
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
              self._showItemDialog('document', worldCoords);
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
        }
      };
      document.addEventListener('click', closeMenu);

      // Also close on escape key
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('keydown', closeOnEscape);
          document.removeEventListener('click', closeMenu);
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

      // Create custom context menu HTML
      let html = '<div class="murder-board-context-menu">';
      
      // Add color swatches row
      html += `<div style="padding: 8px 12px; border-bottom: 1px solid #444; display: flex; gap: 4px; flex-wrap: wrap;">`;
      for (let colorOpt of colors) {
        const isSelected = colorOpt.hex.toUpperCase() === currentColor.toUpperCase();
        html += `
          <button class="murder-board-connection-color-btn" data-color="${colorOpt.hex}"
                  style="flex: 0 0 30px; height: 30px; padding: 0; cursor: pointer;
                         border: ${isSelected ? '3px solid #333' : '1px solid #ccc'}; 
                         background: ${colorOpt.hex};
                         border-radius: 3px; transition: all 0.2s;"
                  title="${colorOpt.label}">
          </button>
        `;
      }
      html += `</div>`;

      // Add width options
      const widthOptions = [
        { id: 'thin', label: 'Thin', width: 4 },
        { id: 'medium', label: 'Medium', width: 8 },
        { id: 'thick', label: 'Thick', width: 12 },
      ];
      const currentWidth = connection.width || 2;
      html += `<div style="padding: 8px 12px; border-bottom: 1px solid #444; display: flex; gap: 4px;">`;
      for (let widthOpt of widthOptions) {
        const isSelected = currentWidth === widthOpt.width;
        html += `
          <button class="murder-board-connection-width-btn" data-width="${widthOpt.width}"
                  style="flex: 1; padding: 6px 8px; cursor: pointer;
                         border: ${isSelected ? '2px solid #888' : '1px solid #555'}; 
                         background: ${isSelected ? '#444' : '#333'};
                         color: #fff;
                         border-radius: 3px; transition: all 0.2s; font-size: 11px; font-weight: 500;"
                  title="${widthOpt.label}">
            ${widthOpt.label}
          </button>
        `;
      }
      html += `</div>`;

      // Add edit label button
      html += `
        <div class="murder-board-context-edit-label-btn" style="padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; color: #fff; border-bottom: 1px solid #444; background: #333;"
             onmouseover="this.style.backgroundColor='#444'" 
             onmouseout="this.style.backgroundColor='#333'">
          <i class="fas fa-edit" style="color: #fff;"></i>
          <span>Edit Label</span>
        </div>
      `;

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

      // Create a temporary div container
      const menuDiv = document.createElement('div');
      menuDiv.innerHTML = html;
      menuDiv.style.position = 'fixed';
      menuDiv.style.left = pageX + 'px';
      menuDiv.style.top = pageY + 'px';
      menuDiv.style.zIndex = '10000';
      menuDiv.style.backgroundColor = '#2a2a2a';
      menuDiv.style.border = '1px solid #555';
      menuDiv.style.borderRadius = '4px';
      menuDiv.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
      
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

      // Attach color button handlers
      const colorBtns = menuDiv.querySelectorAll('.murder-board-connection-color-btn');
      colorBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newColor = btn.dataset.color;
          self._updateConnectionColor(connection.id, newColor);
        });
      });

      // Attach width button handlers
      const widthBtns = menuDiv.querySelectorAll('.murder-board-connection-width-btn');
      widthBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newWidth = parseInt(btn.dataset.width);
          self._updateConnectionWidth(connection.id, newWidth);
        });
      });

      // Attach edit label button handler
      const editLabelBtn = menuDiv.querySelector('.murder-board-context-edit-label-btn');
      if (editLabelBtn) {
        editLabelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          menuDiv.remove();
          self._showEditConnectionLabelDialog(connection);
        });
      }

      // Attach delete button handler
      const deleteBtn = menuDiv.querySelector('.murder-board-context-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          self._deleteConnection(connection.id);
          menuDiv.remove();
        });
      }

      // Remove menu when clicking elsewhere - close ALL context menus
      const closeMenu = (e) => {
        if (!menuDiv.contains(e.target)) {
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('click', closeMenu);
        }
      };
      document.addEventListener('click', closeMenu);

      // Also close on escape key
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.murder-board-context-menu').forEach(menu => menu.remove());
          document.removeEventListener('keydown', closeOnEscape);
          document.removeEventListener('click', closeMenu);
        }
      };
      document.addEventListener('keydown', closeOnEscape);
    } catch (error) {
      console.error('Murder Board | Error in _showConnectionMenu:', error);
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
      const boardData = MurderBoardData.getBoardData(this.scene);
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
      const boardData = MurderBoardData.getBoardData(this.scene);
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
   * Show dialog to edit connection label
   * @param {Object} connection - Connection object
   */
  _showEditConnectionLabelDialog(connection) {
    const currentLabel = connection.label || '';
    
    // Create dialog content
    const dialogContent = `
      <div style="padding: 12px; min-width: 300px;">
        <div class="form-group">
          <label for="connection-label-input" style="display: block; margin-bottom: 8px; font-weight: bold;">Connection Label</label>
          <input 
            type="text" 
            id="connection-label-input" 
            value="${currentLabel}" 
            placeholder="e.g., Enemy of, Accomplice, Dated, etc."
            style="width: 100%; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 13px;"
            autofocus
          >
          <p style="margin-top: 8px; margin-bottom: 0; font-size: 12px; color: #666;">This label will appear on the connection line</p>
        </div>
      </div>
    `;

    // Create buttons
    const buttons = {
      save: {
        label: 'Save',
        callback: (html) => {
          const newLabel = html.find('#connection-label-input').val() || '';
          this._updateConnectionLabel(connection.id, newLabel);
        }
      },
      cancel: {
        label: 'Cancel'
      }
    };

    // Show dialog
    new Dialog({
      title: 'Edit Connection Label',
      content: dialogContent,
      buttons: buttons,
      default: 'save'
    }).render(true);
  }

  /**
   * Update connection label
   * @param {string} connectionId - Connection ID
   * @param {string} label - New label text
   */
  async _updateConnectionLabel(connectionId, label) {
    try {
      const boardData = MurderBoardData.getBoardData(this.scene);
      const connection = boardData.connections.find(c => c.id === connectionId);

      if (connection) {
        connection.label = label;
        await this._updateBoardConnections(boardData.connections);

        // Emit socket message for multiplayer sync
        if (!game.user.isGM) {
          emitSocketMessage('updateConnection', {
            sceneId: this.scene.id,
            connectionId: connectionId,
            updates: { label: label },
          });
        }

        this.renderer.draw();
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ConnectionUpdated'));
      }
    } catch (error) {
      console.error('Murder Board | Error updating connection label:', error);
      this._notify('Error updating connection label', 'error');
    }
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
   * Show item creation dialog with optional pre-filled coordinates
   * @param {string} itemType - Type of item ('note', 'image', 'document')
   * @param {Object} prefilledCoords - Optional object with x, y coordinates
   */
  async _showItemDialog(itemType, prefilledCoords = null) {
    try {
      let DialogClass;

      if (itemType === 'note') {
        DialogClass = NoteItemDialog;
      } else if (itemType === 'text') {
        DialogClass = TextItemDialog;
      } else if (itemType === 'image') {
        DialogClass = ImageItemDialog;
      } else if (itemType === 'document') {
        DialogClass = DocumentItemDialog;
      } else {
        this._notify('Invalid item type', 'error');
        return;
      }

      // Store prefilled coordinates on the dialog instance
      const dialog = new DialogClass(this.scene, null, { prefilledCoords });
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error showing item dialog:', error);
      this._notify('Error creating item', 'error');
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
    // Only handle Delete key if the board is ready
    if (event.key !== 'Delete' || !this.renderer) {
      return;
    }

    // Don't trigger if user is typing in an input field
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
      return;
    }

    // Check if the Murder Board window is currently visible/focused
    // Use the element to check if it's in the DOM and visible
    if (!this.element || !this.element.closest('body')) {
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
        // Open the item dialog with pre-filled coordinates
        this._openItemDialog(itemType, null, { x: worldCoords.x, y: worldCoords.y });
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
        const boardData = MurderBoardData.getBoardData(this.scene);
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
          font: 'Arial',
          textColor: '#000000',
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
        },
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
      const boardData = MurderBoardData.getBoardData(this.scene);
      
      // Delete items and their associated connections
      for (const itemId of this.selectedItems) {
        // Remove item
        await MurderBoardData.deleteItem(this.scene, itemId);
        
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
    const boardData = MurderBoardData.getBoardData(this.scene);
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
   * Open appropriate dialog for item type
   * @param {string} type - Item type (Note, Image, Document)
   * @param {string} itemId - Optional item ID for editing
   */
  _openItemDialog(type, itemId = null, options = {}) {
    try {
      let DialogClass;

      switch (type) {
        case 'Note':
          DialogClass = NoteItemDialog;
          break;
        case 'Text':
          DialogClass = TextItemDialog;
          break;
        case 'Image':
          DialogClass = ImageItemDialog;
          break;
        case 'Document':
          DialogClass = DocumentItemDialog;
          break;
        default:
          throw new Error(`Unknown item type: ${type}`);
      }

      const dialog = new DialogClass(this.scene, itemId, options);
      dialog.render(true);
    } catch (error) {
      console.error('Murder Board | Error in _openItemDialog:', error);
      this._notify(`Error opening item dialog: ${error.message}`, 'error');
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
  _onToggleCenter() {
    if (!this.renderer) return;

    // Toggle the center visibility
    this.renderer.showCenter = !this.renderer.showCenter;

    // Persist to scene flags
    this.scene.setFlag('murder-board', 'showCenter', this.renderer.showCenter);

    // Update button styling
    const toggleBtn = this.element.querySelector('#toggle-center-btn');
    if (toggleBtn) {
      if (this.renderer.showCenter) {
        toggleBtn.classList.add('active');
      } else {
        toggleBtn.classList.remove('active');
      }
    }

    // Redraw canvas
    this.renderer.draw();

    // Notify user
    const message = this.renderer.showCenter
      ? game.i18n.localize('MURDER_BOARD.Notifications.CenterShown')
      : game.i18n.localize('MURDER_BOARD.Notifications.CenterHidden');
    this._notify(message, 'info');
  }

  /**
   * Open board settings dialog
   */
  async _onBoardSettings() {
    // Only GMs can manage permissions
    if (!game.user.isGM) {
      this._notify('Only GMs can manage board settings', 'warn');
      return;
    }

    const boardData = MurderBoardData.getBoardData(this.scene);
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
   * Delete an item
   * @param {string} itemId
   */
  async _deleteItem(itemId) {
    const success = await MurderBoardData.deleteItem(this.scene, itemId);

    if (success) {
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
   */
  async _onImportBoard() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        try {
          const file = e.target.files[0];
          if (!file) return resolve();
          
          const text = await file.text();
          const data = JSON.parse(text);
          
          // Validate data structure
          if (!data.items || !Array.isArray(data.items)) {
            throw new Error('Invalid board data format');
          }
          
          // Import the board data
          await MurderBoardData.importBoard(this.scene, data);
          
          // Emit socket message for multiplayer sync
          if (!game.user.isGM) {
            emitSocketMessage('importBoard', {
              sceneId: this.scene.id,
              data: data,
            });
          }
          
          this.renderer.refresh();
          this.renderer.draw();
          this._notify(game.i18n.localize('MURDER_BOARD.Notifications.BoardImported'));
          resolve();
        } catch (error) {
          console.error('Error importing board:', error);
          this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ImportFailed'), 'error');
          resolve();
        }
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
      const boardData = MurderBoardData.getBoardData(this.scene);
      boardData.items = items;
      await MurderBoardData.saveBoardData(this.scene, boardData);
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
      const boardData = MurderBoardData.getBoardData(this.scene);
      boardData.connections = connections;
      await MurderBoardData.saveBoardData(this.scene, boardData);
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
    
    // Simply switch to the selected board by updating currentBoardId
    await MurderBoardData._setFlag(this.scene, 'currentBoardId', selectedBoardId);
    
    // Refresh the application to show new board
    await this.render();
  }

  /**
   * Action: Create new board
   */
  async _onNewBoard() {
    if (!MurderBoardData.canUserEdit(this.scene)) {
      this._notify(game.i18n.localize('MURDER_BOARD.Notifications.CannotEdit'), 'warn');
      return;
    }

    // Create a new board with unique ID
    const boardId = foundry.utils.randomID();
    const boardType = game.settings.get('murder-board', 'defaultBoardType');
    
    // Get all boards and add new one
    const allBoards = MurderBoardData.getAllBoards(this.scene) || [];
    const newBoard = {
      id: boardId,
      name: `Board ${allBoards.length + 1}`,
      boardType: boardType,
      defaultConnectionColor: MurderBoardData.getDefaultConnectionColorForBoardType(boardType),
      items: [],
      connections: [],
      camera: { x: 0, y: 0, zoom: 1 },
    };
    
    allBoards.push(newBoard);
    
    // Save all boards and switch to new one
    await MurderBoardData.setAllBoards(this.scene, allBoards);
    await this.scene.setFlag('murder-board', 'currentBoardId', boardId);
    
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
      // Click handler - opens dialog immediately
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const type = button.dataset.type;
        this.parentApp._openItemDialog(type);
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
    const boardData = MurderBoardData.getBoardData(this.scene);
    const permissions = MurderBoardData.getPermissions(this.scene);

    let playerCheckboxes = '';
    game.users.forEach((user) => {
      if (!user.isGM) {
        const isRestricted = permissions.restrictedPlayers?.includes(user.id);
        const checkId = `restrict-player-${user.id}`;
        playerCheckboxes += `
          <label class="checkbox-label">
            <input type="checkbox" id="${checkId}" name="restricted-player" value="${user.id}" ${isRestricted ? 'checked' : ''} />
            ${user.name}
          </label>
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
      allowPlayersToEdit: permissions.allowPlayersToEdit || false,
      playerCheckboxes: playerCheckboxes,
      canDeleteBoard: MurderBoardData.getAllBoards(this.scene).length > 1,
      defaultConnectionColor: boardData.defaultConnectionColor || '#000000',
      canvasColor: boardData.canvasColor || MurderBoardData.getDefaultCanvasColorForBoardType(boardData.boardType || 'whiteboard'),
      connectionColors: colorOptions,
      backgroundImage: boardData.backgroundImage || '',
      backgroundMode: boardData.backgroundMode || 'content',
      backgroundScale: boardData.backgroundScale || 1.0,
      recentColors: window.game.murderBoard.ColorManager.getColorPalette(),
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

    const exportBtn = content.querySelector('[data-action="export"]');
    const importBtn = content.querySelector('[data-action="import"]');
    const saveBtn = content.querySelector('[data-action="save"]');
    const deleteBtn = content.querySelector('[data-action="delete"]');
    const cancelBtn = content.querySelector('[data-action="cancel"]');

    if (exportBtn) {
      exportBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await this.parentApp._onExportBoard();
      });
    }

    if (importBtn) {
      importBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await this.parentApp._onImportBoard();
      });
    }

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
  }

  async _handleSave() {
    const content = this.element.querySelector('.window-content');
    if (!content) return;

    const boardName = content.querySelector('#board-name')?.value;
    const allowPlayersToEdit = content.querySelector('#allow-players-edit')?.checked;
    const restrictedPlayerCheckboxes = content.querySelectorAll('input[name="restricted-player"]:checked');
    const restrictedPlayers = Array.from(restrictedPlayerCheckboxes).map(cb => cb.value);
    
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

    const boardData = MurderBoardData.getBoardData(this.scene);
    boardData.name = boardName;
    boardData.canvasColor = canvasColor;
    boardData.backgroundImage = backgroundImage;
    boardData.backgroundScale = parseFloat(content.querySelector('#background-scale')?.value) || 1.0;
    
    if (defaultConnectionColor) {
      boardData.defaultConnectionColor = defaultConnectionColor;
      window.game.murderBoard.ColorManager.addColorToPalette(defaultConnectionColor);
    }
    if (canvasColor) {
      window.game.murderBoard.ColorManager.addColorToPalette(canvasColor);
    }

    await MurderBoardData.saveBoardData(this.scene, boardData);

    await MurderBoardData.updatePermissions(this.scene, {
      allowPlayersToEdit,
      restrictedPlayers,
    });

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
    const boardData = MurderBoardData.getBoardData(this.scene);
    const allBoards = MurderBoardData.getAllBoards(this.scene);

    if (allBoards.length <= 1) {
      ui.notifications.warn('Cannot delete the only board');
      return;
    }

    // Confirmation dialog
    Dialog.confirm({
      title: 'Delete Board',
      content: `<p>Are you sure you want to delete "${boardData.name || 'Untitled Board'}"? This cannot be undone.</p>`,
      yes: async () => {
        const success = await MurderBoardData.deleteBoard(this.scene, boardData.id);
        if (success) {
          ui.notifications.info('Board deleted');
          await this.parentApp.render();
          this.close();
        } else {
          this._notify('Failed to delete board', 'error');
        }
      },
      no: () => {},
    });
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
      const picker = new FilePicker(pickerOptions);
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


}
