const { MAX_SELECTION_QUERY_UNITS } = require("../lib/selection-query");

describe("Selection-derived search fields", () => {
  let main, editor;

  beforeEach(async () => {
    editor = await lumine.workspace.open();
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.createFindView();
    main.createProjectFindView();
    spyOn(lumine.notifications, "addWarning");
  });

  it("checks multiline selection metadata before automatic Find, Replace and project prefills", () => {
    editor.setText("first\nsecond\n");
    editor.selectAll();
    main.findView.findEditor.setText("find seed");
    main.findView.replaceEditor.setText("replace seed");
    main.projectFindView.findEditor.setText("find seed");
    const read = spyOn(editor, "getSelectedText").and.throwError("Unexpected selection read");

    main.findView.focusFindEditor();
    main.findView.focusReplaceEditor();
    main.projectFindView.focusFindElement();

    expect(read).not.toHaveBeenCalled();
    expect(main.findView.findEditor.getText()).toBe("find seed");
    expect(main.findView.replaceEditor.getText()).toBe("replace seed");
    expect(main.projectFindView.findEditor.getText()).toBe("find seed");
  });

  it("preflights oversized single-line selections without reading or truncating them", () => {
    editor.setText("x".repeat(MAX_SELECTION_QUERY_UNITS + 1));
    editor.selectAll();
    const read = spyOn(editor, "getSelectedText").and.throwError("Unexpected selection read");
    main.findView.findEditor.setText("keep");
    main.findView.focusFindEditor();
    main.findView.focusReplaceEditor();
    main.projectFindView.focusFindElement();
    expect(read).not.toHaveBeenCalled();
    expect(main.findView.findEditor.getText()).toBe("keep");
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("reports oversized explicit seeds and never navigates with the old query or a word fallback", () => {
    editor.setText("x".repeat(MAX_SELECTION_QUERY_UNITS + 1));
    editor.selectAll();
    main.findView.findEditor.setText("keep");
    main.findView.replaceEditor.setText("keep replacement");
    const read = spyOn(editor, "getSelectedText").and.throwError("Unexpected selection read");
    const word = spyOn(editor, "getWordUnderCursor").and.throwError("Unexpected word fallback");
    const next = spyOn(main.findView, "findNext");
    const previous = spyOn(main.findView, "findPrevious");

    main.findView.findNextSelected();
    main.findView.findPreviousSelected();
    expect(main.findView.setSelectionAsReplacePattern()).toBe(false);
    expect(main.projectFindView.setSelectionAsFindPattern()).toBe(false);
    expect(main.projectFindView.setSelectionAsReplacePattern()).toBe(false);

    expect(read).not.toHaveBeenCalled();
    expect(word).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(previous).not.toHaveBeenCalled();
    expect(main.findView.findEditor.getText()).toBe("keep");
    expect(main.findView.replaceEditor.getText()).toBe("keep replacement");
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
    expect(main.findView.refs.descriptionLabel.textContent).toContain("too large");
  });

  it("rejects whole-line word fallback before scanning a giant row", () => {
    editor.setText("x".repeat(MAX_SELECTION_QUERY_UNITS + 1));
    editor.setCursorBufferPosition([0, 100]);
    const word = spyOn(editor, "getWordUnderCursor").and.throwError(
      "Unexpected whole-line word scan",
    );
    expect(main.findView.setSelectionAsFindPattern()).toBe(false);
    expect(word).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });

  it("still searches the entire large selected range", async () => {
    editor.setText("one\n".repeat(20000));
    editor.selectAll();
    spyOn(editor, "getSelectedText").and.throwError("Selection scopes must use ranges");
    await main.findModel.search("one", { inCurrentSelection: true, caseSensitive: true });
    expect(main.findModel.getResultCount()).toBe(20000);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("retains ordinary multiline explicit selection patterns exactly", () => {
    editor.setText("first\nsecond");
    editor.selectAll();
    expect(main.findView.setSelectionAsFindPattern()).toBe(true);
    expect(main.findView.findEditor.getText()).toBe("first\nsecond");
  });
});
