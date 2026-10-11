const { Disposable } = require("lumine");
describe("Search Panel independent autocomplete providers", () => {
  let main, leases;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.config.set("search-panel.autocompleteSearches", true);
    main = (await lumine.packages.activatePackage("search-panel")).mainModule;
    lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "search-panel:show");
    leases = [];
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("search-panel");
  });
  it("keeps ordinary single-provider configuration changes working", () => {
    const api = jasmine.createSpy("single").and.callFake(() => new Disposable());
    leases.push(lumine.packages.serviceHub.provide("autocomplete.watch-editor", "1.0.0", api));
    lumine.config.set("search-panel.autocompleteSearches", false);
    api.calls.reset();
    lumine.config.set("search-panel.autocompleteSearches", true);
    expect(api).toHaveBeenCalledOnceWith(main.findView.findEditor, ["default"]);
  });
  for (const withdrawal of ["older", "newer", "none"]) {
    it(`retains the query registration after ${withdrawal} edge withdraws`, () => {
      const offer = (label) => {
        const dispose = jasmine.createSpy(label + " dispose");
        const api = jasmine.createSpy(label).and.callFake(() => new Disposable(dispose));
        const lease = lumine.packages.serviceHub.provide("autocomplete.watch-editor", "1.0.0", api);
        leases.push(lease);
        return { api, dispose, lease };
      };
      const older = offer("older"),
        newer = offer("newer");
      if (withdrawal !== "none") (withdrawal === "older" ? older : newer).lease.dispose();
      const expected = withdrawal === "newer" ? older : newer;
      // A real configuration change must reconnect the currently available facade.
      lumine.config.set("search-panel.autocompleteSearches", false);
      expected.api.calls.reset();
      expected.dispose.calls.reset();
      lumine.config.set("search-panel.autocompleteSearches", true);
      expect(expected.api).toHaveBeenCalledOnceWith(main.findView.findEditor, ["default"]);
      expect(expected.dispose).not.toHaveBeenCalled();
    });
  }
});
