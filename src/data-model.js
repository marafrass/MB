/**
 * Murder Board Data Model
 * Manages scene flag structure and operations for items and connections
 */

export class MurderBoardData {
  // Static camera cache - stores per-user, per-scene camera state in memory
  static cameraCache = new Map();
  
  // Track which board folders have been attempted to avoid repeated API calls
  static _folderCreationAttempts = new Set();

  /**
   * Get the default connection color for a board type
   * @param {string} boardType - The board type (whiteboard, blackboard, chalkboard, corkboard)
   * @returns {string} The hex color code
   */
  static getDefaultConnectionColorForBoardType(boardType) {
    const colorMap = {
      'whiteboard': '#000000',    // Black
      'blackboard': '#FFFFFF',    // White
      'chalkboard': '#FFFF00',    // Yellow
      'corkboard': '#FF0000',     // Red
    };
    return colorMap[boardType] || '#000000'; // Default to black
  }

  /**
   * Get the default canvas color for a board type
   * @param {string} boardType - The board type (whiteboard, blackboard, chalkboard, corkboard)
   * @returns {string} The hex color code
   */
  static getDefaultCanvasColorForBoardType(boardType) {
    const colorMap = {
      'whiteboard': '#f5f5f5',    // Light gray
      'blackboard': '#1a1a1a',    // Dark gray/black
      'chalkboard': '#2d5016',    // Dark green
      'corkboard': '#c9a876',     // Tan/cork color
    };
    return colorMap[boardType] || '#f5f5f5'; // Default to light gray
  }

  /**
   * Internal method to set a flag - handles both GM and player updates
   * Players route through socket to GM, GMs update directly
   * @param {Scene} scene - The scene
   * @param {string} key - The flag key
   * @param {any} value - The value to set
   * @private
   */
  static async _setFlag(scene, key, value) {
    if (game.user.isGM) {
      // GM can update directly
      await scene.setFlag('murder-board', key, value);
    } else {
      // Players route through socket
      const { emitSocketMessage } = await import('./socket-handler.js');
      emitSocketMessage('updateFlag', {
        sceneId: scene.id,
        key: key,
        value: value,
      });
    }
  }

  /**
   * Initialize a new Murder Board for a scene
   * @param {Scene} scene - The scene to initialize the board for
   */
  static async initializeBoard(scene) {
    const flags = scene.flags['murder-board'] || {};
    
    if (!flags.items) flags.items = [];
    if (!flags.connections) flags.connections = [];
    if (!flags.boardType) flags.boardType = game.settings.get('murder-board', 'defaultBoardType');
    if (!flags.camera) {
      // Default camera position and zoom
      flags.camera = {
        x: 0,
        y: 0,
        zoom: 1,
      };
    }
    if (!flags.permissions) {
      // Default permissions: all players can edit
      flags.permissions = {
        allowPlayersToEdit: true,
        restrictedPlayers: [], // Array of user IDs to restrict
      };
    }

    // Batch all flag updates into a single scene.update() call
    await scene.update({
      flags: {
        'murder-board': {
          items: flags.items,
          connections: flags.connections,
          boardType: flags.boardType,
          camera: flags.camera,
          permissions: flags.permissions,
        },
      },
    });
  }

