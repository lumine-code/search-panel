// A SearchTarget is the thing FindView searches and navigates. It abstracts away
// "what is being searched" so the buffer find UI can drive either a real text
// editor (EditorSearchTarget, below) or a custom view supplied by another
// package through the search.adapter contract (AdapterSearchTarget).
//
// The interface FindView depends on:
//   isUsable(): boolean
//   getFindOptions(): FindOptions
//   onDidUpdate(cb) / onDidError(cb) / onDidChangeCurrentResult(cb): Disposable
//   search(pattern, options?): void
//   patternMatchesEmptyString(pattern): boolean
//   getResultCount(): number
//   getCurrentResultIndex(): number            // -1 when nothing is current
//   hasSelectionMatchingResult(): boolean
//   selectNext(options?) / selectPrevious(options?) / selectFirstFromCursor(options?) / selectAll(options?)
//                                              -> { found, wrapped }  (wrapped: "up"|"down"|null)
//   replaceCurrentMatch(replaceText, direction): void   // direction: "next"|"previous"
//   replaceAll(replaceText): void
//   getSelectedText(): string
//   getWordUnderCursor(): string
//   getWrapIconHost(): HTMLElement | null

const { Disposable, CompositeDisposable, Emitter } = require("lumine");
const FindOptions = require("./find-options");
const { getSelectionText, getWordText } = require("./selection-query");

// Wraps a BufferSearch model (which tracks the active TextEditor) and implements
// the SearchTarget interface using buffer markers and editor selection/scroll.
// This is the behaviour the FindView used to implement inline; it is unchanged,
// only relocated behind the interface.
class EditorSearchTarget {
  constructor(model) {
    this.model = model; // BufferSearch
  }

  isUsable() {
    return this.model.getEditor() != null;
  }

  canReplace() {
    const editor = this.model.getEditor();
    return Boolean(editor && !editor.isDestroyed() && !editor.isReadOnly());
  }

  getFindOptions() {
    return this.model.getFindOptions();
  }

  onDidUpdate(callback) {
    return this.model.onDidUpdate(callback);
  }

  onDidError(callback) {
    return this.model.onDidError(callback);
  }

  onDidChangeCurrentResult(callback) {
    return this.model.onDidChangeCurrentResult(callback);
  }

  search(findPattern, options) {
    return this.model.search(findPattern, options);
  }

  refresh() {
    this.model.recreateMarkers();
  }

  patternMatchesEmptyString(findPattern) {
    return this.model.patternMatchesEmptyString(findPattern);
  }

  markers() {
    return this.model.markers || [];
  }

  getResultCount() {
    return this.model.getResultCount();
  }

  getCurrentResultIndex() {
    return this.model.getCurrentResultIndex();
  }

  isPending() {
    return Boolean(this.model.pending);
  }

  isPresentationUpdate() {
    return Boolean(this.model.presentationOnlyUpdate);
  }

  hasSelectionMatchingResult() {
    const editor = this.model.getEditor();
    if (!editor) return false;
    return editor
      .getSelectedBufferRanges()
      .some((selectedRange) => this.model.findMarker(selectedRange));
  }

  // --- navigation -----------------------------------------------------------

  selectNext(options) {
    if (this.model.asyncSearch) return this.model.selectMatch("next", options);
    return this._selectAt(this._indexAfterCursor(false), options);
  }

  selectFirstFromCursor(options) {
    if (this.model.asyncSearch)
      return this.model.selectMatch("next", { ...options, inclusive: true });
    return this._selectAt(this._indexAfterCursor(true), options);
  }

  selectPrevious(options) {
    if (this.model.asyncSearch) return this.model.selectMatch("previous", options);
    return this._selectAt(this._indexBeforeCursor(), options);
  }

  selectAll({ mode = "zone" } = {}) {
    if (this.model.asyncSearch) return this.model.selectAllMatches({ mode });
    const markers = this.markers();
    if (markers.length === 0) return { found: false, wrapped: null };
    const editor = this.model.getEditor();
    const ranges = Array.from(markers).map((marker) => marker.getBufferRange());
    const after = this._indexAfterCursor(false);
    const scrollMarker = markers[(after && after.index) || 0];
    for (const range of ranges) {
      editor.unfoldBufferRow(range.start.row);
    }
    editor.setSelectedBufferRanges(ranges, { flash: true, autoscroll: false });
    editor.scrollToBufferPosition(scrollMarker.getStartBufferPosition(), { mode });
    return { found: true, wrapped: null };
  }

  _indexAfterCursor(indexIncluded = false) {
    const editor = this.model.getEditor();
    const markers = this.markers();
    if (!editor || markers.length === 0) return null;

    const selection = editor.getLastSelection();
    let { start, end } = selection.getBufferRange();
    if (selection.isReversed()) start = end;

    for (let index = 0, length = markers.length; index < length; index++) {
      const markerStartPosition = markers[index].bufferMarker.getStartPosition();
      switch (markerStartPosition.compare(start)) {
        case -1:
          continue;
        case 0:
          if (!indexIncluded) continue;
          break;
      }
      return { index, wrapped: null };
    }
    return { index: 0, wrapped: "up" };
  }

