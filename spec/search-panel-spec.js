const fs = require("fs");
const os = require("os");
const path = require("path");
const etch = require("@lumine-code/etch");
const ResultsModel = require("../lib/results-model");
const { Result } = ResultsModel;

describe("search-panel integration", () => {
  let workspaceElement, editor, mainModule;

  beforeEach(async () => {
    lumine.config.set("core.excludeVcsIgnoredPaths", true);
    workspaceElement = lumine.views.getView(lumine.workspace);
    editor = await lumine.workspace.open();
    editor.setText("one two one\nthree one four\n");

    await lumine.packages.activatePackage("language-regex");
    await lumine.packages.activatePackage("language-text");

    // search-panel activates on command, so trigger one and await activation.
    const activationPromise = lumine.packages.activatePackage("search-panel");
    lumine.commands.dispatch(workspaceElement, "search-panel:show");
    const pkg = await activationPromise;
    mainModule = pkg.mainModule;
  });

  describe("activation and services", () => {
    it("registers search fields as inputs until deactivation", async () => {
      const searchEditors = [mainModule.findView.findEditor, mainModule.findView.replaceEditor];
      mainModule.createProjectFindView();
      searchEditors.push(
        mainModule.projectFindView.findEditor,
        mainModule.projectFindView.replaceEditor,
        mainModule.projectFindView.pathsEditor,
      );

      for (const searchEditor of searchEditors) {
        expect(lumine.textEditors.roleFor(searchEditor)).toBe("input");
      }

      await lumine.packages.deactivatePackage("search-panel");

      for (const searchEditor of searchEditors) {
        expect(lumine.textEditors.roleFor(searchEditor)).toBeNull();
      }
    });

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
      const ResultsPaneView = require("../lib/results-pane");
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
  });

  describe("the buffer find panel", () => {
    it("uses Tree-sitter grammars for regex patterns and replacements", () => {
      mainModule.findOptions.set({ useRegex: true });

      const findGrammar = mainModule.findView.findEditor.getGrammar();
      const replaceGrammar = mainModule.findView.replaceEditor.getGrammar();
      expect(findGrammar.scopeName).toBe("source.regexp");
      expect(findGrammar.constructor.name).toBe("TreeSitterGrammar");
      expect(replaceGrammar.scopeName).toBe("source.regexp.replacement");
      expect(replaceGrammar.constructor.name).toBe("TreeSitterGrammar");

      mainModule.findOptions.set({ useRegex: false });
      expect(mainModule.findView.findEditor.getGrammar().scopeName).toBe("text.plain");
      expect(mainModule.findView.replaceEditor.getGrammar().scopeName).toBe("text.plain");
    });

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

    it("routes selection commands through the active find view", () => {
      editor.setSelectedBufferRange([
        [0, 4],
        [0, 7],
      ]);

      lumine.commands.dispatch(workspaceElement, "search-panel:use-selection-as-find-pattern");

      expect(mainModule.findView.findEditor.getText()).toBe("two");
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
      const clear = spyOn(mainModule.findView, "clear").and.callThrough();

      lumine.commands.dispatch(mainModule.findView.element, "search-panel:clear");

      expect(clear).toHaveBeenCalledTimes(1);
      expect(mainModule.findView.findEditor.getText()).toBe("");
      expect(mainModule.findView.replaceEditor.getText()).toBe("");
      expect(outsideElement).toHaveFocus();
    });
  });

  describe("the project find panel", () => {
    it("uses Tree-sitter grammars for project regex patterns and replacements", () => {
      mainModule.createProjectFindView();
      mainModule.findOptions.set({ useRegex: true });

      const findGrammar = mainModule.projectFindView.findEditor.getGrammar();
      const replaceGrammar = mainModule.projectFindView.replaceEditor.getGrammar();
      expect(findGrammar.scopeName).toBe("source.regexp");
      expect(findGrammar.constructor.name).toBe("TreeSitterGrammar");
      expect(replaceGrammar.scopeName).toBe("source.regexp.replacement");
      expect(replaceGrammar.constructor.name).toBe("TreeSitterGrammar");
    });

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
      const dispatchPromise = lumine.commands.dispatch(
        workspaceElement,
        "search-panel:project-show",
      );
      const [pkg] = await Promise.all([activationPromise, dispatchPromise]);
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

    it("routes selection commands through the visible project view", () => {
      lumine.commands.dispatch(workspaceElement, "search-panel:project-show");
      editor.setSelectedBufferRange([
        [0, 4],
        [0, 7],
      ]);

      lumine.commands.dispatch(workspaceElement, "search-panel:use-selection-as-find-pattern");

      expect(mainModule.projectFindView.findEditor.getText()).toBe("two");
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
      const clear = spyOn(mainModule.projectFindView, "clear").and.callThrough();

      lumine.commands.dispatch(mainModule.projectFindView.element, "search-panel:clear");

      expect(clear).toHaveBeenCalledTimes(1);
      expect(mainModule.projectFindView.findEditor.getText()).toBe("");
      expect(mainModule.projectFindView.replaceEditor.getText()).toBe("");
      expect(mainModule.projectFindView.pathsEditor.getText()).toBe("");
      expect(outsideElement).toHaveFocus();
    });
  });

  describe("command lifecycle", () => {
    it("owns exactly one results opener across deactivation and reactivation", async () => {
      const activeCount = lumine.workspace.getOpeners().length;

      await lumine.packages.deactivatePackage("search-panel");
      expect(lumine.workspace.getOpeners().length).toBe(activeCount - 1);

      await lumine.packages.activatePackage("search-panel");
      expect(lumine.workspace.getOpeners().length).toBe(activeCount);

      await lumine.packages.deactivatePackage("search-panel");
      await lumine.packages.activatePackage("search-panel");
      expect(lumine.workspace.getOpeners().length).toBe(activeCount);
    });

    it("runs the first find command and restores cold wrappers after reactivation", async () => {
      const createFindView = spyOn(mainModule, "createFindView").and.callThrough();
      const findNext = spyOn(
        mainModule.findView.constructor.prototype,
        "findNext",
      ).and.callThrough();
      const replaceNext = spyOn(
        mainModule.findView.constructor.prototype,
        "replaceNext",
      ).and.callThrough();

      await lumine.packages.deactivatePackage("search-panel");
      await lumine.packages.startPackage("search-panel");
      expect(lumine.packages.getPackageLifecycleState("search-panel")).toBe("active");
      createFindView.calls.reset();

      const hasCommand = (name) =>
        lumine.commands
          .findCommands({ target: workspaceElement })
          .some(({ name: commandName }) => commandName === name);

      await lumine.commands.dispatch(workspaceElement, "search-panel:find-next");
      expect(lumine.packages.getPackageLifecycleState("search-panel")).toBe("active");
      expect(hasCommand("search-panel:find-next")).toBe(true);
      expect(mainModule.findView).not.toBeNull();
      expect(createFindView).toHaveBeenCalled();
      expect(findNext).toHaveBeenCalledTimes(1);

      await lumine.packages.deactivatePackage("search-panel");
      expect(hasCommand("search-panel:find-next")).toBe(false);
      await lumine.packages.startPackage("search-panel");
      createFindView.calls.reset();

      await lumine.commands.dispatch(workspaceElement, "search-panel:replace-next");
      expect(lumine.packages.getPackageLifecycleState("search-panel")).toBe("active");
      expect(hasCommand("search-panel:replace-next")).toBe(true);
      expect(mainModule.findView).not.toBeNull();
      expect(createFindView).toHaveBeenCalled();
      expect(replaceNext).toHaveBeenCalledTimes(1);
    });
  });
});
