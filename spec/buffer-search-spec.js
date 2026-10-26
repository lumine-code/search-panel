const FindOptions = require("../lib/find-options");
const BufferSearch = require("../lib/buffer-search");

describe("BufferSearch", () => {
  let editor, model, markersListener;

  beforeEach(() => {
    for (const key of ["useRegex", "caseSensitive", "wholeWord", "inCurrentSelection"]) {
      lumine.config.set(`search-panel.${key}`, false);
    }

    editor = lumine.workspace.buildTextEditor();
    editor.setText("one two One\none oneone\ntwo one\n");

    model = new BufferSearch(new FindOptions());
    model.setEditor(editor);

    markersListener = jasmine.createSpy("markersListener");
    model.onDidUpdate(markersListener);
  });

  afterEach(() => model.destroy());

  it("replaces many matches on the same row in one layout update and one undo", () => {
    const source = "one gap ".repeat(100);
    editor.setText(source);
    editor.getBuffer().clearUndoStack();
    model.search("one");
    const layout = spyOn(editor.getBuffer(), "updateDisplayLayersForChange").and.callThrough();
    model.replace(model.markers.slice(), "replacement");
    expect(editor.getText()).toBe("replacement gap ".repeat(100));
    expect(model.markers.length).toBe(0);
    expect(layout.calls.count()).toBe(1);
    editor.undo();
    expect(editor.getText()).toBe(source);
    editor.redo();
    expect(editor.getText()).toBe("replacement gap ".repeat(100));
  });

  it("keeps read-only text and result markers when replacement is refused", () => {
    editor.setText("one ".repeat(100));
    model.search("one");
    editor.setReadOnly(true);
    model.replace(model.markers.slice(), "other");
    expect(editor.getText()).toBe("one ".repeat(100));
    expect(model.markers.length).toBe(100);
  });

  it("marks every occurrence of the pattern and emits did-update", () => {
    model.search("one");
    // "one" (case-insensitive default): line0 col0, line0 col8 (One),
    // line1 col0, line1 col4, line1 col7, line2 col4 => 6 matches.
    expect(model.markers.length).toBe(6);
    expect(markersListener).toHaveBeenCalled();
  });

  it("clears markers when the pattern is emptied", () => {
    model.search("one");
    expect(model.markers.length).toBeGreaterThan(0);
    model.search("");
    expect(model.markers.length).toBe(0);
  });

  it("updates the current result once when a multi-selection moves", () => {
    model.search("one");
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 0],
      ],
      [
        [1, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [2, 0],
      ],
    ]);
    const findMarker = spyOn(model, "findMarker").and.callThrough();

    editor.selectRight();

    expect(findMarker.calls.count()).toBe(1);
  });

  describe("the case-sensitive option", () => {
    it("matches any case when disabled", () => {
      model.search("one", { caseSensitive: false });
      expect(model.markers.length).toBe(6);
    });

    it("matches exact case when enabled", () => {
      model.search("One", { caseSensitive: true });
      expect(model.markers.length).toBe(1);
    });
  });

  describe("the whole-word option", () => {
    it("only matches standalone words when enabled", () => {
      // Without whole-word "one" matches inside "oneone"; with it, that is excluded.
      model.search("one", { wholeWord: false, caseSensitive: true });
      const loose = model.markers.length;
      model.search("one", { wholeWord: true, caseSensitive: true });
      expect(model.markers.length).toBeLessThan(loose);
      // Standalone lowercase "one": line0 col0, line1 col0, line2 col4 => 3.
      expect(model.markers.length).toBe(3);
    });
  });

  describe("the regex option", () => {
    it("interprets the pattern as a regular expression when enabled", () => {
      model.search("o.e", { useRegex: true, caseSensitive: true });
      // matches every lowercase "one" occurrence including inside "oneone".
      expect(model.markers.length).toBe(5);
    });

    it("treats the pattern literally when disabled", () => {
      model.search("o.e", { useRegex: false });
      expect(model.markers.length).toBe(0);
    });
  });

  describe("the in-current-selection option", () => {
    it("only searches within the selected ranges", () => {
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 11],
      ]);
      model.search("one", { inCurrentSelection: true, caseSensitive: true });
      // Only the first line is selected -> single lowercase "one".
      expect(model.markers.length).toBe(1);
    });
  });

  describe("the project discovery options", () => {
    it("defaults to core ignored names and the core VCS ignore preference", () => {
      const originalValue = lumine.config.get("core.excludeVcsIgnoredPaths");

      try {
        lumine.config.set("core.excludeVcsIgnoredPaths", true);
        expect(new FindOptions().useCoreIgnoredNames).toBe(true);
        expect(new FindOptions().excludeVcsIgnoredPaths).toBe(true);

        lumine.config.set("core.excludeVcsIgnoredPaths", false);
        expect(new FindOptions().excludeVcsIgnoredPaths).toBe(false);
      } finally {
        lumine.config.set("core.excludeVcsIgnoredPaths", originalValue);
      }
    });
  });

  describe("replace", () => {
    it("replaces the given markers and shrinks the marker set", () => {
      model.search("one", { caseSensitive: true });
      const before = model.markers.length;
      const [first] = model.markers;
      model.replace([first], "X");
      expect(model.markers.length).toBe(before - 1);
      expect(editor.getText()).toContain("X");
    });

    it("replaces every marker when passed the full set", () => {
      model.search("two", { caseSensitive: true });
      model.replace(model.markers.slice(), "2");
      expect(model.markers.length).toBe(0);
      expect(editor.getText()).not.toContain("two");
    });
  });

  it("preserves lookbehind and capture context when replacing a current small-buffer match", async () => {
    const { EditorSearchTarget } = require("../lib/search-target");
    editor.setText("prefix-one prefix-two");
    model.search("(?<=prefix-)(one|two)", { useRegex: true, caseSensitive: true });
    const target = new EditorSearchTarget(model);
    await target.replaceCurrentMatch("[$1]");
    expect(editor.getText()).toBe("prefix-[one] prefix-two");
    await model.search("(?<=prefix-)(two)");
    await target.replaceAll("[$1]");
    expect(editor.getText()).toBe("prefix-[one] prefix-[two]");
  });

  describe("large-document sessions", () => {
    beforeEach(() => editor.setText("one two\n".repeat(20000)));

    it("counts every result while bounding markers and navigates beyond the presentation limit", async () => {
      await model.search("one", { caseSensitive: true });
      expect(model.getResultCount()).toBe(20000);
      expect(model.pending).toBe(false);
      expect(model.markers.length).toBeLessThanOrEqual(2001);
      editor.setCursorBufferPosition([19000, 0]);
      const result = await model.selectMatch("next");
      expect(result.found).toBe(true);
      expect(editor.getSelectedBufferRange()).toEqual([
        [19001, 0],
        [19001, 3],
      ]);
      expect(model.getCurrentResultIndex()).toBe(19001);
      await model.refreshViewport();
      expect(model.markers.length).toBeLessThanOrEqual(2001);
    });

    it("serializes queued navigation against the selection left by the preceding command", async () => {
      await model.search("one");
      editor.setCursorBufferPosition([0, 0]);
      await Promise.all([
        model.selectMatch("next"),
        model.selectMatch("next"),
        model.selectMatch("next"),
      ]);
      expect(editor.getSelectedBufferRange()).toEqual([
        [3, 0],
        [3, 3],
      ]);
    });

    it("decorates a multiline match that starts above the viewport and ends inside it", async () => {
      const needle = "start\n" + "middle\n".repeat(30) + "end";
      editor.setText("x\n".repeat(90) + needle + "\n" + "tail\n".repeat(30000));
      spyOn(editor, "getFirstVisibleScreenRow").and.returnValue(120);
      spyOn(editor, "getLastVisibleScreenRow").and.returnValue(130);
      await model.search(needle, { caseSensitive: true });
      await model.refreshViewport();
      expect(model.getResultCount()).toBe(1);
      expect(model.markers.length).toBe(1);
      expect(model.markers[0].getBufferRange()).toEqual([
        [90, 0],
        [121, 3],
      ]);
    });

    it("counts dense nonliteral regex matches in the renderer worker", async () => {
      await model.search("o.e", { useRegex: true, caseSensitive: true });
      expect(model.getResultCount()).toBe(20000);
      expect(model.pending).toBe(false);
      expect(model.error).toBeNull();
    });

    it("cancels old queries and rejects an edited revision before rebuilding", async () => {
      const old = model.search("one");
      await model.search("two");
      await old;
      expect(model.getResultCount()).toBe(20000);
      expect(model.getFindOptions().findPattern).toBe("two");
      editor.insertText("two ");
      expect(model.pending).toBe(true);
      await model.search("two");
      expect(model.getResultCount()).toBe(20001);
    });

    it("does not let an oversized multiline error survive a new supported query", async () => {
      const errors = jasmine.createSpy("errors");
      model.onDidError(errors);
      editor.setText("one\n".repeat(2100000));
      await model.search("[\\s\\S]*one", { useRegex: true });
      expect(errors).toHaveBeenCalled();
      expect(model.pending).toBe(false);
      await model.search("missing", { useRegex: false });
      expect(model.getResultCount()).toBe(0);
      expect(model.pending).toBe(false);
    });

    it("replaces every match outside the marker cap and preserves one undo operation", async () => {
      await model.search("one", { caseSensitive: true });
      await model.replaceAllMatches("found");
      expect(editor.getText()).toBe("found two\n".repeat(20000));
      editor.undo();
      expect(editor.getText()).toBe("one two\n".repeat(20000));
    });
  });
});