  _indexBeforeCursor() {
    const editor = this.model.getEditor();
    const markers = this.markers();
    if (!editor || markers.length === 0) return null;

    const selection = editor.getLastSelection();
    let { start, end } = selection.getBufferRange();
    if (selection.isReversed()) start = end;

    for (let index = markers.length - 1; index >= 0; index--) {
      if (markers[index].bufferMarker.getEndPosition().isLessThan(start)) {
        return { index, wrapped: null };
      }
    }
    return { index: markers.length - 1, wrapped: "down" };
  }

  _selectAt(found, { mode = "zone" } = {}) {
    if (!found) return { found: false, wrapped: null };
    const markers = this.markers();
    const marker = markers[found.index];
    if (!marker) return { found: false, wrapped: null };

    const editor = this.model.getEditor();
    const bufferRange = marker.getBufferRange();
    const screenRange = marker.getScreenRange();
    const outOfView =
      screenRange.start.row < editor.getFirstVisibleScreenRow() ||
      screenRange.end.row > editor.getLastVisibleScreenRow();

    editor.unfoldBufferRow(bufferRange.start.row);
    editor.setSelectedBufferRange(bufferRange, { flash: true, autoscroll: false });
    editor.scrollToCursorPosition({ mode });
    return { found: true, wrapped: outOfView ? found.wrapped : null };
  }

  // --- replace --------------------------------------------------------------

  replaceCurrentMatch(replaceText, direction = "next") {
    if (!this.model.asyncSearch && this.model.getFindOptions().useRegex) {
      let marker = this.model.currentResultMarker;
      if (!marker) {
        const position =
          direction === "previous" ? this._indexBeforeCursor() : this._indexAfterCursor(true);
        marker = position && this.markers()[position.index];
      }
      if (!marker) return;
      const range = marker.getBufferRange();
      const buffer = this.model.getEditor().getBuffer();
      this.model.currentResult = {
        range,
        start: buffer.characterIndexForPosition(range.start),
        end: buffer.characterIndexForPosition(range.end),
      };
      return this.model.replaceAllMatches(replaceText, true);
    }
    if (this.model.asyncSearch)
      return (async () => {
        if (!this.model.currentResult) await this.model.selectMatch(direction, { inclusive: true });
        return this.model.replaceAllMatches(replaceText, true);
      })();
    const markers = this.markers();
    if (markers.length === 0) return;
    let currentMarker = this.model.currentResultMarker;
    if (!currentMarker) {
      const position =
        direction === "previous" ? this._indexBeforeCursor() : this._indexAfterCursor(true);
      if (position) currentMarker = markers[position.index];
    }
    if (currentMarker) {
      this.model.replace([currentMarker], replaceText);
    }
  }

  replaceAll(replaceText) {
    if (this.model.asyncSearch || this.model.getFindOptions().useRegex)
      return this.model.replaceAllMatches(replaceText);
    // Pass a copy: BufferSearch.replace splices the live markers array as it
    // goes, which would corrupt iteration if we handed it the live array.
    this.model.replace(this.markers().slice(), replaceText);
  }

  // --- selection helpers ----------------------------------------------------

  isSelectionEmpty() {
    const editor = this.model.getEditor();
    if (!editor) return false;
    return editor.getSelectedBufferRanges().every((range) => range.isEmpty());
  }

  getSelectedText(options) {
    return getSelectionText(this.model.getEditor(), options);
  }

  getWordUnderCursor() {
    return getWordText(this.model.getEditor());
  }

  getWrapIconHost() {
    const editor = this.model.getEditor();
    if (!editor) return null;
    const editorView = lumine.views.getView(editor);
    return editorView && editorView.parentNode ? editorView.parentNode : null;
  }
}

// Wraps a search adapter supplied by another package through the search.adapter
// service. The adapter owns matching, navigation, highlight
// and replace inside its own view; this target adapts it to the SearchTarget
// interface and supplies the shared FindOptions + regex helpers so the adapter
// doesn't have to reimplement option handling.
//
// Adapter contract (methods marked (opt) are optional):
//   search(findOptions): void                 // scan; emit "did-update"
//   onDidUpdate(cb) / onDidChangeCurrentResult(cb): Disposable
//   onDidError(cb): Disposable                 // (opt)
//   getResultCount(): number
//   getCurrentResultIndex(): number            // -1 when none
//   selectNext(options?) / selectPrevious(options?): { found, wrapped }
//   selectFirstFromCursor(options?) (opt) / selectAll(options?) (opt): { found, wrapped }
//   canReplace: boolean
//   replaceCurrentMatch(text, direction) (opt) / replaceAll(text) (opt)
//   hasSelectionMatchingResult() (opt) / isSelectionEmpty() (opt)
//   getSelectedText() (opt) / getWordUnderCursor() (opt)
//   getWrapIconHost() (opt): HTMLElement | null
class AdapterSearchTarget {
  constructor(adapter, findOptions) {
    this.adapter = adapter;
    this.findOptions = findOptions;
    this.errors = new Emitter();
    this.operationGeneration = 0;
  }

