const { CompositeDisposable, Range } = require("lumine");
const { escapeRegExp } = require("./helpers");
const {
  getSelectionText,
  assertWordQueryBudget,
  MAX_OCCURRENCE_SELECTIONS,
  reportQueryError,
} = require("./selection-query");

// Find and select the next occurrence of the currently selected text.
//
// The word under the cursor will be selected if the selection is empty.
module.exports = class SelectNext {
  constructor(editor) {
    this.editor = editor;
    this.selectionRanges = [];
  }

  runQueryAction(callback) {
    try {
      return callback();
    } catch (error) {
      reportQueryError(error);
      return false;
    }
  }

  findAndSelectNext() {
    return this.runQueryAction(() =>
      this.editor.getLastSelection().isEmpty() ? this.selectWord() : this.selectNextOccurrence(),
    );
  }

  findAndSelectAll() {
    return this.runQueryAction(() => {
      if (this.editor.getLastSelection().isEmpty()) this.selectWord();
      return this.selectAllOccurrences();
    });
  }

  undoLastSelection() {
    this.updateSavedSelections();

    if (this.selectionRanges.length < 1) {
      return;
    }

    if (this.selectionRanges.length > 1) {
      this.selectionRanges.pop();
      this.editor.setSelectedBufferRanges(this.selectionRanges);
    } else {
      this.editor.clearSelections();
    }

    return this.editor.scrollToCursorPosition({ mode: "nearest" });
  }

  skipCurrentSelection() {
    return this.runQueryAction(() => {
      getSelectionText(this.editor);
      return this.skipCurrentSelectionAfterPreflight();
    });
  }

  skipCurrentSelectionAfterPreflight() {
    this.updateSavedSelections();

    if (this.selectionRanges.length < 1) {
      return;
    }

    if (this.selectionRanges.length > 1) {
      const lastSelection = this.selectionRanges.pop();
      this.editor.setSelectedBufferRanges(this.selectionRanges);
      return this.selectNextOccurrence({ start: lastSelection.end });
    } else {
      this.selectNextOccurrence();
      this.selectionRanges.shift();
      if (this.selectionRanges.length < 1) {
        return;
      }
      return this.editor.setSelectedBufferRanges(this.selectionRanges);
    }
  }

  selectWord() {
    assertWordQueryBudget(this.editor, true);
    this.editor.selectWordsContainingCursors();
    const lastSelection = this.editor.getLastSelection();
    if ((this.wordSelected = this.isWordSelected(lastSelection))) {
      const disposables = new CompositeDisposable();
      const clearWordSelected = () => {
        this.wordSelected = null;
        return disposables.dispose();
      };
      disposables.add(lastSelection.onDidChangeRange(clearWordSelected));
      return disposables.add(lastSelection.onDidDestroy(clearWordSelected));
    }
  }

  selectAllOccurrences() {
    const ranges = new Map(
      this.editor.getSelectedBufferRanges().map((range) => [range.toString(), range]),
    );
    let tooMany = ranges.size > MAX_OCCURRENCE_SELECTIONS;
    if (!tooMany)
      this.scanForNextOccurrence(
        [[0, 0], this.editor.getEofBufferPosition()],
        ({ range, stop }) => {
          ranges.set(range.toString(), range);
          if (ranges.size > MAX_OCCURRENCE_SELECTIONS) {
            tooMany = true;
            stop();
          }
        },
      );
    if (tooMany)
      throw Object.assign(new Error("Too many occurrences to create selections."), {
        detail: `At most ${MAX_OCCURRENCE_SELECTIONS} occurrence selections can be created at once. Find and Replace All still process every match.`,
      });
    this.editor.setSelectedBufferRanges([...ranges.values()], { autoscroll: false });
    this.selectionRanges = this.editor.getSelectedBufferRanges();
    return this.editor.scrollToCursorPosition({ mode: "nearest" });
  }

  selectNextOccurrence(options) {
    if (options == null) {
      options = {};
    }
    const startingRange =
      options.start != null ? options.start : this.editor.getSelectedBufferRange().end;
    let range = this.findNextOccurrence([startingRange, this.editor.getEofBufferPosition()]);
    if (range == null) {
      range = this.findNextOccurrence([
        [0, 0],
        this.editor.getSelections()[0].getBufferRange().start,
      ]);
    }
    if (range != null) {
      return this.addSelection(range);
    }
  }

  findNextOccurrence(scanRange) {
    let foundRange = null;
    this.scanForNextOccurrence(scanRange, function ({ range, stop }) {
      foundRange = range;
      return stop();
    });
    return foundRange;
  }

  addSelection(range) {
    const reversed = this.editor.getLastSelection().isReversed();
    const selection = this.editor.addSelectionForBufferRange(range, {
      reversed,
    });
    return this.updateSavedSelections(selection);
  }

  scanForNextOccurrence(range, callback) {
    const selection = this.editor.getLastSelection();
    const text = escapeRegExp(getSelectionText(this.editor));
    const buffer = this.editor.getBuffer();
    const source = buffer.getTextSnapshot();
    let prefix, suffix;
    if (this.wordSelected) {
      const extra = escapeRegExp(
        this.nonWordCharactersAt(selection.getBufferRange().start),
      ).replace(/-/g, "\\-");
      prefix = new RegExp(`[ \t${extra}]`);
      suffix = new RegExp(`[\\s${extra}]`);
    }
    // Search the literal itself, then inspect only its adjacent code units.
    // This retains custom word boundaries without a multiline regexp input.
    return this.editor.scanInBufferRange(new RegExp(text, "g"), range, (result) => {
      if (prefix) {
        const candidate = result.range;
        const start = source.offsetAt(candidate.start),
          end = source.offsetAt(candidate.end);
        if (candidate.start.column !== 0 && !prefix.test(source.slice(start - 1, start))) return;
        if (
          candidate.end.column !== buffer.lineLengthForRow(candidate.end.row) &&
          !suffix.test(source.slice(end, end + 1))
        )
          return;
      }
      return callback(result);
    });
  }

  updateSavedSelections(selection = null) {
    const selections = this.editor.getSelections();
    if (selections.length < 3) {
      this.selectionRanges = [];
    }
    if (this.selectionRanges.length === 0) {
      return Array.from(selections).map((s) => this.selectionRanges.push(s.getBufferRange()));
    } else if (selection) {
      const selectionRange = selection.getBufferRange();
      if (this.selectionRanges.some((existingRange) => existingRange.isEqual(selectionRange))) {
        return;
      }
      return this.selectionRanges.push(selectionRange);
    }
  }

  nonWordCharactersAt(position) {
    return lumine.config.get("editor.nonWordCharacters", {
      scope: this.editor.scopeDescriptorForBufferPosition(position),
    });
  }

  isNonWordCharacter(character, position) {
    const nonWordCharacters = this.nonWordCharactersAt(position);
    return new RegExp(`[ \t${escapeRegExp(nonWordCharacters).replace(/-/g, "\\-")}]`).test(
      character,
    );
  }

  isNonWordCharacterToTheLeft(selection) {
    const selectionStart = selection.getBufferRange().start;
    const range = Range.fromPointWithDelta(selectionStart, 0, -1);
    return this.isNonWordCharacter(this.editor.getTextInBufferRange(range), selectionStart);
  }

  isNonWordCharacterToTheRight(selection) {
    const selectionEnd = selection.getBufferRange().end;
    const range = Range.fromPointWithDelta(selectionEnd, 0, 1);
    return this.isNonWordCharacter(this.editor.getTextInBufferRange(range), selectionEnd);
  }

  isWordSelected(selection) {
    if (selection.getBufferRange().isSingleLine()) {
      const selectionRange = selection.getBufferRange();
      const lineRange = this.editor.bufferRangeForBufferRow(selectionRange.start.row);
      const nonWordCharacterToTheLeft =
        selectionRange.start.isEqual(lineRange.start) ||
        this.isNonWordCharacterToTheLeft(selection);
      const nonWordCharacterToTheRight =
        selectionRange.end.isEqual(lineRange.end) || this.isNonWordCharacterToTheRight(selection);
      const containsOnlyWordCharacters = !this.isNonWordCharacter(
        getSelectionText(this.editor),
        selectionRange.start,
      );

      return nonWordCharacterToTheLeft && nonWordCharacterToTheRight && containsOnlyWordCharacters;
    } else {
      return false;
    }
  }
};
