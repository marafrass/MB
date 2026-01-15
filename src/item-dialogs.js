/**
 * Item Dialogs for Murder Board
 * Separate ApplicationV2 dialogs for each item type (Note, Image, Document)
 */

import { MurderBoardData } from './data-model.js';
import { emitSocketMessage } from './socket-handler.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * Register Handlebars helpers for Murder Board
 */
export function registerMurderBoardHelpers() {
  // File picker helper for selecting images/documents
  Handlebars.registerHelper('file-picker', function(options) {
    const { type = 'image', buttonClass = 'murder-board-btn' } = options.hash;
    const html = `<button type="button" class="${buttonClass} murder-board-btn-secondary file-picker-btn" data-file-type="${type}" style="width: 100%;"><i class="fas fa-folder-open"></i>Browse Server</button>`;
    return new Handlebars.SafeString(html);
  });
}

/**
 * Base class for item dialogs
 */
export class ItemDialogBase extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'murder-board-item-dialog',
    tag: 'div',
    classes: ['murder-board-item-dialog'],
    window: {
      icon: 'fas fa-note-sticky',
      title: 'MURDER_BOARD.Dialogs.AddNote',
      resizable: true,
    },
    position: {
      width: 600,
      height: 700,
    },
  };

  constructor(scene, itemId = null, options = {}) {
    super(options);
    this.scene = scene;
    this.itemId = itemId;
    this.isEdit = !!itemId;
    // Store prefilled coordinates from options if provided
    this.prefilledCoords = options.prefilledCoords || null;
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

  async _prepareContext(options) {
    let item = null;
    if (this.isEdit && this.itemId) {
      item = MurderBoardData.getItem(this.scene, this.itemId);
    }

    // Get default x, y or use prefilled coordinates
    let x = 0, y = 0;
    if (this.prefilledCoords) {
      x = this.prefilledCoords.x;
      y = this.prefilledCoords.y;
    }

    return {
      label: (item && item.label) || '',
      color: (item && item.color) || '#FFFFFF', // Default to white
      data: (item && item.data) || {},
      x: (item && item.x !== undefined) ? item.x : x,
      y: (item && item.y !== undefined) ? item.y : y,
      acceptsConnections: item ? item.acceptsConnections !== false : true, // Default to true
    };
  }

  async _onRender(context, options) {
    // Call parent render handler
    await super._onRender(context, options);

    // Initialize all event listeners
    this._initializeEventListeners();
    this._initializeSelects();
    this._initializeColorPickers();
    this._initializeFontSelects();
    this._initializeColorPickerUpdates();
  }

  /**
   * Initialize event listeners for form submission and cancel button
   * Centralizes event setup to reduce _onRender complexity
   * @private
   */
  _initializeEventListeners() {
    const form = this.element.querySelector('form');
    if (form) {
      form.addEventListener('submit', this._handleFormSubmit.bind(this));
    }
    
    const cancelBtn = this.element.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }
  }

  /**
   * Initialize select dropdown display values
   * Ensures selected options render properly
   * @private
   */
  _initializeSelects() {
    const selects = this.element.querySelectorAll('select');
    selects.forEach(select => {
      if (select.value) {
        select.value = select.value; // Force browser to re-render selected option
      }
    });
  }

  /**
   * Initialize custom color picker inputs
   * Syncs HTML5 color picker with radio button field for form submission
   * @private
   */
  _initializeColorPickers() {
    const colorInputs = this.element.querySelectorAll('.color-picker-input');
    colorInputs.forEach(input => {
      const fieldName = input.dataset.fieldName;
      if (!fieldName) return;

      const form = this.element.querySelector('form');
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
   * Initialize file picker buttons
   * Attaches click handlers to all file picker buttons
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
   * Initialize font select dropdowns
   * Ensures the display label stays in sync with the actual select value
   * @private
   */
  _initializeFontSelects() {
    const fontSelectWrappers = this.element.querySelectorAll('.font-select-wrapper');
    fontSelectWrappers.forEach(wrapper => {
      const select = wrapper.querySelector('select');
      const display = wrapper.querySelector('.font-display');
      
      if (!select || !display) return;
      
      // Update display text when select changes
      const updateDisplay = () => {
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption) {
          display.textContent = selectedOption.textContent;
        }
      };
      
      // Set initial display value
      updateDisplay();
      
      // Listen for changes
      select.addEventListener('change', updateDisplay);
    });
  }

  /**
   * Initialize color picker updates for swatches
   * When a color is picked from the custom input, update the palette and refresh swatches
   * @private
   */
  _initializeColorPickerUpdates() {
    const colorInputs = this.element.querySelectorAll('input[type="color"].color-picker-input');
    colorInputs.forEach(input => {
      input.addEventListener('change', async (e) => {
        const selectedColor = e.target.value;
        const fieldName = e.target.dataset.fieldName;
        
        // Add color to palette immediately
        game.murderBoard.ColorManager.addColorToPalette(selectedColor);
        
        // Update the swatches for this field
        const swatchContainer = input.closest('.color-picker-inline').querySelector('.color-swatches');
        if (swatchContainer) {
          this._updatePaletteSatches(swatchContainer, fieldName, selectedColor);
        }
      });
    });
  }

  /**
   * Update the displayed swatches with the current palette
   * @private
   */
  _updatePaletteSatches(swatchContainer, fieldName, currentColor) {
    const palette = game.murderBoard.ColorManager.getColorPalette();
    
    // Clear existing swatches
    swatchContainer.innerHTML = '';
    
    // Recreate swatches with updated palette
    palette.forEach((color, index) => {
      const radioId = `${fieldName}-${index}`;
      
      // Create radio input
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.id = radioId;
      radio.name = fieldName;
      radio.value = color;
      radio.className = 'color-radio';
      if (color === currentColor) {
        radio.checked = true;
      }
      
      // Create label/swatch
      const label = document.createElement('label');
      label.htmlFor = radioId;
      label.className = 'swatch';
      label.style.backgroundColor = color;
      label.title = color;
      
      swatchContainer.appendChild(radio);
      swatchContainer.appendChild(label);
    });
  }

  async _handleFormSubmit(event) {
    event.preventDefault();
    
    try {
      const formData = new FormData(event.target);
      await this._onSubmitForm(formData);
    } catch (error) {
      console.error('Murder Board | Error in form submission:', error);
    }
  }

  async _onSubmitForm(formData) {
    // Override in subclasses
    throw new Error('_onSubmitForm must be implemented by subclass');
  }

  /**
   * Get available fonts from Foundry VTT
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
      const fallbackFonts = [
        { value: 'Arial', label: 'Arial (Clean)', family: 'Arial' },
        { value: 'Georgia', label: 'Georgia (Serif)', family: 'Georgia' },
        { value: 'Courier New', label: 'Courier (Monospace)', family: 'Courier New' },
        { value: 'Comic Sans MS', label: 'Comic Sans (Casual)', family: 'Comic Sans MS' },
        { value: 'Caveat', label: 'Caveat (Handwriting)', family: 'Caveat' },
        { value: 'Permanent Marker', label: 'Permanent Marker (Marker)', family: 'Permanent Marker' },
        { value: 'Reenie Beanie', label: 'Reenie Beanie (Sketch)', family: 'Reenie Beanie' }
      ];
      fonts.push(...fallbackFonts);
    }

    return fonts;
  }

  /**
   * Get recent colors formatted consistently for template
   * Converts string colors to objects with value property
   * @returns {Array} Array of color objects with value property
   * @private
   */
  _getFormattedColorPalette() {
    const palette = game.murderBoard.ColorManager.getColorPalette();
    return palette.map(color => ({ value: color }));
  }
}

/**
 * Dialog for Sticky Notes
 */
export class NoteItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    window: {
      icon: 'fas fa-note-sticky',
      title: 'MURDER_BOARD.Dialogs.AddNote',
    },
  };

  get title() {
    return this.isEdit ? game.i18n.localize('MURDER_BOARD.Dialogs.EditNote') : game.i18n.localize('MURDER_BOARD.Dialogs.AddNote');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/item-note.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    // Ensure data has default font value - use board default for new items
    if (!baseContext.data.font) {
      const boardData = MurderBoardData.getGlobalBoardData();
      baseContext.data.font = boardData.defaultFont || 'Arial';
    }
    if (!baseContext.data.textColor) {
      baseContext.data.textColor = '#000000';
    }

    // Get available fonts from Foundry
    const availableFonts = this._getAvailableFonts();
    baseContext.availableFonts = availableFonts;

    // Post-it note colors
    baseContext.noteColors = [
      { value: '#FFFF99', label: 'Yellow', title: 'Yellow' },
      { value: '#FFB6C1', label: 'Pink', title: 'Pink' },
      { value: '#90EE90', label: 'Green', title: 'Green' },
    ];

    // Get user's color palette
    baseContext.colors = this._getFormattedColorPalette();

    return baseContext;
  }

  async _onRender(context, options) {
    // Call parent render handler
    await super._onRender(context, options);
  }

  async _onSubmitForm(formData) {
    try {
      const x = parseFloat(formData.get('x')) || 0;
      const y = parseFloat(formData.get('y')) || 0;
      const noteColor = formData.get('color') || '#FFFF99';
      const textColor = formData.get('textColor') || '#000000';
      
      // Track newly used colors in palette
      game.murderBoard.ColorManager.addColorToPalette(noteColor);
      game.murderBoard.ColorManager.addColorToPalette(textColor);
      
      const data = {
        type: 'Note',
        label: formData.get('label') || 'Note',
        color: noteColor,
        x: x,
        y: y,
        acceptsConnections: formData.get('acceptsConnections') === 'on',
        data: {
          textColor: textColor,
          font: formData.get('font') || 'Arial',
        },
      };

      if (this.isEdit) {
        // When editing, only pass the fields that changed - updateItem will preserve everything else
        await MurderBoardData.updateItem(this.scene, this.itemId, {
          label: data.label,
          color: noteColor,
          acceptsConnections: data.acceptsConnections,
          data: {
            textColor: textColor,
            font: formData.get('font') || 'Arial',
          },
        });
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'));
      } else {
        await MurderBoardData.addItem(this.scene, data);
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'));
      }

      // Refresh the main board to show new/updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in NoteItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Dialog for Text
 */
export class TextItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    window: {
      icon: 'fas fa-font',
      title: 'MURDER_BOARD.Dialogs.AddText',
    },
  };

  get title() {
    return this.isEdit ? game.i18n.localize('MURDER_BOARD.Dialogs.EditText') : game.i18n.localize('MURDER_BOARD.Dialogs.AddText');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/item-text.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    
    // Text items should NOT accept connections by default
    baseContext.acceptsConnections = false;
    
    // Ensure data has default values - use board default font for new items
    if (!baseContext.data.font) {
      const boardData = MurderBoardData.getGlobalBoardData();
      baseContext.data.font = boardData.defaultFont || 'Arial';
    }
    if (!baseContext.data.textColor) {
      baseContext.data.textColor = '#000000';
    }
    if (!baseContext.data.fontSize) {
      baseContext.data.fontSize = 14;
    }
    if (!baseContext.data.width) {
      baseContext.data.width = 200;
    }
    if (!baseContext.data.height) {
      baseContext.data.height = 100;
    }

    // Get available fonts from Foundry
    const availableFonts = this._getAvailableFonts();
    baseContext.availableFonts = availableFonts;

    // Text colors
    baseContext.textColors = [
      { value: '#000000', label: 'Black', title: 'Black' },
      { value: '#FFFFFF', label: 'White', title: 'White' },
      { value: '#CC0000', label: 'Red', title: 'Red' },
    ];

    // Get user's color palette
    baseContext.colors = this._getFormattedColorPalette();

    return baseContext;
  }

  async _onRender(context, options) {
    // Call parent render handler
    await super._onRender(context, options);
  }

  async _onSubmitForm(formData) {
    try {
      const x = parseFloat(formData.get('x')) || 0;
      const y = parseFloat(formData.get('y')) || 0;
      const textColor = formData.get('textColor') || '#000000';
      
      // Track color in palette
      game.murderBoard.ColorManager.addColorToPalette(textColor);
      
      const data = {
        type: 'Text',
        label: formData.get('label') || 'Text',
        x: x,
        y: y,
        acceptsConnections: formData.get('acceptsConnections') === 'on',
        data: {
          textColor: textColor,
          font: formData.get('font') || 'Arial',
          fontSize: parseInt(formData.get('fontSize')) || 14,
        },
      };

      if (this.isEdit) {
        // When editing, only pass the fields that changed - updateItem will preserve everything else
        await MurderBoardData.updateItem(this.scene, this.itemId, {
          label: data.label,
          acceptsConnections: data.acceptsConnections,
          data: {
            textColor: textColor,
            font: formData.get('font') || 'Arial',
            fontSize: parseInt(formData.get('fontSize')) || 14,
          },
        });
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'));
      } else {
        await MurderBoardData.addItem(this.scene, data);
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'));
      }

      // Refresh the main board to show new/updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in TextItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Dialog for Images
 */
export class ImageItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    window: {
      icon: 'fas fa-image',
      title: 'MURDER_BOARD.Dialogs.AddImage',
    },
    position: {
      width: 750,
      height: 'auto',
    },
  };

  get title() {
    return this.isEdit ? game.i18n.localize('MURDER_BOARD.Dialogs.EditImage') : game.i18n.localize('MURDER_BOARD.Dialogs.AddImage');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/item-image.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);

    // Border color options
    baseContext.borderOptions = [
      { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
      { value: 'none', label: 'None' },
    ];

    // Fastener options
    baseContext.fastenerOptions = [
      { value: 'pushpin', label: 'Pushpin', icon: 'fas fa-thumbtack' },
      { value: 'tape-top', label: 'Top', icon: 'fas fa-rectangle-landscape' },
      { value: 'tape-top-bottom', label: 'Top & Bot', icon: 'fas fa-square' },
      { value: 'tape-all-corners', label: 'Tape All Corners', icon: 'fas fa-expand' },
    ];

    // Get user's color palette
    baseContext.colors = this._getFormattedColorPalette();

    return baseContext;
  }

  async _onRender(context, options) {
    // Call parent render handler
    await super._onRender(context, options);

    // Setup file picker button handlers
    this._initializeFilePickers();

    // Accordion toggle handlers
    const accordionToggles = this.element.querySelectorAll('.accordion-toggle');
    accordionToggles.forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        const sectionId = toggle.dataset.section;
        const content = this.element.querySelector(`#${sectionId}`);
        if (content) {
          content.classList.toggle('active');
          toggle.classList.toggle('active');
        }
      });
    });
  }

  async _onSubmitForm(formData) {
    try {
      const imageUrl = formData.get('imageUrl');

      if (!imageUrl) {
        ui.notifications.warn('Please provide an image URL');
        return;
      }

      const x = parseFloat(formData.get('x')) || 0;
      const y = parseFloat(formData.get('y')) || 0;

      const data = {
        type: 'Image',
        label: formData.get('label') || 'Image',
        color: formData.get('color') || '#FFFFFF',
        x: x,
        y: y,
        acceptsConnections: formData.get('acceptsConnections') === 'on',
        data: {
          imageUrl: imageUrl,
          borderColor: formData.get('borderColor') || 'white',
          fastenerType: formData.get('fastenerType') || 'pushpin',
        },
      };

      if (this.isEdit) {
        // When editing, only pass the fields that changed - updateItem will preserve everything else
        await MurderBoardData.updateItem(this.scene, this.itemId, {
          label: data.label,
          acceptsConnections: data.acceptsConnections,
          data: {
            imageUrl: imageUrl,
            borderColor: formData.get('borderColor') || 'white',
            fastenerType: formData.get('fastenerType') || 'pushpin',
          },
        });
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'));
      } else {
        await MurderBoardData.addItem(this.scene, data);
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'));
      }

      // Refresh the main board to show new/updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in ImageItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Dialog for Documents
 */
export class DocumentItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    window: {
      icon: 'fas fa-file',
      title: 'MURDER_BOARD.Dialogs.AddDocument',
    },
    position: {
      width: 700,
      height: 'auto',
    },
  };

  get title() {
    return this.isEdit ? game.i18n.localize('MURDER_BOARD.Dialogs.EditDocument') : game.i18n.localize('MURDER_BOARD.Dialogs.AddDocument');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/item-document.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    // Ensure data has default preset, size, and font values
    if (!baseContext.data.preset) {
      baseContext.data.preset = 'blank';
    }
    if (!baseContext.data.font) {
      const boardData = MurderBoardData.getGlobalBoardData();
      baseContext.data.font = boardData.defaultFont || 'Arial';
    }
    
    // Preload color for legal pad preset
    if (baseContext.data.preset === 'legal' && !this.isEdit) {
      baseContext.color = '#FFFF89';
    }

    // Get available fonts from Foundry
    const availableFonts = this._getAvailableFonts();
    baseContext.availableFonts = availableFonts;

    // Document preset/type options (kept for backwards compatibility with existing items)
    baseContext.documentPresetOptions = [
      { value: 'blank', label: 'Blank', icon: 'fas fa-file' },
      { value: 'looseleaf', label: 'Loose Leaf', icon: 'fas fa-lines-leaning' },
      { value: 'grid', label: 'Grid', icon: 'fas fa-border-all' },
      { value: 'legal', label: 'Legal Pad', icon: 'fas fa-sticky-note' },
      { value: 'spiral', label: 'Spiral', icon: 'fas fa-book' },
    ];

    // Get recently used colors
    baseContext.colors = this._getFormattedColorPalette();

    return baseContext;
  }

  async _onSubmitForm(formData) {
    try {
      const x = parseFloat(formData.get('x')) || 0;
      const y = parseFloat(formData.get('y')) || 0;
      const rotation = parseFloat(formData.get('rotation')) || 0;
      const documentColor = formData.get('color') || '#FFFFFF';
      
      // Get existing item if editing to preserve all data
      let existingItem = null;
      if (this.isEdit && this.itemId) {
        existingItem = MurderBoardData.getItem(this.scene, this.itemId);
      }
      
      // Track color in palette
      game.murderBoard.ColorManager.addColorToPalette(documentColor);

      const data = {
        type: 'Document',
        label: formData.get('label') || 'Document',
        color: documentColor,
        x: x,
        y: y,
        acceptsConnections: formData.get('acceptsConnections') === 'on',
        data: {
          preset: formData.get('preset') || 'blank',
          font: formData.get('font') || 'Arial',
          rotation: rotation,
        },
      };

      if (this.isEdit) {
        // When editing, only pass the fields that changed - updateItem will preserve everything else
        await MurderBoardData.updateItem(this.scene, this.itemId, {
          label: data.label,
          color: documentColor,
          acceptsConnections: data.acceptsConnections,
          data: {
            preset: formData.get('preset') || 'blank',
            font: formData.get('font') || 'Arial',
            rotation: rotation,
          },
        });
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'));
      } else {
        await MurderBoardData.addItem(this.scene, data);
        ui.notifications.info(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'));
      }

      // Refresh the main board to show new/updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in DocumentItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Quick Note Dialog - Minimal single-input form for fast note creation
 */
export class QuickNoteItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    classes: ['murder-board-item-dialog', 'murder-board-quick-dialog'],
    window: {
      icon: 'fas fa-note-sticky',
      title: 'MURDER_BOARD.Dialogs.AddNote',
    },
    position: {
      width: 400,
      height: 'auto',
    },
  };

  get title() {
    return this.isEdit 
      ? game.i18n.localize('MURDER_BOARD.Dialogs.EditNote')
      : game.i18n.localize('MURDER_BOARD.Dialogs.AddNote');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/quick-note.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    return baseContext;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
  }

  async _onSubmitForm(formData) {
    try {
      if (this.isEdit && this.itemId) {
        // Edit mode - update existing item
        const updates = {
          label: formData.get('label') || 'Note',
        };
        
        await MurderBoardData.updateItem(this.scene, this.itemId, updates);
        
        // Broadcast to other clients
        emitSocketMessage('updateItem', {
          sceneId: this.scene.id,
          itemId: this.itemId,
          updates: updates,
        });
        
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'), 'info');
      } else {
        // Add mode - create new item
        const x = parseFloat(formData.get('x')) || 0;
        const y = parseFloat(formData.get('y')) || 0;
        
        // Get default font color from board settings
        const boardData = MurderBoardData.getGlobalBoardData();
        const defaultFontColor = boardData.defaultFontColor || '#000000';
        const defaultFont = boardData.defaultFont || 'Arial';
        
        const data = {
          type: 'Note',
          label: formData.get('label') || 'Note',
          color: '#FFFF99', // Default yellow post-it
          x: x,
          y: y,
          acceptsConnections: false,
          data: {
            textColor: defaultFontColor,
            font: defaultFont,
          },
        };

        await MurderBoardData.addItem(this.scene, data);
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'), 'info');
      }

      // Refresh the main board to show updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in QuickNoteItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Quick Text Dialog - Minimal single-input form for fast text creation
 */
export class QuickTextItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    classes: ['murder-board-item-dialog', 'murder-board-quick-dialog'],
    window: {
      icon: 'fas fa-font',
      title: 'MURDER_BOARD.Dialogs.AddText',
    },
    position: {
      width: 400,
      height: 'auto',
    },
  };

  get title() {
    return this.isEdit 
      ? game.i18n.localize('MURDER_BOARD.Dialogs.EditText')
      : game.i18n.localize('MURDER_BOARD.Dialogs.AddText');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/quick-text.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    return baseContext;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
  }

  async _onSubmitForm(formData) {
    try {
      if (this.isEdit && this.itemId) {
        // Edit mode - update existing item
        const updates = {
          data: {
            text: formData.get('text') || '',
          },
        };
        
        await MurderBoardData.updateItem(this.scene, this.itemId, updates);
        
        // Broadcast to other clients
        emitSocketMessage('updateItem', {
          sceneId: this.scene.id,
          itemId: this.itemId,
          updates: updates,
        });
        
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'), 'info');
      } else {
        // Add mode - create new item
        const x = parseFloat(formData.get('x')) || 0;
        const y = parseFloat(formData.get('y')) || 0;
        
        // Get default font color from board settings
        const boardData = MurderBoardData.getGlobalBoardData();
        const defaultFontColor = boardData.defaultFontColor || '#000000';
        const defaultFont = boardData.defaultFont || 'Arial';
        
        const data = {
          type: 'Text',
          label: formData.get('label') || 'Text',
          x: x,
          y: y,
          acceptsConnections: false,
          data: {
            textColor: defaultFontColor,
            font: defaultFont,
            fontSize: 14,
          },
        };

        await MurderBoardData.addItem(this.scene, data);
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'), 'info');
      }

      // Refresh the main board to show updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in QuickTextItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}

/**
 * Quick Document Dialog - Minimal single-input form for fast document text editing
 */
export class QuickDocumentItemDialog extends ItemDialogBase {
  static DEFAULT_OPTIONS = {
    ...ItemDialogBase.DEFAULT_OPTIONS,
    classes: ['murder-board-item-dialog', 'murder-board-quick-dialog'],
    window: {
      icon: 'fas fa-file',
      title: 'MURDER_BOARD.Dialogs.AddDocument',
    },
    position: {
      width: 400,
      height: 'auto',
    },
  };

  get title() {
    return this.isEdit 
      ? game.i18n.localize('MURDER_BOARD.Dialogs.EditDocument')
      : game.i18n.localize('MURDER_BOARD.Dialogs.AddDocument');
  }

  static PARTS = {
    form: {
      template: 'modules/murder-board/templates/quick-document.hbs',
    },
  };

  async _prepareContext(options) {
    const baseContext = await super._prepareContext(options);
    
    // Ensure data.text exists (for backwards compatibility with old Documents)
    if (!baseContext.data) {
      baseContext.data = {};
    }
    if (baseContext.data.text === undefined) {
      // Initialize from label if text doesn't exist
      baseContext.data.text = baseContext.label || '';
    }
    
    return baseContext;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
  }

  async _onSubmitForm(formData) {
    try {
      if (this.isEdit && this.itemId) {
        // Edit mode - update existing item's text
        const updates = {
          data: {
            text: formData.get('text') || '',
          },
        };
        
        await MurderBoardData.updateItem(this.scene, this.itemId, updates);
        
        // Broadcast to other clients
        emitSocketMessage('updateItem', {
          sceneId: this.scene.id,
          itemId: this.itemId,
          updates: updates,
        });
        
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemUpdated'), 'info');
      } else {
        // Add mode - create new item
        const x = parseFloat(formData.get('x')) || 0;
        const y = parseFloat(formData.get('y')) || 0;
        
        // Get default font from board settings
        const boardData = MurderBoardData.getGlobalBoardData();
        const defaultFont = boardData.defaultFont || 'Arial';
        
        const data = {
          type: 'Document',
          label: 'Document',
          color: '#FFFEF5',
          x: x,
          y: y,
          acceptsConnections: false,
          data: {
            text: formData.get('text') || '',
            preset: 'blank',
            font: defaultFont,
            width: 200,
            height: 260,
          },
        };

        await MurderBoardData.addItem(this.scene, data);
        this._notify(game.i18n.localize('MURDER_BOARD.Notifications.ItemAdded'), 'info');
      }

      // Refresh the main board to show updated items
      if (game.murderBoard.mainBoard) {
        game.murderBoard.mainBoard.renderer.refresh();
        game.murderBoard.mainBoard.renderer.draw();
      }

      this.close();
    } catch (error) {
      console.error('Murder Board | Error in QuickDocumentItemDialog:', error);
      ui.notifications.error('Error: ' + error.message);
    }
  }
}