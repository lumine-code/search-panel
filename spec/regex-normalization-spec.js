describe("Native buffer regex normalization", () => {
  let main, service, editor;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    spyOn(lumine.notifications, "beep");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("language-regex");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    editor = await lumine.workspace.open();
    service = main.provideSearchControl();
    service.getFindOptions().set({ useRegex: true });
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("search-panel"))
      await lumine.packages.deactivatePackage("search-panel");
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel");
    editor?.destroy();
    main = service = editor = null;
  });

  function matchedText() {
    return service
      .resultsMarkerLayerForTextEditor(editor)
      .getMarkers()
      .map((marker) => editor.getTextInBufferRange(marker.getBufferRange()));
  }

  it("keeps newline character classes from matching a question mark", () => {
    editor.setText("one?two\nend");
    service.search("[\\n]");
    expect(matchedText()).toEqual(["\n"]);
  });

  it("preserves an escaped literal backslash followed by n", () => {
    editor.setText("literal\\n\nend");
    service.search("\\\\n");
    expect(matchedText()).toEqual(["\\n"]);
  });

  it("uses selected Unicode text with a hyphen as a valid escaped regex", async () => {
    editor.setText("żółw-test");
    editor.selectAll();
    await lumine.commands.dispatch(
      editor.getElement(),
      "search-panel:use-selection-as-find-pattern",
    );
    expect(matchedText()).toEqual(["żółw-test"]);
    expect(main.findView.refs.descriptionLabel.classList.contains("text-error")).toBe(false);
  });

  it("keeps ordinary newline matching", () => {
    editor.setText("one\ntwo\nend");
    service.search("\\n");
    expect(matchedText()).toEqual(["\n", "\n"]);
  });

  it("keeps ordinary newline matching across CRLF and LF", () => {
    editor.setText("one\r\ntwo\nend");
    service.search("\\n");
    expect(matchedText()).toEqual(["\r\n", "\n"]);
  });

  it("preserves explicitly requested CRLF matching", () => {
    editor.setText("one\r\ntwo\nend");
    service.search("\\r\\n");
    expect(matchedText()).toEqual(["\r\n"]);
  });

  it("keeps a newline quantifier applying to complete CRLF line endings", () => {
    editor.setText("one\r\n\r\nend");
    service.search("\\n+");
    expect(matchedText()).toEqual(["\r\n\r\n"]);
  });
});
