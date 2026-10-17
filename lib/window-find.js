const { CompositeDisposable, Disposable } = require("lumine");

class WindowFind {
  constructor(owner, window) {
    this.owner = owner;
    this.window = window;
    const { FindOptions, BufferSearch, EditorSearchTarget } = owner.ensureRuntime();
    this.options = new FindOptions(owner.findOptions.serialize());
    this.model = new BufferSearch(this.options);
    this.editorTarget = new EditorSearchTarget(this.model);
    this.target = this.editorTarget;
    this.itemSubscription = new Disposable();
    this.subscriptions = new CompositeDisposable(
      owner.observeOptions(this.options, () => this.target.refresh?.()),
      this.model.onDidUpdate(() => owner.searchEvents.emit("did-update", window)),
      this.model.onDidChangeCurrentResult(() =>
        owner.searchEvents.emit("did-change-result", window),
      ),
      window.getEditorContainer().observeActivePaneItem((item) => this.activate(item)),
    );
  }

  activate(item) {
    this.itemSubscription.dispose();
    const adapter = this.owner.getSearchAdapterForPaneItem(item);
    this.target.deactivate?.();
    if (adapter) {
      const { AdapterSearchTarget } = this.owner.ensureRuntime();
      this.model.setEditor(null);
      this.target = new AdapterSearchTarget(adapter, this.options);
    } else {
      this.target = this.editorTarget;
      this.model.setEditor(this.window.getEditorContainer().getActiveEmbeddedTextEditor() ?? null);
      if (item?.observeEmbeddedTextEditor)
        this.itemSubscription = item.observeEmbeddedTextEditor((editor) => {
          this.model.setEditor(editor);
          this.view?.setTarget(this.target);
        });
    }
    this.view?.setTarget(this.target);
    if (this.view) this.target.refresh?.();
  }

  createView() {
    if (this.view) return this.view;
    const { FindView, TextBuffer, HistoryCycler } = this.owner.ensureRuntime();
    this.viewOptions = {
      findBuffer: new TextBuffer(),
      replaceBuffer: new TextBuffer(),
    };
    this.subscriptions.add(
      this.owner.observeFindPattern(this.viewOptions.findBuffer),
      this.owner.observePatternBuffer(
        this.viewOptions.replaceBuffer,
        this.options,
        "replacePattern",
      ),
    );
    this.viewOptions.findHistoryCycler = new HistoryCycler(
      this.viewOptions.findBuffer,
      this.owner.findHistory,
      { syncBuffer: false },
    );
    this.viewOptions.replaceHistoryCycler = new HistoryCycler(
      this.viewOptions.replaceBuffer,
      this.owner.replaceHistory,
      { syncBuffer: false },
    );
    this.view = new FindView(this.target, this.viewOptions);
    this.panel = this.window.addFooterPanel({
      item: this.view,
      visible: false,
      className: "tool-panel panel-bottom",
      priority: 20,
    });
    this.view.setPanel(this.panel);
    this.subscriptions.add(
      this.panel.onDidChangeVisible(() =>
        this.owner.searchEvents.emit("did-change-visible", this.window),
      ),
    );
    this.target.refresh?.();
    this.refreshAutocomplete();
    this.owner.ensureMarkerLayerConnection();
    return this.view;
  }

  refreshAutocomplete() {
    this.autocomplete?.dispose();
    this.autocomplete = null;
    if (this.view && lumine.config.get("search-panel.autocompleteSearches"))
      this.autocomplete = this.owner.autocompleteWatchEditor?.(this.view.findEditor, ["default"]);
  }

  async destroy() {
    this.subscriptions.dispose();
    this.itemSubscription.dispose();
    this.autocomplete?.dispose();
    this.target.deactivate?.();
    this.panel?.destroy();
    const destruction = this.view?.destroy();
    this.model.destroy();
    this.viewOptions?.findHistoryCycler.dispose();
    this.viewOptions?.replaceHistoryCycler.dispose();
    await destruction;
  }
}

module.exports = WindowFind;
