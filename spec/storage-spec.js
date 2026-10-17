const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function removeTemporaryDirectory(directory) {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
    throw Error("Fixture escaped its owned temporary root");
  await fs.promises.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

describe("search preference storage", () => {
  let main;

  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    await Promise.all([
      main.globalState.update("options", undefined),
      main.workspaceState.update("patterns", undefined),
      main.workspaceState.update("findHistory", undefined),
    ]);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("search-panel");
  });

  it("reads global options and project history only when the search runtime is needed", async () => {
    expect(main.runtime).toBeNull();
    await main.globalState.update("options", { useRegex: true });
    await main.workspaceState.update("patterns", { pathsPattern: "src/**" });
    await main.workspaceState.update("findHistory", ["first", "second"]);
    expect(main.runtime).toBeNull();

    main.ensureRuntime();

    expect(main.findOptions.useRegex).toBe(true);
    expect(main.findOptions.pathsPattern).toBe("src/**");
    expect(main.findHistory.getLast()).toBe("second");
    expect(main.workspaceState.get("options")).toBeUndefined();
    expect(main.globalState.get("findHistory")).toBeUndefined();
  });

  it("retains searches and option changes across package generations", async () => {
    main.ensureRuntime();
    await main.findHistory.add("needle");
    main.findOptions.set({ caseSensitive: true, pathsPattern: "lib/**" });
    await conditionPromise(
      () =>
        main.globalState.get("options", {}).caseSensitive === true &&
        main.workspaceState.get("patterns", {}).pathsPattern === "lib/**",
    );
    await lumine.packages.deactivatePackage("search-panel");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.ensureRuntime();

    expect(main.findHistory.getLast()).toBe("needle");
    expect(main.findOptions.caseSensitive).toBe(true);
    expect(main.findOptions.pathsPattern).toBe("lib/**");
  });

  it("updates live models when stored preferences change", async () => {
    main.ensureRuntime();
    const options = main.findOptions;
    const history = main.findHistory;
    await main.globalState.update("options", { wholeWord: true });
    await main.workspaceState.update("findHistory", ["incoming"]);

    expect(main.findOptions).toBe(options);
    expect(main.findHistory).toBe(history);
    expect(options.wholeWord).toBe(true);
    expect(history.getLast()).toBe("incoming");
    await main.workspaceState.update("findHistory", undefined);
    expect(history.length).toBe(0);
  });

  it("preserves history navigation when its own search is committed", async () => {
    main.ensureRuntime();
    await main.findHistory.add("first");
    const buffer = new main.runtime.TextBuffer("second");
    const cycler = new main.runtime.HistoryCycler(buffer, main.findHistory);
    try {
      cycler.store();
      await conditionPromise(() => main.workspaceState.get("findHistory", []).at(-1) === "second");

      cycler.previous();

      expect(buffer.getText()).toBe("first");
    } finally {
      cycler.dispose();
      buffer.destroy();
    }
  });

  it("does not replay older option values over later pending edits", async () => {
    main.ensureRuntime();
    const changes = [];
    const subscription = main.findOptions.onDidChange((change) => changes.push(change));
    try {
      main.findOptions.set({ useRegex: true });
      main.findOptions.set({ wholeWord: true });
      await conditionPromise(() => main.globalState.get("options", {}).wholeWord === true);

      expect(changes.filter((change) => change.useRegex === false)).toEqual([]);
      expect(changes.filter((change) => change.wholeWord === false)).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  it("updates the existing project fields when stored patterns change", async () => {
    main.ensureRuntime();
    main.createProjectFindView();
    const view = main.projectFindView;
    view.findEditor.setText("query being edited");
    view.findEditor.setSelectedBufferRange([
      [0, 2],
      [0, 8],
    ]);
    const selection = view.findEditor.getSelectedBufferRange();
    const mutate = spyOn(main.workspaceState, "mutate").and.callThrough();
    await main.workspaceState.update("patterns", {
      replacePattern: "restored replacement",
      pathsPattern: "lib/**",
    });

    expect(main.projectFindView).toBe(view);
    expect(view.replaceEditor.getText()).toBe("restored replacement");
    expect(view.pathsEditor.getText()).toBe("lib/**");
    expect(view.findEditor.getText()).toBe("query being edited");
    expect(view.findEditor.getSelectedBufferRange()).toEqual(selection);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("captures edits from search fields without waiting for a search or debounce", async () => {
    main.ensureRuntime();
    main.createProjectFindView();
    main.projectFindView.replaceEditor.setText("replacement");
    main.projectFindView.pathsEditor.setText("src/**");
    await main.workspaceState.update("findHistory", ["flush pending writes"]);

    expect(main.workspaceState.get("patterns")).toEqual({
      replacePattern: "replacement",
      pathsPattern: "src/**",
    });
  });

  it("rebinds fields and history while outgoing project writes are still pending", async () => {
    const originalPaths = lumine.project.getPaths();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-state-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    try {
      lumine.project.setPaths([first]);
      main.ensureRuntime();
      main.createProjectFindView();
      const view = main.projectFindView;
      view.replaceEditor.setText("first replacement");
      view.pathsEditor.setText("first/**");
      const outgoing = main.findHistory.add("first search");

      lumine.project.setPaths([second]);

      expect(view.replaceEditor.getText()).toBe("");
      expect(view.pathsEditor.getText()).toBe("");
      expect(main.findHistory.items).toEqual([]);
      view.replaceEditor.setText("second replacement");
      view.pathsEditor.setText("second/**");
      const incoming = main.findHistory.add("second search");
      await outgoing;
      await incoming;
      await main.workspaceState.update("flush", true);

      expect(view.replaceEditor.getText()).toBe("second replacement");
      expect(view.pathsEditor.getText()).toBe("second/**");
      expect(main.findHistory.items).toEqual(["second search"]);
      lumine.project.setPaths([first]);
      expect(view.replaceEditor.getText()).toBe("first replacement");
      expect(view.pathsEditor.getText()).toBe("first/**");
      expect(main.findHistory.items).toEqual(["first search"]);
    } finally {
      lumine.project.setPaths(originalPaths);
      await lumine.fileWatchClient.settlePendingTeardown();
      await removeTemporaryDirectory(root);
    }
  });

  it("keeps the final toggle and history selection through several queued writes", async () => {
    main.ensureRuntime();
    const buffer = new main.runtime.TextBuffer("first");
    const cycler = new main.runtime.HistoryCycler(buffer, main.findHistory);
    const changes = [];
    const subscription = main.findOptions.onDidChange((change) => changes.push(change));
    try {
      cycler.store();
      buffer.setText("second");
      cycler.store();
      main.findOptions.set({ useRegex: true });
      main.findOptions.set({ useRegex: false });
      await main.workspaceState.update("flush", true);

      cycler.previous();
      expect(buffer.getText()).toBe("first");
      expect(changes).toEqual([{ useRegex: true }, { useRegex: false }]);
    } finally {
      subscription.dispose();
      cycler.dispose();
      buffer.destroy();
    }
  });

  it("refreshes existing buffer matches when another window changes a search option", async () => {
    await lumine.packages.activatePackage("language-regex");
    const editor = await lumine.workspace.open();
    editor.setText("oneX two");
    main.ensureRuntime();
    main.createFindView();
    main.findView.findEditor.setText("one.");
    main.findView.search();
    expect(main.activeTarget.getResultCount()).toBe(0);

    await main.globalState.update("options", { useRegex: true });

    expect(main.findOptions.useRegex).toBe(true);
    expect(main.activeTarget.getResultCount()).toBe(1);
  });

  it("cancels the outgoing project scan and ignores its late results", async () => {
    main.ensureRuntime();
    const originalPaths = lumine.project.getPaths();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-scan-"));
    let report;
    let finish;
    const scan = new Promise((resolve) => (finish = resolve));
    scan.cancel = jasmine.createSpy("cancel scan");
    const scans = spyOn(lumine.workspace, "scan").and.callFake((_regex, _options, callback) => {
      report = callback;
      return scan;
    });
    try {
      const search = main.resultsModel.search("needle", "", "");
      lumine.project.setPaths([root]);
      report({
        filePath: path.join(root, "outgoing-result.txt"),
        matches: [
          {
            matchText: "needle",
            lineText: "needle",
            range: [
              [0, 0],
              [0, 6],
            ],
          },
        ],
      });
      finish();
      await search;

      expect(scan.cancel).toHaveBeenCalled();
      expect(main.resultsModel.getPathCount()).toBe(0);
      await main.resultsModel.search("needle", "", "", { onlyRunIfChanged: true });
      expect(scans).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      lumine.project.setPaths(originalPaths);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not start a search in the next project when an outgoing replacement finishes", async () => {
    main.ensureRuntime();
    const originalPaths = lumine.project.getPaths();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-replace-"));
    const scan = Object.assign(Promise.resolve(), { cancel() {} });
    const scans = spyOn(lumine.workspace, "scan").and.returnValue(scan);
    let report;
    let finish;
    const replacement = new Promise((resolve) => (finish = resolve));
    spyOn(lumine.workspace, "replace").and.callFake((_regex, _text, _paths, callback) => {
      report = callback;
      return replacement;
    });
    try {
      await main.resultsModel.search("needle", "", "replacement");
      const operation = main.resultsModel.replace("", "replacement", []);
      lumine.project.setPaths([root]);
      report({ replacements: 2 });
      finish();
      await operation;

      expect(scans).toHaveBeenCalledTimes(1);
      expect(main.resultsModel.replacementCount).toBeNull();
    } finally {
      finish();
      lumine.project.setPaths(originalPaths);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
