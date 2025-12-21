/**
 * Murder Board Socket Handler
 * Manages multiplayer synchronization using SocketLib
 */

import { MurderBoardData } from './data-model.js';

const MODULE_ID = 'murder-board';
let socket = null;

// Debounce timer for refresh broadcasts (prevent spamming)
const refreshTimers = new Map();
const REFRESH_DEBOUNCE_MS = 100; // Wait 100ms before broadcasting refresh

/**
 * Initialize socket communication using SocketLib's registerModule
 * Call this in the 'socketlib.ready' hook
 */
export function initializeSocketHandler() {
  // Check if socketlib is available
  if (!game.modules.get('socketlib')?.active) {
    console.warn(`${MODULE_ID} | SocketLib not available. Multiplayer sync disabled.`);
    return;
  }

  // Register socket module with SocketLib (returns socket object)
  try {
    socket = socketlib.registerModule(MODULE_ID);
    
    // Register handler functions
    socket.register('addItem', _handleAddItem);
    socket.register('updateItem', _handleUpdateItem);
    socket.register('updateItems', _handleUpdateItems);
    socket.register('updateConnections', _handleUpdateConnections);
    socket.register('updateFlag', _handleUpdateFlag);
    socket.register('deleteItem', _handleDeleteItem);
    socket.register('addConnection', _handleAddConnection);
    socket.register('updateConnection', _handleUpdateConnection);
    socket.register('deleteConnection', _handleDeleteConnection);
    socket.register('clearBoard', _handleClearBoard);
    socket.register('refreshBoard', _handleRefreshBoard);
  } catch (error) {
    console.error(`${MODULE_ID} | Error registering socket module:`, error);
  }
}

/**
 * Emit a socket message to sync data across clients
 * @param {string} action - The action type (e.g., 'addItem', 'updateItem')
 * @param {Object} payload - The data to send
 */
export function emitSocketMessage(action, payload) {
  if (!socket) {
    console.warn(`${MODULE_ID} | Socket not initialized. Cannot emit socket message.`);
    return;
  }

  try {
    // Use SocketLib's executeAsGM to route to GM for processing
    socket.executeAsGM(action, payload);
  } catch (error) {
    console.error(`${MODULE_ID} | Error emitting socket message:`, error);
  }
}

/**
 * Factory function to create socket handlers that follow the standard pattern
 * Reduces boilerplate for handlers that: get scene → call operation → broadcast refresh
 * @param {Function} operation - Async function that performs the operation
 * @returns {Function} Handler function
 * @private
 */
function _createSocketHandler(operation) {
  return async (payload) => {
    const { sceneId } = payload;
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    
    await operation(scene, payload);
    _broadcastRefresh(scene);
  };
}

/**
 * Handle adding an item via socket
 * @private
 */
const _handleAddItem = _createSocketHandler((scene, { item }) => 
  MurderBoardData.addItem(scene, item)
);

/**
 * Handle updating an item via socket
 * @private
 */
const _handleUpdateItem = _createSocketHandler((scene, { itemId, updates }) => 
  MurderBoardData.updateItem(scene, itemId, updates)
);

/**
 * Handle updating multiple items via socket
 * @private
 */
const _handleUpdateItems = _createSocketHandler((scene, { items }) => 
  scene.setFlag('murder-board', 'items', items)
);

/**
 * Handle updating connections via socket
 * @private
 */
const _handleUpdateConnections = _createSocketHandler((scene, { connections }) => 
  scene.setFlag('murder-board', 'connections', connections)
);

/**
 * Handle updating a generic flag via socket
 * @private
 */
const _handleUpdateFlag = _createSocketHandler((scene, { key, value }) => 
  scene.setFlag('murder-board', key, value)
);

/**
 * Handle deleting an item via socket
 * @private
 */
const _handleDeleteItem = _createSocketHandler((scene, { itemId }) => 
  MurderBoardData.deleteItem(scene, itemId)
);

/**
 * Handle adding a connection via socket
 * @private
 */
const _handleAddConnection = _createSocketHandler((scene, { fromId, toId }) => 
  MurderBoardData.addConnection(scene, fromId, toId)
);

/**
 * Handle updating a connection via socket
 * @private
 */
const _handleUpdateConnection = _createSocketHandler((scene, { connectionId, updates }) => 
  MurderBoardData.updateConnection(scene, connectionId, updates)
);

/**
 * Handle deleting a connection via socket
 * @private
 */
const _handleDeleteConnection = _createSocketHandler((scene, { connectionId }) => 
  MurderBoardData.deleteConnection(scene, connectionId)
);

/**
 * Handle clearing the board via socket
 * @private
 */
const _handleClearBoard = _createSocketHandler((scene) => 
  MurderBoardData.clearBoard(scene)
);

/**
 * Handle refresh board message
 * @private
 */
async function _handleRefreshBoard(payload) {
  const { sceneId } = payload;
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  
  _refreshBoardsForScene(scene);
}

/**
 * Broadcast refresh to all OTHER clients (players only receive this, GM doesn't process their own)
 * Uses debouncing to prevent spamming refreshes during rapid updates (e.g., dragging items)
 * @param {Scene} scene - The scene to refresh
 * @private
 */
function _broadcastRefresh(scene) {
  // GM broadcasts to all players after processing an update
  if (game.user.isGM && socket) {
    const sceneId = scene.id;
    
    // Clear existing timer if any
    if (refreshTimers.has(sceneId)) {
      clearTimeout(refreshTimers.get(sceneId));
    }
    
    // Set new debounced timer
    const timer = setTimeout(() => {
      socket.executeForOthers('refreshBoard', {
        sceneId: sceneId,
      });
      refreshTimers.delete(sceneId);
    }, REFRESH_DEBOUNCE_MS);
    
    refreshTimers.set(sceneId, timer);
  }
}

/**
 * Refresh all Murder Board applications for a scene
 * Called when receiving a refresh broadcast from GM
 * Only redraws canvas, does not re-render the full application
 * @param {Scene} scene - The scene to refresh
 * @private
 */
function _refreshBoardsForScene(scene) {
  // Find all MurderBoardApplication instances for this scene and refresh them
  const appInstances = foundry.applications.instances;
  for (const [id, app] of appInstances) {
    if (
      app.constructor.name === 'MurderBoardApplication' &&
      app.scene?.id === scene.id
    ) {
      // Only redraw canvas, don't re-render the full application
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}
