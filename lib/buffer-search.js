const { Point, Range, Emitter, CompositeDisposable } = require("lumine");
const FindOptions = require("./find-options");
const escapeHelper = require("./escape-helper");
const Util = require("./util");

const ResultsMarkerLayersByEditor = new WeakMap();
const MAX_MARKERS = 2000;
const ASYNC_SEARCH_UNITS = 128 * 1024;

module.exports = class BufferSearch {
  constructor(findOptions) {
    this.findOptions = findOptions;
    this.emitter = new Emitter();
    this.subscriptions = null;
    this.markers = [];
    this.editor = null;
    this.searchGeneration = 0;
    this.searchPromise = Promise.resolve();
  }

  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  onDidError(callback) {
    return this.emitter.on("did-error", callback);
  }

  onDidChangeCurrentResult(callback) {
    return this.emitter.on("did-change-current-result", callback);
  }

  setEditor(editor) {
    this.cancelSearch();
    this.clearSearchScope();
    this.resultsMarkerLayer?.clear();
    this.editor = editor;
    this.selectionRevision = editor?.getBuffer().getTextRevision();
    if (this.subscriptions) this.subscriptions.dispose();
    if (this.editor) {
      this.subscriptions = new CompositeDisposable();
      this.subscriptions.add(
        this.editor.getBuffer().onDidChangeText(() => {
          this.selectionRevision = this.editor.getBuffer().getTextRevision();
          if (this.resultSelections && !this.scopeSelectionDirty)
            this.resultSelections = this.editor.getSelectedBufferRanges();
          if (!this.asyncSearch) return;
          this.cancelSearch();
          this.pending = true;
          this.totalCount = 0;
          this.resultsMarkerLayer.clear();
          this.markers = [];
          this.emitUpdate();
        }),
      );
      this.subscriptions.add(
        this.editor.getElement().onDidChangeScrollTop(() => this.scheduleViewport()),
      );
      this.subscriptions.add(this.editor.onDidStopChanging(this.bufferStoppedChanging.bind(this)));
      this.subscriptions.add(
        this.editor.onDidAddSelection(this.setCurrentMarkerFromSelection.bind(this)),
      );
      this.subscriptions.add(
        this.editor.onDidChangeSelectionRange(this.setCurrentMarkerFromSelection.bind(this)),
      );
      this.resultsMarkerLayer = this.resultsMarkerLayerForTextEditor(this.editor);
      if (this.resultsLayerDecoration) this.resultsLayerDecoration.destroy();
      this.resultsLayerDecoration = this.editor.decorateMarkerLayer(this.resultsMarkerLayer, {
        type: "highlight",
        class: "find-result",
      });
    }
    this.recreateMarkers();
  }

  getEditor() {
    return this.editor;
  }

  setFindOptions(newParams) {
    return this.findOptions.set(newParams);
  }

  getFindOptions() {
    return this.findOptions;
  }

  resultsMarkerLayerForTextEditor(editor) {
    let layer = ResultsMarkerLayersByEditor.get(editor);
    if (!layer) {
      layer = editor.addMarkerLayer({ maintainHistory: false });
      ResultsMarkerLayersByEditor.set(editor, layer);
    }
    return layer;
  }

  patternMatchesEmptyString(findPattern) {
    const findOptions = new FindOptions(this.findOptions.serialize());
    findOptions.set({ findPattern });
    try {
      return findOptions.getFindPatternRegex().test("");
    } catch (e) {
      this.emitter.emit("did-error", e);
      return false;
    }
  }

  search(findPattern, otherOptions) {
    let options = { findPattern };
    Object.assign(options, otherOptions);

    const changedParams = this.findOptions.set(options);
    const scopeChanged = this.updateSearchScope();
    if (
      !this.editor ||
      this.searchedRevision !== this.editor.getBuffer().getTextRevision() ||
      (this.asyncSearch && this.searchController?.signal.aborted) ||
      changedParams.findPattern != null ||
      changedParams.useRegex != null ||
      changedParams.wholeWord != null ||
      changedParams.caseSensitive != null ||
      changedParams.inCurrentSelection != null ||
      scopeChanged
    ) {
      return this.recreateMarkers();
    }
    return this.searchPromise;
  }

  replace(markers, replacePattern) {
    if (!markers || markers.length === 0 || this.editor.isReadOnly()) return;

    this.findOptions.set({ replacePattern });
    const preserveCaseOnReplace = lumine.config.get("search-panel.preserveCaseOnReplace");

    this.editor.transact(() => {
      let findRegex = null;

      if (this.findOptions.useRegex) {
        findRegex = this.getFindPatternRegex();
        replacePattern = escapeHelper.unescapeEscapeSequence(replacePattern);
      }

      if (markers.length >= 64) {
        const edits = markers
          .map((marker) => {
            const range = marker.getBufferRange();
            const oldText = this.editor.getTextInBufferRange(range);
            let text = findRegex ? oldText.replace(findRegex, replacePattern) : replacePattern;
            if (preserveCaseOnReplace) text = Util.preserveCase(text, oldText);
            return { range, text };
          })
          .sort((a, b) => a.range.start.compare(b.range.start));
        if (
          edits.every(
            (edit, i) =>
              edit.range.start.row === edit.range.end.row &&
              !/[\r\n]/.test(edit.text) &&
              (i === 0 ||
                (edits[i - 1].range.end.compare(edit.range.start) <= 0 &&
                  !edits[i - 1].range.start.isEqual(edit.range.start))),
          )
        ) {
          this.editor.getBuffer().setTextInIndependentRanges(edits);
          const removed = new Set(markers);
          for (const marker of removed) marker.destroy();
          this.markers = this.markers.filter((marker) => !removed.has(marker));
          return;
        }
      }

      for (let i = 0, n = markers.length; i < n; i++) {
        const marker = markers[i];
        const bufferRange = marker.getBufferRange();
        const replacedText = this.editor.getTextInBufferRange(bufferRange);
        let replacementText = findRegex
          ? replacedText.replace(findRegex, replacePattern)
          : replacePattern;
        replacementText = preserveCaseOnReplace
          ? Util.preserveCase(replacementText, replacedText)
          : replacementText;
        this.editor.setTextInBufferRange(bufferRange, replacementText);

        marker.destroy();
        this.markers.splice(this.markers.indexOf(marker), 1);
      }
    });

    return this.emitter.emit("did-update", this.markers.slice());
  }

  destroy() {
    this.cancelSearch();
    this.clearSearchScope();
    this.resultsLayerDecoration?.destroy();
    this.resultsMarkerLayer?.clear();
    if (this.subscriptions) this.subscriptions.dispose();
  }

  /*
  Section: Private
  */

  cancelSearch() {
    this.searchGeneration++;
    this.searchController?.abort();
    this.viewportController?.abort();
    clearTimeout(this.viewportTimer);
    this.pending = false;
    this.currentResult = null;
    this.currentResultMarker = null;
    this.sessions = [];
    this.navigationPromise = Promise.resolve();
  }

  emitUpdate(presentationOnly = false) {
    this.presentationOnlyUpdate = presentationOnly;
    try {
      this.emitter.emit("did-update", this.markers.slice());
    } finally {
      this.presentationOnlyUpdate = false;
    }
  }

  getResultCount() {
    return this.asyncSearch ? (this.totalCount ?? 0) : this.markers.length;
  }
  getCurrentResultIndex() {
    if (!this.asyncSearch) return this.markers.indexOf(this.currentResultMarker);
    if (!this.currentResult || this.pending) return -1;
    const preceding = this.sessions
      .slice(0, this.currentResult.sessionIndex)
      .reduce((sum, session) => sum + session.count, 0);
    return preceding + this.currentResult.index;
  }

  getSearchRanges() {
    const selected = this.findOptions.inCurrentSelection
      ? (this.scopeLayer?.getMarkers() ?? []).map((marker) => marker.getBufferRange())
      : [];
    const ranges = (selected.length ? selected : [this.editor.getBuffer().getRange()])
      .slice()
      .sort((a, b) => a.start.compare(b.start));
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && last.end.compare(range.start) >= 0) merged[merged.length - 1] = last.union(range);
      else merged.push(range);
    }
    return merged;
  }

  clearSearchScope() {
    this.scopeLayer?.destroy();
    this.scopeLayer = null;
    this.scopeEnabled = false;
    this.scopeSelectionDirty = false;
    this.resultSelections = null;
  }

  updateSearchScope() {
    const enabled = Boolean(this.editor && this.findOptions.inCurrentSelection);
    if (!enabled) {
      const changed = this.scopeEnabled;
      this.clearSearchScope();
      return changed;
    }
    if (this.scopeEnabled && !this.scopeSelectionDirty) return false;
    const visibleRanges = this.editor.getSelectedBufferRanges();
    this.scopeSelectionDirty = false;
    // Copy and other commands can temporarily expand then restore a result
    // selection. Its final position still expresses the same navigation.
    if (
      this.scopeEnabled &&
      this.resultSelections?.length === visibleRanges.length &&
      visibleRanges.every((range, index) => range.isEqual(this.resultSelections[index]))
    )
      return false;
    const ranges = visibleRanges.filter((range) => !range.isEmpty());
    if (!this.scopeEnabled || ranges.length) {
      // A new user scope has its own history identity. Undoing an earlier
      // edit must move these ranges, not resurrect the previous scope.
      this.scopeLayer?.destroy();
      this.scopeLayer = this.editor.addMarkerLayer({ maintainHistory: true });
      for (const range of ranges) this.scopeLayer.markBufferRange(range, { invalidate: "never" });
      this.resultSelections = null;
    }
    this.scopeEnabled = true;
    return true;
  }

  withResultSelection(callback) {
    this.resultSelectionDepth = (this.resultSelectionDepth ?? 0) + 1;
    try {
      return callback();
    } finally {
      this.resultSelectionDepth--;
      if (!this.resultSelectionDepth) this.resultSelections = this.editor.getSelectedBufferRanges();
    }
  }

  recreateMarkers() {
    this.updateSearchScope();
    this.searchedRevision = this.editor?.getBuffer().getTextRevision();
    this.cancelSearch();
    this.resultsMarkerLayer?.clear();
    this.markers = [];
    this.currentResultMarker = null;
    this.totalCount = 0;
    this.error = null;
    this.asyncSearch = false;
    this.needsAsync = false;
    if (!this.editor || !this.findOptions.findPattern) {
      this.emitUpdate();
      return (this.searchPromise = Promise.resolve());
    }
    if (this.editor.getBuffer().getTextSnapshot().length >= ASYNC_SEARCH_UNITS)
      return this.startAsyncSearch();
    const markers = this.createMarkers(Point.ZERO, Point.INFINITY);
    if (this.needsAsync) {
      this.resultsMarkerLayer.clear();
      this.markers = [];
      return this.startAsyncSearch();
    }
    if (markers) {
      this.markers = markers;
      this.emitUpdate();
    }
    return (this.searchPromise = Promise.resolve());
  }

  startAsyncSearch() {
    this.asyncSearch = true;
    this.pending = true;
    const generation = this.searchGeneration;
    const controller = (this.searchController = new AbortController());
    const buffer = this.editor.getBuffer();
    const regex = this.getFindPatternRegex(buffer.hasAstral?.());
    if (!regex) {
      this.pending = false;
      return (this.searchPromise = Promise.resolve());
    }
    try {
      this.sessions = this.getSearchRanges().map((range) =>
        buffer.createSearch(regex, { range, signal: controller.signal }),
      );
    } catch (error) {
      this.pending = false;
      this.error = error;
      this.emitter.emit("did-error", error);
      return (this.searchPromise = Promise.resolve());
    }
    this.emitUpdate();
    this.scheduleViewport();
    this.searchPromise = (async () => {
      try {
        for (const session of this.sessions) {
          await session.collect({
            limit: 0,
            onProgress: () => {
              if (generation !== this.searchGeneration) return;
              this.totalCount = this.sessions.reduce((sum, item) => sum + item.count, 0);
              this.emitUpdate();
            },
          });
        }
        if (generation !== this.searchGeneration) return;
        this.pending = false;
        const current = this.currentResult;
        if (current && current.index < 0) {
          const resolved = await this.sessions[current.sessionIndex].findNear(current.start, {
            inclusive: true,
            allowLocal: false,
          });
          if (generation !== this.searchGeneration) return;
          if (this.currentResult === current && resolved?.start === current.start)
            this.currentResult = { ...resolved, sessionIndex: current.sessionIndex };
        }
        this.emitUpdate();
      } catch (error) {
        this.handleAsyncError(error, generation);
      }
    })();
    return this.searchPromise;
  }

  handleAsyncError(error, generation = this.searchGeneration) {
    if (
      generation !== this.searchGeneration ||
      error.name === "AbortError" ||
      error.code === "ERR_STALE_SEARCH"
    )
      return;
    this.pending = false;
    this.error = error;
    this.searchController?.abort();
    this.viewportController?.abort();
    clearTimeout(this.viewportTimer);
    this.totalCount = 0;
    this.resultsMarkerLayer?.clear();
    this.markers = [];
    this.emitUpdate();
    this.emitter.emit("did-error", error);
  }

  scheduleViewport() {
    if (!this.asyncSearch || !this.sessions) return;
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => this.refreshViewport(), 40);
  }

  async refreshViewport() {
    if (!this.editor || !this.asyncSearch || this.searchController?.signal.aborted) return;
    this.viewportController?.abort();
    const controller = (this.viewportController = new AbortController());
    const generation = this.searchGeneration;
    try {
      const editor = this.editor;
      const first = editor.bufferPositionForScreenPosition([
        Math.max(0, editor.getFirstVisibleScreenRow() - 10),
        0,
      ]);
      const last = editor.bufferPositionForScreenPosition([
        editor.getLastVisibleScreenRow() + 11,
        0,
      ]);
      const snapshot = editor.getBuffer().getTextSnapshot();
      const start = snapshot.offsetAt(first),
        end = snapshot.offsetAt(last);
      const ranges = [];
      for (const session of this.sessions) {
        const task = session.withSignal(controller.signal);
        const match = await task.findNear(start, { inclusive: true, intersecting: true });
        if (!match) continue;
        for await (const result of task.matches(match.start)) {
          if (controller.signal.aborted || generation !== this.searchGeneration) return;
          if (result.start > end || ranges.length >= MAX_MARKERS) break;
          ranges.push(session.range(result));
        }
      }
      if (controller.signal.aborted || generation !== this.searchGeneration) return;
      this.resultsMarkerLayer.clear();
      this.currentResultMarker = null;
      this.markers = ranges.map((range) => this.createMarker(range));
      if (this.currentResult && !this.findMarker(Range.fromObject(this.currentResult.range)))
        this.markers.push(this.createMarker(this.currentResult.range));
      this.setCurrentMarkerFromSelection();
      this.emitUpdate(true);
    } catch (error) {
      this.handleAsyncError(error, generation);
    }
  }

  selectMatch(direction, options) {
    const generation = this.searchGeneration;
    const navigation = (this.navigationPromise ?? Promise.resolve()).then(() =>
      generation === this.searchGeneration
        ? this.performSelectMatch(direction, options)
        : { found: false, wrapped: null },
    );
    this.navigationPromise = navigation;
    return navigation;
  }

  async performSelectMatch(direction, { mode = "zone", inclusive = false } = {}) {
    if (!this.editor || !this.sessions?.length || this.searchController?.signal.aborted)
      return { found: false, wrapped: null };
    const generation = this.searchGeneration;
    const editor = this.editor;
    const selection = editor.getLastSelection();
    const range = selection.getBufferRange();
    const point = selection.isReversed() ? range.end : range.start;
    const offset = editor.getBuffer().characterIndexForPosition(point);
    const backwards = direction === "previous";
    const ordered = this.sessions.map((session, sessionIndex) => ({ session, sessionIndex }));
    if (backwards) ordered.reverse();
    try {
      let result,
        wrapped = null;
      for (const { session, sessionIndex } of ordered) {
        const candidate = await session.findNear(offset, { backwards, inclusive });
        if (candidate) {
          result = { ...candidate, sessionIndex };
          break;
        }
      }
      if (!result) {
        for (const { session, sessionIndex } of ordered) {
          const candidate = await session.findNear(backwards ? session.end + 1 : session.start, {
            backwards,
            inclusive: true,
          });
          if (candidate) {
            result = { ...candidate, sessionIndex };
            wrapped = backwards ? "down" : "up";
            break;
          }
        }
      }
      if (!result || generation !== this.searchGeneration) return { found: false, wrapped: null };
      if (result.index < 0 && this.sessions[result.sessionIndex].complete) {
        const resolved = await this.sessions[result.sessionIndex].findNear(result.start, {
          inclusive: true,
          allowLocal: false,
        });
        if (generation !== this.searchGeneration) return { found: false, wrapped: null };
        if (resolved?.start === result.start)
          result = { ...resolved, sessionIndex: result.sessionIndex };
      }
      this.currentResult = result;
      editor.unfoldBufferRow(result.range.start.row);
      this.withResultSelection(() =>
        editor.setSelectedBufferRange(result.range, { flash: true, autoscroll: false }),
      );
      editor.scrollToCursorPosition({ mode });
      this.scheduleViewport();
      this.emitter.emit("did-change-current-result", null);
      return { found: true, wrapped };
    } catch (error) {
      this.handleAsyncError(error, generation);
      return { found: false, wrapped: null };
    }
  }

  async selectAllMatches(options) {
    const generation = this.searchGeneration;
    try {
      await this.searchPromise;
      if (generation !== this.searchGeneration) return { found: false, wrapped: null };
      if (this.totalCount > MAX_MARKERS) {
        this.emitter.emit(
          "did-error",
          new Error(
            `Select All is limited to ${MAX_MARKERS} selections. All ${this.totalCount} matches remain available to Find Next and Replace All.`,
          ),
        );
        return { found: false, wrapped: null };
      }
      const ranges = [];
      for (const session of this.sessions)
        for await (const match of session.matches()) ranges.push(session.range(match));
      if (generation !== this.searchGeneration) return { found: false, wrapped: null };
      if (ranges.length)
        this.withResultSelection(() =>
          this.editor.setSelectedBufferRanges(ranges, { autoscroll: true, ...options }),
        );
      return { found: ranges.length > 0, wrapped: null };
    } catch (error) {
      this.handleAsyncError(error, generation);
      return { found: false, wrapped: null };
    }
  }

  async replaceAllMatches(replacement, onlyCurrent = false) {
    const editor = this.editor;
    if (!editor || editor.isReadOnly() || this.replacing) return;
    this.findOptions.set({ replacePattern: replacement });
    const regex = this.getFindPatternRegex(editor.getBuffer().hasAstral?.());
    if (!regex) return;
    const options = this.findOptions;
    let ranges = this.getSearchRanges();
    if (onlyCurrent) {
      if (!this.currentResult) return;
      // Keep original search context for lookbehind, anchors and backreferences.
    }
    const current = this.currentResult;
    this.cancelSearch();
    this.resultsMarkerLayer.clear();
    this.markers = [];
    const generation = this.searchGeneration;
    this.searchController = new AbortController();
    this.replacing = true;
    try {
      await editor
        .getBuffer()
        .replaceAllMatches(
          regex,
          options.useRegex ? escapeHelper.unescapeEscapeSequence(replacement) : replacement,
          {
            ranges,
            onlyMatch: onlyCurrent ? { start: current.start, end: current.end } : undefined,
            signal: this.searchController?.signal,
            literalReplacement: !options.useRegex,
            transformReplacement: lumine.config.get("search-panel.preserveCaseOnReplace")
              ? Util.preserveCase
              : undefined,
          },
        );
      if (this.editor === editor) this.recreateMarkers();
    } catch (error) {
      this.handleAsyncError(error, generation);
    } finally {
      this.replacing = false;
    }
  }

  createMarkers(start, end) {
    let newMarkers = [];
    if (this.findOptions.findPattern && this.editor) {
      const searchRanges = this.findOptions.inCurrentSelection
        ? this.getSearchRanges()
        : [Range(start, end)];

      const buffer = this.editor.getBuffer();
      const regex = this.getFindPatternRegex(buffer.hasAstral && buffer.hasAstral());
      if (regex) {
        try {
          for (const range of searchRanges) {
            const search = buffer.createSearch(regex, { range });
            for (const match of search.scan()) {
              if (!match) continue;
              if (newMarkers.length >= MAX_MARKERS) {
                this.needsAsync = true;
                return newMarkers;
              }
              newMarkers.push(this.createMarker(search.range(match)));
            }
          }
        } catch (error) {
          this.emitter.emit("did-error", error);
          return false;
        }
      } else {
        return false;
      }
    }
    return newMarkers;
  }

  bufferStoppedChanging({ changes }) {
    if (
      this.findOptions.inCurrentSelection ||
      this.asyncSearch ||
      this.editor.getBuffer().getTextSnapshot().length >= ASYNC_SEARCH_UNITS
    )
      return this.recreateMarkers();
    let marker;
    let scanEnd = Point.ZERO;
    let markerIndex = 0;

    for (let change of changes) {
      const changeStart = change.start;
      const changeEnd = change.start.traverse(change.newExtent);
      if (changeEnd.isLessThan(scanEnd)) continue;

      let precedingMarkerIndex = -1;
      while ((marker = this.markers[markerIndex])) {
        if (marker.isValid()) {
          if (marker.getBufferRange().end.isGreaterThan(changeStart)) {
            break;
          }
          precedingMarkerIndex = markerIndex;
        } else {
          this.markers[markerIndex] = this.recreateMarker(marker);
        }
        markerIndex++;
      }

      let followingMarkerIndex = -1;
      while ((marker = this.markers[markerIndex])) {
        if (marker.isValid()) {
          followingMarkerIndex = markerIndex;
          if (marker.getBufferRange().start.isGreaterThanOrEqual(changeEnd)) {
            break;
          }
        } else {
          this.markers[markerIndex] = this.recreateMarker(marker);
        }
        markerIndex++;
      }

      let spliceStart, scanStart;
      if (precedingMarkerIndex >= 0) {
        spliceStart = precedingMarkerIndex;
        scanStart = this.markers[precedingMarkerIndex].getBufferRange().start;
      } else {
        spliceStart = 0;
        scanStart = Point.ZERO;
      }

      let spliceEnd;
      if (followingMarkerIndex >= 0) {
        spliceEnd = followingMarkerIndex;
        scanEnd = this.markers[followingMarkerIndex].getBufferRange().end;
      } else {
        spliceEnd = Infinity;
        scanEnd = Point.INFINITY;
      }

      const newMarkers = this.createMarkers(scanStart, scanEnd) || [];
      const oldMarkers = this.markers.splice(
        spliceStart,
        spliceEnd - spliceStart + 1,
        ...newMarkers,
      );
      for (let oldMarker of oldMarkers) {
        oldMarker.destroy();
      }
      markerIndex += newMarkers.length - oldMarkers.length;
    }

    while ((marker = this.markers[++markerIndex])) {
      if (!marker.isValid()) {
        this.markers[markerIndex] = this.recreateMarker(marker);
      }
    }

    if (this.needsAsync || this.markers.length > MAX_MARKERS) return this.recreateMarkers();
    this.emitter.emit("did-update", this.markers.slice());
    this.currentResultMarker = null;
    this.setCurrentMarkerFromSelection();
  }

  setCurrentMarkerFromSelection(change) {
    if (
      change &&
      (change.selection || this.selectionRevision === this.editor.getBuffer().getTextRevision()) &&
      this.findOptions.inCurrentSelection &&
      !this.resultSelectionDepth &&
      !this.replacing &&
      !change.textChanged &&
      !["undo", "redo", "reload"].includes(change.origin) &&
      this.editor.getSelectedBufferRanges().some((range) => !range.isEmpty())
    )
      this.scopeSelectionDirty = true;
    const changedSelection = change?.selection ?? change;
    if (changedSelection && changedSelection !== this.editor.getLastSelection()) return;

    const selectedRange = this.editor.getSelectedBufferRange();
    if (this.asyncSearch && this.currentResult && !selectedRange.isEqual(this.currentResult.range))
      this.currentResult = null;
    const marker = this.findMarker(selectedRange);

    if (marker === this.currentResultMarker) return;

    if (this.currentResultMarker) {
      this.resultsLayerDecoration.setPropertiesForMarker(this.currentResultMarker, null);
      this.currentResultMarker = null;
    }

    if (marker && !marker.isDestroyed()) {
      this.resultsLayerDecoration.setPropertiesForMarker(marker, {
        type: "highlight",
        class: "current-result",
      });
      this.currentResultMarker = marker;
    }

    this.emitter.emit("did-change-current-result", this.currentResultMarker);
  }

  findMarker(range) {
    if (this.resultsMarkerLayer) {
      return this.resultsMarkerLayer.findMarkers({
        startBufferPosition: range.start,
        endBufferPosition: range.end,
      })[0];
    }
  }

  recreateMarker(marker) {
    const range = marker.getBufferRange();
    marker.destroy();
    return this.createMarker(range);
  }

  createMarker(range) {
    return this.resultsMarkerLayer.markBufferRange(range, {
      invalidate: "inside",
    });
  }

  getFindPatternRegex(forceUnicode) {
    try {
      return this.findOptions.getFindPatternRegex(forceUnicode);
    } catch (e) {
      this.error = e;
      this.emitter.emit("did-error", e);
      return null;
    }
  }
};
