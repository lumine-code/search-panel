describe("search-panel select-next commands", () => {
  let editor, editorElement;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("foo bar\nfoo baz\nfoo qux\n");
    editorElement = lumine.views.getView(editor);

    await lumine.packages.activatePackage("search-panel");
  });

  const dispatch = (command) => lumine.commands.dispatch(editorElement, command);
  const selectedTexts = () => editor.getSelections().map((s) => s.getText());

  it("does not expose selection actions outside a non-mini editor", () => {
    const mini = lumine.workspace.buildTextEditor({ mini: true });
    lumine.workspace.getElement().appendChild(mini.getElement());
    try {
      for (const suffix of ["select-next", "select-all", "select-undo", "select-skip"]) {
        const command = `search-panel:${suffix}`;
        expect(lumine.commands.canDispatch(editorElement, command)).toBe(true);
        expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command)).toBe(false);
        expect(lumine.commands.canDispatch(mini.getElement(), command)).toBe(false);
      }
      dispatch("search-panel:select-next");
      const ranges = editor.getSelectedBufferRanges();
      lumine.commands.dispatch(lumine.workspace.getElement(), "search-panel:select-all");
      expect(editor.getSelectedBufferRanges()).toEqual(ranges);
    } finally {
      mini.destroy();
    }
  });

  it("selects the word under the cursor, then the next occurrence", () => {
    editor.setCursorBufferPosition([0, 1]);
    dispatch("search-panel:select-next");
    expect(selectedTexts()).toEqual(["foo"]);

    dispatch("search-panel:select-next");
    expect(editor.getSelections().length).toBe(2);
    expect(selectedTexts()).toEqual(["foo", "foo"]);
  });

  it("selects all occurrences", () => {
    editor.setCursorBufferPosition([0, 1]);
    dispatch("search-panel:select-all");
    expect(editor.getSelections().length).toBe(3);
    expect(selectedTexts()).toEqual(["foo", "foo", "foo"]);
  });

  it("skips the current occurrence and selects the next", () => {
    editor.setCursorBufferPosition([0, 1]);
    dispatch("search-panel:select-next");
    dispatch("search-panel:select-skip");
    dispatch("search-panel:select-next");

    const ranges = editor.getSelectedBufferRanges();
    expect(ranges.length).toBe(2);
    // The first occurrence was skipped, so no selection remains on line 0.
    expect(ranges.some((r) => r.start.row === 0)).toBe(false);
  });

  it("undoes the last added selection", () => {
    editor.setCursorBufferPosition([0, 1]);
    dispatch("search-panel:select-next");
    dispatch("search-panel:select-next");
    expect(editor.getSelections().length).toBe(2);

    dispatch("search-panel:select-undo");
    expect(editor.getSelections().length).toBe(1);
  });

  it("rejects an oversized occurrence query before reading the selected text", () => {
    editor.setText("x".repeat(65537));
    editor.selectAll();
    const selected = editor.getSelectedBufferRange();
    const read = spyOn(editor, "getSelectedText").and.throwError("Unexpected selection read");
    spyOn(lumine.notifications, "addWarning");
    dispatch("search-panel:select-next");
    dispatch("search-panel:select-all");
    expect(read).not.toHaveBeenCalled();
    expect(editor.getSelectedBufferRange()).toEqual(selected);
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });

  it("rejects empty-selection word lookup before scanning a giant row", () => {
    editor.setText("x".repeat(65537));
    editor.setCursorBufferPosition([0, 100]);
    const word = spyOn(editor.getLastCursor(), "getCurrentWordBufferRange").and.throwError(
      "Unexpected whole-line scan",
    );
    spyOn(lumine.notifications, "addWarning");
    dispatch("search-panel:select-next");
    expect(word).not.toHaveBeenCalled();
    expect(editor.getSelectedBufferRange().isEmpty()).toBe(true);
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });

  it("reports excessive occurrence selections without silently selecting a prefix", () => {
    editor.setText("one ".repeat(2500));
    editor.setSelectedBufferRange([
      [0, 0],
      [0, 3],
    ]);
    spyOn(lumine.notifications, "addWarning");
    dispatch("search-panel:select-all");
    expect(editor.getSelections().length).toBe(1);
    expect(editor.getSelectedText()).toBe("one");
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });

  it("preserves whole-word boundaries while scanning the literal occurrence", () => {
    editor.setText("foo foobar\nfoo\tfoo");
    editor.setCursorBufferPosition([0, 1]);
    dispatch("search-panel:select-next");
    const model = lumine.packages
      .getActivePackage("search-panel")
      .mainModule.selectNextObjects.get(editor);
    expect(model.wordSelected).toBe(true);
    dispatch("search-panel:select-all");
    expect(editor.getSelectedBufferRanges()).toEqual([
      [
        [0, 0],
        [0, 3],
      ],
      [
        [1, 0],
        [1, 3],
      ],
      [
        [1, 4],
        [1, 7],
      ],
    ]);
  });
});
