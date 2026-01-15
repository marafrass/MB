/**
 * Handlebars Helpers for Murder Board
 */

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
