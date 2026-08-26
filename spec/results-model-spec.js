const FindOptions = require("../lib/find-options");
const ResultsModel = require("../lib/results-model");
const { Result } = ResultsModel;
const { ResultRowGroup } = require("../lib/result-row");

describe("project search results", () => {
  describe("Result.create", () => {
    it("keeps a multiline match as one occurrence without a phantom final row", () => {
      const result = Result.create({
        filePath: "multi.txt",
        matches: [
          {
            range: [
              [4, 2],
              [6, 0],
            ],
            matchText: "pha\r\nbeta\r\n",
            lineText: "alpha\r\nbeta\r\n",
            leadingContextLines: ["before"],
            trailingContextLines: ["after"],
          },
        ],
      });

      expect(result.matchCount).toBe(1);
      expect(result.matches.length).toBe(2);
      expect(result.matches[0]).toEqual({
        matchText: "pha",
        lineText: "alpha",
        lineTextOffset: 0,
        range: {
          start: { row: 4, column: 2 },
          end: { row: 4, column: 5 },
        },
        leadingContextLines: ["before"],
        trailingContextLines: [],
      });
      expect(result.matches[1]).toEqual({
        matchText: "beta",
        lineText: "beta",
        lineTextOffset: 0,
        range: {
          start: { row: 5, column: 0 },
          end: { row: 5, column: 4 },
        },
        leadingContextLines: [],
        trailingContextLines: ["after"],
      });
    });

    it("retains empty matches and empty lines and supplies empty context arrays", () => {
      const result = Result.create({
        filePath: "empty.txt",
        matches: [
          {
            range: [
              [0, 0],
              [0, 0],
            ],
            matchText: "",
            lineText: "",
          },
        ],
      });

      expect(result.matchCount).toBe(1);
      expect(result.matches.length).toBe(1);
      expect(result.matches[0].matchText).toBe("");
      expect(result.matches[0].lineText).toBe("");
      expect(result.matches[0].leadingContextLines).toEqual([]);
      expect(result.matches[0].trailingContextLines).toEqual([]);
    });

    it("uses occurrence counts in the model and result header instead of display fragments", () => {
      const result = Result.create({
        filePath: "multi.txt",
        matches: [
          {
            range: [
              [0, 0],
              [1, 3],
            ],
            matchText: "one\ntwo",
            lineText: "one\ntwo",
          },
        ],
      });
      const findOptions = new FindOptions();
      const model = new ResultsModel(findOptions);

      model.addResult(result.filePath, result);
      const group = new ResultRowGroup(result, {
        leadingContextLineCount: 0,
        trailingContextLineCount: 0,
      });

      expect(result.matches.length).toBe(2);
      expect(model.getMatchCount()).toBe(1);
      expect(group.data.matchCount).toBe(1);
      model.destroy();
    });
  });

  describe("lifecycle", () => {
    it("cancels an in-progress search without emitting after destruction", async () => {
      const findOptions = new FindOptions();
      findOptions.set({ findPattern: "needle" });
      const model = new ResultsModel(findOptions);
      let resolveSearch;
      const scanPromise = new Promise((resolve) => {
        resolveSearch = resolve;
      });
      scanPromise.cancel = jasmine.createSpy("cancel").and.callFake(() => {
        resolveSearch("cancelled");
      });
      spyOn(lumine.workspace, "scan").and.returnValue(scanPromise);
      const didCancel = jasmine.createSpy("didCancel");
      const didFinish = jasmine.createSpy("didFinish");
      model.onDidCancelSearching(didCancel);
      model.onDidFinishSearching(didFinish);

      const searchPromise = model.search("needle", "", "");
      model.destroy();
      await searchPromise;

      expect(scanPromise.cancel).toHaveBeenCalledTimes(1);
      expect(didCancel).not.toHaveBeenCalled();
      expect(didFinish).not.toHaveBeenCalled();

      model.destroy();
      expect(scanPromise.cancel).toHaveBeenCalledTimes(1);
    });
  });
});
