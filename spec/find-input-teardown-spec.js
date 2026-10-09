describe("Owned find input teardown", () => {
  let main, inputs;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    await lumine.packages.activatePackage("language-regex");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.createFindView();
    inputs = [main.findView.findEditor, main.findView.replaceEditor];
    expect(inputs.every((editor) => !editor.isDestroyed())).toBe(true);
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("search-panel"))
      await lumine.packages.deactivatePackage("search-panel");
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel");
    for (const editor of inputs ?? []) if (!editor.isDestroyed()) editor.destroy();
    main = inputs = null;
  });

  it("destroys the real find and replace editor models during package deactivation", async () => {
    await lumine.packages.deactivatePackage("search-panel");
    expect(inputs.map((editor) => editor.isDestroyed())).toEqual([true, true]);
  });

  it("retires old find input models before constructing the next package generation", async () => {
    const oldInputs = inputs;
    await lumine.packages.deactivatePackage("search-panel");
    await lumine.packages.unloadPackage("search-panel");
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    main.createFindView();
    inputs = [...oldInputs, main.findView.findEditor, main.findView.replaceEditor];
    expect(oldInputs.map((editor) => editor.isDestroyed())).toEqual([true, true]);
    expect(inputs.slice(2).map((editor) => editor.isDestroyed())).toEqual([false, false]);
  });
});
