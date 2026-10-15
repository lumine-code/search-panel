const FindOptions = require("../lib/find-options");
const ResultsModel = require("../lib/results-model");
const ResultsView = require("../lib/results-view");

describe("Project search result platform gestures", () => {
  let model, view;
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
    view = new ResultsView({ model });
    jasmine.attachToDOM(view.element);
  });
  afterEach(async () => {
    await view?.destroy();
    model?.destroy();
  });

  for (const platform of ["win32", "linux", "darwin"]) {
    it(`confirms Ctrl-click on Windows/Linux and preserves the macOS context gesture (${platform})`, () => {
      const confirm = spyOn(view, "confirmResult");
      const row = document.createElement("li");
      row.className = "list-item path-row";
      row.dataset.filePath = "example.txt";
      view.element.appendChild(row);
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      try {
        const event = new MouseEvent("mousedown", {
          button: 0,
          ctrlKey: true,
          detail: 1,
          bubbles: true,
          cancelable: true,
        });
        row.dispatchEvent(event);
        expect(confirm.calls.count()).toBe(platform === "darwin" ? 0 : 1);
        expect(event.defaultPrevented).toBe(platform !== "darwin");
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
  }
});
