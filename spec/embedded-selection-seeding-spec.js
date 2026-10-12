describe("Find panel selection from embedded editors", () => {
  let main, item, editor, registration, workspaceElement, wasConnected;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    workspaceElement = lumine.views.getView(lumine.workspace);
    wasConnected = workspaceElement.isConnected;
    if (!wasConnected) document.body.appendChild(workspaceElement);
    await lumine.packages.activatePackage("language-regex");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("search-panel"))
      await lumine.packages.deactivatePackage("search-panel");
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel");
    const pane = item && lumine.workspace.paneForItem(item);
    if (pane) await pane.destroyItem(item);
    registration?.dispose();
    if (editor && !editor.isDestroyed()) editor.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (!wasConnected) workspaceElement.remove();
    main = item = editor = registration = null;
  });

  async function openEmbeddedSelection() {
    editor = lumine.workspace.buildTextEditor({ readOnly: true });
    editor.setText("before (selected) after", { bypassReadOnly: true });
    editor.setSelectedBufferRange([
      [0, 7],
      [0, 17],
    ]);
    registration = lumine.textEditors.add(editor, { role: "viewer" });
    const element = document.createElement("div");
    element.appendChild(editor.getElement());
    item = {
      isSingleton: () => true,
      getTitle: () => "Owned embedded search source",
      getElement: () => element,
      getEmbeddedTextEditor: () => editor,
      destroy: () => {
        registration.dispose();
        editor.destroy();
      },
    };
    await lumine.workspace.open(item);
    expect(lumine.workspace.getCenter().getActiveTextEditor()).toBeUndefined();
    main.ensureRuntime();
    expect(main.findModel.getEditor()).toBe(editor);
  }

  it("seeds the find field from the current embedded viewer selection", async () => {
    await openEmbeddedSelection();
    main.findOptions.set({ useRegex: true });
    lumine.commands.dispatch(item.getElement(), "search-panel:show");
    expect(main.findView.findEditor.getText()).toBe("\\(selected\\)");
  });

  it("seeds the replace field from the current embedded viewer selection", async () => {
    await openEmbeddedSelection();
    lumine.commands.dispatch(item.getElement(), "search-panel:show-replace");
    expect(main.findView.replaceEditor.getText()).toBe("(selected)");
  });

  it("retains selection seeding for an ordinary pane editor", async () => {
    editor = await lumine.workspace.open();
    editor.setText("ordinary selection");
    editor.setSelectedBufferRange([
      [0, 0],
      [0, 8],
    ]);
    item = editor;
    lumine.commands.dispatch(editor.getElement(), "search-panel:show");
    expect(main.findView.findEditor.getText()).toBe("ordinary");
  });
});
