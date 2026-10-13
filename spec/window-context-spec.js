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
    await workspace.attachWindow(extra);
    expect(main.windowFinds.has(extra)).toBe(false);
  });
});
