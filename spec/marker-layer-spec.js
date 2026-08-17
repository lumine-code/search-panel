const { CompositeDisposable, Emitter } = require("lumine");

describe("search-panel marker layer", () => {
  let workspaceElement, editor, mainModule, provider, layer, service, consumerDisposable;

  // Minimal stand-in for the layer object a renderer passes to `initialize` and
  // `getItems` (see lib/layer.js in the marker package).
  function makeLayer(targetEditor) {
    const fake = {
      editor: targetEditor,
      props: provider,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
    };
    fake.update = jasmine.createSpy("update").and.callFake(() => {
      const items = provider.getItems(fake);
      if (items) {
        fake.items = items;
      }
    });
    fake.updateSync = fake.update;
    if (provider.initialize) {
      provider.initialize(fake);
    }
    return fake;
  }

  // Fake service mirroring the shape of this package's provideSearchControl(),
  // so the specs control visibility and results directly.
  function makeFakeService() {
    const emitter = new Emitter();
    return {
      emitter,
      visible: false,
      markerLayers: new Map(),
      resultsMarkerLayerForTextEditor(targetEditor) {
        return this.markerLayers.get(targetEditor) || null;
      },
      isFindVisible() {
        return this.visible;
      },
      onDidUpdate: (callback) => emitter.on("did-update", callback),
      onDidChangeFindVisibility: (callback) => emitter.on("did-change-find-visibility", callback),
    };
  }

  function markResults(...ranges) {
    const markerLayer = editor.addMarkerLayer();
    for (const range of ranges) {
      markerLayer.markScreenRange(range);
    }
    service.markerLayers.set(editor, markerLayer);
    return markerLayer;
  }

  function emitUpdate() {
    service.emitter.emit("did-update");
  }

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    // The window shares one config across specs, so the keys this suite touches
    // start from their schema defaults.
    lumine.config.unset("search-panel.marker.permanent");
    lumine.config.unset("search-panel.marker.threshold");
    // search-panel activates on command, so trigger one and await activation.
    const activationPromise = lumine.packages.activatePackage("search-panel");
    lumine.commands.dispatch(workspaceElement, "search-panel:show");
    const pack = await activationPromise;
    mainModule = pack.mainModule;
    // activate() wired the layer to the real search.control service; these
    // specs drive a fake one instead.
    mainModule.markerLayerConnection.dispose();
    mainModule.markerLayerConnection = null;
    provider = mainModule.provideMarkerLayer();
    editor = await lumine.workspace.open();
    editor.setText(Array(50).fill("hello world").join("\n"));
    layer = makeLayer(editor);
    service = makeFakeService();
    consumerDisposable = mainModule.markerLayer.connect(service);
  });

  afterEach(() => {
    consumerDisposable.dispose();
    layer.disposables.dispose();
  });

  it("activates and provides a marker layer descriptor", () => {
    expect(lumine.packages.isPackageActive("search-panel")).toBe(true);
    expect(provider.name).toBe("search-panel");
    expect(typeof provider.description).toBe("string");
    expect(provider.merge).toBe(true);
    expect(provider.enabled).toBe("search-panel.marker.enabled");
    expect(provider.threshold).toBe("search-panel.marker.threshold");
    expect(typeof provider.initialize).toBe("function");
    expect(typeof provider.getItems).toBe("function");
  });

  it("pushes search result markers of the active editor to the layer", () => {
    markResults(
      [
        [2, 0],
        [2, 5],
      ],
      [
        [10, 0],
        [11, 5],
      ],
    );
    emitUpdate();
    expect(layer.update).toHaveBeenCalled();
    expect(layer.items).toEqual([
      { row: 2, end: 2 },
      { row: 10, end: 11 },
    ]);
  });

  it("forgets the editor once its layer detaches", () => {
    layer.disposables.dispose();
    // Consuming the service in the setup already pushed once; only calls
    // arriving after the detach are the regression.
    layer.update.calls.reset();

    markResults([
      [2, 0],
      [2, 5],
    ]);
    emitUpdate();

    expect(layer.update).not.toHaveBeenCalled();
    expect(mainModule.markerLayer.layers.has(editor)).toBe(false);
  });

  it("returns raw ranges and leaves sorting and merging to the host", () => {
    // Created out of document order on purpose.
    markResults(
      [
        [20, 0],
        [20, 5],
      ],
      [
        [3, 0],
        [3, 5],
      ],
    );
    emitUpdate();
    expect(layer.items).toEqual([
      { row: 20, end: 20 },
      { row: 3, end: 3 },
    ]);
  });

  it("clears the markers when the find panel closes and permanent is disabled", () => {
    lumine.config.set("search-panel.marker.permanent", false);
    markResults([
      [2, 0],
      [2, 5],
    ]);

    service.visible = true;
    emitUpdate();
    expect(layer.items).toEqual([{ row: 2, end: 2 }]);

    service.visible = false;
    service.emitter.emit("did-change-find-visibility");
    expect(layer.items).toEqual([]);
  });

  it("clears the markers in editors that are not active", async () => {
    markResults([
      [2, 0],
      [2, 5],
    ]);
    emitUpdate();
    expect(layer.items.length).toBe(1);

    await lumine.workspace.open();
    emitUpdate();
    expect(layer.items).toEqual([]);
  });

  it("clears the layers and stops updating once the consumer is disposed", () => {
    markResults([
      [2, 0],
      [2, 5],
    ]);
    emitUpdate();
    expect(layer.items.length).toBe(1);

    consumerDisposable.dispose();
    expect(mainModule.markerLayer.service).toBeNull();
    expect(layer.items).toEqual([]);

    layer.update.calls.reset();
    service.emitter.emit("did-update");
    expect(layer.update).not.toHaveBeenCalled();
  });
});
