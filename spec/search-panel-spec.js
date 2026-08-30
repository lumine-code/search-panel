const fs = require("fs");
const os = require("os");
const path = require("path");
const etch = require("@lumine-code/etch");
const ResultsModel = require("../lib/results-model");
const ResultsPaneView = require("../lib/results-pane");
const { Result } = ResultsModel;

describe("search-panel integration", () => {
  let workspaceElement, editor, mainModule;

  beforeEach(async () => {
    lumine.config.set("core.excludeVcsIgnoredPaths", true);
    workspaceElement = lumine.views.getView(lumine.workspace);
    editor = await lumine.workspace.open();
    editor.setText("one two one\nthree one four\n");

    // search-panel activates on command, so trigger one and await activation.
    const activationPromise = lumine.packages.activatePackage("search-panel");
    lumine.commands.dispatch(workspaceElement, "search-panel:show");
    const pkg = await activationPromise;
    mainModule = pkg.mainModule;
  });

  describe("activation and services", () => {
    it("exposes the search-panel service", () => {
      const service = mainModule.provideSearchControl();
      expect(typeof service.search).toBe("function");
      expect(typeof service.projectSearch).toBe("function");
      expect(typeof service.showFind).toBe("function");
      expect(typeof service.resultsMarkerLayerForTextEditor).toBe("function");
    });

    it("releases detached result models and destroys the remaining models on deactivation", async () => {
      const sharedModel = mainModule.resultsModel;
      const detachedModel = mainModule.createResultsModel(mainModule.findOptions);
      spyOn(sharedModel, "destroy").and.callThrough();
      spyOn(detachedModel, "destroy").and.callThrough();

      mainModule.destroyResultsModel(detachedModel);

      expect(detachedModel.destroy.calls.count()).toBe(1);
      expect(mainModule.resultsModels.has(detachedModel)).toBe(false);

      await lumine.packages.deactivatePackage("search-panel");

      expect(sharedModel.destroy).toHaveBeenCalled();
      expect(detachedModel.destroy.calls.count()).toBe(1);
    });

    it("reattaches a detached results pane to the shared model and its events", async () => {
      mainModule.createProjectFindView();
      const pane = new ResultsPaneView();

      await pane.dontOverrideTab();
      const detachedModel = pane.model;
      const sharedModel = mainModule.projectFindView.model;
      spyOn(detachedModel, "destroy").and.callThrough();

      const firstResult = Result.create({
        filePath: "C:\\project\\first.txt",
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
      });
      sharedModel.addResult(firstResult.filePath, firstResult);

      await pane.dontOverrideTab();

      expect(pane.model).toBe(sharedModel);
      expect(pane.refs.resultsView.model).toBe(sharedModel);
      expect(pane.refs.resultsView.resultRowGroups.map((group) => group.result.filePath)).toEqual([
        firstResult.filePath,
      ]);
      expect(detachedModel.destroy.calls.count()).toBe(1);
      expect(mainModule.resultsModels.has(detachedModel)).toBe(false);

      const secondResult = Result.create({
        filePath: "C:\\project\\second.txt",
        matches: [
          {
            range: [
              [0, 0],
              [0, 3],
            ],
            matchText: "two",
            lineText: "two",
          },
        ],
      });
      sharedModel.addResult(secondResult.filePath, secondResult);
      sharedModel.emitter.emit("did-finish-searching", sharedModel.getResultsSummary());

      expect(pane.refs.resultsView.resultRowGroups.map((group) => group.result.filePath)).toEqual([
        firstResult.filePath,
        secondResult.filePath,
      ]);
      expect(pane.searchResults.matchCount).toBe(2);

      pane.destroy();
      await etch.destroy(pane);
    });

    it("rebinds result viewport observers after moving between Documents", async () => {
      lumine.initializeDetachedPaneSurfaces({ force: true });
      mainModule.createProjectFindView();
      const pane = await lumine.workspace.open(ResultsPaneView.URI, { searchAllPanes: true });
      let detachedPane = null;

      try {
        const primaryResultsObserver = pane.refs.resultsView.resizeObserver;
        const primaryListObserver = pane.refs.resultsView.refs.listView.resizeObserver;
        spyOn(primaryResultsObserver, "disconnect").and.callThrough();
        spyOn(primaryListObserver, "disconnect").and.callThrough();

        detachedPane = await lumine.workspace.detachPaneItem(pane, { show: false });
        const detachedSurface = lumine.workspace.getWindowSurface(pane);

        expect(pane.element.ownerDocument).toBe(detachedSurface.document);
        expect(
          pane.refs.resultsView.resizeObserver instanceof detachedSurface.window.ResizeObserver,
        ).toBe(true);
        expect(
          pane.refs.resultsView.refs.listView.resizeObserver instanceof
            detachedSurface.window.ResizeObserver,
        ).toBe(true);
        expect(primaryResultsObserver.disconnect).toHaveBeenCalledTimes(1);
        expect(primaryListObserver.disconnect).toHaveBeenCalledTimes(1);

        const detachedResultsObserver = pane.refs.resultsView.resizeObserver;
        const detachedListObserver = pane.refs.resultsView.refs.listView.resizeObserver;
        spyOn(detachedResultsObserver, "disconnect").and.callThrough();
        spyOn(detachedListObserver, "disconnect").and.callThrough();

        await lumine.workspace.attachDetachedPane(detachedPane);
        detachedPane = null;

        expect(pane.refs.resultsView.resizeObserver instanceof ResizeObserver).toBe(true);
        expect(pane.refs.resultsView.refs.listView.resizeObserver instanceof ResizeObserver).toBe(
          true,
        );
        expect(detachedResultsObserver.disconnect).toHaveBeenCalledTimes(1);
        expect(detachedListObserver.disconnect).toHaveBeenCalledTimes(1);
      } finally {
        if (detachedPane?.isAlive?.()) await lumine.workspace.attachDetachedPane(detachedPane);
        const ownerPane = lumine.workspace.paneForItem(pane);
        if (ownerPane) await ownerPane.destroyItem(pane, true);
        lumine.initializeDetachedPaneSurfaces();
      }
    });
  });

  describe("the buffer find panel", () => {
    it("shows and hides with the toggle command", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      expect(mainModule.findPanel.isVisible()).toBe(true);
      expect(workspaceElement.querySelector(".search-panel")).toExist();

      lumine.commands.dispatch(workspaceElement, "search-panel:toggle");
      expect(mainModule.findPanel.isVisible()).toBe(false);
    });

    it("selects the next match found for the typed pattern", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      lumine.commands.dispatch(workspaceElement, "search-panel:find-next");

      expect(mainModule.findModel.markers.length).toBe(3);
      expect(editor.getSelectedText()).toBe("one");
    });

    it("replaces the current match in place", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("two");
      mainModule.findView.replaceEditor.setText("2");
      lumine.commands.dispatch(workspaceElement, "search-panel:find-next");
      lumine.commands.dispatch(workspaceElement, "search-panel:replace-current");

      expect(editor.getText()).toContain("2");
      expect(editor.getText()).not.toContain("two");
    });

    // A pattern with several matches, so the move after the replacement has
    // somewhere to land: navigate() beeps out early once the last result is
    // gone, and would leave focus wherever it already was.
    jasmine.itWithDocumentFocus("replaces without pulling focus out of the editor", () => {
      jasmine.attachToDOM(workspaceElement);
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      mainModule.findView.replaceEditor.setText("1");
      editor.element.focus();

      lumine.commands.dispatch(editor.element, "search-panel:replace-next");

      expect(editor.getText()).toContain("1");
      expect(mainModule.findView.element.contains(document.activeElement)).toBe(false);
    });

    jasmine.itWithDocumentFocus("keeps focus in the replace field when confirming from it", () => {
      jasmine.attachToDOM(workspaceElement);
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      mainModule.findView.replaceEditor.setText("1");
      mainModule.findView.replaceEditor.element.focus();

      lumine.commands.dispatch(mainModule.findView.replaceEditor.element, "core:confirm");

      expect(editor.getText()).toContain("1");
      expect(mainModule.findView.replaceEditor.element).toHaveFocus();
    });

    it("replaces every match", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      mainModule.findView.replaceEditor.setText("1");
      lumine.commands.dispatch(workspaceElement, "search-panel:replace-all");

      expect(editor.getText()).not.toContain("one");
      expect((editor.getText().match(/1/g) || []).length).toBe(3);
    });

    jasmine.itWithDocumentFocus("clears the search fields without focusing the panel", () => {
      const outsideElement = document.createElement("button");
      jasmine.attachToDOM(outsideElement);
      mainModule.findView.findEditor.setText("one");
      mainModule.findView.replaceEditor.setText("1");
      outsideElement.focus();

      lumine.commands.dispatch(workspaceElement, "search-panel:clear");

      expect(mainModule.findView.findEditor.getText()).toBe("");
      expect(mainModule.findView.replaceEditor.getText()).toBe("");
      expect(outsideElement).toHaveFocus();
    });
  });

  describe("the project find panel", () => {
    it("searches and replaces project files on disk while preserving a dirty buffer", async () => {
      const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "search-panel-replace-"));
      const openPath = path.join(projectDirectory, "open.txt");
      const closedPath = path.join(projectDirectory, "closed.txt");
      const openDiskText = "alpha beta disk";
      const openBufferText = "dirty buffer without matches";
      fs.writeFileSync(openPath, openDiskText);
      fs.writeFileSync(closedPath, "alpha beta disk");
      let projectEditor;

      try {
        lumine.project.setPaths([projectDirectory]);
        projectEditor = await lumine.workspace.open(openPath);
        projectEditor.setText(openBufferText);

        const model = mainModule.resultsModel;
        await model.search("\\b(alpha|beta)\\b", "", "x$1x", {
          useRegex: true,
          caseSensitive: true,
        });

        expect(model.getPathCount()).toBe(2);
        expect(model.getMatchCount()).toBe(4);

        await model.replace("", "x$1x", model.getPaths());

        const summary = model.getResultsSummary();
        expect(summary.replacedPathCount).toBe(2);
        expect(summary.replacementCount).toBe(4);
        expect(summary.matchCount).toBe(0);
        expect(projectEditor.getText()).toBe(openBufferText);
        expect(projectEditor.getFileState()).toBe("modified");
        expect(fs.readFileSync(openPath, "utf8")).toBe("xalphax xbetax disk");
        expect(fs.readFileSync(closedPath, "utf8")).toBe("xalphax xbetax disk");
      } finally {
        projectEditor?.destroy();
        lumine.project.setPaths([]);
        fs.rmSync(projectDirectory, { recursive: true, force: true });
      }
    });

    it("does not show the buffer panel when its command activates the package", async () => {
      await lumine.packages.deactivatePackage("search-panel");

      const activationPromise = lumine.packages.activatePackage("search-panel");
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      const pkg = await activationPromise;
      mainModule = pkg.mainModule;

      // The marker layer's visibility subscription creates the buffer panel at
      // activation, so existence is no longer the tell — visibility is.
      expect(mainModule.findPanel.isVisible()).toBe(false);
      expect(mainModule.projectFindPanel.isVisible()).toBe(true);
    });

    it("shows with the project-show command", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      expect(mainModule.projectFindPanel.isVisible()).toBe(true);
      expect(workspaceElement.querySelector(".search-panel-project")).toExist();
    });

    it("orders search options by regex engine, case, and word matching", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");

      const optionClasses = Array.from(
        workspaceElement.querySelectorAll(".search-panel-project .btn-group-options > .btn"),
      ).map((button) => button.classList[1]);

      expect(optionClasses).toEqual([
        "option-regex",
        "option-pcre2",
        "option-case-sensitive",
        "option-whole-word",
        "option-include-ignored-names",
        "option-include-vcs-ignored-paths",
      ]);
    });

    it("includes ignored names only for the current search when selected", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      const button = workspaceElement.querySelector(".option-include-ignored-names");

      expect(mainModule.resultsModel.getFindOptions().useCoreIgnoredNames).toBe(true);
      expect(button.classList.contains("selected")).toBe(false);

      button.click();

      expect(lumine.config.get("search-panel.ignoredNames")).toEqual([]);
      expect(mainModule.resultsModel.getFindOptions().useCoreIgnoredNames).toBe(false);
      expect(button.classList.contains("selected")).toBe(true);
    });

    it("includes VCS-ignored files only for the current search when selected", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      const button = workspaceElement.querySelector(".option-include-vcs-ignored-paths");

      expect(mainModule.resultsModel.getFindOptions().excludeVcsIgnoredPaths).toBe(true);
      expect(button.classList.contains("selected")).toBe(false);

      button.click();

      expect(lumine.config.get("core.excludeVcsIgnoredPaths")).toBe(true);
      expect(mainModule.resultsModel.getFindOptions().excludeVcsIgnoredPaths).toBe(false);
      expect(button.classList.contains("selected")).toBe(true);
    });

    it("updates the option when the core VCS ignore preference changes", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      const button = workspaceElement.querySelector(".option-include-vcs-ignored-paths");

      lumine.config.set("core.excludeVcsIgnoredPaths", false);

      expect(mainModule.resultsModel.getFindOptions().excludeVcsIgnoredPaths).toBe(false);
      expect(button.classList.contains("selected")).toBe(true);
    });

    jasmine.itWithDocumentFocus("clears the search fields without focusing the panel", () => {
      const outsideElement = document.createElement("button");
      jasmine.attachToDOM(outsideElement);
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      mainModule.projectFindView.findEditor.setText("one");
      mainModule.projectFindView.replaceEditor.setText("1");
      mainModule.projectFindView.pathsEditor.setText("src");
      outsideElement.focus();

      lumine.commands.dispatch(workspaceElement, "search-panel:clear");

      expect(mainModule.projectFindView.findEditor.getText()).toBe("");
      expect(mainModule.projectFindView.replaceEditor.getText()).toBe("");
      expect(mainModule.projectFindView.pathsEditor.getText()).toBe("");
      expect(outsideElement).toHaveFocus();
    });
  });
});
