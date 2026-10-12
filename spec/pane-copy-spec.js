describe("Project search singleton results", () => {
  let main, ResultsPane;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.ensureRuntime();
    main.createProjectFindView();
    ResultsPane = require("../lib/results-pane");
    main.findOptions.set({ findPattern: "needle" });
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("search-panel");
  });

  it("silently skips copying its current result set without changing preview or panes", async () => {
    const source = await main.projectFindView.showResultPane();
    const pane = lumine.workspace.paneForItem(source);
    pane.setPendingItem(source);
    const panes = lumine.workspace.getPanes();
    const warnings = spyOn(lumine.notifications, "addWarning");
    const errors = spyOn(lumine.notifications, "addError");
    expect(await lumine.workspace.copyPaneItem(source, { splitDirection: "right" })).toBeNull();
    expect(lumine.workspace.getPanes()).toEqual(panes);
    expect(pane.getPendingItem()).toBe(source);
    expect(warnings).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps saved result sets unique even when their find patterns match", async () => {
    const first = await main.projectFindView.showResultPane();
    first.model.lastFindPattern = "needle";
    const firstModel = first.model;
    await first.dontOverrideTab();
    const second = await main.projectFindView.showResultPane();
    second.model.lastFindPattern = "needle";
    await second.dontOverrideTab();
    expect(first.getSingletonKey()).not.toBe(second.getSingletonKey());
    expect(first.model).toBe(firstModel);
    expect(second.model).not.toBe(firstModel);
    expect(lumine.workspace.getPaneItems()).toContain(first);
    expect(lumine.workspace.getPaneItems()).toContain(second);
    expect(firstModel.destroyed).toBe(false);
  });

  it("unpins into the already existing current results without duplicating that resource", async () => {
    const saved = await main.projectFindView.showResultPane();
    await saved.dontOverrideTab();
    const current = await main.projectFindView.showResultPane();
    expect(current.getURI()).toBe(ResultsPane.URI);
    expect(await saved.dontOverrideTab()).toBe(current);
    expect(saved.isDestroyed()).toBe(true);
    expect(
      lumine.workspace.getPaneItems().filter((item) => item.getURI?.() === ResultsPane.URI),
    ).toEqual([current]);
  });
});
