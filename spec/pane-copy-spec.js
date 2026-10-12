describe("search result pane copies", () => {
  let main, items, ResultsPane, Result;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.ensureRuntime();
    main.createProjectFindView();
    ResultsPane = require("../lib/results-pane");
    Result = require("../lib/results-model").Result;
    items = [];
    main.findOptions.set({ findPattern: "needle" });
  });

  afterEach(async () => {
    for (const item of items) if (!item.destroyed) await item.destroy();
    await lumine.packages.deactivatePackage("search-panel");
  });

  function add(model, filePath) {
    const result = Result.create({
      filePath,
      matches: [
        {
          range: [
            [0, 0],
            [0, 6],
          ],
          matchText: "needle",
          lineText: "needle",
        },
      ],
    });
    model.lastFindPattern = "needle";
    model.addResult(filePath, result);
  }

  it("retains the pinned result model after its original pane closes", async () => {
    const original = new ResultsPane();
    items.push(original);
    add(original.model, "old.txt");
    await lumine.workspace.open(original);
    await original.dontOverrideTab();
    const pinned = original.model;
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    expect(copy.model).toBe(pinned);
    expect(copy.refs.resultsView).not.toBe(original.refs.resultsView);
    expect(copy.separatePane).toBe(true);
    add(main.projectFindView.model, "new.txt");
    await original.destroy();
    expect(pinned.destroyed).toBe(false);
    expect(pinned.viewOwners.size).toBe(1);
    expect(pinned.getActive()).toBe(true);
    expect(copy.refs.resultsView.resultRowGroups.map((group) => group.data.filePath)).toEqual([
      "old.txt",
    ]);
    await copy.destroy();
    expect(pinned.destroyed).toBe(true);
    expect(main.projectFindView.model.destroyed).toBe(false);
  });

  it("keeps unpinned copies following the current model when one pane is pinned", async () => {
    const original = new ResultsPane();
    items.push(original);
    add(original.model, "first.txt");
    await lumine.workspace.open(original);
    original.refs.resultsView.collapseAllResults();
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    expect(copy.refs.resultsView.resultRowGroups[0].data.isCollapsed).toBe(true);
    copy.refs.resultsView.expandAllResults();
    expect(original.refs.resultsView.resultRowGroups[0].data.isCollapsed).toBe(true);
    await original.dontOverrideTab();
    expect(copy.model).toBe(main.projectFindView.model);
    expect(copy.model).not.toBe(original.model);
    expect(copy.separatePane).toBe(false);
    const pinned = original.model;
    await original.destroy();
    expect(pinned.destroyed).toBe(true);
    expect(copy.model.destroyed).toBe(false);
  });
});
