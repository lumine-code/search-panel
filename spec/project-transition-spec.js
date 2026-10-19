const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Search project transitions", () => {
  let root, projectA, projectB, main, release;
  beforeEach(async () => {
    jasmine.useRealClock();
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-transition-")),
    );
    projectA = path.join(root, "a");
    projectB = path.join(root, "b");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    fs.writeFileSync(path.join(projectA, "source.txt"), "needle A\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    lumine.project.setPaths([projectB]);
    await main.workspaceState.update("patterns", {
      pathsPattern: "b/**",
      replacePattern: "replacement B",
    });
    lumine.project.setPaths([projectA]);
    await main.workspaceState.update("patterns", {
      pathsPattern: "a/**",
      replacePattern: "replacement A",
    });
    await lumine.workspace.open(path.join(projectA, "source.txt"));
    main.createProjectFindView();
    main.projectFindView.findEditor.setText("needle A");
    await main.workspaceState.mutate("patterns", (value) => value);
  });
  afterEach(async () => {
    release?.();
    await lumine.packages.deactivatePackage("search-panel");
    lumine.project.setPaths([]);
    for (const editor of lumine.workspace.getTextEditors()) editor.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporaryRoot = fs.realpathSync.native(os.tmpdir());
    if (
      path.dirname(fs.realpathSync.native(root)) !== temporaryRoot ||
      !path.basename(root).startsWith("lumine-search-transition-")
    )
      throw new Error("Search transition scratch escaped its temporary root");
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    release = null;
  });
  it("applies incoming patterns before paths change without starting a project scan", async () => {
    const scans = spyOn(lumine.workspace, "scan").and.returnValue(
      Object.assign(Promise.resolve(), { cancel() {} }),
    );
    let observedRoots;
    const subscription = main.workspaceState.observe("patterns", (_state, { scopeChanged }) => {
      if (scopeChanged) observedRoots = lumine.project.getPaths();
    });
    try {
      expect(await lumine.project.setState([projectB])).toBe(true);
      expect(observedRoots).toEqual([projectA]);
      expect(main.projectFindView.pathsEditor.getText()).toBe("b/**");
      expect(main.projectFindView.replaceEditor.getText()).toBe("replacement B");
      expect(scans).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
    }
  });
  it("does not launch an outgoing search after its result pane finishes opening in the next project", async () => {
    const view = main.projectFindView;
    const opened = new Promise((resolve) => (release = resolve));
    spyOn(view, "showResultPane").and.returnValue(opened);
    const scans = spyOn(lumine.workspace, "scan").and.returnValue(
      Object.assign(Promise.resolve(), { cancel() {} }),
    );
    const searching = view.search();
    expect(await lumine.project.setState([projectB])).toBe(true);
    expect(main.workspaceState.get("patterns").pathsPattern).toBe("b/**");
    release();
    await searching;
    await main.workspaceState.mutate("patterns", (value) => value);
    expect(scans).not.toHaveBeenCalled();
    expect(main.workspaceState.get("patterns").pathsPattern).toBe("b/**");
    expect(main.workspaceState.get("patterns").replacePattern).toBe("replacement B");
  });

  it("retires an outgoing search as soon as storage changes, before project paths are restored", async () => {
    const view = main.projectFindView;
    const opened = new Promise((resolve) => (release = resolve));
    spyOn(view, "showResultPane").and.returnValue(opened);
    const scans = spyOn(lumine.workspace, "scan").and.returnValue(
      Object.assign(Promise.resolve(), { cancel() {} }),
    );
    const storage = lumine.packages.storage;
    const switchProject = storage.switchProject.bind(storage);
    let releaseSwitch;
    let didRebind;
    const rebound = new Promise((resolve) => (didRebind = resolve));
    const resumeSwitch = new Promise((resolve) => (releaseSwitch = resolve));
    spyOn(storage, "switchProject").and.callFake((paths) => {
      const switching = switchProject(paths);
      if (paths[0] !== projectB) return switching;
      didRebind();
      return switching.then(() => resumeSwitch);
    });
    const searching = view.search();
    const changing = lumine.project.setState([projectB]);
    await rebound;
    try {
      expect(lumine.project.getPaths()).toEqual([projectA]);
      release();
      await searching;
      await main.workspaceState.mutate("patterns", (value) => value);
      expect(scans).not.toHaveBeenCalled();
      expect(main.workspaceState.get("patterns").pathsPattern).toBe("b/**");
    } finally {
      release();
      releaseSwitch();
      await changing;
      await searching;
    }
  });

  it("starts only the latest search when two result-pane openings overlap", async () => {
    const view = main.projectFindView;
    let releaseFirst;
    const firstPane = new Promise((resolve) => (releaseFirst = resolve));
    const lastPane = new Promise((resolve) => (release = resolve));
    spyOn(view, "showResultPane").and.returnValues(firstPane, lastPane);
    const scans = spyOn(lumine.workspace, "scan").and.returnValue(
      Object.assign(Promise.resolve(), { cancel() {} }),
    );
    const first = view.search();
    view.findEditor.setText("latest needle");
    const last = view.search();
    try {
      releaseFirst();
      await first;
      expect(scans).not.toHaveBeenCalled();
      release();
      await last;
      expect(scans).toHaveBeenCalledTimes(1);
      expect(scans.calls.mostRecent().args[0].source).toBe("latest needle");
    } finally {
      releaseFirst();
      release();
      await Promise.all([first, last]);
    }
  });
});
