const { CompositeDisposable, Disposable } = require("lumine");

describe("Search adapter shortcut scope", () => {
  let main, subscriptions;
  const primary = process.platform === "darwin" ? "cmd" : "ctrl";

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    subscriptions = new CompositeDisposable();
  });

  afterEach(async () => {
    subscriptions.dispose();
    await lumine.packages.deactivatePackage("search-panel");
    await lumine.workspace.discardEditorWindows();
  });

  function createItem(title = "Searchable document", document = globalThis.document) {
    const element = document.createElement("div");
    const content = document.createElement("span");
    const input = document.createElement("input");
    element.append(content, input);
    return { getTitle: () => title, getElement: () => element, content, input };
  }

  function activate(item, container = lumine.workspace.getCenter()) {
    const pane = container.getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    return pane;
  }

  function register(item) {
    const adapter = {
      canReplace: false,
      search: jasmine.createSpy("search"),
      getResultCount: () => 2,
      getCurrentResultIndex: () => -1,
      selectNext: jasmine.createSpy("selectNext").and.returnValue({ found: true, wrapped: null }),
      selectPrevious: jasmine
        .createSpy("selectPrevious")
        .and.returnValue({ found: true, wrapped: null }),
      onDidUpdate: () => new Disposable(),
      onDidChangeCurrentResult: () => new Disposable(),
      deactivate: jasmine.createSpy("deactivate"),
    };
    const factory = jasmine.createSpy("adapter factory").and.returnValue(adapter);
    const edge = main.consumeSearchAdapter({
      handlesItem: (candidate) => candidate === item,
      canReplaceItem: () => false,
      getAdapterForItem: factory,
    });
    subscriptions.add(edge);
    return { adapter, factory, edge };
  }

  function key(target, keystroke) {
    lumine.keymaps.handleKeyboardEvent(
      lumine.keymaps.constructor.buildKeydownEvent(keystroke, { target }),
    );
  }

  function bindings(target, keystrokes) {
    return lumine.keymaps
      .findKeyBindings({ target, keystrokes })
      .filter(({ command }) => command.startsWith("search-panel:"));
  }

  it("keeps passive adapter availability cold until the search runtime is needed", () => {
    const item = createItem();
    activate(item);
    const { factory } = register(item);
    const ensure = spyOn(main, "ensureRuntime").and.callThrough();

    expect(lumine.commands.canDispatch(item.content, "search-panel:find-next-selected")).toBeTrue();
    expect(lumine.commands.canDispatch(item.content, "search-panel:find-next")).toBeFalse();
    expect(item.getElement().hasAttribute("data-search-target")).toBeFalse();
    expect(bindings(item.content, "f3")).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(main.runtime).toBeNull();

    main.createFindView();

    expect(factory).toHaveBeenCalledOnceWith(item);
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();
  });

  it("navigates and clears through the shared scope from adapter content and toolbar inputs", () => {
    const item = createItem();
    activate(item);
    const { adapter } = register(item);
    main.createFindView();
    main.findView.findEditor.setText("needle");

    key(item.content, "f3");
    key(item.input, "shift-f3");

    expect(adapter.selectNext).toHaveBeenCalledOnceWith({ mode: "zone" });
    expect(adapter.selectPrevious).toHaveBeenCalledOnceWith({ mode: "zone" });
    expect(main.findView.findEditor.getText()).toBe("needle");
    key(item.content, `${primary}-f3`);
    expect(main.findView.findEditor.getText()).toBe("");
    expect(lumine.commands.canDispatch(item.content, "search-panel:find-next")).toBeFalse();
  });

  it("does not extend adapter shortcuts to the workspace or unrelated inputs", () => {
    const item = createItem();
    activate(item);
    const { adapter } = register(item);
    main.createFindView();
    main.findView.findEditor.setText("needle");
    const unrelated = document.createElement("input");
    lumine.workspace.getElement().appendChild(unrelated);
    subscriptions.add(new Disposable(() => unrelated.remove()));
    const mini = lumine.workspace.buildTextEditor({ mini: true });
    lumine.workspace.getElement().appendChild(mini.getElement());
    subscriptions.add(new Disposable(() => mini.destroy()));

    for (const target of [lumine.workspace.getElement(), unrelated, mini.getElement()]) {
      expect(bindings(target, "f3")).toEqual([]);
      expect(bindings(target, "shift-f3")).toEqual([]);
      expect(bindings(target, `${primary}-f3`)).toEqual([]);
      key(target, "f3");
      key(target, "shift-f3");
      key(target, `${primary}-f3`);
    }

    expect(adapter.selectNext).not.toHaveBeenCalled();
    expect(adapter.selectPrevious).not.toHaveBeenCalled();
    expect(main.findView.findEditor.getText()).toBe("needle");
    expect(bindings(item.content, "f4")).toEqual([]);
    expect(bindings(item.content, "shift-f4")).toEqual([]);
    expect(lumine.commands.canDispatch(item.content, "search-panel:replace-current")).toBeFalse();
  });

  it("moves the scope with the active adapter item and removes it for ordinary editors", async () => {
    const first = createItem("First document");
    const second = createItem("Second document");
    const pane = activate(first);
    register(first);
    register(second);
    main.createFindView();

    expect(first.getElement().hasAttribute("data-search-target")).toBeTrue();
    expect(second.getElement().hasAttribute("data-search-target")).toBeFalse();
    activate(second);
    expect(first.getElement().hasAttribute("data-search-target")).toBeFalse();
    expect(second.getElement().hasAttribute("data-search-target")).toBeTrue();
    await lumine.workspace.open();
    expect(second.getElement().hasAttribute("data-search-target")).toBeFalse();
    pane.activateItem(first);
    expect(first.getElement().hasAttribute("data-search-target")).toBeTrue();
  });

  it("retains an overlapping provider and releases the scope when the last edge disappears", () => {
    const item = createItem();
    activate(item);
    const first = register(item);
    const second = register(item);
    main.createFindView();

    first.edge.dispose();
    expect(first.adapter.deactivate).toHaveBeenCalled();
    expect(second.factory).toHaveBeenCalledWith(item);
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();
    second.edge.dispose();
    expect(item.getElement().hasAttribute("data-search-target")).toBeFalse();
    expect(bindings(item.content, "f3")).toEqual([]);
    register(item);
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();
  });

  it("keeps a transferred item's scope until both window leases have been released", () => {
    const item = createItem();
    const source = main.markSearchTarget(item);
    const destination = main.markSearchTarget(item);
    subscriptions.add(source, destination);

    source.dispose();
    source.dispose();
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();
    destination.dispose();
    expect(item.getElement().hasAttribute("data-search-target")).toBeFalse();
  });

  it("releases the scope on package deactivation and reacquires it after reactivation", async () => {
    const item = createItem();
    activate(item);
    const first = register(item);
    main.createFindView();
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();

    await lumine.packages.deactivatePackage("search-panel");
    expect(item.getElement().hasAttribute("data-search-target")).toBeFalse();
    first.edge.dispose();
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    register(item);
    expect(item.getElement().hasAttribute("data-search-target")).toBeFalse();
    main.createFindView();
    expect(item.getElement().hasAttribute("data-search-target")).toBeTrue();
  });

  it("owns the scope independently in an additional editor window", async () => {
    const first = createItem("Main document");
    activate(first);
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const second = createItem("Window document", extra.getDocument());
    const container = extra.getEditorContainer();
    const pane = activate(second, container);
    const other = createItem("Unsearchable document", extra.getDocument());
    const firstProvider = register(first);
    const secondProvider = register(second);
    main.createFindView();
    main.getWindowFind(extra).createView();

    expect(first.getElement().hasAttribute("data-search-target")).toBeTrue();
    expect(second.getElement().hasAttribute("data-search-target")).toBeTrue();
    activate(other, container);
    expect(first.getElement().hasAttribute("data-search-target")).toBeTrue();
    expect(second.getElement().hasAttribute("data-search-target")).toBeFalse();
    pane.activateItem(second);
    expect(second.getElement().hasAttribute("data-search-target")).toBeTrue();
    secondProvider.edge.dispose();
    expect(first.getElement().hasAttribute("data-search-target")).toBeTrue();
    expect(second.getElement().hasAttribute("data-search-target")).toBeFalse();
    firstProvider.edge.dispose();
    expect(first.getElement().hasAttribute("data-search-target")).toBeFalse();
  });
});
