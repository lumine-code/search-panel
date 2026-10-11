const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Native project result boundaries", () => {
  let main, directory, workspaceElement, wasConnected;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    workspaceElement = lumine.views.getView(lumine.workspace);
    wasConnected = workspaceElement.isConnected;
    if (!wasConnected) document.body.appendChild(workspaceElement);
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "search-results-")));
    lumine.project.setPaths([directory]);
    await lumine.packages.activatePackage("language-regex");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.createProjectFindView();
  });

  afterEach(async () => {
    for (const item of lumine.workspace.getPaneItems()) {
      if (item.getURI?.()?.startsWith("lumine://search-panel/project-results"))
        await lumine.workspace.paneForItem(item).destroyItem(item);
    }
    if (lumine.packages.isPackageActive("search-panel"))
      await lumine.packages.deactivatePackage("search-panel");
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel");
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (!wasConnected) workspaceElement.remove();
    const root = fs.realpathSync.native(os.tmpdir());
    const resolved = fs.realpathSync.native(directory);
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Unsafe owned search cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
    main = directory = workspaceElement = null;
  });

  async function searchRows(count) {
    fs.writeFileSync(path.join(directory, "rows.txt"), "needle\n".repeat(count));
    main.projectFindView.findEditor.setText("needle");
    await main.projectFindView.search();
    expect(main.resultsModel.getMatchCount()).toBe(count);
    const pane = lumine.workspace.paneForURI("lumine://search-panel/project-results");
    const view = pane.itemForURI("lumine://search-panel/project-results").refs.resultsView;
    expect(view.resultRowGroups.length).toBe(1);
    expect(view.resultRowGroups[0]?.rows.length).toBe(count + 1);
    return view;
  }

  it("builds the reported fifty-thousand-match file without argument overflow", async () => {
    await searchRows(50000);
  }, 30000);

  it("keeps ordinary three-row search grouping intact", async () => {
    await searchRows(3);
  });

  it("uses each capture when replacing several includes across owned files", async () => {
    const first = path.join(directory, "first.c");
    const second = path.join(directory, "second.c");
    fs.writeFileSync(first, "#include <mousepad/private.h>\n#include <mousepad/application.h>\n");
    fs.writeFileSync(second, "#include <mousepad/other.h>\n");
    main.projectFindView.findEditor.setText("#include <(mousepad/.*)>");
    main.resultsModel.getFindOptions().set({ useRegex: true });
    await main.projectFindView.search();
    expect(main.resultsModel.getMatchCount()).toBe(3);
    await main.resultsModel.replace("", '#include "$1"', [first, second]);
    expect(fs.readFileSync(first, "utf8")).toBe(
      '#include "mousepad/private.h"\n#include "mousepad/application.h"\n',
    );
    expect(fs.readFileSync(second, "utf8")).toBe('#include "mousepad/other.h"\n');
  });
});