  /**
   * Get board data from scene flags
   * @param {Scene} scene - The scene to get board data from
   * @returns {Object} Object containing items and connections
   */
  static getBoardData(scene) {
    const flags = scene.flags['murder-board'] || {};
    const currentBoardId = flags.currentBoardId;
    const boards = flags.boards || [];
    
    // Get current board or create a default one if none exists
    let currentBoard = boards.find(b => b.id === currentBoardId);
    if (!currentBoard && boards.length > 0) {
      currentBoard = boards[0];
    } else if (!currentBoard) {
      // Create a default board if none exist
      const defaultBoardType = flags.boardType || 'whiteboard';
      currentBoard = {
        id: foundry.utils.randomID(),
        name: 'Default Board',
        items: [],
        connections: [],
        boardType: defaultBoardType,
        defaultConnectionColor: this.getDefaultConnectionColorForBoardType(defaultBoardType),
        camera: { x: 0, y: 0, zoom: 1 },
      };
    }
    
    const boardType = currentBoard.boardType || 'whiteboard';
    const boardData = {
      id: currentBoard.id,
      name: currentBoard.name || 'Untitled Board',
      items: currentBoard.items || [],
      connections: currentBoard.connections || [],
      boardType: boardType,
      defaultConnectionColor: currentBoard.defaultConnectionColor || this.getDefaultConnectionColorForBoardType(boardType),
      canvasColor: currentBoard.canvasColor || this.getDefaultCanvasColorForBoardType(boardType),
      camera: currentBoard.camera || { x: 0, y: 0, zoom: 1 },
      backgroundImage: currentBoard.backgroundImage || null,
      backgroundScale: currentBoard.backgroundScale || 1.0,
      permissions: flags.permissions || { allowPlayersToEdit: true, restrictedPlayers: [] },
    };
    
    // Only ensure board folder exists if the board has been explicitly saved to the scene
    // (i.e., the boards array is actually stored in flags, not just a temporary default)
    if (flags.boards && flags.boards.length > 0) {
      if (!this._folderCreationAttempts.has(boardData.id)) {
        this._folderCreationAttempts.add(boardData.id);
        this._ensureBoardFolder(boardData.id).catch(() => {
          // Folder creation failed - this is expected in some cases
          // Drag-and-drop upload will handle creation when files are dropped
        });
      }
    }
    
    return boardData;
  }

  /**
   * Ensure a board folder exists in the data directory
   * @param {string} boardId - The board ID
   * @private
   */
  static async _ensureBoardFolder(boardId) {
    try {
      // First, ensure the parent boards directory exists
      const parentPath = 'murder-board-uploads';
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', parentPath);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      
      // Then create the board-specific folder
      const boardFolderPath = `murder-board-uploads/${boardId}`;
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', boardFolderPath);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    } catch (error) {
      // Folder creation failed - this is non-critical for board functionality
      // Just log and continue - uploads will handle folder creation as needed
      throw error;
    }
  }

  /**
   * Get all items for a scene
   * @param {Scene} scene - The scene
   * @returns {Array} Array of item objects
   */
  static getItems(scene) {
    const boardData = this.getBoardData(scene);
    return boardData.items || [];
  }

  /**
   * Get a single item by ID
   * @param {Scene} scene - The scene
   * @param {string} itemId - The item ID
   * @returns {Object|null} The item object or null if not found
   */
  static getItem(scene, itemId) {
    const items = this.getItems(scene);
    return items.find(item => item.id === itemId) || null;
  }

  /**
   * Add a new item to the board
   * @param {Scene} scene - The scene
   * @param {Object} itemData - Object with type, label, x, y, color, data
   * @returns {Object} The created item with generated ID
   */
  static async addItem(scene, itemData) {
    if (!this.validateItemData(itemData)) {
      throw new Error('Invalid item data provided');
    }

    const boardData = this.getBoardData(scene);
    const items = boardData.items || [];
    
    const newItem = {
      id: foundry.utils.randomID(),
      type: itemData.type,
      label: itemData.label || '',
      x: itemData.x || 0,
      y: itemData.y || 0,
      color: itemData.color || '#FFFFFF', // Default to white
      rotation: itemData.rotation || 0, // Rotation in degrees
      data: itemData.data || {},
      acceptsConnections: itemData.acceptsConnections !== false, // Default to true
      createdAt: new Date().toISOString(),
    };

    const updatedItems = [...items, newItem];
    boardData.items = updatedItems;
    
    // Save the updated board
    await this.saveBoardData(scene, boardData);
    
    return newItem;
  }

  /**
   * Update an existing item
   * @param {Scene} scene - The scene
   * @param {string} itemId - The item ID to update
   * @param {Object} updates - Object with fields to update
   * @returns {Object|null} The updated item or null if not found
   */
  static async updateItem(scene, itemId, updates) {
    const boardData = this.getBoardData(scene);
    const items = boardData.items || [];
    const itemIndex = items.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
      console.warn('Murder Board | Item not found:', itemId);
      return null;
    }

