describe("document find panels in editor windows", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("search-panel");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("search-panel");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps local patterns and replacement targets while another window is active", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    first.setText("alpha alpha");
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    second.setText("beta beta");
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    await lumine.commands.dispatch(first.getElement(), "search-panel:show");
    await lumine.commands.dispatch(second.getElement(), "search-panel:show");
    const main = lumine.packages.getActivePackage("search-panel").mainModule;
    const remote = main.windowFinds.get(extra);
    expect(main.findPanel.isVisible()).toBe(true);
    expect(remote.panel.isVisible()).toBe(true);
    expect(remote.view.element.ownerDocument).toBe(extra.getDocument());
    main.findView.search("alpha");
    remote.view.search("beta");
    expect(main.findModel.getEditor()).toBe(first);
    expect(remote.model.getEditor()).toBe(second);
    expect(main.findOptions.findPattern).toBe("alpha");
    expect(remote.options.findPattern).toBe("beta");
    await lumine.commands.dispatch(first.getElement(), "search-panel:find-next");
    expect(first.getSelectedText()).toBe("alpha");
    await lumine.commands.dispatch(second.getElement(), "search-panel:find-next");
    expect(second.getSelectedText()).toBe("beta");
    const focus = spyOn(extra.getElement(), "focus").and.callThrough();
    await lumine.commands.dispatch(remote.view.element, "window:focus-next-pane");
    expect(focus).toHaveBeenCalled();
    await workspace.attachWindow(extra);
    expect(main.windowFinds.has(extra)).toBe(false);
  });

  it("checks the invoking window's current pattern instead of the main find field", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    await lumine.commands.dispatch(first.getElement(), "search-panel:show");
    await lumine.commands.dispatch(second.getElement(), "search-panel:show");
    const main = lumine.packages.getActivePackage("search-panel").mainModule;
    const remote = main.windowFinds.get(extra);
    main.findView.findEditor.setText("main");
    expect(lumine.commands.canDispatch(first.getElement(), "search-panel:find-next")).toBeTrue();
    expect(lumine.commands.canDispatch(second.getElement(), "search-panel:find-next")).toBeFalse();
    remote.view.findEditor.setText("other");
    main.findView.findEditor.setText("");
    expect(lumine.commands.canDispatch(first.getElement(), "search-panel:find-next")).toBeFalse();
    expect(lumine.commands.canDispatch(second.getElement(), "search-panel:find-next")).toBeTrue();
  });
});
