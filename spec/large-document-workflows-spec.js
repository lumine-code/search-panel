const fs = require("node:fs");
const path = require("node:path");
const { TextBuffer } = require("lumine");

// Stateful user workflows through the current package generation and real UI
// target. No OS clipboard, fixture writes, search/replace mocks or fake workers.
const operations = [];
async function action(name, callback) {
  operations.push(name);
  return await callback();
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const padding = "background\n".repeat(14000);

describe("large document search workflows", () => {
  let editor, main, view, model;
  async function openPanel() {
    const pkg = await lumine.packages.activatePackage("search-panel");
    expect(fs.realpathSync(pkg.path)).toBe(fs.realpathSync(path.resolve(__dirname, "..")));
    main = pkg.mainModule;
    main.createFindView();
    main.findPanel.show();
    view = main.findView;
    model = main.findModel;
    expect(model.getEditor()).toBe(editor);
  }
  async function search(pattern, options = {}) {
    await view.search(pattern, {
      useRegex: false,
      caseSensitive: true,
      wholeWord: false,
      inCurrentSelection: false,
      ...options,
    });
    expect(model.pending).toBeFalse();
    expect(model.error).toBeNull();
  }
  function selectedOffsets() {
    const range = editor.getSelectedBufferRange();
    const buffer = editor.getBuffer();
    return [
      buffer.characterIndexForPosition(range.start),
      buffer.characterIndexForPosition(range.end),
    ];
  }
  beforeEach(async () => {
    for (const key of [
      "useRegex",
      "caseSensitive",
      "wholeWord",
      "inCurrentSelection",
      "cleanOnHide",
      "scrollToResultOnLiveSearch",
    ])
      lumine.config.set(`search-panel.${key}`, false);
    editor = await lumine.workspace.open();
    await lumine.packages.activatePackage("language-text");
    await lumine.packages.activatePackage("language-regex");
    await openPanel();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("search-panel");
    editor?.destroy();
  });
  afterAll(() => {
    console.log(
      "SEARCH_WORKFLOW_OPERATIONS " + JSON.stringify({ count: operations.length, operations }),
    );
  });

  it("navigates Unicode captures, replaces one/all, and undoes mixed CRLF/LF source exactly", async () => {
    const source = "id:α😀\r\nid:β😀\nid:α😀\r\n" + padding;
    await action("captures/load", () => editor.setText(source));
    editor.getBuffer().clearUndoStack();
    await action("captures/query", () =>
      search("(?<=id:)(?<letter>α|β)(?<face>😀)", { useRegex: true }),
    );
    expect(model.getResultCount()).toBe(3);
    await action("captures/next", () => view.findNext());
    expect(editor.getSelectedText()).toBe("α😀");
    view.replaceEditor.setText("$<face>-$<letter>");
    await action("captures/replace-one", () => view.replaceCurrent());
    expect(editor.getText()).toBe(
      source.replace(/(?<=id:)(?<letter>α|β)(?<face>😀)/u, "$<face>-$<letter>"),
    );
    await action("captures/undo-one", () => editor.undo());
    expect(editor.getText()).toBe(source);
    await action("captures/requery-after-undo", () =>
      search("(?<=id:)(?<letter>α|β)(?<face>😀)", { useRegex: true }),
    );
    await action("captures/replace-all", () => view.replaceAll());
    expect(editor.getText()).toBe(
      source.replace(/(?<=id:)(?<letter>α|β)(?<face>😀)/gu, "$<face>-$<letter>"),
    );
    await action("captures/undo-all", () => editor.undo());
    expect(editor.getText()).toBe(source);
    await action("captures/redo-all", () => editor.redo());
    expect(editor.getText()).toBe(
      source.replace(/(?<=id:)(?<letter>α|β)(?<face>😀)/gu, "$<face>-$<letter>"),
    );
  }, 30000);

  it("finds literal multiline Unicode text crossing search windows and changes the query after editing", async () => {
    const needle = "END\r\nBEGIN😀";
    const source = "x".repeat(65534) + needle + "\n" + padding + needle;
    await action("windows/load", () => editor.setText(source));
    await action("windows/query", () => search(needle));
    expect(model.getResultCount()).toBe(2);
    await action("windows/next", () => view.findNext());
    expect(selectedOffsets()).toEqual([65534, 65534 + needle.length]);
    await action("windows/edit-selected-result", () => editor.insertText("changed"));
    await action("windows/query-new-revision", () => search(needle));
    expect(model.getResultCount()).toBe(1);
    await action("windows/query-changed-text", () => search("changed"));
    expect(model.getResultCount()).toBe(1);
    await action("windows/previous", () => view.findPrevious());
    expect(editor.getSelectedText()).toBe("changed");
    await action("windows/undo-edit", () => editor.undo());
    await action("windows/requery-original", () => search(needle));
    expect(model.getResultCount()).toBe(2);
  }, 30000);

  it("keeps zero-width Unicode navigation phase and replacement identical to native RegExp", async () => {
    const source = "p😀q\r\nr😀s\nt😀u\r\n" + padding;
    const starts = [...source.matchAll(/(?=😀)/gu)].map((match) => match.index);
    await action("zero/load", () => editor.setText(source));
    editor.getBuffer().clearUndoStack();
    await action("zero/query", () => search("(?=😀)", { useRegex: true }));
    expect(model.getResultCount()).toBe(starts.length);
    for (let i = 0; i < starts.length + 1; i++) {
      await action(`zero/next-${i}`, () => view.findNext());
      expect(selectedOffsets()).toEqual([starts[i % starts.length], starts[i % starts.length]]);
    }
    view.replaceEditor.setText("_");
    await action("zero/replace-all", () => view.replaceAll());
    expect(editor.getText()).toBe(source.replace(/(?=😀)/gu, "_"));
    await action("zero/undo", () => editor.undo());
    expect(editor.getText()).toBe(source);
  }, 30000);

  it("keeps the original selection scope through repeated next and Replace All", async () => {
    const source = "hit hit hit\noutside hit\n" + padding;
    await action("scope/load", () => editor.setText(source));
    await action("scope/select-range", () =>
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 11],
      ]),
    );
    await action("scope/query", () => search("hit", { inCurrentSelection: true }));
    expect(model.getResultCount()).toBe(3);
    await action("scope/next-one", () => view.findNext());
    expect(selectedOffsets()).toEqual([4, 7]);
    await action("scope/next-two", () => view.findNext());
    expect(selectedOffsets()).toEqual([8, 11]);
    expect(model.getResultCount()).toBe(3);
    view.replaceEditor.setText("OK");
    await action("scope/replace-all", () => view.replaceAll());
    expect(editor.getText()).toBe("OK OK OK\noutside hit\n" + padding);
    await action("scope/undo", () => editor.undo());
    expect(editor.getText()).toBe(source);
  }, 30000);

  for (const large of [false, true]) {
    it(`tracks reversed and disjoint scopes through navigation, edits, undo and toggle (${large ? "async" : "sync"})`, async () => {
      const source = "hit hit\noutside hit\nhit hit\n" + (large ? padding : "");
      const label = large ? "multi-async" : "multi-sync";
      await action(`${label}/load`, () => editor.setText(source));
      editor.getBuffer().clearUndoStack();
      await action(`${label}/select-reversed-disjoint`, () =>
        editor.setSelectedBufferRanges(
          [
            [
              [0, 0],
              [0, 7],
            ],
            [
              [2, 0],
              [2, 7],
            ],
          ],
          { reversed: true },
        ),
      );
      await action(`${label}/query`, () => search("hit", { inCurrentSelection: true }));
      expect(model.getResultCount()).toBe(4);
      await action(`${label}/previous`, () => view.findPrevious());
      await action(`${label}/next`, () => view.findNext());
      await action(`${label}/select-all-results`, () => view.findAll({ focusEditorAfter: false }));
      expect(editor.getSelectedBufferRanges().length).toBe(4);
      await action(`${label}/query-after-owned-selection`, () =>
        search("hit", { inCurrentSelection: true }),
      );
      expect(model.getSearchRanges()).toEqual([
        [
          [0, 0],
          [0, 7],
        ],
        [
          [2, 0],
          [2, 7],
        ],
      ]);
      await action(`${label}/edit-before-scopes`, () =>
        editor.getBuffer().insert([0, 0], "prefix\n"),
      );
      await action(`${label}/query-shifted`, () => search("hit", { inCurrentSelection: true }));
      expect(model.getSearchRanges()).toEqual([
        [
          [0, 0],
          [1, 7],
        ],
        [
          [3, 0],
          [3, 7],
        ],
      ]);
      expect(model.getResultCount()).toBe(4);
      view.replaceEditor.setText("longer");
      await action(`${label}/replace-all`, () => view.replaceAll());
      expect(editor.getText()).toBe(
        "prefix\nlonger longer\noutside hit\nlonger longer\n" + (large ? padding : ""),
      );
      await action(`${label}/undo-replace`, () => editor.undo());
      await action(`${label}/undo-prefix`, () => editor.undo());
      expect(editor.getText()).toBe(source);
      await action(`${label}/query-restored`, () => search("hit", { inCurrentSelection: true }));
      expect(model.getSearchRanges()).toEqual([
        [
          [0, 0],
          [0, 7],
        ],
        [
          [2, 0],
          [2, 7],
        ],
      ]);
      expect(model.getResultCount()).toBe(4);
      await action(`${label}/external-selection`, () =>
        editor.setSelectedBufferRange(
          [
            [1, 0],
            [1, 11],
          ],
          { reversed: true },
        ),
      );
      await action(`${label}/new-explicit-scope`, () =>
        search("hit", { inCurrentSelection: true }),
      );
      expect(model.getResultCount()).toBe(1);
      expect(model.getSearchRanges()).toEqual([
        [
          [1, 0],
          [1, 11],
        ],
      ]);
      await action(`${label}/toggle-off`, () => search("hit"));
      expect(model.getResultCount()).toBe(5);
      expect(model.scopeLayer).toBeNull();
    }, 30000);
  }

  it("preserves a scoped zero-width query when navigation collapses its visible selection", async () => {
    const source = "p😀q😀r\noutside😀\n" + padding;
    await action("scope-zero/load", () => editor.setText(source));
    await action("scope-zero/select", () =>
      editor.setSelectedBufferRange(
        [
          [0, 0],
          [0, 7],
        ],
        { reversed: true },
      ),
    );
    await action("scope-zero/query", () =>
      search("(?=😀)", { useRegex: true, inCurrentSelection: true }),
    );
    expect(model.getResultCount()).toBe(2);
    await action("scope-zero/previous", () => view.findPrevious());
    await action("scope-zero/next", () => view.findNext());
    expect(model.getResultCount()).toBe(2);
    expect(model.getSearchRanges()).toEqual([
      [
        [0, 0],
        [0, 7],
      ],
    ]);
    view.replaceEditor.setText("_");
    await action("scope-zero/replace-all", () => view.replaceAll());
    expect(editor.getText()).toBe("p_😀q_😀r\noutside😀\n" + padding);
    await action("scope-zero/undo", () => editor.undo());
    expect(editor.getText()).toBe(source);
  }, 30000);

  it("honors a new external scope selected before an intervening text edit", async () => {
    await action("scope-intent/load", () => editor.setText("hit hit\noutside hit\n" + padding));
    await action("scope-intent/initial-selection", () =>
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 7],
      ]),
    );
    await action("scope-intent/initial-query", () => search("hit", { inCurrentSelection: true }));
    await action("scope-intent/new-selection", () =>
      editor.setSelectedBufferRange([
        [1, 0],
        [1, 11],
      ]),
    );
    await action("scope-intent/intervening-edit", () =>
      editor.getBuffer().insert([0, 0], "prefix\n"),
    );
    await action("scope-intent/search", () => search("hit", { inCurrentSelection: true }));
    expect(model.getResultCount()).toBe(1);
    expect(model.getSearchRanges()).toEqual([
      [
        [2, 0],
        [2, 11],
      ],
    ]);
  });

  it("does not resurrect an older scope when undoing an edit made before the user chose a new scope", async () => {
    await action("scope-history/load", () => editor.setText("hit hit\noutside hit\n" + padding));
    editor.getBuffer().clearUndoStack();
    await action("scope-history/select-A", () =>
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 7],
      ]),
    );
    await action("scope-history/search-A", () => search("hit", { inCurrentSelection: true }));
    await action("scope-history/edit", () => editor.getBuffer().insert([0, 0], "prefix\n"));
    await action("scope-history/select-B", () =>
      editor.setSelectedBufferRange([
        [2, 0],
        [2, 11],
      ]),
    );
    await action("scope-history/search-B", () => search("hit", { inCurrentSelection: true }));
    expect(model.getResultCount()).toBe(1);
    await action("scope-history/undo-earlier-edit", () => editor.undo());
    await action("scope-history/requery-B", () => search("hit", { inCurrentSelection: true }));
    expect(model.getSearchRanges()).toEqual([
      [
        [1, 0],
        [1, 11],
      ],
    ]);
    expect(model.getResultCount()).toBe(1);
  });

  it("keeps scoped Find, memory Copy, Next and Replace connected across temporary selection movement", async () => {
    const source = "hit hit hit\noutside hit\n" + padding;
    await action("find-copy/load", () => editor.setText(source));
    editor.getBuffer().clearUndoStack();
    await action("find-copy/select-scope", () =>
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 11],
      ]),
    );
    await action("find-copy/search", () => search("hit", { inCurrentSelection: true }));
    await action("find-copy/find", () => view.findNext());
    const selected = editor.getSelectedBufferRange();
    await action("find-copy/temporary-expansion-and-restore", () => {
      editor.getLastSelection().selectLine();
      editor.setSelectedBufferRange(selected);
    });
    const clipboard = editor.constructor.clipboard.createMemoryClipboard({ write() {} });
    await action("find-copy/copy-memory", () => editor.copySelectedText(clipboard));
    expect(clipboard.readWithMetadata().text).toBe("hit");
    await action("find-copy/next", () => view.findNext());
    expect(selectedOffsets()).toEqual([8, 11]);
    expect(model.getResultCount()).toBe(3);
    view.replaceEditor.setText("OK");
    await action("find-copy/replace", () => view.replaceCurrent());
    expect(editor.getText()).toBe("hit hit OK\noutside hit\n" + padding);
    await action("find-copy/undo", () => editor.undo());
    expect(editor.getText()).toBe(source);
    await action("find-copy/query-zero-width", () =>
      search("(?=hit)", { inCurrentSelection: true, useRegex: true }),
    );
    await action("find-copy/navigate-zero-width", () => view.findNext());
    await action("find-copy/copy-full-line-from-empty-result", () =>
      editor.copySelectedText(clipboard),
    );
    expect(clipboard.readWithMetadata().text).toBe("hit hit hit\n");
    await action("find-copy/next-zero-width", () => view.findNext());
    expect(model.getResultCount()).toBe(3);
    expect(model.getSearchRanges()).toEqual([
      [
        [0, 0],
        [0, 11],
      ],
    ]);
  }, 30000);

  it("cancels obsolete searches and prepared replacement, then closes and reopens the actual package", async () => {
    const source = "red blue\n".repeat(40000);
    await action("lifecycle/load", () => editor.setText(source));
    editor.getBuffer().clearUndoStack();
    const old = await action("lifecycle/start-obsolete", () => ({
      promise: view.search("red", { caseSensitive: true }),
    }));
    await action("lifecycle/change-query", () => search("blue"));
    await old.promise;
    expect(model.getFindOptions().findPattern).toBe("blue");
    expect(model.getResultCount()).toBe(40000);
    view.replaceEditor.setText("green");
    const replacing = await action("lifecycle/start-replacement", () => ({
      promise: view.replaceAll(),
    }));
    await action("lifecycle/cancel-with-new-query", () => search("red"));
    await replacing.promise;
    expect(editor.getText()).toBe(source);
    expect(model.replacing).toBeFalse();
    await action("lifecycle/hide", () => main.findPanel.hide());
    expect(main.findPanel.isVisible()).toBeFalse();
    await action("lifecycle/show", () => main.findPanel.show());
    await action("lifecycle/requery", () => search("blue"));
    const staleModel = model;
    const pending = view.search("absent");
    await action("lifecycle/deactivate-during-search", () =>
      lumine.packages.deactivatePackage("search-panel"),
    );
    await pending;
    expect(staleModel.searchController.signal.aborted).toBeTrue();
    await action("lifecycle/reopen-current-generation", () => openPanel());
    expect(model).not.toBe(staleModel);
    await action("lifecycle/query-after-reopen", () => search("blue"));
    expect(model.getResultCount()).toBe(40000);
    await action("lifecycle/edit-after-reopen", () => editor.getBuffer().insert([0, 0], "blue "));
    await action("lifecycle/query-after-edit", () => search("blue"));
    expect(model.getResultCount()).toBe(40001);
  }, 30000);

  it("searches and replaces sparse matches above the native string limit without flattening the source", async () => {
    let filler = TextBuffer.createTextSnapshot("x".repeat(65536));
    while (filler.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
      filler = filler.replace(filler.length, filler.length, filler);
    const base = TextBuffer.createTextSnapshot("SPARSE😀\n")
      .replace(9, 9, filler)
      .replace(9 + filler.length, 9 + filler.length, "\nSPARSE😀");
    await action("sparse/load-shared-source", () => editor.setText(base));
    editor.getBuffer().clearUndoStack();
    await action("sparse/query", () => search("SPARSE😀"));
    expect(model.getResultCount()).toBe(2);
    await action("sparse/select-near-end", () =>
      editor.setCursorBufferPosition(editor.getBuffer().getEndPosition()),
    );
    await action("sparse/previous", () => view.findPrevious());
    expect(editor.getSelectedText()).toBe("SPARSE😀");
    view.replaceEditor.setText("RESULT😀");
    await action("sparse/replace-all", () => view.replaceAll());
    expect(editor.getBuffer().getTextSnapshot().slice(0, 8)).toBe("RESULT😀");
    const result = editor.getBuffer().getTextSnapshot();
    expect(result.slice(result.length - 8, result.length)).toBe("RESULT😀");
    await action("sparse/undo", () => editor.undo());
    expect(editor.getBuffer().getTextSnapshot().equals(base)).toBeTrue();
    const controller = new AbortController();
    const session = editor.getBuffer().createSearch(/absent/g, { signal: controller.signal });
    const collecting = session.collect();
    await action("sparse/cancel-core-session", () => controller.abort());
    await expectAsync(collecting).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
    await action("sparse/clear-query", () => search(""));
    expect(model.getResultCount()).toBe(0);
    expect(model.markers.length).toBe(0);
    await turn();
  }, 60000);
});
