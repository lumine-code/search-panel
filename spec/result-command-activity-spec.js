const etch = require("@lumine-code/etch");
const FindOptions = require("../lib/find-options");
const ResultsModel = require("../lib/results-model");
const ResultsView = require("../lib/results-view");

describe("Project result open command activity", () => {
  let model, view, editor, confirm, openInNewTab, reveal;
  beforeEach(() => {
    model = new ResultsModel(new FindOptions());
    model.results = {
      "example.txt": ResultsModel.Result.create({
        filePath: "example.txt",
        matches: [
          {
            range: [
              [0, 0],
              [0, 3],
            ],
            matchText: "one",
            lineText: "one",
          },
        ],
      }),
    };
    editor = lumine.workspace.buildTextEditor();
    editor.setText("one\nsecond");
    spyOn(lumine.workspace, "open").and.resolveTo(editor);
    confirm = spyOn(ResultsView.prototype, "confirmResult").and.callThrough();
    openInNewTab = spyOn(ResultsView.prototype, "openInNewTab").and.callThrough();
    view = new ResultsView({ model });
    jasmine.attachToDOM(view.element);
    view.selectedRowIndex = 1;
    reveal = spyOn(lumine.scrollbars, "reveal");
  });
  afterEach(async () => {
    await view?.destroy();
    model?.destroy();
    editor?.destroy();
  });

  for (const command of ["core:confirm", "search-panel:open-in-new-tab"]) {
    it(`signals ${command} for a visible match before opening without moving its scrollport`, async () => {
      const port = view.refs.listView.element;
      const before = port.scrollTop;
      lumine.commands.dispatch(view.element, command);
      expect(reveal).toHaveBeenCalledOnceWith(port);
      expect(port.scrollTop).toBe(before);
      await (command === "core:confirm" ? confirm : openInNewTab).calls.mostRecent().returnValue;
      expect(lumine.workspace.open).toHaveBeenCalled();
      expect(editor.getSelectedText()).toBe("one");
    });
  }

  for (const collapsed of [false, true]) {
    it(`signals a group confirmation once when ${collapsed ? "expanding" : "collapsing"} the group`, async () => {
      view.selectedRowIndex = 0;
      if (collapsed) {
        await view.collapseResult();
        reveal.calls.reset();
      }
      lumine.commands.dispatch(view.element, "core:confirm");
      await confirm.calls.mostRecent().returnValue;
      expect(reveal).toHaveBeenCalledOnceWith(view.refs.listView.element);
      expect(view.selectedRow().group.data.isCollapsed).toBe(!collapsed);
      expect(lumine.workspace.open).not.toHaveBeenCalled();
    });
  }

  it("leaves empty commands, copying, typing and rerendering without navigation activity", async () => {
    view.selectedRowIndex = -1;
    lumine.commands.dispatch(view.element, "core:confirm");
    lumine.commands.dispatch(view.element, "search-panel:open-in-new-tab");
    await confirm.calls.mostRecent().returnValue;
    view.selectedRowIndex = 1;
    spyOn(lumine.clipboard, "write");
    lumine.commands.dispatch(view.element, "core:copy");
    view.element.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await etch.update(view);
    expect(reveal).not.toHaveBeenCalled();
  });
});
