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
});
