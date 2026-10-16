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
    expect(lumine.commands.canDispatch(target, "search-panel:find-next-selected")).toBe(true);
    expect(main.isSearchAvailable({ target }, true)).toBe(true);
    editor.setReadOnly(true);
    expect(lumine.commands.canDispatch(target, "search-panel:find-next-selected")).toBe(true);
    expect(main.isSearchAvailable({ target }, true)).toBe(false);
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
    expect(lumine.commands.canDispatch(element, "search-panel:find-next-selected")).toBe(true);
    expect(main.isSearchAvailable({ target: element }, true)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(main.runtime).toBeNull();
    service.dispose();
  });

  it("rejects non-Boolean passive replacement capability answers", () => {
    const item = {
      getTitle: () => "Custom document",
      getElement: () => document.createElement("div"),
    };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    const service = main.consumeSearchAdapter({
      handlesItem: () => true,
      canReplaceItem: () => "yes",
      getAdapterForItem() {},
    });
    expect(() => main.isSearchAvailable({ target: lumine.workspace.element }, true)).toThrowError(
      TypeError,
    );
    service.dispose();
  });

  it("requires a passive item matcher and an item-specific adapter factory", () => {
    expect(() => main.consumeSearchAdapter({ getActiveAdapter() {} })).toThrowError(TypeError);
    expect(() => main.consumeSearchAdapter({ handlesItem: () => true })).toThrowError(TypeError);
    expect(() =>
      main.consumeSearchAdapter({
        handlesItem: () => true,
        getAdapterForItem() {},
        canReplaceItem: true,
      }),
    ).toThrowError(TypeError);
    expect(main.searchAdapterServices).toEqual([]);
  });

  it("uses the same passive matching contract before and after constructing the runtime", () => {
    const { Disposable } = require("lumine");
    const element = document.createElement("div");
    const item = { getTitle: () => "Searchable document", getElement: () => element };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    const unrelated = jasmine.createSpy("unmatched factory").and.throwError("Wrong adapter");
    const first = main.consumeSearchAdapter({
      handlesItem: () => false,
      getAdapterForItem: unrelated,
    });
    const adapter = {
      canReplace: true,
      search() {},
      getResultCount: () => 0,
      getCurrentResultIndex: () => -1,
      onDidUpdate: () => new Disposable(),
      onDidChangeCurrentResult: () => new Disposable(),
    };
    const create = jasmine.createSpy("matching factory").and.returnValue(adapter);
    const matching = main.consumeSearchAdapter({
      handlesItem: (candidate) => candidate === item,
      canReplaceItem: () => true,
      getAdapterForItem: create,
    });
    expect(lumine.commands.canDispatch(element, "search-panel:find-next-selected")).toBeTrue();
    expect(create).not.toHaveBeenCalled();
    main.createFindView();
    expect(lumine.commands.canDispatch(element, "search-panel:find-next-selected")).toBeTrue();
    expect(unrelated).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    matching.dispose();
    first.dispose();
  });

  it("rejects non-Boolean passive adapter answers", () => {
    const item = {
      getTitle: () => "Custom document",
      getElement: () => document.createElement("div"),
    };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    const service = main.consumeSearchAdapter({
      handlesItem: () => Promise.resolve(true),
      getAdapterForItem() {},
    });
    expect(() => main.isSearchAvailable({ target: lumine.workspace.element })).toThrowError(
      TypeError,
    );
    service.dispose();
  });

  it("requires an entered pattern only for commands which cannot derive one from the document", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("a word");
    const target = editor.getElement();
    const commands = [
      "find-next",
      "find-previous",
      "find-all",
      "replace-next",
      "replace-previous",
      "replace-current",
      "replace-all",
    ];
    for (const command of commands)
      expect(lumine.commands.canDispatch(target, `search-panel:${command}`)).toBeFalse();
    for (const command of [
      "find-next-selected",
      "find-previous-selected",
      "use-selection-as-find-pattern",
      "use-selection-as-replace-pattern",
    ])
      expect(lumine.commands.canDispatch(target, `search-panel:${command}`)).toBeTrue();
    main.createFindView();
    lumine.config.set("search-panel.liveSearchMinimumCharacters", 3);
    main.findView.findEditor.setText("a");
    expect(main.findModel.markers.length).toBe(0);
    const read = spyOn(main.findView.findEditor, "getText").and.callThrough();
    for (const command of commands)
      expect(lumine.commands.canDispatch(target, `search-panel:${command}`)).toBeTrue();
    expect(read).not.toHaveBeenCalled();
    await lumine.commands.dispatch(target, "search-panel:find-next");
    expect(editor.getSelectedText()).toBe("a");
    main.findView.findEditor.setText("");
    for (const command of commands)
      expect(lumine.commands.canDispatch(target, `search-panel:${command}`)).toBeFalse();
  });

  it("invalidates workspace command state when the shared find field crosses the empty boundary", async () => {
    await lumine.workspace.open();
    main.createProjectFindView();
    await globalThis.flushMicrotasks();
    const changed = jasmine.createSpy("find pattern availability");
    const subscription = lumine.commands.onDidChange(changed);
    main.projectFindView.findEditor.setText("a");
    expect(changed).toHaveBeenCalledWith(undefined);
    expect(
      lumine.commands.canDispatch(lumine.workspace.element, "search-panel:find-next"),
    ).toBeTrue();
    changed.calls.reset();
    main.projectFindView.findEditor.setText("ab");
    expect(changed).not.toHaveBeenCalled();
    main.projectFindView.findEditor.setText("");
    expect(changed).toHaveBeenCalledWith(undefined);
    subscription.dispose();
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
