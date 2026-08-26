const FindOptions = require("../lib/find-options");
const ProjectFindView = require("../lib/project-find-view");

describe("project find options", () => {
  it("applies Whole Word to an entire regular-expression alternative", () => {
    const options = new FindOptions();
    options.set({
      findPattern: "cat|dog",
      useRegex: true,
      caseSensitive: true,
      wholeWord: true,
    });
    const regex = options.getFindPatternRegex();

    expect("cat dog".match(regex)).toEqual(["cat", "dog"]);
    expect("catapult hotdog".match(regex)).toBeNull();
  });

  it("reruns an active search when PCRE2 is toggled", () => {
    lumine.config.set("search-panel.enablePCRE2", false);
    const view = {
      updateEngineOptionButtons: jasmine.createSpy("updateEngineOptionButtons"),
      search: jasmine.createSpy("search").and.returnValue(Promise.resolve()),
    };

    ProjectFindView.prototype.togglePCRE2Option.call(view);

    expect(lumine.config.get("search-panel.enablePCRE2")).toBe(true);
    expect(view.updateEngineOptionButtons).toHaveBeenCalled();
    expect(view.search).toHaveBeenCalledWith({ onlyRunIfActive: true });
  });
});
