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
    socket.register('bringToFront', _handleBringToFront);
    socket.register('bringForward', _handleBringForward);
    socket.register('sendBackward', _handleSendBackward);
    socket.register('sendToBack', _handleSendToBack);
    socket.register('createGroup', _handleCreateGroup);
    socket.register('ungroup', _handleUngroup);
    socket.register('bringGroupToFront', _handleBringGroupToFront);
    socket.register('sendGroupToBack', _handleSendGroupToBack);
    socket.register('duplicateItems', _handleDuplicateItems);
    
    // Global board handlers
    socket.register('setCurrentBoardId', _handleSetCurrentBoardId);
    socket.register('setGlobalBoards', _handleSetGlobalBoards);
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
 * Handle bringing an item to front via socket
 * @private
 */
const _handleBringToFront = _createSocketHandler((scene, { itemId }) => 
  MurderBoardData.bringToFront(scene, itemId)
);

/**
 * Handle bringing an item forward via socket
 * @private
 */
const _handleBringForward = _createSocketHandler((scene, { itemId }) => 
  MurderBoardData.bringForward(scene, itemId)
);

/**
 * Handle sending an item backward via socket
 * @private
 */
const _handleSendBackward = _createSocketHandler((scene, { itemId }) => 
  MurderBoardData.sendBackward(scene, itemId)
);

/**
 * Handle sending an item to back via socket
 * @private
 */
const _handleSendToBack = _createSocketHandler((scene, { itemId }) => 
  MurderBoardData.sendToBack(scene, itemId)
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

/**
 * Handle setting the global current board ID via socket
 * @private
 */
async function _handleSetCurrentBoardId({ boardId }) {
  await game.settings.set(MODULE_ID, 'globalCurrentBoardId', boardId);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      await app.render();
    }
  }
}

/**
 * Handle setting global boards via socket
 * @private
 */
async function _handleSetGlobalBoards({ boards }) {
  console.log('Murder Board | Socket: setGlobalBoards received. First board defaultFontColor:', boards[0]?.defaultFontColor);
  
  // Set a flag to prevent recursive socket emissions
  if (window.game.murderBoard) {
    window.game.murderBoard._isReceivingSocketUpdate = true;
  }
  
  await game.settings.set(MODULE_ID, 'globalBoards', boards);
  console.log('Murder Board | Socket: setGlobalBoards saved. Verifying...', game.settings.get(MODULE_ID, 'globalBoards')[0]?.defaultFontColor);
  
  // Clear the flag after a short delay
  setTimeout(() => {
    if (window.game.murderBoard) {
      window.game.murderBoard._isReceivingSocketUpdate = false;
    }
  }, 100);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      await app.render();
    }
  }
}
/**
 * Handle creating a group via socket
 * @private
 */
async function _handleCreateGroup({ itemIds }) {
  await MurderBoardData.createGroup(itemIds);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}

/**
 * Handle ungrouping via socket
 * @private
 */
async function _handleUngroup({ groupId }) {
  await MurderBoardData.ungroup(groupId);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}

/**
 * Handle bringing group to front via socket
 * @private
 */
async function _handleBringGroupToFront({ groupId }) {
  await MurderBoardData.bringGroupToFront(groupId);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}
/**
 * Handle duplicating items via socket
 * @private
 */
async function _handleDuplicateItems({ itemIds, offset }) {
  const boardData = MurderBoardData.getGlobalBoardData();
  const newItemIds = [];

  // Duplicate each item
  for (const itemId of itemIds) {
    const originalItem = boardData.items.find(item => item.id === itemId);
    if (!originalItem) {
      console.warn(`${MODULE_ID} | Item not found: ${itemId}`);
      continue;
    }

    // Create a copy with an offset position
    const duplicate = {
      id: foundry.utils.randomID(),
      type: originalItem.type,
      label: originalItem.label,
      x: originalItem.x + offset.x,
      y: originalItem.y + offset.y,
      color: originalItem.color,
      width: originalItem.width,
      height: originalItem.height,
      data: { ...originalItem.data }, // Deep copy the data
    };

    boardData.items.push(duplicate);
    newItemIds.push(duplicate.id);
  }

  // Save the updated board data
  await MurderBoardData.saveGlobalBoardData(boardData);

  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}
/**
 * Handle sending group to back via socket
 * @private
 */
async function _handleSendGroupToBack({ groupId }) {
  await MurderBoardData.sendGroupToBack(groupId);
  
  // Refresh all Murder Board applications
  for (const app of Object.values(ui.windows)) {
    if (app.constructor.name === 'MurderBoardApplication') {
      if (app.renderer && typeof app.renderer.draw === 'function') {
        app.renderer.draw();
      }
    }
  }
}