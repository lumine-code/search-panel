describe("Search recovery bootstrap", () => {
  let pack, deactivate;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel", { serialize: false });
    pack = lumine.packages.loadPackage("search-panel");
    pack.requireMainModule();
    pack.initializeForExternalUse("workspace restoration");
    deactivate = spyOn(pack.mainModule, "deactivate").and.callThrough();
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivated).toBe(false);
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("search-panel"))
      await lumine.packages.unloadPackage("search-panel", { serialize: false });
  });

  it("deactivates before activation", async () => {
    await expectAsync(pack.deactivate()).toBeResolved();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(pack.mainInitialized).toBe(false);
  });

  it("unloads before activation", async () => {
    await expectAsync(
      lumine.packages.unloadPackage("search-panel", { serialize: false }),
    ).toBeResolved();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(lumine.packages.isPackageLoaded("search-panel")).toBe(false);
  });
});
