describe("Project results measurement across windows", () => {
  let model, view;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const FindOptions = require("../lib/find-options");
    const ResultsModel = require("../lib/results-model");
    const ResultsView = require("../lib/results-view");
    model = new ResultsModel(new FindOptions());
    view = new ResultsView({ model });
    await lumine.workspace.open({ element: view.element, getTitle: () => "Search results" });
  });

  afterEach(async () => {
    await view?.destroy();
    model?.destroy();
    await lumine.workspace.discardEditorWindows();
  });

  for (const component of ["results", "list"]) {
    it(`rebinds the ${component} observer on detachment and reattachment`, async () => {
      const measured = component === "results" ? view : view.refs.listView;
      const original = measured.resizeObserver;
      const releaseOriginal = spyOn(original, "disconnect").and.callThrough();
      const item = lumine.workspace.getActivePaneItem();
      const extra = await lumine.workspace.openEditorWindow({ show: false });
      await lumine.workspace.movePaneItem(item, {
        targetPane: extra.getEditorContainer().getActivePane(),
      });
      expect(releaseOriginal).toHaveBeenCalled();
      expect(measured.resizeObserver instanceof extra.getDOMWindow().ResizeObserver).toBeTrue();
      const releaseDetached = spyOn(measured.resizeObserver, "disconnect").and.callThrough();
      await lumine.workspace.attachWindow(extra);
      expect(releaseDetached).toHaveBeenCalled();
      expect(measured.resizeObserver instanceof window.ResizeObserver).toBeTrue();
    });
  }
});
