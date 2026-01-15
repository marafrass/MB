/**
 * Murder Board - Main Module Entry Point
 * A collaborative investigation tracking interface for Foundry VTT
 */

import { MurderBoardData } from './data-model.js';
import { MurderBoardApplication } from './application.js';
import { initializeSocketHandler } from './socket-handler.js';
import { registerMurderBoardHelpers } from './helpers.js';

const MODULE_ID = 'murder-board';
const MODULE_TITLE = 'Murder Board';

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/**
 * Manage the user's 5-swatch color palette
 * Starts with default colors, evolves with user selections
 */
class ColorManager {
  static MAX_COLORS = 5;
  
  static DEFAULT_COLORS = [
    '#FFFF99',  // Yellow
    '#FFB6C1',  // Pink
    '#90EE90',  // Green
    '#ADD8E6',  // Blue
    '#FFA07A',  // Light Salmon
  ];

  /**
   * Add a color to the palette (replaces oldest with new selection)
   */
  static addColorToPalette(color) {
    try {
      const palette = game.settings.get(MODULE_ID, 'colorPalette') || this.DEFAULT_COLORS;
      
      // Remove duplicate if it exists
      const filtered = palette.filter(c => c !== color);
      
      // Add to front and limit to MAX_COLORS
      const updated = [color, ...filtered].slice(0, this.MAX_COLORS);
      
      game.settings.set(MODULE_ID, 'colorPalette', updated);
    } catch (error) {
      console.warn('Murder Board | Error updating color palette:', error);
    }
  }

  /**
   * Get the current 5-color palette
   */
  static getColorPalette() {
    try {
      const palette = game.settings.get(MODULE_ID, 'colorPalette');
      // Return stored palette or defaults if not yet set
      return (palette && palette.length === this.MAX_COLORS) ? palette : this.DEFAULT_COLORS;
    } catch (error) {
      console.warn('Murder Board | Error getting color palette:', error);
      return this.DEFAULT_COLORS;
    }
  }

  /**
   * Convert hex color to RGB for display
   */
  static hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }
}

// ============================================================================
// INITIALIZE MODULE
// ============================================================================

// Global error handler to catch errors before reload
window.addEventListener('error', (event) => {
  console.error('GLOBAL ERROR CAUGHT:', event.error);
  console.error('Message:', event.message);
  console.error('Filename:', event.filename);
  console.error('Line:', event.lineno);
  console.error('Stack:', event.error?.stack);
  localStorage.setItem('murder-board-last-error', JSON.stringify({
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    stack: event.error?.stack,
    timestamp: new Date().toISOString(),
  }));
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('UNHANDLED REJECTION:', event.reason);
  console.error('Promise:', event.promise);
  localStorage.setItem('murder-board-last-error', JSON.stringify({
    message: String(event.reason),
    type: 'unhandledrejection',
    stack: event.reason?.stack,
    timestamp: new Date().toISOString(),
  }));
});

Hooks.once('init', () => {
  // Register the global namespace
  window.game.murderBoard = {
    MODULE_ID,
    MODULE_TITLE,
    MurderBoardData,
    MurderBoardApplication,
    ColorManager,
  };

  // Register Handlebars helpers
  registerMurderBoardHelpers();

  // Register Handlebars partials for Murder Board templates
  registerPartials();

  // Register settings
  registerSettings();
});

// ============================================================================
// PARTIALS REGISTRATION
// ============================================================================

async function registerPartials() {
  const partialPaths = {
    'radio-group': 'modules/murder-board/templates/_radio-group.hbs',
    'color-picker': 'modules/murder-board/templates/_color-picker.hbs',
    'font-select': 'modules/murder-board/templates/_font-select.hbs',
    'dialog-buttons': 'modules/murder-board/templates/_dialog-buttons.hbs',
  };

  for (const [name, path] of Object.entries(partialPaths)) {
    try {
      const response = await fetch(path);
      if (!response.ok) {
        console.warn(`Failed to load partial ${name} from ${path}`);
        continue;
      }
      const template = await response.text();
      Handlebars.registerPartial(name, template);
      console.log(`Registered Handlebars partial: ${name}`);
    } catch (error) {
      console.error(`Error registering partial ${name}:`, error);
    }
  }
}

