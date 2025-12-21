/**
 * Murder Board - Main Module Entry Point
 * A collaborative investigation tracking interface for Foundry VTT
 */

import { MurderBoardData } from './data-model.js';
import { MurderBoardApplication } from './application.js';
import { initializeSocketHandler } from './socket-handler.js';
import { registerMurderBoardHelpers } from './item-dialogs.js';

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

  // Theme is now handled entirely by CSS based on Foundry's native dark mode (body.dark-mode class)
  // No custom theme setting needed - the stylesheet automatically switches when dark mode is toggled
}

// ============================================================================
// READY HOOK
// ============================================================================

Hooks.once('socketlib.ready', () => {
  initializeSocketHandler();
});

Hooks.once('ready', () => {
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