  isUsable() {
    return true;
  }

  canReplace() {
    return Boolean(this.adapter.canReplace);
  }

  getFindOptions() {
    return this.findOptions;
  }

  onDidUpdate(callback) {
    return this.adapter.onDidUpdate(() => callback(this.getResultCount()));
  }

  onDidError(callback) {
    return new CompositeDisposable(
      this.errors.on("did-error", callback),
      this.adapter.onDidError ? this.adapter.onDidError(callback) : new Disposable(),
    );
  }

  onDidChangeCurrentResult(callback) {
    return this.adapter.onDidChangeCurrentResult(callback);
  }

  search(findPattern, otherOptions) {
    const options = { findPattern };
    Object.assign(options, otherOptions);
    const changed = this.findOptions.set(options);
    if (
      changed.findPattern != null ||
      changed.useRegex != null ||
      changed.wholeWord != null ||
      changed.caseSensitive != null ||
      changed.inCurrentSelection != null
    ) {
      this.operationGeneration++;
      return this._invoke("search", this.findOptions);
    }
  }

  // Re-run the current query when this target becomes active, so the adapter can
  // re-highlight in its now-visible view (mirrors buffer search re-running when
  // the active editor changes).
  refresh() {
    if (this.findOptions.findPattern) {
      this.operationGeneration++;
      return this._invoke("search", this.findOptions);
    }
  }

  // Called when this target stops being active (the active pane item changed),
  // so the adapter can clear its highlights, matching how a text editor's find
  // results disappear when you switch away.
  deactivate() {
    this.operationGeneration++;
    if (this.adapter.deactivate) {
      this.adapter.deactivate();
    }
  }

  patternMatchesEmptyString(findPattern) {
    const options = new FindOptions(this.findOptions.serialize());
    options.set({ findPattern });
    try {
      return options.getFindPatternRegex().test("");
    } catch {
      return false;
    }
  }

  getResultCount() {
    return this.adapter.getResultCount();
  }

  isPending() {
    return Boolean(this.adapter.isPending?.());
  }

  getCurrentResultIndex() {
    return this.adapter.getCurrentResultIndex();
  }

  hasSelectionMatchingResult() {
    return this.adapter.hasSelectionMatchingResult
      ? this.adapter.hasSelectionMatchingResult()
      : false;
  }

  isSelectionEmpty() {
    return this.adapter.isSelectionEmpty ? this.adapter.isSelectionEmpty() : true;
  }

  selectNext(options) {
    return this._normalize(this._invoke("selectNext", options));
  }

  selectPrevious(options) {
    return this._normalize(this._invoke("selectPrevious", options));
  }

  selectFirstFromCursor(options) {
    return this._normalize(
      this.adapter.selectFirstFromCursor
        ? this._invoke("selectFirstFromCursor", options)
        : this._invoke("selectNext", options),
    );
  }

  selectAll(options) {
    return this._normalize(this.adapter.selectAll ? this._invoke("selectAll", options) : null);
  }

  _invoke(method, ...args) {
    const generation = this.operationGeneration;
    const report = (error) => {
      if (
        generation === this.operationGeneration &&
        error.name !== "AbortError" &&
        error.code !== "ERR_STALE_EDIT" &&
        error.code !== "ERR_STALE_SEARCH"
      )
        this.errors.emit("did-error", error);
      throw error;
    };
    let result;
    try {
      result = this.adapter[method](...args);
    } catch (error) {
      result = Promise.reject(error);
    }
    if (typeof result?.then !== "function") return result;
    const pending = Promise.resolve(result).catch(report);
    // Some callers intentionally dispatch without awaiting. The error event is
    // still delivered, while callers that await retain the original rejection.
    pending.catch(() => {});
    return pending;
  }

  _normalize(result) {
    if (typeof result?.then !== "function") return result || { found: false, wrapped: null };
    const pending = Promise.resolve(result).then(
      (value) => value || { found: false, wrapped: null },
    );
    pending.catch(() => {});
    return pending;
  }

  replaceCurrentMatch(replaceText, direction) {
    if (this.adapter.canReplace && this.adapter.replaceCurrentMatch) {
      return this._invoke("replaceCurrentMatch", replaceText, direction);
    }
  }

  replaceAll(replaceText) {
    if (this.adapter.canReplace && this.adapter.replaceAll) {
      return this._invoke("replaceAll", replaceText);
    }
  }

  getSelectedText(options) {
    return getSelectionText(this.adapter, options);
  }

  getWordUnderCursor() {
    return getWordText(this.adapter);
  }

  getWrapIconHost() {
    return this.adapter.getWrapIconHost ? this.adapter.getWrapIconHost() : null;
  }
}

module.exports = { EditorSearchTarget, AdapterSearchTarget };
