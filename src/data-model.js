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
      // Default permissions: all players can edit and view
      flags.permissions = {
        allowPlayersToEdit: true,
        restrictedPlayers: [], // Array of user IDs restricted from editing
        allowPlayersToView: true,
        restrictedViewers: [], // Array of user IDs restricted from viewing
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
      defaultConnectionSize: currentBoard.defaultConnectionSize || 5,
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
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @returns {Array} Array of item objects
   */
  static getItems(scene) {
    const boardData = this.getGlobalBoardData();
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
    const found = items.find(item => item.id === itemId) || null;
    if (!found) {
      console.warn(`Murder Board | Item not found: ${itemId}. Total items: ${items.length}`);
      console.warn('Murder Board | Available item IDs:', items.map(i => i.id));
    } else {
      console.debug(`Murder Board | Found item ${itemId}:`, found);
    }
    return found;
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

    const boardData = this.getGlobalBoardData();
    const items = boardData.items || [];
    
    // Calculate max z-index to ensure new items appear on top
    const maxZIndex = items.reduce((max, item) => Math.max(max, item.zIndex || 0), 0);
    
    const newItem = {
      id: foundry.utils.randomID(),
      type: itemData.type,
      label: itemData.label || '',
      x: itemData.x || 0,
      y: itemData.y || 0,
      color: itemData.color || '#FFFFFF', // Default to white
      rotation: itemData.rotation || 0, // Rotation in degrees
      zIndex: maxZIndex + 1, // Place on top of existing items
      data: itemData.data || {},
      acceptsConnections: itemData.acceptsConnections !== false, // Default to true
      createdAt: new Date().toISOString(),
    };

    const updatedItems = [...items, newItem];
    boardData.items = updatedItems;
    
    // Save the updated board
    await this.saveGlobalBoardData(boardData);
    
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
    const boardData = this.getGlobalBoardData();
    const items = boardData.items || [];
    const itemIndex = items.findIndex(item => item.id === itemId);

    if (itemIndex === -1) {
      console.warn('Murder Board | Item not found:', itemId);
      return null;
    }

    // Create a NEW array with the updated item
    const updatedItems = items.map((item, index) => {
      if (index === itemIndex) {
        // Deep merge the data object if it's being updated
        const mergedItem = {
          ...item,
          ...updates,
          id: itemId, // Prevent ID changes
          createdAt: item.createdAt, // Preserve creation date
          updatedAt: new Date().toISOString(),
        };
        
        // If data is being updated, merge it with existing data instead of replacing
        if (updates.data && item.data) {
          mergedItem.data = {
            ...item.data,
            ...updates.data,
          };
        }
        
        return mergedItem;
      }
      return item;
    });

    boardData.items = updatedItems;
    await this.saveGlobalBoardData(boardData);
    
    return updatedItems[itemIndex];
  }

  /**
   * Delete an item by ID
   * @param {Scene} scene - The scene
   * @param {string} itemId - The item ID to delete
   * @returns {boolean} Whether deletion was successful
   */
  static async deleteItem(scene, itemId) {
    const boardData = this.getGlobalBoardData();
    const items = boardData.items || [];
    const itemToDelete = items.find(i => i.id === itemId);
    const filteredItems = items.filter(item => item.id !== itemId);

    if (filteredItems.length === items.length) return false; // Item not found

    // Also delete connections associated with this item
    const connections = boardData.connections || [];
    const filteredConnections = connections.filter(
      conn => conn.fromItem !== itemId && conn.toItem !== itemId
    );

    // If item was part of a group, remove it from the group
    if (itemToDelete && itemToDelete.groupId && boardData.groups) {
      const group = boardData.groups.find(g => g.id === itemToDelete.groupId);
      if (group) {
        group.items = group.items.filter(id => id !== itemId);
        // If group is now empty, remove the group entirely
        if (group.items.length === 0) {
          boardData.groups = boardData.groups.filter(g => g.id !== itemToDelete.groupId);
        }
      }
    }

    boardData.items = filteredItems;
    boardData.connections = filteredConnections;
    await this.saveGlobalBoardData(boardData);
    return true;
  }

  /**
   * Bring an item to the front (highest z-index)
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @param {string} itemId - The item ID to bring to front
   */
  static async bringToFront(scene, itemId) {
    try {
      const boardData = this.getGlobalBoardData();
      const items = boardData.items || [];
      
      const item = items.find(i => i.id === itemId);
      if (!item) {
        console.warn(`Murder Board | Item not found for bringToFront: ${itemId}`);
        return false;
      }
      
      // If item is in a group, move the group instead
      if (item.groupId) {
        return this.bringGroupToFront(item.groupId);
      }
      
      // Find max z-index and set this item to max + 1
      const maxZIndex = items.reduce((max, item) => Math.max(max, item.zIndex || 0), 0);
      const newZIndex = maxZIndex + 1;
      
      const updatedItems = items.map(itm => {
        if (itm.id === itemId) {
          return { ...itm, zIndex: newZIndex };
        }
        return itm;
      });

      boardData.items = updatedItems;
      await this.saveGlobalBoardData(boardData);
      console.log(`Murder Board | Brought item ${itemId} to front: zIndex ${newZIndex}`);
      return true;
    } catch (error) {
      console.error(`Murder Board | Error in bringToFront:`, error);
      return false;
    }
  }

  /**
   * Bring an item forward one layer
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @param {string} itemId - The item ID to bring forward
   * @returns {boolean} True if successful, false otherwise
   */
  static async bringForward(scene, itemId) {
    try {
      const boardData = this.getGlobalBoardData();
      const items = boardData.items || [];
      
      const item = items.find(i => i.id === itemId);
      if (!item) {
        console.warn(`Murder Board | Item not found for bringForward: ${itemId}`);
        return false;
      }
      
      // If item is in a group, move the group instead
      if (item.groupId) {
        return this.bringGroupToFront(item.groupId);
      }

      const itemIndex = items.findIndex(item => item.id === itemId);
      if (itemIndex === -1) return false;
      
      const currentItem = items[itemIndex];
      const currentZIndex = currentItem.zIndex || 0;
      
      // Find the next higher z-index among other items
      const higherZIndices = items
        .filter((item, index) => index !== itemIndex && (item.zIndex || 0) > currentZIndex)
        .map(item => item.zIndex || 0)
        .sort((a, b) => a - b);
      
      let newZIndex;
      if (higherZIndices.length > 0) {
        // Move to just above the next item
        newZIndex = higherZIndices[0] + 0.5;
      } else {
        // No items above, just increment by 1
        const maxZIndex = items.reduce((max, item) => Math.max(max, item.zIndex || 0), 0);
        newZIndex = maxZIndex + 1;
      }
      
      const updatedItems = items.map(item => {
        if (item.id === itemId) {
          return { ...item, zIndex: newZIndex };
        }
        return item;
      });

      boardData.items = updatedItems;
      await this.saveGlobalBoardData(boardData);
      console.log(`Murder Board | Brought item ${itemId} forward: zIndex ${newZIndex}`);
      return true;
    } catch (error) {
      console.error(`Murder Board | Error in bringForward:`, error);
      return false;
    }
  }

  /**
   * Send an item to the back (lowest z-index)
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @param {string} itemId - The item ID to send to back
   * @returns {boolean} True if successful, false otherwise
   */
  static async sendToBack(scene, itemId) {
    try {
      const boardData = this.getGlobalBoardData();
      const items = boardData.items || [];
      
      const item = items.find(i => i.id === itemId);
      if (!item) {
        console.warn(`Murder Board | Item not found for sendToBack: ${itemId}`);
        return false;
      }
      
      // If item is in a group, move the group instead
      if (item.groupId) {
        return this.sendGroupToBack(item.groupId);
      }
      
      // Find min z-index and set this item to min - 1
      const minZIndex = items.reduce((min, item) => Math.min(min, item.zIndex || 0), 0);
      const newZIndex = minZIndex - 1;
      
      const updatedItems = items.map(item => {
        if (item.id === itemId) {
          return { ...item, zIndex: newZIndex };
        }
        return item;
      });

      boardData.items = updatedItems;
      await this.saveGlobalBoardData(boardData);
      console.log(`Murder Board | Sent item ${itemId} to back: zIndex ${newZIndex}`);
      return true;
    } catch (error) {
      console.error(`Murder Board | Error in sendToBack:`, error);
      return false;
    }
  }

  /**
   * Send an item backward one layer
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @param {string} itemId - The item ID to send backward
   * @returns {boolean} True if successful, false otherwise
   */
  static async sendBackward(scene, itemId) {
    try {
      const boardData = this.getGlobalBoardData();
      const items = boardData.items || [];
      
      const item = items.find(i => i.id === itemId);
      if (!item) {
        console.warn(`Murder Board | Item not found for sendBackward: ${itemId}`);
        return false;
      }
      
      // If item is in a group, move the group instead
      if (item.groupId) {
        return this.sendGroupToBack(item.groupId);
      }

      const itemIndex = items.findIndex(item => item.id === itemId);
      if (itemIndex === -1) return false;
      
      const currentItem = items[itemIndex];
      const currentZIndex = currentItem.zIndex || 0;
      
      // Find the next lower z-index among other items
      const lowerZIndices = items
        .filter((item, index) => index !== itemIndex && (item.zIndex || 0) < currentZIndex)
        .map(item => item.zIndex || 0)
        .sort((a, b) => b - a);
      
      let newZIndex;
      if (lowerZIndices.length > 0) {
        // Move to just below the next item
        newZIndex = lowerZIndices[0] - 0.5;
      } else {
        // No items below, just decrement by 1
        const minZIndex = items.reduce((min, item) => Math.min(min, item.zIndex || 0), 0);
        newZIndex = minZIndex - 1;
      }
      
      const updatedItems = items.map(item => {
        if (item.id === itemId) {
          return { ...item, zIndex: newZIndex };
        }
        return item;
      });

      boardData.items = updatedItems;
      await this.saveGlobalBoardData(boardData);
      console.log(`Murder Board | Sent item ${itemId} backward: zIndex ${newZIndex}`);
      return true;
    } catch (error) {
      console.error(`Murder Board | Error in sendBackward:`, error);
      return false;
    }
  }

  /**
   * Get all connections for a scene
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @returns {Array} Array of connection objects
   */
  static getConnections(scene) {
    const boardData = this.getGlobalBoardData();
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
   * @param {Object} connectionData - Object with color
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

    const boardData = this.getGlobalBoardData();
    const connections = boardData.connections || [];
    
    // Check for duplicate connections (both directions)
    const duplicateExists = connections.some(conn => 
      (conn.fromItem === fromItemId && conn.toItem === toItemId) ||
      (conn.fromItem === toItemId && conn.toItem === fromItemId)
    );
    
    if (duplicateExists) {
      throw new Error('A connection already exists between these items');
    }

    // Use board's default connection color and size if not specified
    const defaultColor = boardData.defaultConnectionColor || this.getDefaultConnectionColorForBoardType(boardData.boardType);
    const defaultSize = boardData.defaultConnectionSize || 5;
    const newConnection = {
      id: foundry.utils.randomID(),
      fromItem: fromItemId,
      toItem: toItemId,
      color: connectionData.color || defaultColor,

      width: connectionData.width || defaultSize,
      createdAt: new Date().toISOString(),
    };

    const updatedConnections = [...connections, newConnection];
    boardData.connections = updatedConnections;
    await this.saveGlobalBoardData(boardData);
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
    const boardData = this.getGlobalBoardData();
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
    await this.saveGlobalBoardData(boardData);
    return updatedConnections[connIndex];
  }

  /**
   * Delete a connection by ID
   * @param {Scene} scene - The scene
   * @param {string} connectionId - The connection ID to delete
   * @returns {boolean} Whether deletion was successful
   */
  static async deleteConnection(scene, connectionId) {
    const boardData = this.getGlobalBoardData();
    const connections = boardData.connections || [];
    const filteredConnections = connections.filter(conn => conn.id !== connectionId);

    if (filteredConnections.length === connections.length) return false; // Connection not found

    boardData.connections = filteredConnections;
    await this.saveGlobalBoardData(boardData);
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
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   */
  static async clearBoard(scene) {
    const boardData = this.getGlobalBoardData();
    boardData.items = [];
    boardData.connections = [];
    boardData.groups = [];
    await this.saveGlobalBoardData(boardData);
  }

  /**
   * Update board-level settings
   * @param {Scene} scene - The scene
   * @param {Object} updates - Object with boardType, etc.
   */
  static async updateBoardData(scene, updates) {
    const boardData = this.getGlobalBoardData();
    
    if (updates.boardType !== undefined) {
      boardData.boardType = updates.boardType;
    }
    
    await this.saveGlobalBoardData(boardData);
  }

  /**
   * Export board data as JSON
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @returns {Object} Board data object
   */
  static exportBoard(scene) {
    const boardData = this.getGlobalBoardData();
    const moduleVersion = game.modules.get('murder-board')?.version || '1.1.1';
    return {
      version: moduleVersion,
      name: boardData.name,
      boardType: boardData.boardType,
      items: boardData.items,
      connections: boardData.connections,
      canvasColor: boardData.canvasColor,
      backgroundImage: boardData.backgroundImage,
      backgroundScale: boardData.backgroundScale,
      defaultConnectionColor: boardData.defaultConnectionColor,
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

      // Get all global boards
      let boards = this.getGlobalBoards();

      // Find the current board or use the first one
      let currentBoardId = this.getGlobalCurrentBoardId();
      let currentBoard = boards.find(b => b.id === currentBoardId);
      if (!currentBoard && boards.length > 0) {
        currentBoard = boards[0];
        currentBoardId = currentBoard.id;
      } else if (!currentBoard) {
        // Create a default board if none exist
        currentBoardId = foundry.utils.randomID();
        currentBoard = {
          id: currentBoardId,
          name: data.name || 'Imported Board',
          items: [],
          connections: [],
          boardType: 'whiteboard',
          defaultConnectionColor: '#000000',
        };
        boards.push(currentBoard);
      }

      // Update the current board with imported data
      currentBoard.items = data.items;
      currentBoard.connections = data.connections;
      currentBoard.boardType = data.boardType || 'whiteboard';
      
      // Import optional board settings
      if (data.name) currentBoard.name = data.name;
      if (data.canvasColor) currentBoard.canvasColor = data.canvasColor;
      if (data.backgroundImage) currentBoard.backgroundImage = data.backgroundImage;
      if (data.backgroundScale !== undefined) currentBoard.backgroundScale = data.backgroundScale;
      if (data.defaultConnectionColor) currentBoard.defaultConnectionColor = data.defaultConnectionColor;

      console.log('Murder Board | Importing board', currentBoardId, 'with', data.items.length, 'items and background image:', data.backgroundImage);

      // Save all boards globally
      await this.saveGlobalBoards(boards);
      await this.setGlobalCurrentBoardId(currentBoardId);

      console.log('Murder Board | Import complete, global boards saved');
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
    
    // Get permissions from current global board
    const boardData = this.getGlobalBoardData();
    const permissions = boardData.permissions || { allowPlayersToEdit: true, restrictedPlayers: [] };
    
    // Check if player is in restricted list
    if (permissions.restrictedPlayers?.includes(game.user.id)) {
      return false;
    }
    
    // Check if editing is allowed for players
    return permissions.allowPlayersToEdit !== false;
  }

  /**
   * Check if current user can view the board
   * @param {Scene} scene - The scene
   * @returns {boolean} True if user can view
   */
  static canUserView(scene) {
    // GMs always can view
    if (game.user.isGM) return true;
    
    // Get permissions from current global board
    const boardData = this.getGlobalBoardData();
    const permissions = boardData.permissions || { allowPlayersToView: true, restrictedViewers: [] };
    
    // Check if player is in restricted viewers list
    if (permissions.restrictedViewers?.includes(game.user.id)) {
      return false;
    }
    
    // Check if viewing is allowed for players
    return permissions.allowPlayersToView !== false;
  }

  /**
   * Check if current user can view a specific board by ID
   * @param {string} boardId - The board ID
   * @returns {boolean} True if user can view
   */
  static canUserViewBoard(boardId) {
    // GMs always can view
    if (game.user.isGM) return true;
    
    // Get the board from global boards
    const boards = this.getGlobalBoards();
    const board = boards.find(b => b.id === boardId);
    
    if (!board) return false;
    
    // Get permissions from the board
    const permissions = board.permissions || { allowPlayersToView: true, restrictedViewers: [] };
    
    // Check if player is in restricted viewers list
    if (permissions.restrictedViewers?.includes(game.user.id)) {
      return false;
    }
    
    // Check if viewing is allowed for players
    return permissions.allowPlayersToView !== false;
  }

  /**
   * Get permissions for the board
   * @param {Scene} scene - The scene
   * @returns {Object} Permissions object
   */
  static getPermissions(scene) {
    // Get permissions from current global board
    const boardData = this.getGlobalBoardData();
    return boardData.permissions || { allowPlayersToEdit: true, restrictedPlayers: [], allowPlayersToView: true, restrictedViewers: [] };
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
    // Update permissions on the current global board
    const boardData = this.getGlobalBoardData();
    boardData.permissions = permissions;
    await this.saveGlobalBoardData(boardData);
  }

  /**
   * Update the default connection color for the current board
   * @param {Scene} scene - The scene (unused, kept for API compatibility)
   * @param {string} color - The new default connection color (hex code)
   */
  static async updateBoardDefaultConnectionColor(scene, color) {
    const boardData = this.getGlobalBoardData();
    boardData.defaultConnectionColor = color;
    await this.saveGlobalBoardData(boardData);
  }

  /**
   * Get all boards (global, not scene-specific)
   * @returns {Array} Array of all board objects
   */
  static getGlobalBoards() {
    return game.settings.get('murder-board', 'globalBoards') || [];
  }

  /**
   * Get the current board ID (globally)
   * @returns {string} The current board ID
   */
  static getGlobalCurrentBoardId() {
    return game.settings.get('murder-board', 'globalCurrentBoardId') || null;
  }

  /**
   * Set the current board ID globally
   * @param {string} boardId - The board ID to set as current
   */
  static async setGlobalCurrentBoardId(boardId) {
    // Client scope - each user sets their own current board
    await game.settings.set('murder-board', 'globalCurrentBoardId', boardId);
  }

  /**
   * Save all boards globally
   * @param {Array} boards - Array of board objects
   */
  static async saveGlobalBoards(boards) {
    if (game.user.isGM) {
      await game.settings.set('murder-board', 'globalBoards', boards);
    } else {
      // Only emit socket if not currently receiving an update (prevent echo)
      if (!window.game.murderBoard?._isReceivingSocketUpdate) {
        const { emitSocketMessage } = await import('./socket-handler.js');
        emitSocketMessage('setGlobalBoards', { boards });
      }
    }
  }

  /**
   * Get the current board data (uses global boards)
   * @returns {Object} Current board data
   */
  /**
   * Ensure all connections have label properties and migrate old labels to Text items
   * This is a migration helper for converting old embedded connection.label to separate Text items
   * Preserves old label data with _wasMigrated flag for backup/recovery purposes
   * @param {Array} connections - Array of connections to check
   * @param {Array} items - Array of items (for creating new label items)
   * @returns {Object} Object with { connections, newItems } where newItems are created Text items
   * @private
   */
  static _ensureConnectionsHaveLabels(connections, items = []) {
    if (!connections || connections.length === 0) {
      return { connections, newItems: [] };
    }
    
    const newItems = [];
    
    // Migrate connections, adding label properties and converting old labels
    const migratedConnections = connections.map(connection => {
      // Check if this connection has old-style label data that needs conversion
      if (connection.label && !connection.labelItemId && !connection._wasMigrated) {
        // Old format: connection.label
        // Convert to new format: create a Text item and reference it
        
        // Calculate midpoint between connected items (best guess for label position)
        const fromItem = items.find(i => i.id === connection.fromItem);
        const toItem = items.find(i => i.id === connection.toItem);
        
        let labelX = 0;
        let labelY = 0;
        
        if (fromItem && toItem) {
          const centerFrom = {
            x: fromItem.x + (fromItem.data?.width || 40) / 2,
            y: fromItem.y + (fromItem.data?.height || 40) / 2
          };
          const centerTo = {
            x: toItem.x + (toItem.data?.width || 40) / 2,
            y: toItem.y + (toItem.data?.height || 40) / 2
          };
          labelX = (centerFrom.x + centerTo.x) / 2 - 60; // Center the text (approximate width)
          labelY = (centerFrom.y + centerTo.y) / 2 - 25; // Center the text (approximate height)
        }
        
        const labelItem = {
          id: foundry.utils.randomID(),
          type: 'Text',
          label: 'Connection Label',
          x: labelX,
          y: labelY,
          color: '#000000',
          data: {
            text: connection.label,
            font: 'Arial',
            textColor: '#000000',
            fontSize: 14,
            width: 120,
            height: 50,
          },
        };
        newItems.push(labelItem);
        
        // Update connection to reference the new Text item, but preserve old label data
        return {
          ...connection,
          labelItemId: labelItem.id,
          labelOffsetX: 0,
          labelOffsetY: 0,
          _wasMigrated: true, // Mark as migrated for recovery/backup purposes
        };
      }
      
      // Ensure new label properties exist
      return {
        ...connection,
        labelItemId: connection.labelItemId || null,
        labelOffsetX: connection.labelOffsetX || 0,
        labelOffsetY: connection.labelOffsetY || 0,
      };
    });
    
    return { connections: migratedConnections, newItems };
  }

  /**
   * Ensure all items have a zIndex property for layering
   * This is a migration helper for items created before zIndex was added
   * @param {Array} items - Array of items to check
   * @returns {Array} Items with zIndex ensured
   * @private
   */
  static _ensureItemsHaveZIndex(items) {
    if (!items || items.length === 0) return items;
    
    // Check if any items are missing zIndex
    const needsMigration = items.some(item => typeof item.zIndex === 'undefined');
    
    if (!needsMigration) {
      return items;
    }
    
    // Migrate items, assigning zIndex based on creation order or a default value
    return items.map((item, index) => {
      if (typeof item.zIndex === 'undefined') {
        return {
          ...item,
          zIndex: index, // Assign based on position in array
        };
      }
      return item;
    });
  }

  static getGlobalBoardData() {
    const boards = this.getGlobalBoards();
    const currentBoardId = this.getGlobalCurrentBoardId();

    let currentBoard = boards.find(b => b.id === currentBoardId);
    if (!currentBoard && boards.length > 0) {
      currentBoard = boards[0];
    } else if (!currentBoard) {
      // Create a default board if none exist
      const boardId = foundry.utils.randomID();
      currentBoard = {
        id: boardId,
        name: 'Default Board',
        items: [],
        connections: [],
        groups: [],
        boardType: 'whiteboard',
        defaultConnectionColor: '#000000',
        defaultConnectionSize: 5,
        canvasColor: '#f5f5f5',
        defaultFont: 'Arial',
        defaultFontColor: '#000000',
        camera: { x: 0, y: 0, zoom: 1 },
      };
      boards.push(currentBoard);
      // Save the new default board
      this.saveGlobalBoards(boards);
      this.setGlobalCurrentBoardId(boardId);
    }

    const boardType = currentBoard.boardType || 'whiteboard';
    
    // Ensure all items have zIndex (migration for old data)
    const items = this._ensureItemsHaveZIndex(currentBoard.items || []);
    
    // Ensure all connections have label properties (but don't create items - that's handled by migration)
    const connections = (currentBoard.connections || []).map(connection => {
      return {
        ...connection,
        labelItemId: connection.labelItemId || null,
        labelOffsetX: connection.labelOffsetX || 0,
        labelOffsetY: connection.labelOffsetY || 0,
      };
    });
    
    return {
      id: currentBoard.id,
      name: currentBoard.name || 'Untitled Board',
      items: items,
      connections: connections,
      groups: currentBoard.groups || [],
      boardType: boardType,
      defaultConnectionColor: currentBoard.defaultConnectionColor || this.getDefaultConnectionColorForBoardType(boardType),
      defaultConnectionSize: currentBoard.defaultConnectionSize || 5,
      canvasColor: currentBoard.canvasColor || this.getDefaultCanvasColorForBoardType(boardType),
      defaultFont: currentBoard.defaultFont || 'Arial',
      defaultFontColor: currentBoard.defaultFontColor || '#000000',
      camera: currentBoard.camera || { x: 0, y: 0, zoom: 1 },
      backgroundImage: currentBoard.backgroundImage || null,
      backgroundScale: currentBoard.backgroundScale || 1.0,
      permissions: currentBoard.permissions || { allowPlayersToEdit: true, restrictedPlayers: [], allowPlayersToView: true, restrictedViewers: [] },
    };
  }

  /**
   * Save board data globally
   * @param {Object} boardData - The board data to save
   */
  static async saveGlobalBoardData(boardData) {
    const boards = this.getGlobalBoards();
    const index = boards.findIndex(b => b.id === boardData.id);

    if (index !== -1) {
      // Create a new board object with spread data AND deep copy of items array to ensure Foundry detects the change
      boards[index] = {
        ...boards[index],
        ...boardData,
        items: boardData.items ? [...boardData.items] : boards[index].items  // Create new array reference
      };
    } else {
      boards.push(boardData);
    }

    await this.saveGlobalBoards(boards);
  }

  /**
   * Create a new board globally
   * @param {Object} boardData - The board data
   */
  static async createGlobalBoard(boardData) {
    const boards = this.getGlobalBoards();
    const newBoard = {
      id: boardData.id || foundry.utils.randomID(),
      name: boardData.name || 'New Board',
      items: boardData.items || [],
      connections: boardData.connections || [],
      groups: boardData.groups || [],
      boardType: boardData.boardType || 'whiteboard',
      defaultConnectionColor: boardData.defaultConnectionColor || this.getDefaultConnectionColorForBoardType(boardData.boardType || 'whiteboard'),
      canvasColor: boardData.canvasColor || this.getDefaultCanvasColorForBoardType(boardData.boardType || 'whiteboard'),
      defaultFont: boardData.defaultFont || 'Arial',
      defaultFontColor: boardData.defaultFontColor || '#000000',
      camera: boardData.camera || { x: 0, y: 0, zoom: 1 },
      backgroundImage: boardData.backgroundImage,
      backgroundScale: boardData.backgroundScale,
      backgroundMode: boardData.backgroundMode,
      permissions: boardData.permissions,
    };
    boards.push(newBoard);
    await this.saveGlobalBoards(boards);
    return newBoard;
  }

  /**
   * Delete a board globally
   * @param {string} boardId - The ID of the board to delete
   */
  static async deleteGlobalBoard(boardId) {
    const boards = this.getGlobalBoards();
    const filtered = boards.filter(b => b.id !== boardId);
    await this.saveGlobalBoards(filtered);

    // If deleted board was current, switch to first remaining board
    if (this.getGlobalCurrentBoardId() === boardId) {
      if (filtered.length > 0) {
        await this.setGlobalCurrentBoardId(filtered[0].id);
      }
    }
    
    return true;
  }

  /**
   * Create a group from selected item IDs
   * @param {Array<string>} itemIds - Array of item IDs to group
   * @returns {string} The new group ID
   */
  static async createGroup(itemIds) {
    if (itemIds.length < 2) {
      throw new Error('Groups must contain at least 2 items');
    }

    const boardData = this.getGlobalBoardData();
    if (!boardData.groups) boardData.groups = [];
    if (!boardData.items) boardData.items = [];

    // Check if any items are already in a group
    const itemsToGroup = boardData.items.filter(item => itemIds.includes(item.id));
    const itemsInExistingGroup = itemsToGroup.find(item => item.groupId);
    if (itemsInExistingGroup) {
      throw new Error(`Cannot create group: "${itemsInExistingGroup.label || itemsInExistingGroup.id}" is already part of another group`);
    }

    // Find the highest z-index among items to be grouped
    const groupedItems = boardData.items.filter(item => itemIds.includes(item.id));
    const maxZIndex = Math.max(...groupedItems.map(item => item.zIndex || 0), 0);

    // Create group object
    const groupId = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const group = {
      id: groupId,
      zIndex: maxZIndex, // Group z-index is set to highest member z-index
      items: itemIds,
      name: `Group ${groupId.substring(6, 16)}`,
      createdAt: Date.now(),
    };

    // Assign groupId to all items
    const updatedItems = boardData.items.map(item => {
      if (itemIds.includes(item.id)) {
        return { ...item, groupId };
      }
      return item;
    });

    boardData.groups.push(group);
    boardData.items = updatedItems;

    await this.saveGlobalBoardData(boardData);
    return groupId;
  }

  /**
   * Ungroup items - removes group and returns items to individual z-index
   * @param {string} groupId - The group ID to ungroup
   */
  static async ungroup(groupId) {
    const boardData = this.getGlobalBoardData();
    if (!boardData.groups) boardData.groups = [];
    if (!boardData.items) boardData.items = [];

    const groupIndex = boardData.groups.findIndex(g => g.id === groupId);
    if (groupIndex === -1) {
      console.warn(`Murder Board | Group not found: ${groupId}`);
      return false;
    }

    const group = boardData.groups[groupIndex];
    
    // Remove groupId from all items in the group
    const updatedItems = boardData.items.map(item => {
      if (item.groupId === groupId) {
        // Create new item object without groupId
        const newItem = { ...item };
        delete newItem.groupId;
        return newItem;
      }
      return item;
    });

    boardData.groups.splice(groupIndex, 1);
    boardData.items = updatedItems;

    await this.saveGlobalBoardData(boardData);
    return true;
  }

  /**
   * Get all items in a group
   * @param {string} groupId - The group ID
   * @returns {Array<Object>} Array of items in the group
   */
  static getGroupItems(groupId) {
    const boardData = this.getGlobalBoardData();
    return (boardData.items || []).filter(item => item.groupId === groupId);
  }

  /**
   * Get group by ID
   * @param {string} groupId - The group ID
   * @returns {Object|null} The group object or null
   */
  static getGroup(groupId) {
    const boardData = this.getGlobalBoardData();
    return (boardData.groups || []).find(g => g.id === groupId) || null;
  }

  /**
   * Bring group to front (set group z-index higher than all others)
   * @param {string} groupId - The group ID
   */
  static async bringGroupToFront(groupId) {
    const boardData = this.getGlobalBoardData();
    const groups = boardData.groups || [];
    const items = boardData.items || [];

    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    // Find the highest z-index among all other groups
    const otherGroupZIndices = groups
      .filter(g => g.id !== groupId)
      .map(g => g.zIndex || 0);

    const maxZIndex = Math.max(...otherGroupZIndices, 0);
    const newZIndex = maxZIndex + 1;

    // Update group z-index
    group.zIndex = newZIndex;

    // Update all items in the group to maintain relative order
    const groupItemIds = items
      .filter(item => item.groupId === groupId)
      .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
      .map(item => item.id);

    const updatedItems = items.map(item => {
      if (item.groupId === groupId) {
        // Preserve relative position within group, add offset from new group z-index
        const relativeIndex = groupItemIds.indexOf(item.id);
        return { ...item, zIndex: newZIndex + (relativeIndex * 0.1) };
      }
      return item;
    });

    boardData.items = updatedItems;
    await this.saveGlobalBoardData(boardData);
  }

  /**
   * Send group to back (set group z-index lower than all others)
   * @param {string} groupId - The group ID
   */
  static async sendGroupToBack(groupId) {
    const boardData = this.getGlobalBoardData();
    const groups = boardData.groups || [];
    const items = boardData.items || [];

    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    // Find the lowest z-index among all other groups
    const otherGroupZIndices = groups
      .filter(g => g.id !== groupId)
      .map(g => g.zIndex || 0);

    const minZIndex = Math.min(...otherGroupZIndices, 0);
    const newZIndex = minZIndex - 1;

    // Update group z-index
    group.zIndex = newZIndex;

    // Update all items in the group to maintain relative order
    const groupItemIds = items
      .filter(item => item.groupId === groupId)
      .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
      .map(item => item.id);

    const updatedItems = items.map(item => {
      if (item.groupId === groupId) {
        // Preserve relative position within group, add offset from new group z-index
        const relativeIndex = groupItemIds.indexOf(item.id);
        return { ...item, zIndex: newZIndex + (relativeIndex * 0.1) };
      }
      return item;
    });

    boardData.items = updatedItems;
    await this.saveGlobalBoardData(boardData);
  }
}
