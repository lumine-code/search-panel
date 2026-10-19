const { CompositeDisposable, Disposable } = require("lumine");

// The `marker.layer` provider: search results on the overview maps.
//
// Wired by find.js to the package's own `search.control` service — the same
// contract an external consumer would get. Nothing goes through `layer.cache`:
// results exist only on the active editor and follow it, the panel's
// visibility and the permanent setting, so `getItems` pulls live from the
// service on every update instead of holding a copy per layer.
module.exports = {
  activate() {
    this.service = null;
    this.connection = null;
    this.nativeBindings = new Map();
    // Layers handed over by the marker hub, keyed by editor. The hub builds
    // exactly one layer per editor, so an editor maps to a single layer.
    this.layers = new Map();
    this.disposables = new CompositeDisposable(
      // Both answers are the same for every editor, so they are subscribed
      // once per package here instead of once per editor.
      lumine.config.observe("search-panel.marker.permanent", (value) => {
        this.permanent = value;
        this.updateAllLayers();
      }),
      lumine.workspace.onDidChangeActiveTextEditor(() => this.updateAllLayers()),
    );
  },

  deactivate() {
    this.service = null;
    this.connection = null;
    for (const binding of this.nativeBindings?.values() ?? []) binding.subscription.dispose();
    this.nativeBindings?.clear();
    this.layers?.clear();
    this.disposables?.dispose();
  },

  updateAllLayers() {
    for (const layer of this.layers.values()) {
      this.bindNativeLayer(layer);
      layer.update();
    }
  },

  sourceLayerFor(editor) {
    if (!this.service) return null;
    const window = lumine.workspace.getWindowForElement(editor.getElement());
    if (editor !== window?.getEditorContainer().getActiveEmbeddedTextEditor()) return null;
    if (!this.permanent && !this.service.isFindVisible(window)) return null;
    return this.service.resultsMarkerLayerForTextEditor(editor);
  },

  bindNativeLayer(layer) {
    const source = this.sourceLayerFor(layer.editor);
    const previous = this.nativeBindings.get(layer);
    if (previous?.source === source) return;
    previous?.subscription.dispose();
    this.nativeBindings.delete(layer);
    if (!source) return;
    const binding = { source };
    binding.subscription = source.onDidUpdate(() => {
      if (this.nativeBindings.get(layer) === binding && this.layers.get(layer.editor) === layer) {
        layer.update();
      }
    });
    this.nativeBindings.set(layer, binding);
  },

  connect(service) {
    const connection = {};
    this.connection = connection;
    this.service = service;
    const updateAll = () => {
      if (this.connection === connection) this.updateAllLayers();
    };
    const subscriptions = new CompositeDisposable(
      service.onDidUpdate(updateAll),
      service.onDidChangeFindVisibility(updateAll),
    );
    updateAll();
    return new Disposable(() => {
      subscriptions.dispose();
      if (this.connection !== connection) return;
      this.connection = null;
      this.service = null;
      this.updateAllLayers();
    });
  },

  provideMarkerLayer() {
    return {
      name: "search-panel",
      description: "Search panel result markers",
      merge: true,
      enabled: "search-panel.marker.enabled",
      threshold: "search-panel.marker.threshold",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.disposables.add(
          new Disposable(() => {
            this.nativeBindings.get(layer)?.subscription.dispose();
            this.nativeBindings.delete(layer);
            if (this.layers.get(layer.editor) === layer) this.layers.delete(layer.editor);
          }),
        );
        this.bindNativeLayer(layer);
        layer.update();
      },
      getItems: ({ editor }) => {
        const markerLayer = this.sourceLayerFor(editor);
        if (!markerLayer) {
          return [];
        }
        const items = [];
        for (const marker of markerLayer.getMarkers()) {
          if (!marker.isValid()) continue;
          const range = marker.getScreenRange();
          items.push({ row: range.start.row, end: range.end.row });
        }
        return items;
      },
    };
  },
};
