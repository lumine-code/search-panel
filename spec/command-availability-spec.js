const path = require("node:path");

describe("Search command availability", () => {
  let main;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
  });
  afterEach(() => lumine.packages.deactivatePackage("search-panel"));

  it("checks the current surface without constructing the search runtime", async () => {
    const ensure = spyOn(main, "ensureRuntime").and.callThrough();
    const target = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(target, "search-panel:find-next")).toBe(false);
    const editor = await lumine.workspace.open();
    expect(lumine.commands.canDispatch(target, "search-panel:find-next")).toBe(true);
    expect(lumine.commands.canDispatch(target, "search-panel:replace-all")).toBe(true);
    editor.setReadOnly(true);
    expect(lumine.commands.canDispatch(target, "search-panel:find-next")).toBe(true);
    expect(lumine.commands.canDispatch(target, "search-panel:replace-all")).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("uses passive adapter capabilities before the adapter has ever been constructed", () => {
    const element = document.createElement("div");
    const item = { getTitle: () => "Adapter target", getElement: () => element };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    const create = jasmine
      .createSpy("adapter factory")
      .and.throwError("Queries must not create adapters");
    const service = main.consumeSearchAdapter({
      handlesItem: (candidate) => candidate === item,
      canReplaceItem: () => false,
      getAdapterForItem: create,
    });
    expect(lumine.commands.canDispatch(element, "search-panel:find-next")).toBe(true);
    expect(lumine.commands.canDispatch(element, "search-panel:replace-all")).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(main.runtime).toBeNull();
    service.dispose();
  });

  it("handles Focus Next Pane exactly once from either search panel", async () => {
    await lumine.commands.dispatch(lumine.workspace.getElement(), "search-panel:show");
    const focus = spyOn(lumine.workspace.getElement(), "focus").and.stub();
    const next = spyOn(lumine.workspace.getCenter().paneContainer, "activateNextPane").and.stub();
    for (const getView of [
      () => main.findView,
      () => {
        main.createProjectFindView();
        return main.projectFindView;
      },
    ]) {
      focus.calls.reset();
      await lumine.commands.dispatch(getView().findEditor.getElement(), "window:focus-next-pane");
      expect(focus).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("resolves a captured file context instead of the main editor and respects an explicit empty context", async () => {
    const editor = await lumine.workspace.open();
    editor.getBuffer().setPath(path.join(process.cwd(), "first", "a.txt"));
    const other = lumine.workspace.buildTextEditor();
    other.getBuffer().setPath(path.join(process.cwd(), "second", "b.txt"));
    const { directoryPathForEvent } = require("../lib/command-context");
    const target = document.createElement("button");
    expect(directoryPathForEvent({ target, context: { fileEditor: other } })).toBe(
      path.dirname(other.getPath()),
    );
    expect(directoryPathForEvent({ target, context: {} })).toBeNull();
    other.destroy();
  });
});