    // Create a NEW array with the updated item
    const updatedItems = items.map((item, index) => {
      if (index === itemIndex) {
        return {
          ...item,
          ...updates,
          id: itemId, // Prevent ID changes
          createdAt: item.createdAt, // Preserve creation date
          updatedAt: new Date().toISOString(),
        };
      }
      return item;
    });

    boardData.items = updatedItems;
    await this.saveBoardData(scene, boardData);
    
    return updatedItems[itemIndex];
  }

  /**
   * Delete an item by ID
   * @param {Scene} scene - The scene
   * @param {string} itemId - The item ID to delete
   * @returns {boolean} Whether deletion was successful
   */
  static async deleteItem(scene, itemId) {
    const boardData = this.getBoardData(scene);
    const items = boardData.items || [];
    const filteredItems = items.filter(item => item.id !== itemId);

    if (filteredItems.length === items.length) return false; // Item not found

    // Also delete connections associated with this item
    const connections = boardData.connections || [];
    const filteredConnections = connections.filter(
      conn => conn.fromItem !== itemId && conn.toItem !== itemId
    );

    boardData.items = filteredItems;
    boardData.connections = filteredConnections;
    await this.saveBoardData(scene, boardData);
    return true;
  }

  /**
   * Get all connections for a scene
   * @param {Scene} scene - The scene
   * @returns {Array} Array of connection objects
   */
  static getConnections(scene) {
    const boardData = this.getBoardData(scene);
    return boardData.connections || [];
  }

  /**
   * Get a single connection by ID
   * @param {Scene} scene - The scene
   * @param {string} connectionId - The connection ID
   * @returns {Object|null} The connection object or null if not found
   */
  static getConnection(scene, connectionId) {
    const connections = this.getConnections(scene);
    return connections.find(conn => conn.id === connectionId) || null;
  }

  /**
   * Add a new connection between two items
   * @param {Scene} scene - The scene
   * @param {string} fromItemId - Source item ID
   * @param {string} toItemId - Target item ID
   * @param {Object} connectionData - Object with color, label
   * @returns {Object} The created connection with generated ID
   */
  static async addConnection(scene, fromItemId, toItemId, connectionData = {}) {
    // Validate items exist
    const fromItem = this.getItem(scene, fromItemId);
    const toItem = this.getItem(scene, toItemId);
    
    if (!fromItem || !toItem) {
      throw new Error('One or both items do not exist');
    }

    // Check if items accept connections
    if (fromItem.acceptsConnections === false) {
      throw new Error('From item does not accept connections');
    }
    if (toItem.acceptsConnections === false) {
      throw new Error('To item does not accept connections');
    }

    // Prevent self-connections
    if (fromItemId === toItemId) {
      throw new Error('Cannot create connection from item to itself');
    }

    const boardData = this.getBoardData(scene);
    const connections = boardData.connections || [];
    // Use board's default connection color if not specified
    const defaultColor = boardData.defaultConnectionColor || this.getDefaultConnectionColorForBoardType(boardData.boardType);
    const newConnection = {
      id: foundry.utils.randomID(),
      fromItem: fromItemId,
      toItem: toItemId,
      color: connectionData.color || defaultColor,
      label: connectionData.label || '',
      width: connectionData.width || 8, // Medium width by default
      createdAt: new Date().toISOString(),
    };

    const updatedConnections = [...connections, newConnection];
    boardData.connections = updatedConnections;
    await this.saveBoardData(scene, boardData);
    return newConnection;
  }

  /**
   * Update an existing connection
   * @param {Scene} scene - The scene
   * @param {string} connectionId - The connection ID to update
   * @param {Object} updates - Object with fields to update
   * @returns {Object|null} The updated connection or null if not found
   */
  static async updateConnection(scene, connectionId, updates) {
    const boardData = this.getBoardData(scene);
    const connections = boardData.connections || [];
    const connIndex = connections.findIndex(conn => conn.id === connectionId);

    if (connIndex === -1) return null;

    const updatedConnections = connections.map((conn, index) => {
      if (index === connIndex) {
        return {
          ...conn,
          ...updates,
          id: connectionId, // Prevent ID changes
          fromItem: conn.fromItem, // Prevent endpoint changes
          toItem: conn.toItem,
          createdAt: conn.createdAt, // Preserve creation date
          updatedAt: new Date().toISOString(),
        };
      }
      return conn;
    });

    boardData.connections = updatedConnections;
    await this.saveBoardData(scene, boardData);
    return updatedConnections[connIndex];
  }

  /**
   * Delete a connection by ID
   * @param {Scene} scene - The scene
   * @param {string} connectionId - The connection ID to delete
   * @returns {boolean} Whether deletion was successful
   */
  static async deleteConnection(scene, connectionId) {
    const boardData = this.getBoardData(scene);
    const connections = boardData.connections || [];
    const filteredConnections = connections.filter(conn => conn.id !== connectionId);

    if (filteredConnections.length === connections.length) return false; // Connection not found

    boardData.connections = filteredConnections;
    await this.saveBoardData(scene, boardData);
    return true;
  }

  /**
   * Get connections for a specific item (both incoming and outgoing)
   * @param {Scene} scene - The scene
   * @param {string} itemId - The item ID
   * @returns {Array} Array of connections involving this item
   */
  static getItemConnections(scene, itemId) {
    const connections = this.getConnections(scene);
    return connections.filter(conn => conn.fromItem === itemId || conn.toItem === itemId);
  }

  /**
   * Validate item data structure
   * @param {Object} itemData - Item data to validate
   * @returns {boolean} Whether data is valid
   */
  static validateItemData(itemData) {
    if (!itemData.type || !['Note', 'Image', 'Document', 'Text'].includes(itemData.type)) {
      console.warn('Invalid item type:', itemData.type);
      return false;
    }

    if (typeof itemData.x !== 'number' || typeof itemData.y !== 'number') {
      console.warn('Invalid item coordinates');
      return false;
    }

    return true;
  }

  /**
   * Clear all board data from a scene
   * @param {Scene} scene - The scene
   */
  static async clearBoard(scene) {
    const boardData = this.getBoardData(scene);
    boardData.items = [];
    boardData.connections = [];
    await this.saveBoardData(scene, boardData);
  }

  /**
   * Update board-level settings
   * @param {Scene} scene - The scene
   * @param {Object} updates - Object with boardType, etc.
   */
  static async updateBoardData(scene, updates) {
    const flags = scene.flags['murder-board'] || {};
    
    if (updates.boardType !== undefined) {
      await this._setFlag(scene, 'boardType', updates.boardType);
    }
  }

  /**
   * Export board data as JSON
   * @param {Scene} scene - The scene
   * @returns {Object} Board data object
   */
  static exportBoard(scene) {
    const boardData = this.getBoardData(scene);
    return {
      version: '1.0.0',
      boardType: boardData.boardType,
      items: boardData.items,
      connections: boardData.connections,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Import board data from JSON
   * @param {Scene} scene - The scene to import into
   * @param {Object} data - Exported board data
   * @returns {boolean} Whether import was successful
   */
  static async importBoard(scene, data) {
    try {
      if (!Array.isArray(data.items) || !Array.isArray(data.connections)) {
        throw new Error('Invalid board data structure');
      }

      await this._setFlag(scene, 'boardType', data.boardType || 'whiteboard');
      await this._setFlag(scene, 'items', data.items);
      await this._setFlag(scene, 'connections', data.connections);
      return true;
    } catch (error) {
      console.error('Murder Board | Import failed:', error);
      return false;
    }
  }

  /**
   * Get camera state (position and zoom)
   * @param {Scene} scene - The scene
   * @returns {Object} Camera object with x, y, zoom
   */
  static getCameraState(scene) {
    // Camera state is stored in-memory per user, per scene
    const cacheKey = `${game.user.id}-${scene.id}`;
    const cached = this.cameraCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    // Return default if not cached
    return { x: 0, y: 0, zoom: 1 };
  }

  /**
   * Save camera state to in-memory cache
   * @param {Scene} scene - The scene
   * @param {Object} camera - Camera object with x, y, zoom
   */
  static async saveCameraState(scene, camera) {
    try {
      // Camera state is stored in-memory per user (not synced across clients)
      const cacheKey = `${game.user.id}-${scene.id}`;
      const cameraData = {
        x: camera.x,
        y: camera.y,
        zoom: camera.zoom,
      };
      this.cameraCache.set(cacheKey, cameraData);
    } catch (error) {
      console.error('Murder Board | Error saving camera state:', error);
    }
  }

  /**
   * Check if current user can edit the board
   * @param {Scene} scene - The scene
   * @returns {boolean} True if user can edit
   */
  static canUserEdit(scene) {
    // GMs always can edit
    if (game.user.isGM) return true;
    
    const flags = scene.flags['murder-board'] || {};
    const permissions = flags.permissions || { allowPlayersToEdit: true, restrictedPlayers: [] };
    
    // Check if player is in restricted list
    if (permissions.restrictedPlayers?.includes(game.user.id)) {
      return false;
    }
    
    // Check if editing is allowed for players
    return permissions.allowPlayersToEdit !== false;
  }

  /**
   * Get permissions for the board
   * @param {Scene} scene - The scene
   * @returns {Object} Permissions object
   */
  static getPermissions(scene) {
    const flags = scene.flags['murder-board'] || {};
    return flags.permissions || { allowPlayersToEdit: true, restrictedPlayers: [] };
  }

  /**
   * Get all boards for a scene
   * @param {Scene} scene - The scene
   * @returns {Array} Array of board objects
   */
  static getAllBoards(scene) {
    const flags = scene.flags['murder-board'] || {};
    return flags.boards || [];
  }

  /**
   * Set all boards for a scene
   * @param {Scene} scene - The scene
   * @param {Array} boards - Array of board objects
   */
  static async setAllBoards(scene, boards) {
    await this._setFlag(scene, 'boards', boards);
  }

  /**
   * Save board data back to scene flags
   * @param {Scene} scene - The scene
   * @param {Object} boardData - The board data to save
   */
  static async saveBoardData(scene, boardData) {
    const flags = scene.flags['murder-board'] || {};
    const boards = flags.boards || [];
    const boardIndex = boards.findIndex(b => b.id === boardData.id);
    
    if (boardIndex !== -1) {
      // Update existing board
      boards[boardIndex] = {
        ...boards[boardIndex],
        ...boardData,
      };
    } else {
      // Add new board
      boards.push(boardData);
    }
    
    await this._setFlag(scene, 'boards', boards);
    await this._setFlag(scene, 'currentBoardId', boardData.id);
  }

  /**
   * Delete a board by ID
   * @param {Scene} scene - The scene
   * @param {string} boardId - The board ID to delete
   * @returns {boolean} Whether deletion was successful
   */
  static async deleteBoard(scene, boardId) {
    const flags = scene.flags['murder-board'] || {};
    const boards = flags.boards || [];
    const filteredBoards = boards.filter(b => b.id !== boardId);

    if (filteredBoards.length === boards.length) return false; // Board not found

    // Switch to first remaining board if we deleted the current one
    let newCurrentBoardId = flags.currentBoardId;
    if (newCurrentBoardId === boardId && filteredBoards.length > 0) {
      newCurrentBoardId = filteredBoards[0].id;
    }

    await this._setFlag(scene, 'boards', filteredBoards);
    if (newCurrentBoardId !== boardId) {
      await this._setFlag(scene, 'currentBoardId', newCurrentBoardId);
    }
    return true;
  }

  /**
   * Update permissions for the board
   * @param {Scene} scene - The scene
   * @param {Object} permissions - New permissions object
   */
  static async updatePermissions(scene, permissions) {
    await this._setFlag(scene, 'permissions', permissions);
  }

  /**
   * Update the default connection color for the current board
   * @param {Scene} scene - The scene
   * @param {string} color - The new default connection color (hex code)
   */
  static async updateBoardDefaultConnectionColor(scene, color) {
    const boardData = this.getBoardData(scene);
    boardData.defaultConnectionColor = color;
    await this.saveBoardData(scene, boardData);
  }
}
