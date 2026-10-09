const fs = require("fs");
const path = require("path");
const os = require("os");

describe("Project replacement confirmation ownership", () => {
  let main, view, directory, originalPaths, a, b;
  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    await lumine.packages.activatePackage("language-regex");
    originalPaths = lumine.project.getPaths();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-replace-confirm-")));
    a = path.join(directory, "a.txt");
    b = path.join(directory, "b.txt");
    fs.writeFileSync(a, "Alpha\n");
    fs.writeFileSync(b, "Beta\n");
    lumine.project.setPaths([directory]);
    const pack = await lumine.packages.activatePackage("search-panel");
    main = pack.mainModule;
    main.createProjectFindView();
    view = main.projectFindView;
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    view.findEditor.setText("Alpha");
    view.pathsEditor.setText("a.txt");
    view.replaceEditor.setText("Changed");
    view.model.getFindOptions().set({ useRegex: false });
    await view.search({});
    expect(view.model.getPaths()).toEqual([a]);
  });
  afterEach(async () => {
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
      throw new Error("Fixture directory escaped its owned temporary root");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("does not apply an older confirmation to a newer search's actual file", async () => {
    let release, entered;
    const arrival = new Promise((resolve) => (entered = resolve));
    const confirmation = new Promise((resolve) => (release = resolve));
    spyOn(lumine.window, "confirm").and.callFake(() => {
      entered();
      return confirmation;
    });
    const replacing = view.replaceAll();
    try {
      await arrival;
      view.findEditor.setText("Beta");
      view.pathsEditor.setText("b.txt");
      await view.search({});
      expect(view.model.getPaths()).toEqual([b]);
    } finally {
      release(0);
      await replacing;
    }
    expect(fs.readFileSync(a, "utf8")).toBe("Alpha\n");
    expect(fs.readFileSync(b, "utf8")).toBe("Beta\n");
  });
  it("still completes a current confirmed replacement through Core filesystem IO", async () => {
    spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(0));
    await view.replaceAll();
    expect(fs.readFileSync(a, "utf8")).toBe("Changed\n");
    expect(fs.readFileSync(b, "utf8")).toBe("Beta\n");
  });
  async function holdConfirmation(change) {
    let release, entered;
    const arrival = new Promise((resolve) => (entered = resolve));
    const confirmation = new Promise((resolve) => (release = resolve));
    spyOn(lumine.window, "confirm").and.callFake(() => {
      entered();
      return confirmation;
    });
    const replacing = view.replaceAll();
    try {
      await arrival;
      await change();
    } finally {
      release(0);
      await replacing;
    }
  }
  it("does not reinterpret an accepted replacement when regex mode changes", async () => {
    view.replaceEditor.setText("\\n");
    await holdConfirmation(() => view.model.getFindOptions().set({ useRegex: true }));
    expect(fs.readFileSync(a, "utf8")).toBe("Alpha\n");
  });
  it("does not replace files from a project removed before confirmation", async () => {
    await holdConfirmation(() => lumine.project.setPaths([]));
    expect(fs.readFileSync(a, "utf8")).toBe("Alpha\n");
  });
  it("does not submit a replacement after the actual Package retires", async () => {
    await holdConfirmation(() => lumine.packages.deactivatePackage("search-panel"));
    expect(fs.readFileSync(a, "utf8")).toBe("Alpha\n");
  });
  it("does not show confirmation after its accepted results-pane open completes late", async () => {
    let release, entered;
    const arrival = new Promise((resolve) => (entered = resolve));
    const held = new Promise((resolve) => (release = resolve));
    const open = view.showResultPane.bind(view);
    spyOn(view, "showResultPane").and.callFake(async () => {
      const pane = await open();
      entered();
      await held;
      return pane;
    });
    const confirm = spyOn(lumine.window, "confirm").and.resolveTo(0);
    const replacing = view.replaceAll();
    try {
      await arrival;
      await lumine.packages.deactivatePackage("search-panel");
    } finally {
      release();
      await replacing;
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(a, "utf8")).toBe("Alpha\n");
  });
});
