const { EditorSearchTarget, AdapterSearchTarget } = require("../lib/search-target");
const BufferSearch = require("../lib/buffer-search");
const FindOptions = require("../lib/find-options");

describe("buffer result navigation scrolling", () => {
  let editor, model, target, subscription, scrollRequests;

  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText("one\nsecond\none");
    editor.setCursorBufferPosition([0, 0], { autoscroll: false });
    model = new BufferSearch(new FindOptions());
    model.setEditor(editor);
    model.search("one", { useRegex: false, caseSensitive: false, inCurrentSelection: false });
    target = new EditorSearchTarget(model);
    scrollRequests = [];
    subscription = editor.onDidRequestAutoscroll((request) => scrollRequests.push(request));
  });

  afterEach(() => {
    subscription.dispose();
    model.destroy();
    editor.destroy();
  });

  it("uses live shared zone settings for explicit next and previous results", () => {
    lumine.config.set("editor.scrollZone", [15, 65]);
    target.selectNext();
    expect(editor.getSelectedBufferRange().serialize()).toEqual([
      [2, 0],
      [2, 3],
    ]);
    expect(scrollRequests.map((request) => request.options.mode)).toEqual([[15, 65]]);

    lumine.config.set("editor.scrollZone", [30]);
    target.selectPrevious();
    expect(editor.getSelectedBufferRange().start.row).toBe(0);
    expect(scrollRequests.at(-1).options.mode).toEqual([30, 30]);
  });

  it("reveals a live search result with nearest visibility", () => {
    lumine.config.set("editor.scrollZone", [25]);
    target.selectFirstFromCursor({ mode: "nearest" });
    expect(editor.getSelectedText()).toBe("one");
    expect(scrollRequests.map((request) => request.options.mode)).toEqual([[0, 100]]);
  });

  it("selects all results while revealing one destination once", () => {
    lumine.config.set("editor.scrollZone", [10, 70]);
    target.selectAll();
    expect(editor.getSelectedBufferRanges().length).toBe(2);
    expect(scrollRequests.map((request) => request.options.mode)).toEqual([[10, 70]]);
  });

  it("preserves navigation modes through a custom adapter and its live-search fallback", () => {
    const adapterTarget = new AdapterSearchTarget(
      {
        selectNext: (options) => target.selectNext(options),
        selectPrevious: (options) => target.selectPrevious(options),
        selectAll: (options) => target.selectAll(options),
      },
      new FindOptions(),
    );
    lumine.config.set("editor.scrollZone", [15, 65]);

    adapterTarget.selectFirstFromCursor({ mode: "nearest" });
    expect(editor.getSelectedBufferRange().start.row).toBe(2);
    expect(scrollRequests.at(-1).options.mode).toEqual([0, 100]);

    adapterTarget.selectPrevious({ mode: "zone" });
    expect(editor.getSelectedBufferRange().start.row).toBe(0);
    expect(scrollRequests.at(-1).options.mode).toEqual([15, 65]);

    adapterTarget.selectAll({ mode: "zone" });
    expect(editor.getSelectedBufferRanges().length).toBe(2);
    expect(scrollRequests.at(-1).options.mode).toEqual([15, 65]);
  });
  it("supports asynchronous adapters and counts beyond array-length limits", async () => {
    let update;
    const failure = new Error("replacement failed");
    const adapterTarget = new AdapterSearchTarget(
      {
        canReplace: true,
        getResultCount: () => 2 ** 33,
        isPending: () => true,
        onDidUpdate(callback) {
          update = callback;
          return { dispose() {} };
        },
        selectNext: async () => ({ found: true, wrapped: null }),
        replaceAll: () => Promise.reject(failure),
      },
      new FindOptions(),
    );
    let seen;
    adapterTarget.onDidUpdate((count) => {
      seen = count;
    });
    update();
    expect(seen).toBe(2 ** 33);
    expect(adapterTarget.isPending()).toBe(true);
    expect(await adapterTarget.selectNext()).toEqual({ found: true, wrapped: null });
    let reported;
    adapterTarget.onDidError((error) => {
      reported = error;
    });
    await expectAsync(adapterTarget.replaceAll("x")).toBeRejectedWith(failure);
    expect(reported).toBe(failure);
  });
});
