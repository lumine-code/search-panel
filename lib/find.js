const { CompositeDisposable, Disposable, Emitter } = require("lumine");
const markerLayer = require("./marker-layer");
const RESULTS_PANE_URI = require("./results-pane-uri");
const { directoryPathForEvent } = require("./command-context");

// `find.js` is the package entry point and is required during the initial
// package bootstrap. Keep the search models, etch, and all DOM views behind a
// single package-owned boundary: activation only publishes commands,
// openers, and service facades. The first operation that needs a search model
// or a view pays for this graph once.
let runtimeModules;

function loadRuntimeModules() {
  if (runtimeModules != null) return runtimeModules;

  // Etch holds its scheduler per copy of the library, and this package
  // resolves its own copy — so the assignment the editor makes on core's copy
  // never reaches it. Configure it immediately before loading any view module.
  const etch = require("@lumine-code/etch");
  etch.setScheduler(lumine.views);

  runtimeModules = {
    SelectNext: require("./select-next"),
    ...require("./history"),
    FindOptions: require("./find-options"),
    BufferSearch: require("./buffer-search"),
    ...require("./search-target"),
    FindView: require("./find-view"),
    ProjectFindView: require("./project-find-view"),
    ResultsModel: require("./results-model"),
    ResultsPaneView: require("./results-pane"),
    TextBuffer: require("lumine").TextBuffer,
  };
  return runtimeModules;
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "search-panel",
      tips: [
        "You can find and replace inside the current file with {{ 'search-panel:show' | keystroke }}",
        "You can search every file in the project at once with {{ 'search-panel:project-show' | keystroke }}",
        "You can jump to the next match without reopening the panel using {{ 'search-panel:find-next' | keystroke }}",
      ],
    };
  },

  activate({ globalState, workspaceState }) {
    this.globalState = globalState;
    this.workspaceState = workspaceState;
    this.runtime = null;
    this.windowFinds = new Map();
    this.searchEvents = new Emitter();
    if (lumine.config.get("search-panel.openProjectFindResultsInRightPane")) {
      lumine.config.set("search-panel.projectSearchResultsPaneSplitDirection", "right");
    }
    lumine.config.unset("search-panel.openProjectFindResultsInRightPane");

    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.project.onDidChangePaths(() => {
        for (const model of this.resultsModels ?? []) model.clear();
      }),
    );
    this.autocompleteWatchEditor = null;
    this.autocompleteServices = new Map();
    this.subscriptions.add(
      lumine.config.observe("search-panel.autocompleteSearches", (value) =>
        this.toggleAutocompletions(value),
      ),
    );
    this.subscriptions.add(
      lumine.workspace.addOpener((filePath) => {
        // Do not cross the runtime boundary for ordinary editor paths. The
        // URI is a stable protocol constant; only a matching restore/open
        // request needs the results-pane constructor.
        if (filePath.indexOf(RESULTS_PANE_URI) !== -1) {
          const { ResultsPaneView } = this.ensureRuntime();
          return new ResultsPaneView();
        }
      }),
    );
    this.currentItemSub = new Disposable();
    this.searchAdapterServices = [];
    this.resultsModels = new Set();
    this.selectNextObjects = null;
    this.pendingPaneItem = null;

    this.subscriptions.add(
      lumine.workspace
        .getMainWindow()
        .getEditorContainer()
        .observeActivePaneItem((paneItem) => {
          this.pendingPaneItem = paneItem;
          if (this.runtime != null) this.activatePaneItem(paneItem);
        }),
    );

    const focusWorkspace = (event) => {
      event.stopPropagation();
      return (event.context?.window ?? lumine.workspace.getMainWindow()).getElement().focus();
    };
    this.subscriptions.add(
      lumine.commands.add(".search-panel", "window:focus-next-pane", focusWorkspace),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:project-show", {
        description: "Open the panel that searches every file in the project.",
        didDispatch: () => {
          this.createProjectFindView();
          return showPanel(this.projectFindPanel, this.findPanel, () =>
            this.projectFindView.focusFindElement(),
          );
        },
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:project-toggle", () => {
        this.createProjectFindView();
        return togglePanel(this.projectFindPanel, this.findPanel, () =>
          this.projectFindView.focusFindElement(),
        );
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:project-show-in-current-directory", {
        description: "Search the project, limited to the selected directory.",
        isAvailable: (event) => Boolean(directoryPathForEvent(event)),
        didDispatch: (event) => {
          this.createProjectFindView();
          this.findPanel?.hide();
          this.projectFindPanel.show();
          this.projectFindView.focusFindElement();
          return this.projectFindView.findInCurrentlySelectedDirectory(event.target, event.context);
        },
      }),
    );

    const viewForSelectionCommand = (event) => {
      if (event?.context?.window && !event.context.window.isMain()) return this.getFindView(event);
      if (this.projectFindPanel?.isVisible()) return this.projectFindView;
      this.createFindView();
      return this.findView;
    };
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "search-panel:use-selection-as-find-pattern": {
          description: "Put the editor selection into the find field.",
          isAvailable: (event) => this.isSearchAvailable(event),
          didDispatch: (event) => viewForSelectionCommand(event).setSelectionAsFindPattern(),
        },
        "search-panel:use-selection-as-replace-pattern": {
          description: "Put the editor selection into the replace field.",
          isAvailable: (event) => this.isSearchAvailable(event),
          didDispatch: (event) => viewForSelectionCommand(event).setSelectionAsReplacePattern(),
        },
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:toggle", (event) => {
        if (event.context?.window && !event.context.window.isMain())
          return this.showWindowFind(event, true);
        this.createFindView();
        return togglePanel(this.findPanel, this.projectFindPanel, () =>
          this.findView.focusFindEditor(),
        );
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:show", (event) => {
        if (event.context?.window && !event.context.window.isMain())
          return this.showWindowFind(event);
        this.createFindView();
        return showPanel(this.findPanel, this.projectFindPanel, () =>
          this.findView.focusFindEditor(),
        );
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:show-replace", {
        description: "Open the find panel with the cursor in the replace field.",
        didDispatch: (event) => {
          if (event.context?.window && !event.context.window.isMain())
            return this.showWindowFind(event, false, true);
          this.createFindView();
          return showPanel(this.findPanel, this.projectFindPanel, () =>
            this.findView.focusReplaceEditor(),
          );
        },
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:clear-history", {
        description: "Forget the searches and replacements remembered so far.",
        didDispatch: () => {
          this.ensureRuntime();
          return Promise.all([this.findHistory.clear(), this.replaceHistory.clear()]);
        },
      }),
    );

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", "search-panel:clear", {
        description: "Empty the find field and drop the match highlights.",
        didDispatch: (event) => {
          if (event.context?.window && !event.context.window.isMain())
            return this.windowFinds.get(event.context.window)?.view?.clear();
          this.findView?.clear();
          this.projectFindView?.clear();
        },
      }),
    );

    // These commands are cold and globally scoped, so their handlers must
    // exist as soon as the package activates. The view remains lazy: the first
    // command that needs it creates it idempotently before forwarding.
    const getFindView = (event) => this.getFindView(event);

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "search-panel:find-next": {
          description: "Move to the next match and give the editor focus back.",
          isAvailable: (event) => this.isSearchAvailable(event, false, true),
          didDispatch: (event) => getFindView(event).findNext({ focusEditorAfter: true }),
        },
        "search-panel:find-previous": {
          description: "Move to the previous match and give the editor focus back.",
          isAvailable: (event) => this.isSearchAvailable(event, false, true),
          didDispatch: (event) => getFindView(event).findPrevious({ focusEditorAfter: true }),
        },
        "search-panel:find-all": {
          description: "Put a cursor at every match and give the editor focus back.",
          isAvailable: (event) => this.isSearchAvailable(event, false, true),
          didDispatch: (event) => getFindView(event).findAll({ focusEditorAfter: true }),
        },
        "search-panel:find-next-selected": {
          description: "Search for the editor selection and move to the next match.",
          isAvailable: (event) => this.isSearchAvailable(event),
          didDispatch: (event) => getFindView(event).findNextSelected(),
        },
        "search-panel:find-previous-selected": {
          description: "Search for the selection and move to the previous match.",
          isAvailable: (event) => this.isSearchAvailable(event),
          didDispatch: (event) => getFindView(event).findPreviousSelected(),
        },
        "search-panel:replace-previous": {
          description: "Replace this match and move back to the previous one.",
          isAvailable: (event) => this.isSearchAvailable(event, true, true),
          didDispatch: (event) => getFindView(event).replacePrevious({ focusEditorAfter: true }),
        },
        "search-panel:replace-next": {
          description: "Replace this match and move on to the next one.",
          isAvailable: (event) => this.isSearchAvailable(event, true, true),
          didDispatch: (event) => getFindView(event).replaceNext({ focusEditorAfter: true }),
        },
        "search-panel:replace-current": {
          description: "Replace this match and stay where it was.",
          isAvailable: (event) => this.isSearchAvailable(event, true, true),
          didDispatch: (event) => getFindView(event).replaceCurrent(),
        },
        "search-panel:replace-all": {
          description: "Replace every match in the file at once.",
          isAvailable: (event) => this.isSearchAvailable(event, true, true),
          didDispatch: (event) => getFindView(event).replaceAll(),
        },
      }),
    );

    // Handling cancel in the workspace + code editors
    const handleEditorCancel = ({ target, context }) => {
      if (context?.window && !context.window.isMain())
        return this.windowFinds.get(context.window)?.panel?.hide();
      if (target.closest?.("lumine-dock, lumine-panel")) return;
      const isMiniEditor = target.tagName === "LUMINE-TEXT-EDITOR" && target.hasAttribute("mini");
      if (!isMiniEditor) {
        this.findPanel?.hide();
        return this.projectFindPanel?.hide();
      }
    };

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "core:cancel": handleEditorCancel,
      }),
    );

    const editorForEvent = (event) =>
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false });

    const selectNextObjectForEvent = (event) => {
      const editor = editorForEvent(event);
      if (editor == null) {
        return null;
      }
      const { SelectNext } = this.ensureRuntime();
      if (this.selectNextObjects == null) {
        this.selectNextObjects = new WeakMap();
      }
      let selectNext = this.selectNextObjects.get(editor);
      if (selectNext == null) {
        selectNext = new SelectNext(editor);
        this.selectNextObjects.set(editor, selectNext);
      }
      return selectNext;
    };

    var showPanel = function (panelToShow, panelToHide, postShowAction) {
      panelToHide?.hide();
      panelToShow.show();
      return postShowAction?.();
    };

    var togglePanel = function (panelToToggle, panelToHide, postToggleAction) {
      panelToHide?.hide();

      if (panelToToggle.isVisible()) {
        return panelToToggle.hide();
      } else {
        panelToToggle.show();
        return postToggleAction?.();
      }
    };

    this.subscriptions.add(
      lumine.commands.add("lumine-text-editor:not([mini])", {
        "search-panel:select-next": {
          description: "Add a cursor at the next occurrence of the selection.",
          didDispatch: (event) => selectNextObjectForEvent(event)?.findAndSelectNext(),
        },
        "search-panel:select-all": {
          description: "Add a cursor at every occurrence of the selection.",
          didDispatch: (event) => selectNextObjectForEvent(event)?.findAndSelectAll(),
        },
        "search-panel:select-undo": {
          description: "Drop the occurrence Select Next added last.",
          didDispatch: (event) => selectNextObjectForEvent(event)?.undoLastSelection(),
        },
        "search-panel:select-skip": {
          description: "Leave this occurrence behind and take the next one instead.",
          didDispatch: (event) => selectNextObjectForEvent(event)?.skipCurrentSelection(),
        },
      }),
    );

    markerLayer.activate();
  },

  ensureRuntime() {
    if (this.runtime != null) return this.runtime;

    const modules = loadRuntimeModules();
    // Publish the runtime before constructing any object that can synchronously
    // call back into this main module (for example, an active-pane observer).
    this.runtime = modules;

    const { History, FindOptions, BufferSearch, EditorSearchTarget, ResultsModel } = modules;
    this.findHistory = new History([], this.workspaceState, "findHistory");
    this.replaceHistory = new History([], this.workspaceState, "replaceHistory");
    this.pathsHistory = new History([], this.workspaceState, "pathsHistory");
    this.findOptions = new FindOptions();
    this.subscriptions.add(
      this.observeOptions(this.findOptions, () => this.activeTarget?.refresh?.()),
    );
    this.findModel = new BufferSearch(this.findOptions);
    this.subscriptions.add(
      this.findModel.onDidUpdate(() => this.searchEvents.emit("did-update")),
      this.findModel.onDidChangeCurrentResult(() => this.searchEvents.emit("did-change-result")),
    );
    // The buffer find UI searches through a SearchTarget. The editor-backed
    // target wraps the BufferSearch model; other targets (search adapters) are
    // selected per active pane item in observeActivePaneItem.
    this.editorTarget = new EditorSearchTarget(this.findModel);
    this.activeTarget = this.editorTarget;
    this.resultsModels = new Set();
    this.resultsModel = new ResultsModel(this.findOptions);
    this.resultsModels.add(this.resultsModel);
    modules.ResultsPaneView.createResultsModel = this.createResultsModel.bind(this);
    modules.ResultsPaneView.destroyResultsModel = this.destroyResultsModel.bind(this);

    // Apply the pane item observed during activation only after the models are
    // ready. The observer itself stays cheap while the package is bootstrapping.
    if (this.pendingPaneItem != null) this.activatePaneItem(this.pendingPaneItem);

    return modules;
  },

  observeOptions(options, refresh = () => {}) {
    const { FindOptions } = this.runtime;
    const defaults = new FindOptions();
    const globalKeys = [
      "useRegex",
      "wholeWord",
      "caseSensitive",
      "inCurrentSelection",
      "leadingContextLineCount",
      "trailingContextLineCount",
    ];
    const projectKeys = ["replacePattern", "pathsPattern"];
    const stores = [
      { store: this.globalState, key: "options", keys: globalKeys },
      {
        store: this.workspaceState,
        key: "patterns",
        keys: projectKeys,
      },
    ].map((entry) => ({ ...entry, pending: new Map() }));
    // A committed snapshot may predate a newer local edit in another field.
    // Keep those edits visible until their own writes settle.
    let applying = false;
    let disposed = false;
    const apply = () => {
      const values = {};
      for (const { store, key, keys, pending } of stores) {
        const stored = store.get(key, {});
        for (const name of keys) {
          const edit = pending.get(name);
          values[name] = edit ? edit.value : (stored[name] ?? defaults[name]);
        }
      }
      applying = true;
      try {
        const changes = options.set(values);
        if (
          ["useRegex", "caseSensitive", "wholeWord", "inCurrentSelection"].some(
            (key) => key in changes,
          )
        )
          refresh();
      } finally {
        applying = false;
      }
    };
    const changed = options.onDidChange((changes) => {
      if (applying) return;
      for (const { store, key, keys, pending } of stores) {
        const values = Object.fromEntries(
          Object.entries(changes).filter(([name]) => keys.includes(name)),
        );
        if (!Object.keys(values).length) continue;
        const token = {};
        for (const [name, value] of Object.entries(values)) pending.set(name, { token, value });
        const settled = () => {
          if (disposed) return;
          for (const name of Object.keys(values))
            if (pending.get(name)?.token === token) pending.delete(name);
          apply();
        };
        void store
          .mutate(key, (current) => ({ ...current, ...values }))
          .then(settled, (error) => {
            settled();
            lumine.notifications.addError("Unable to save search preferences", {
              detail: error.message,
            });
          });
      }
    });
    return new CompositeDisposable(
      changed,
      ...stores.map(({ store, key, pending }) =>
        store.observe(key, (_value, { scopeChanged } = {}) => {
          // Outgoing writes belong to the previous project, even while pending.
          if (scopeChanged) pending.clear();
          apply();
        }),
      ),
      new Disposable(() => (disposed = true)),
    );
  },

  isSearchAvailable(event, replace = false, requirePattern = false) {
    const window =
      event?.context?.window ??
      lumine.workspace.getWindowForElement(event?.target) ??
      lumine.workspace.getMainWindow();
    if (!window || window.isDestroyed()) return false;
    const controller = this.windowFinds.get(window);
    const findBuffer = window.isMain()
      ? this.viewOptions?.findBuffer
      : controller?.viewOptions?.findBuffer;
    if (requirePattern && !(findBuffer && findBuffer.getLength() > 0)) return false;
    const target = window.isMain() ? this.activeTarget : controller?.target;
    if (target) return Boolean(target.isUsable() && (!replace || target.canReplace()));
    const container = window.getEditorContainer();
    const item = container.getActivePaneItem();
    if (!item || item.isDestroyed?.()) return false;
    for (const service of this.searchAdapterServices) {
      if (this.adapterHandlesItem(service, item)) {
        return !replace || this.adapterCanReplaceItem(service, item);
      }
    }
    const editor = container.getActiveEmbeddedTextEditor();
    return Boolean(editor && !editor.isDestroyed() && (!replace || !editor.isReadOnly()));
  },

  getWindowFind(window) {
    let controller = this.windowFinds.get(window);
    if (!controller) {
      const WindowFind = require("./window-find");
      controller = new WindowFind(this, window);
      controller.lease = window.onWillDestroy(() => {
        this.windowFinds.delete(window);
        controller.lease.dispose();
        void controller.destroy();
      });
      this.windowFinds.set(window, controller);
    }
    return controller;
  },

  getFindView(event) {
    const window = event?.context?.window;
    if (window && !window.isMain()) return this.getWindowFind(window).createView();
    this.createFindView();
    return this.findView;
  },

  showWindowFind(event, toggle = false, replace = false) {
    const controller = this.getWindowFind(event.context.window);
    const view = controller.createView();
    if (toggle && controller.panel.isVisible()) return controller.panel.hide();
    controller.panel.show();
    return replace ? view.focusReplaceEditor() : view.focusFindEditor();
  },

  ensureMarkerLayerConnection() {
    if (this.markerLayerConnection == null && !this.connectingMarkerLayer) {
      this.connectingMarkerLayer = true;
      try {
        this.markerLayerConnection = markerLayer.connect(this.provideSearchControl());
      } finally {
        this.connectingMarkerLayer = false;
      }
    }
    return this.markerLayerConnection;
  },

  consumeSearchAdapter(service) {
    if (
      typeof service?.handlesItem !== "function" ||
      typeof service.getAdapterForItem !== "function" ||
      (service.canReplaceItem != null && typeof service.canReplaceItem !== "function")
    )
      throw new TypeError(
        "A search adapter requires handlesItem and getAdapterForItem functions, with an optional canReplaceItem function.",
      );
    this.searchAdapterServices.push(service);
    lumine.commands.invalidateAvailability();
    if (this.runtime != null) {
      this.activatePaneItem(
        lumine.workspace.getMainWindow().getEditorContainer().getActivePaneItem(),
      );
      for (const controller of this.windowFinds.values())
        controller.activate(controller.window.getEditorContainer().getActivePaneItem());
    }
    return new Disposable(() => {
      this.searchAdapterServices = this.searchAdapterServices.filter(
        (candidate) => candidate !== service,
      );
      lumine.commands.invalidateAvailability();
      if (this.runtime != null) {
        this.activatePaneItem(
          lumine.workspace.getMainWindow().getEditorContainer().getActivePaneItem(),
        );
        for (const controller of this.windowFinds.values())
          controller.activate(controller.window.getEditorContainer().getActivePaneItem());
      }
    });
  },

  toggleAutocompletions(value) {
    for (const controller of this.windowFinds.values()) controller.refreshAutocomplete();
    if (this.findView == null) {
      return;
    }
    this.autocompleteSubscriptions?.dispose();
    this.autocompleteSubscriptions = null;
    if (value) {
      this.autocompleteSubscriptions = new CompositeDisposable();
      const disposable = this.autocompleteWatchEditor?.(this.findView.findEditor, ["default"]);
      if (disposable != null) {
        this.autocompleteSubscriptions.add(disposable);
      }
    }
  },

  consumeAutocompleteWatchEditor(watchEditor) {
    const owner = this.subscriptions,
      edges = this.autocompleteServices;
    if (!edges || owner.disposed) return new Disposable();
    const token = {};
    const select = () => {
      const current = [...edges.values()].at(-1) ?? null;
      if (current === this.autocompleteWatchEditor) return;
      this.autocompleteWatchEditor = current;
      this.toggleAutocompletions(lumine.config.get("search-panel.autocompleteSearches"));
    };
    edges.set(token, watchEditor);
    select();
    const lease = new Disposable(() => {
      owner.remove(lease);
      edges.delete(token);
      if (this.autocompleteServices === edges) select();
    });
    owner.add(lease);
    return lease;
  },

  provideSearchControl() {
    return {
      resultsMarkerLayerForTextEditor: (editor) => {
        this.ensureRuntime();
        const window = lumine.workspace.getWindowForElement(editor.getElement());
        const model =
          window && !window.isMain() ? this.windowFinds.get(window)?.model : this.findModel;
        return model?.resultsMarkerLayerForTextEditor(editor);
      },

      // FindOptions access
      getFindOptions: () => {
        this.ensureRuntime();
        return this.findOptions;
      },
      onDidChangeFindOptions: (callback) => {
        this.ensureRuntime();
        return this.findOptions.onDidChange(callback);
      },

      // Panel visibility
      showFind: () => {
        this.createFindView();
        this.projectFindPanel?.hide();
        this.findPanel.show();
        this.findView.focusFindEditor();
      },
      showReplace: () => {
        this.createFindView();
        this.projectFindPanel?.hide();
        this.findPanel.show();
        this.findView.focusReplaceEditor();
      },
      showProjectFind: () => {
        this.createProjectFindView();
        this.findPanel?.hide();
        this.projectFindPanel.show();
        this.projectFindView.focusFindElement();
      },
      hideFind: () => this.findPanel?.hide(),
      hideProjectFind: () => this.projectFindPanel?.hide(),
      isFindVisible: (window = lumine.workspace.getMainWindow()) =>
        window.isMain()
          ? (this.findPanel?.isVisible() ?? false)
          : (this.windowFinds.get(window)?.panel?.isVisible() ?? false),
      isProjectFindVisible: () => this.projectFindPanel?.isVisible() ?? false,

      // Events
      onDidUpdate: (callback) => {
        this.ensureRuntime();
        return this.searchEvents.on("did-update", callback);
      },
      onDidChangeCurrentResult: (callback) => {
        this.ensureRuntime();
        return this.searchEvents.on("did-change-result", callback);
      },
      onDidChangeFindVisibility: (callback) => {
        this.createFindView();
        return this.searchEvents.on("did-change-visible", callback);
      },
      onDidChangeProjectFindVisibility: (callback) => {
        this.createProjectFindView();
        return this.projectFindPanel.onDidChangeVisible(callback);
      },

      // Search triggers
      search: (findPattern, options) => {
        this.createFindView();
        this.findView.search(findPattern, options);
      },
      projectSearch: (findPattern, pathsPattern) => {
        this.createProjectFindView();
        this.findOptions.set({ findPattern, pathsPattern });
        this.projectFindView.confirm();
      },
    };
  },

  provideMarkerLayer() {
    return markerLayer.provideMarkerLayer();
  },

  createViews() {
    this.createFindView();
    this.createProjectFindView();
  },

  createResultsModel(findOptions) {
    const { ResultsModel } = this.ensureRuntime();
    const model = new ResultsModel(findOptions);
    this.resultsModels.add(model);
    return model;
  },

  destroyResultsModel(model) {
    if (model?.viewOwners?.size > 0 || this.projectFindView?.model === model) return;
    if (this.resultsModels?.delete(model)) {
      model.destroy();
    }
  },

  createViewOptions() {
    const { HistoryCycler, TextBuffer } = this.ensureRuntime();
    if (this.viewOptions != null) {
      return this.viewOptions;
    }

    const findBuffer = new TextBuffer();
    const replaceBuffer = new TextBuffer();
    const pathsBuffer = new TextBuffer();
    this.subscriptions.add(
      this.observeFindPattern(findBuffer),
      this.observePatternBuffer(replaceBuffer, this.findOptions, "replacePattern"),
      this.observePatternBuffer(pathsBuffer, this.findOptions, "pathsPattern"),
    );

    this.viewOptions = {
      findBuffer,
      replaceBuffer,
      pathsBuffer,
      findHistoryCycler: new HistoryCycler(findBuffer, this.findHistory, { syncBuffer: false }),
      replaceHistoryCycler: new HistoryCycler(replaceBuffer, this.replaceHistory, {
        syncBuffer: false,
      }),
      pathsHistoryCycler: new HistoryCycler(pathsBuffer, this.pathsHistory, { syncBuffer: false }),
    };

    return this.viewOptions;
  },

  observeFindPattern(buffer) {
    let hadPattern = buffer.getLength() > 0;
    return buffer.onDidChange(() => {
      const hasPattern = buffer.getLength() > 0;
      if (hasPattern === hadPattern) return;
      hadPattern = hasPattern;
      lumine.commands.invalidateAvailability();
    });
  },

  observePatternBuffer(buffer, options, key) {
    buffer.setText(options[key]);
    return new CompositeDisposable(
      buffer.onDidChange(() => options.set({ [key]: buffer.getText() })),
      options.onDidChange((changes) => {
        if (key in changes && buffer.getText() !== options[key]) buffer.setText(options[key]);
      }),
    );
  },

  createFindView() {
    const { FindView } = this.ensureRuntime();
    if (this.findView != null || this.creatingFindView) {
      return;
    }
    this.creatingFindView = true;
    try {
      this.findView = new FindView(this.activeTarget, this.createViewOptions());

      this.findPanel = lumine.workspace.addBottomPanel({
        item: this.findView,
        visible: false,
        className: "tool-panel panel-bottom",
      });

      this.findView.setPanel(this.findPanel);
      this.subscriptions.add(
        this.findPanel.onDidChangeVisible(() => this.searchEvents.emit("did-change-visible")),
      );
      if (this.activeTarget?.refresh) {
        this.activeTarget.refresh();
      }
      this.toggleAutocompletions(lumine.config.get("search-panel.autocompleteSearches"));
      this.ensureMarkerLayerConnection();
    } finally {
      this.creatingFindView = false;
    }
  },

  createProjectFindView() {
    const { ProjectFindView } = this.ensureRuntime();
    if (this.projectFindView != null) {
      return;
    }

    this.projectFindView = new ProjectFindView(this.resultsModel, this.createViewOptions());

    this.projectFindPanel = lumine.workspace.addBottomPanel({
      item: this.projectFindView,
      visible: false,
      className: "tool-panel panel-bottom",
    });

    this.projectFindView.setPanel(this.projectFindPanel);

    // Results panes deliberately remain session-only for now. The base pane
    // shares this model with ProjectFindView, while preserved historical panes
    // own separate ResultsModels. A future deserializer must persist each
    // pane's query and options, rebuild that ownership, and rerun the search;
    // serializing result rows would save a large, immediately stale snapshot.
    // Until then, each newly created base pane uses ProjectFindView's current
    // shared model.
    this.runtime.ResultsPaneView.projectFindView = this.projectFindView;
    // The marker provider listens to buffer-panel visibility. Connecting it
    // here preserves the long-standing hidden find panel that accompanies a
    // project search, while still keeping both views out of package startup.
    this.ensureMarkerLayerConnection();
  },

  // Point the buffer find view at the given SearchTarget (editor- or
  // adapter-backed) and, for adapters, re-highlight the current query.
  activateTarget(target) {
    // Clear the outgoing adapter target's highlights when leaving it, so search
    // results don't linger in a view that's no longer active.
    if (this.activeTarget && this.activeTarget !== target && this.activeTarget.deactivate) {
      this.activeTarget.deactivate();
    }
    this.activeTarget = target;
    lumine.commands.invalidateAvailability();
    if (this.findView) {
      this.findView.setTarget(target);
      if (target.refresh) target.refresh();
    }
  },

  getSearchAdapterForPaneItem(paneItem) {
    if (!paneItem) return null;
    for (const service of this.searchAdapterServices || []) {
      if (!this.adapterHandlesItem(service, paneItem)) continue;
      const adapter = service.getAdapterForItem(paneItem);
      if (adapter) return adapter;
    }
    return null;
  },

  adapterHandlesItem(service, item) {
    const handles = service.handlesItem(item);
    if (typeof handles !== "boolean")
      throw new TypeError("Search adapter handlesItem must return a Boolean synchronously.");
    return handles;
  },

  adapterCanReplaceItem(service, item) {
    if (!service.canReplaceItem) return false;
    const canReplace = service.canReplaceItem(item);
    if (typeof canReplace !== "boolean")
      throw new TypeError("Search adapter canReplaceItem must return a Boolean synchronously.");
    return canReplace;
  },

  activatePaneItem(paneItem) {
    const { AdapterSearchTarget } = this.ensureRuntime();
    this.subscriptions.delete(this.currentItemSub);
    this.currentItemSub.dispose();

    const adapter = this.getSearchAdapterForPaneItem(paneItem);
    if (adapter) {
      this.findModel.setEditor(null);
      return this.activateTarget(new AdapterSearchTarget(adapter, this.findOptions));
    }

    if (lumine.workspace.isTextEditor(paneItem)) {
      this.findModel.setEditor(paneItem);
      return this.activateTarget(this.editorTarget);
    } else if (paneItem?.observeEmbeddedTextEditor != null) {
      this.currentItemSub = paneItem.observeEmbeddedTextEditor((editor) => {
        if (
          lumine.workspace.getMainWindow().getEditorContainer().getActivePaneItem() === paneItem
        ) {
          this.findModel.setEditor(editor);
          this.activateTarget(this.editorTarget);
        }
      });
      return this.subscriptions.add(this.currentItemSub);
    } else if (paneItem?.getEmbeddedTextEditor != null) {
      this.findModel.setEditor(paneItem.getEmbeddedTextEditor());
      return this.activateTarget(this.editorTarget);
    } else {
      this.findModel.setEditor(null);
      return this.activateTarget(this.editorTarget);
    }
  },

  async deactivate() {
    const viewDestructions = [];
    for (const controller of this.windowFinds?.values() ?? []) {
      controller.lease.dispose();
      viewDestructions.push(controller.destroy());
    }
    this.windowFinds?.clear();
    this.markerLayerConnection?.dispose();
    this.markerLayerConnection = null;
    markerLayer.deactivate();

    this.findPanel?.destroy();
    this.findPanel = null;
    viewDestructions.push(this.findView?.destroy());
    this.findView = null;
    this.findModel?.destroy();
    this.findModel = null;

    this.projectFindPanel?.destroy();
    this.projectFindPanel = null;
    viewDestructions.push(this.projectFindView?.destroy());
    this.projectFindView = null;
    this.viewOptions?.findHistoryCycler.dispose();
    this.viewOptions?.replaceHistoryCycler.dispose();
    this.viewOptions?.pathsHistoryCycler.dispose();
    this.viewOptions = null;

    for (const model of this.resultsModels ?? []) {
      model.destroy();
    }
    this.resultsModels?.clear();
    this.resultsModels = null;
    this.resultsModel = null;

    if (this.runtime?.ResultsPaneView) {
      this.runtime.ResultsPaneView.projectFindView = null;
      this.runtime.ResultsPaneView.createResultsModel = null;
      this.runtime.ResultsPaneView.destroyResultsModel = null;
    }

    this.autocompleteSubscriptions?.dispose();
    this.autocompleteSubscriptions = null;
    this.autocompleteManagerService = null;
    this.subscriptions?.dispose();
    this.subscriptions = null;
    this.runtime = null;
    for (const history of [this.findHistory, this.replaceHistory, this.pathsHistory])
      history?.dispose();
    this.globalState = this.workspaceState = null;
    this.pendingPaneItem = null;
    this.searchAdapterServices = [];
    await Promise.all(viewDestructions);
    this.searchEvents?.dispose();
  },

  markerLayer,
};
