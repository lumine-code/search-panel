const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("Project search result publication boundaries", () => {
  let main, view, directory, originalPaths, a, b, pending;
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    await lumine.packages.activatePackage("language-regex");
    originalPaths = lumine.project.getPaths();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-results-")));
    a = path.join(directory, "a.txt");
    b = path.join(directory, "b.txt");
    fs.writeFileSync(a, "Alpha\n");
    fs.writeFileSync(b, "Beta\n");
    lumine.project.setPaths([directory]);
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.createProjectFindView();
    view = main.projectFindView;
    view.model.getFindOptions().set({ useRegex: false });
    pending = [];
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });
  afterEach(async () => {
    for (const operation of pending) operation.resolve();
    await Promise.resolve();
    await lumine.packages.deactivatePackage("search-panel");
    lumine.project.setPaths(originalPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw Error("Fixture escaped its owned temporary root");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("keeps the newer real scan when queued callbacks and completion from the old scan arrive", async () => {
    const scan = lumine.workspace.scan.bind(lumine.workspace);
    const calls = [];
    spyOn(lumine.workspace, "scan").and.callFake((regex, options, callback) => {
      const completed = deferred(),
        gate = deferred(),
        queued = [];
      pending.push(gate);
      const native = scan(
        regex,
        {
          ...options,
          onPathsSearched: (count) => queued.push(() => options.onPathsSearched(count)),
        },
        (...args) => queued.push(() => callback(...args)),
      );
      const promise = native.then(async (message) => {
        completed.resolve();
        await gate.promise;
        for (const deliver of queued) deliver();
        return message;
      });
      promise.cancel = () => native.cancel();
      calls.push({ completed, gate, promise });
      return promise;
    });
    const first = view.model.search("Alpha", "a.txt", "");
    await calls[0].completed.promise;
    const second = view.model.search("Beta", "b.txt", "");
    await calls[1].completed.promise;
    calls[0].gate.resolve();
    await first;
    expect(view.model.getPaths()).toEqual([]);
    expect(view.model.inProgressSearchPromise).toBe(calls[1].promise);
    calls[1].gate.resolve();
    await second;
    expect(view.model.getPaths()).toEqual([b]);
  });
  it("keeps project-field subscriptions alive after preserving an actual results tab", async () => {
    view.findEditor.setText("Alpha");
    view.pathsEditor.setText("a.txt");
    await view.search({});
    const pane = await view.showResultPane();
    await pane.dontOverrideTab();
    const publish = spyOn(view, "generateResultsMessage").and.callThrough();
    view.findEditor.setText("Beta");
    view.pathsEditor.setText("b.txt");
    await view.search({});
    expect(publish).toHaveBeenCalled();
    expect(pane.model.getPaths()).toEqual([a]);
    expect(view.model.getPaths()).toEqual([b]);
    const options = view.model.getFindOptions();
    const update = spyOn(view, "updateOptionViews").and.callThrough();
    await view.destroy();
    options.set({ caseSensitive: !options.caseSensitive });
    expect(update).not.toHaveBeenCalled();
  });
  it("disconnects its real native results observer when the Core pane closes", async () => {
    const NativeObserver = window.ResizeObserver;
    const observers = [];
    spyOn(window, "ResizeObserver").and.callFake(function (callback) {
      const observer = new NativeObserver(callback);
      spyOn(observer, "disconnect").and.callThrough();
      observers.push(observer);
      return observer;
    });
    const item = await view.showResultPane();
    const pane = lumine.workspace.paneForItem(item);
    expect(observers.length).toBeGreaterThan(0);
    await pane.destroyItem(item, true);
    await item.destruction;
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalled();
  });
  it("renders a real invalid regex error as text", async () => {
    view.model.getFindOptions().set({ useRegex: true });
    view.findEditor.setText("<b>x</b>[");
    await view.search({});
    expect(view.refs.descriptionLabel.classList.contains("text-error")).toBe(true);
    expect(view.refs.descriptionLabel.querySelector("b")).toBeNull();
    expect(view.refs.descriptionLabel.textContent).toContain("<b>x</b>");
  });
  async function selectedMatch() {
    fs.writeFileSync(a, "first\nsecond\nAlpha\nlast\n");
    view.findEditor.setText("Alpha");
    view.pathsEditor.setText("a.txt");
    await view.search({});
    const pane = await view.showResultPane();
    const results = pane.refs.resultsView;
    results.selectedRowIndex = results.resultRows.findIndex((row) => row.data.matches?.length);
    expect(results.selectedRowIndex).toBeGreaterThan(-1);
    return { pane, results };
  }
  for (const method of ["confirmResult", "openInNewTab"]) {
    it(`reveals the actual match row through ${method}`, async () => {
      const { results } = await selectedMatch();
      const editor = await lumine.workspace.open(a);
      editor.foldBufferRange([
        [0, 0],
        [3, 0],
      ]);
      const unfold = spyOn(editor, "unfoldBufferRow").and.callThrough();
      await results[method]();
      expect(unfold).toHaveBeenCalledWith(2);
      expect(editor.getSelectedText()).toBe("Alpha");
    });
  }
  it("does not move selection after a retired result's actual open completes", async () => {
    const { pane, results } = await selectedMatch();
    const target = await lumine.workspace.open(a);
    target.setSelectedBufferRange([
      [0, 0],
      [0, 0],
    ]);
    const open = lumine.workspace.open.bind(lumine.workspace);
    const arrived = deferred(),
      gate = deferred();
    pending.push(gate);
    spyOn(lumine.workspace, "open").and.callFake(async (...args) => {
      const item = await open(...args);
      if (args[0] === a) {
        arrived.resolve();
        await gate.promise;
      }
      return item;
    });
    const navigating = results.confirmResult();
    try {
      await arrived.promise;
      await lumine.workspace.paneForItem(pane).destroyItem(pane, true);
      await pane.destruction;
    } finally {
      gate.resolve();
      await navigating;
    }
    expect(target.getSelectedBufferRange().serialize()).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(target.isDestroyed()).toBe(false);
  });
});
