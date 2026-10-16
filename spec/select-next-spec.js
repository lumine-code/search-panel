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
});
