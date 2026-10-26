// A field seed is optional UI input, not the extent of a search. Never read a
// whole selection just to discover that it cannot be used as that input.
const MAX_SELECTION_QUERY_UNITS = 64 * 1024;
const MAX_OCCURRENCE_SELECTIONS = 2000;

function selectionQueryError() {
  return Object.assign(new Error("The selection is too large for a search field."), {
    code: "ERR_SELECTION_QUERY_TOO_LARGE",
    detail:
      "Use a shorter selection to fill this field. Searching within the full selection remains available.",
  });
}

function getSelectionText(subject, { singleLine = false, automatic = false } = {}) {
  if (!subject?.getSelectedText) return "";
  const range = subject.getSelectedBufferRange?.();
  if (singleLine && range?.start?.row !== range?.end?.row) return "";
  const buffer = subject.getBuffer?.();
  if (range?.start && range?.end && buffer?.characterIndexForPosition) {
    const length =
      buffer.characterIndexForPosition(range.end) - buffer.characterIndexForPosition(range.start);
    if (length > MAX_SELECTION_QUERY_UNITS) {
      if (automatic) return "";
      throw selectionQueryError();
    }
  }
  try {
    const text = subject.getSelectedText();
    if (text.length > MAX_SELECTION_QUERY_UNITS) {
      if (automatic) return "";
      throw selectionQueryError();
    }
    return singleLine && text.includes("\n") ? "" : text;
  } catch (error) {
    // Legacy adapters only expose a string getter. A failed optional seed
    // must not stop the panel from opening; explicit commands still report it.
    if (automatic) return "";
    throw error;
  }
}

function assertWordQueryBudget(subject, allCursors = false) {
  const buffer = subject?.getBuffer?.();
  const positions =
    allCursors && subject.getCursors
      ? subject.getCursors().map((cursor) => cursor.getBufferPosition())
      : [subject?.getCursorBufferPosition?.()];
  for (const position of positions)
    if (position && buffer?.lineLengthForRow(position.row) > MAX_SELECTION_QUERY_UNITS)
      throw Object.assign(new Error("The current line is too large for automatic word lookup."), {
        code: "ERR_SELECTION_QUERY_TOO_LARGE",
        detail: "Select a shorter exact text fragment, then search for that selection.",
      });
}

function getWordText(subject) {
  assertWordQueryBudget(subject);
  const text = subject?.getWordUnderCursor?.() ?? "";
  if (text.length > MAX_SELECTION_QUERY_UNITS) throw selectionQueryError();
  return text;
}

function reportQueryError(error, view) {
  view?.setErrorMessage(error.message);
  lumine.notifications.addWarning(error.message, {
    detail: error.detail,
    dismissable: true,
  });
}

module.exports = {
  MAX_SELECTION_QUERY_UNITS,
  MAX_OCCURRENCE_SELECTIONS,
  getSelectionText,
  getWordText,
  assertWordQueryBudget,
  reportQueryError,
};