// ============================================================================
// SETTINGS REGISTRATION
// ============================================================================

function registerSettings() {
  // User's color palette (5-swatch selection)
  game.settings.register(MODULE_ID, 'colorPalette', {
    scope: 'client',
    config: false,
    type: Array,
    default: ColorManager.DEFAULT_COLORS,
  });

  // Window positions per scene (stored as object mapping sceneId -> position data)
  game.settings.register(MODULE_ID, 'windowPositions', {
    scope: 'client',
    config: false,
    type: Object,
    default: {},
  });

  // Default Board Type
  game.settings.register(MODULE_ID, 'defaultBoardType', {
    name: game.i18n.localize('MURDER_BOARD.Settings.DefaultBoardType.Name'),
    hint: game.i18n.localize('MURDER_BOARD.Settings.DefaultBoardType.Hint'),
    scope: 'world',
    config: true,
    type: String,
    choices: {
      'chalkboard': game.i18n.localize('MURDER_BOARD.BoardTypes.Chalkboard'),
      'corkboard': game.i18n.localize('MURDER_BOARD.BoardTypes.Corkboard'),
      'whiteboard': game.i18n.localize('MURDER_BOARD.BoardTypes.Whiteboard'),
      'blackboard': game.i18n.localize('MURDER_BOARD.BoardTypes.Blackboard'),
    },
    default: 'whiteboard',
  });

  // Suppress Notifications
  game.settings.register(MODULE_ID, 'suppressNotifications', {
    name: game.i18n.localize('MURDER_BOARD.Settings.SuppressNotifications.Name'),
    hint: game.i18n.localize('MURDER_BOARD.Settings.SuppressNotifications.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  // Enable Drag-and-Drop Image Upload
  game.settings.register(MODULE_ID, 'enableDragDropUpload', {
    name: game.i18n.localize('MURDER_BOARD.Settings.EnableDragDropUpload.Name'),
    hint: game.i18n.localize('MURDER_BOARD.Settings.EnableDragDropUpload.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  // Global Boards Storage (world-level, accessible from any scene)
  game.settings.register(MODULE_ID, 'globalBoards', {
    name: 'Global Boards',
    hint: 'Stores all murder boards globally',
    scope: 'world',
    config: false,
    type: Object,
    default: [],
  });

  // Global Current Board ID
  game.settings.register(MODULE_ID, 'globalCurrentBoardId', {
    name: 'Current Board ID',
    hint: 'Tracks the currently active board ID',
    scope: 'client',
    config: false,
    type: String,
    default: '',
  });

  // Board Migration Version (tracks if migration from scene-based to global boards has been completed)
  game.settings.register(MODULE_ID, 'boardMigrationVersion', {
    name: 'Board Migration Version',
    hint: 'Tracks migration progress from old scene-based boards to new global boards',
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });

  // Connection Label Migration Version (tracks if migration of connection labels to Text items has been completed)
  game.settings.register(MODULE_ID, 'connectionLabelMigrationVersion', {
    name: 'Connection Label Migration Version',
    hint: 'Tracks migration progress of connection labels from embedded text to Text items',
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });

  // Theme is now handled entirely by CSS based on Foundry's native dark mode (body.dark-mode class)
  // No custom theme setting needed - the stylesheet automatically switches when dark mode is toggled
}

// ============================================================================
// READY HOOK
// ============================================================================

Hooks.once('socketlib.ready', () => {
  initializeSocketHandler();
});

Hooks.once('ready', async () => {
  // Perform migration from old scene-based boards to new global boards
  if (game.user.isGM) {
    await _migrateToGlobalBoards();
    // Perform migration of connection labels to Text items
    await _migrateConnectionLabelsToTextItems();
  }

  // Store reference to main board for item dialogs to refresh
  game.murderBoard.mainBoard = null;

  // Watch for dark mode changes and refresh open boards (debounced to prevent excessive re-renders)
  let darkModeTimeout = null;
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class' && mutation.target === document.body) {
        // Debounce dark mode detection to prevent excessive refreshes
        if (darkModeTimeout) clearTimeout(darkModeTimeout);
        darkModeTimeout = setTimeout(() => {
          const isDarkMode = document.body.classList.contains('theme-dark');
          // Refresh all open Murder Board windows
          const appInstances = foundry.applications.instances;
          for (const [id, app] of appInstances) {
            if (app.constructor.name === 'MurderBoardApplication') {
              app.render();
            }
          }
          darkModeTimeout = null;
        }, 500); // Wait 500ms before refreshing
      }
    });
  });

  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

/**
 * Migrate boards from old scene-based storage to new global storage
 * This runs once per world on first load with the new system
 * @private
 */
async function _migrateToGlobalBoards() {
  try {
    const { MurderBoardData } = await import('./data-model.js');
    
    // Check if migration has already been done
    const migrationVersion = game.settings.get(MODULE_ID, 'boardMigrationVersion') || 0;
    if (migrationVersion >= 1) {
      console.log('%c[Murder Board] Boards already migrated, skipping migration', 'color: #4CAF50; font-weight: bold');
      return;
    }

    const globalBoards = game.settings.get(MODULE_ID, 'globalBoards') || [];
    
    // Only migrate if global boards are empty (fresh installation or first run of new system)
    if (globalBoards.length > 0) {
      console.log('%c[Murder Board] Global boards already exist, skipping migration', 'color: #4CAF50; font-weight: bold');
      await game.settings.set(MODULE_ID, 'boardMigrationVersion', 1);
      return;
    }

    console.log('%c[Murder Board] ════════════════════════════════════════', 'color: #2196F3; font-weight: bold');
    console.log('%c[Murder Board] STARTING BOARD MIGRATION TO GLOBAL STORAGE', 'color: #2196F3; font-weight: bold');
    console.log('%c[Murder Board] ════════════════════════════════════════', 'color: #2196F3; font-weight: bold');

    const allMigratedBoards = new Map(); // Track boards by ID to avoid duplicates
    const sceneDetails = [];
    let totalBoardsFound = 0;

    // Iterate through all scenes and collect boards from scene flags
    for (const scene of game.scenes) {
      const sceneFlags = scene.flags[MODULE_ID] || {};
      const sceneBoards = sceneFlags.boards || [];

      if (sceneBoards.length > 0) {
        console.log(`%c  📋 Scene: "${scene.name}" (${scene.id})`, 'color: #FF9800; font-weight: bold');
        totalBoardsFound += sceneBoards.length;
        
        const boardsInScene = [];
        for (const board of sceneBoards) {
          if (!allMigratedBoards.has(board.id)) {
            allMigratedBoards.set(board.id, board);
            console.log(`%c    ✓ "${board.name}" (${board.id})`, 'color: #4CAF50');
            console.log(`%c      - Type: ${board.boardType || 'whiteboard'}`);
            console.log(`%c      - Items: ${(board.items || []).length}`);
            console.log(`%c      - Connections: ${(board.connections || []).length}`);
            boardsInScene.push({ name: board.name, id: board.id, isNew: true });
          } else {
            console.log(`%c    ⊘ "${board.name}" (${board.id}) - DUPLICATE (already migrated)`, 'color: #FFC107');
            boardsInScene.push({ name: board.name, id: board.id, isNew: false });
          }
        }
        sceneDetails.push({ sceneName: scene.name, boards: boardsInScene });
      }
    }

    console.log('%c────────────────────────────────────────────────────', 'color: #2196F3');
    console.log(`%c  📊 Migration Summary:`, 'color: #673AB7; font-weight: bold');
    console.log(`%c    Total boards found across all scenes: ${totalBoardsFound}`, 'color: #673AB7');
    console.log(`%c    Unique boards to migrate: ${allMigratedBoards.size}`, 'color: #673AB7');
    console.log(`%c    Scenes scanned: ${sceneDetails.length}`, 'color: #673AB7');

    if (allMigratedBoards.size > 0) {
      // Save all unique boards to global storage
      const migratedBoardsArray = Array.from(allMigratedBoards.values());
      await game.settings.set(MODULE_ID, 'globalBoards', migratedBoardsArray);
      
      // Set the first board as current if no current board is set
      if (migratedBoardsArray.length > 0) {
        await game.settings.set(MODULE_ID, 'globalCurrentBoardId', migratedBoardsArray[0].id);
        console.log(`%c    Current board set to: "${migratedBoardsArray[0].name}"`, 'color: #673AB7');
      }

      console.log('%c────────────────────────────────────────────────────', 'color: #2196F3');
      console.log('%c✓ MIGRATION COMPLETE!', 'color: #4CAF50; font-weight: bold; font-size: 14px');
      console.log(`%c  ${allMigratedBoards.size} board(s) migrated to global storage`, 'color: #4CAF50');
      console.log('%c════════════════════════════════════════', 'color: #2196F3; font-weight: bold');
      
      ui.notifications.info(`Murder Board: Migrated ${allMigratedBoards.size} board(s) from scenes to global storage`);
    } else {
      console.log('%c────────────────────────────────────────────────────', 'color: #2196F3');
      console.log('%c⊘ No boards found to migrate', 'color: #FFC107; font-weight: bold');
      console.log('%c════════════════════════════════════════', 'color: #2196F3; font-weight: bold');
    }

    // Mark migration as complete
    await game.settings.set(MODULE_ID, 'boardMigrationVersion', 1);
  } catch (error) {
    console.error('%c[Murder Board] ✗ ERROR during board migration:', 'color: #f44336; font-weight: bold', error);
    ui.notifications.error('Murder Board: Failed to migrate boards. Please check console for details.');
  }
}

/**
 * Migrate connection labels from old connection.label property to separate Text items
 * This runs once per world to convert old embedded labels to the new system
 * @private
 */
async function _migrateConnectionLabelsToTextItems() {
  try {
    const { MurderBoardData } = await import('./data-model.js');
    
    // Check if this migration has already been done
    const connectionLabelMigrationVersion = game.settings.get(MODULE_ID, 'connectionLabelMigrationVersion') || 0;
    if (connectionLabelMigrationVersion >= 1) {
      console.log('%c[Murder Board] Connection labels already migrated, skipping migration', 'color: #4CAF50; font-weight: bold');
      return;
    }

    const globalBoards = game.settings.get(MODULE_ID, 'globalBoards') || [];
    
    if (globalBoards.length === 0) {
      console.log('%c[Murder Board] No boards found, skipping connection label migration', 'color: #FFC107; font-weight: bold');
      await game.settings.set(MODULE_ID, 'connectionLabelMigrationVersion', 1);
      return;
    }

    console.log('%c[Murder Board] ════════════════════════════════════════', 'color: #9C27B0; font-weight: bold');
    console.log('%c[Murder Board] MIGRATING CONNECTION LABELS TO TEXT ITEMS', 'color: #9C27B0; font-weight: bold');
    console.log('%c[Murder Board] ════════════════════════════════════════', 'color: #9C27B0; font-weight: bold');

    let totalBoardsMigrated = 0;
    let totalLabelsConverted = 0;

    // Iterate through all boards and migrate connection labels
    for (const board of globalBoards) {
      const items = board.items || [];
      const connections = board.connections || [];
      let itemIds = new Set(items.map(i => i.id));
      
      let boardHasChanges = false;
      const newItems = [];
      
      // PHASE 1: Migrate connections with old-style labels (connection.label without labelItemId)
      const connectionsWithLabels = connections.filter(c => c.label && !c.labelItemId && !c._wasMigrated);
      
      if (connectionsWithLabels.length > 0) {
        console.log(`%c  📋 Board: "${board.name}" (${board.id})`, 'color: #E91E63; font-weight: bold');
        console.log(`%c    Found ${connectionsWithLabels.length} connection(s) with old labels`, 'color: #E91E63');
        boardHasChanges = true;
        
        // Migrate each connection with an old label
        for (const connection of connectionsWithLabels) {
          const fromItem = items.find(i => i.id === connection.fromItem);
          const toItem = items.find(i => i.id === connection.toItem);
          
          // Calculate midpoint position
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
            labelX = (centerFrom.x + centerTo.x) / 2 - 60;
            labelY = (centerFrom.y + centerTo.y) / 2 - 25;
          }
          
          // Create new Text item for the label
          const labelItem = {
            id: foundry.utils.randomID(),
            type: 'Text',
            label: 'Connection Label',
            x: labelX,
            y: labelY,
            color: '#000000',
            data: {
              text: connection.label,
              font: board.defaultFont || 'Arial',
              textColor: board.defaultFontColor || '#000000',
              fontSize: 14,
              width: 120,
              height: 50,
            },
          };
          newItems.push(labelItem);
          itemIds.add(labelItem.id); // Add to set so PHASE 2 recognizes it
          
          // Update connection to reference new Text item and mark as migrated
          connection.labelItemId = labelItem.id;
          connection.labelOffsetX = 0;
          connection.labelOffsetY = 0;
          connection._wasMigrated = true;
          
          console.log(`%c      ✓ Migrated label: "${connection.label.substring(0, 30)}${connection.label.length > 30 ? '...' : ''}"`, 'color: #4CAF50');
          totalLabelsConverted++;
        }
      }
      
      // PHASE 2: Repair orphaned labelItemId references (connection points to item that doesn't exist)
      // This includes connections that were already migrated (_wasMigrated: true) but lost their Text items
      const orphanedConnections = connections.filter(c => c.labelItemId && !itemIds.has(c.labelItemId));
      
      // PHASE 2B: Handle failed migrations - connections marked _wasMigrated but have no labelItemId (migration didn't complete)
      const failedMigrations = connections.filter(c => c._wasMigrated && !c.labelItemId && c.label && c.label.trim());
      
      const allOrphanedConnections = [...orphanedConnections, ...failedMigrations];
      
      if (allOrphanedConnections.length > 0) {
        if (!boardHasChanges) {
          console.log(`%c  📋 Board: "${board.name}" (${board.id})`, 'color: #FF9800; font-weight: bold');
        }
        console.log(`%c    Found ${allOrphanedConnections.length} connection(s) with missing label items (repairing...)`, 'color: #FF9800');
        boardHasChanges = true;
        
        for (const connection of allOrphanedConnections) {
          // Recreate items for connections that have actual label text (either new or previously migrated)
          if (connection.label && connection.label.trim()) {
            const fromItem = items.find(i => i.id === connection.fromItem);
            const toItem = items.find(i => i.id === connection.toItem);
            
            // Calculate midpoint position
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
              labelX = (centerFrom.x + centerTo.x) / 2 - 60;
              labelY = (centerFrom.y + centerTo.y) / 2 - 25;
            }
            
            // Create new Text item for the missing label with the original label text
            const labelItem = {
              id: foundry.utils.randomID(),
              type: 'Text',
              label: 'Connection Label',
              x: labelX,
              y: labelY,
              color: '#000000',
              data: {
                text: connection.label,
                font: board.defaultFont || 'Arial',
                textColor: board.defaultFontColor || '#000000',
                fontSize: 14,
                width: 120,
                height: 50,
              },
            };
            newItems.push(labelItem);
            
            // Update connection with new item ID
            connection.labelItemId = labelItem.id;
            
            console.log(`%c      ✓ Recreated missing label item: "${connection.label.substring(0, 30)}${connection.label.length > 30 ? '...' : ''}"`, 'color: #4CAF50');
            totalLabelsConverted++;
          } else {
            // Clear orphaned reference if there's no text to recover
            connection.labelItemId = null;
            console.log(`%c      ✓ Cleared orphaned label reference (no text to recover)`, 'color: #FFC107');
          }
        }
      }
      
      // Add all new items to board if any were created
      if (newItems.length > 0) {
        board.items = [...items, ...newItems];
      }
    }

    // Save migrated boards back to storage if any changes were made
    if (totalBoardsMigrated > 0 || totalLabelsConverted > 0) {
      await game.settings.set(MODULE_ID, 'globalBoards', globalBoards);
      
      console.log('%c────────────────────────────────────────────────────', 'color: #9C27B0');
      console.log('%c✓ CONNECTION LABEL MIGRATION COMPLETE!', 'color: #4CAF50; font-weight: bold; font-size: 14px');
      if (totalLabelsConverted > 0) {
        console.log(`%c  ${totalLabelsConverted} connection label(s) converted/repaired`, 'color: #4CAF50');
      }
      console.log('%c════════════════════════════════════════', 'color: #9C27B0; font-weight: bold');
      
      if (totalLabelsConverted > 0) {
        ui.notifications.info(`Murder Board: Migrated/repaired ${totalLabelsConverted} connection label(s)`);
      }
    } else {
      console.log('%c────────────────────────────────────────────────────', 'color: #9C27B0');
      console.log('%c⊘ No connection labels to migrate or repair', 'color: #FFC107; font-weight: bold');
      console.log('%c════════════════════════════════════════', 'color: #9C27B0; font-weight: bold');
    }

    // Mark migration as complete
    await game.settings.set(MODULE_ID, 'connectionLabelMigrationVersion', 1);
  } catch (error) {
    console.error('%c[Murder Board] ✗ ERROR during connection label migration:', 'color: #f44336; font-weight: bold', error);
    ui.notifications.error('Murder Board: Failed to migrate connection labels. Please check console for details.');
  }
}

// ============================================================================
// SCENE CONTROLS
// ============================================================================

Hooks.on('getSceneControlButtons', (controls) => {
  controls['murder-board'] = {
    name: 'murder-board',
    title: game.i18n.localize('MURDER_BOARD.Title'),
    icon: 'fas fa-clipboard-list',
    layer: 'murder-board',
    tools: [
      {
        name: 'about',
        title: 'About Murder Board',
        icon: 'fas fa-info-circle',
        button: true,
        onClick: () => {
          ui.notifications.info('Murder Board v1.0 - A collaborative investigation tracking interface for Foundry VTT');
        },
      },
    ],
  };
});

// Handle direct click on Murder Board control button to open/close
Hooks.on('renderSceneControls', () => {
  const murderBoardBtn = document.querySelector('[data-control="murder-board"]');
  if (murderBoardBtn) {
    murderBoardBtn.addEventListener('click', (e) => {
      // Only trigger if clicking the main control button, not the tools
      if (e.target === murderBoardBtn || e.target.closest('[data-control="murder-board"]') === murderBoardBtn) {
        e.preventDefault();
        e.stopPropagation();
        
        const scene = game.scenes.active;
        if (!scene) {
          ui.notifications.warn('No active scene');
          return;
        }
        
        // Check if a Murder Board window is already open for this scene
        const existingApp = Object.values(ui.windows).find(
          w => w.constructor.name === 'MurderBoardApplication' && w.scene?.id === scene.id
        );
        
        if (existingApp) {
          // Window is open, close it
          existingApp.close();
        } else {
          // Window is not open, create and render it
          const app = new game.murderBoard.MurderBoardApplication({ scene });
          app.render(true);
        }
      }
    }, true); // Use capture phase to intercept early
  }
});

// ============================================================================
// GLOBAL DEBUG UTILITIES
// ============================================================================

// ============================================================================
// GLOBAL DEBUG UTILITIES
// ============================================================================

/**
 * Global helper to show Murder Board information and diagnostics
 */
globalThis.murderBoardDebug = {
  activeApp: null,

  /**
   * Show board info summary
   */
  info() {
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
  },

  /**
   * Show detailed board diagnostics
   * Includes item and connection details
   */
  diagnostics() {
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
  },

  /**
   * Shorthand for diagnostics
   */
  diag() {
    return this.diagnostics();
  },
};
