# search.control

Drives the find and replace panels from another package: read the options, show or hide the panels, trigger a search, and follow the results.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `2.0.0`                                               |
| Provided by | `provideSearchControl()` returning the control object |
| Consumed by | `consumeSearchControl(search)`                        |
| Owner       | `search-panel` (bundled)                              |

Read-and-drive, not replace: this controls the panels that exist. To make a _different kind of pane item_ searchable, provide [`search.adapter`](search.adapter.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "search.control": {
      "versions": { "^2.0.0": "consumeSearchControl" }
    }
  }
}
```

## Contract

```ts
type SearchControl = {
  // Results
  resultsMarkerLayerForTextEditor(editor: TextEditor): DisplayMarkerLayer;
  getSearchState(): {
    count: number;
    pending: boolean;
    complete: boolean;
    markerCount: number;
    error: Error | null;
  };
  onDidUpdate(callback: (markers: DisplayMarker[]) => void): Disposable;
  onDidChangeCurrentResult(callback: (result: object) => void): Disposable;

  // Options
  getFindOptions(): FindOptions;
  onDidChangeFindOptions(callback: () => void): Disposable;

  // Visibility
  showFind(): void;
  showReplace(): void;
  showProjectFind(): void;
  hideFind(): void;
  hideProjectFind(): void;
  isFindVisible(): boolean;
  isProjectFindVisible(): boolean;
  onDidChangeFindVisibility(callback: (visible: boolean) => void): Disposable;
  onDidChangeProjectFindVisibility(callback: (visible: boolean) => void): Disposable;

  // Triggers
  search(findPattern: string, options?: object): Promise<void>;
  projectSearch(findPattern: string, pathsPattern?: string): void;
};
```

| Group      | Notes                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Results    | `resultsMarkerLayerForTextEditor` gives the live marker layer of the current matches — this is what a scrollbar overview draws.                                     |
| Options    | `getFindOptions()` returns the live options object, including the pattern, regex and case flags, paths filter, `useCoreIgnoredNames`, and `excludeVcsIgnoredPaths`. |
| Visibility | Showing one panel hides the other; `showReplace` opens find with the replace field focused.                                                                         |
| Triggers   | `search` runs a buffer search in the active editor; `projectSearch` sets the pattern and path filter and runs a project search.                                     |

## Minimal example

```js
module.exports = {
  consumeSearchControl(search) {
    return search.onDidUpdate(() => {
      const editor = lumine.workspace.getActiveTextEditor();
      if (!editor) return;
      const layer = search.resultsMarkerLayerForTextEditor(editor);
      this.drawMarkers(layer.getMarkers().map((m) => m.getStartScreenPosition().row));
    });
  },
};
```

## Behavior

**Several members create the panels as a side effect.** `showFind`, `showReplace`, `showProjectFind`, `search`, `projectSearch`, `onDidChangeFindVisibility`, and `onDidChangeProjectFindVisibility` all build the views if they do not exist yet. The `hide*` and `is*Visible` members do not, and answer `false` for a panel that has never been created. Subscribing to a visibility event therefore materialises a panel — prefer `isFindVisible()` when you only want to read.

`resultsMarkerLayerForTextEditor` returns the layer for that editor whether or not a search is running; it is simply empty when there are no matches. The markers are live, so read positions when you need them.

`onDidUpdate` fires when counts or presented markers change, including when results are cleared. Large-buffer searches count all matches asynchronously but keep at most 2,000 viewport markers plus the current match. Marker count is therefore not the total result count. Read `getSearchState()` for the total discovered so far and its `complete` flag; `pending` remains true until counting finishes. `search()` resolves when that query finishes or is superseded; errors are shown by the panel and available in the returned state accessor.

Selection-derived field seeds are limited to 65,536 UTF-16 units. Opening Find or Replace skips multiline or oversized editor selections before reading their text and retains the existing field. Explicit selection-seeding commands report oversized input without truncating it, substituting a word, or running the previous query. Automatic word lookup on a row beyond that budget also reports a limit; selecting a shorter exact fragment still works. Searching within a selected range has no corresponding range-size limit. Select All Occurrences follows the same explicit 2,000-selection limit as the find panel and leaves existing selections unchanged when exceeded.

Project discovery options use backend polarity: `useCoreIgnoredNames` applies both `core.ignoredNames` and the additional `search-panel.ignoredNames`, while `excludeVcsIgnoredPaths` applies repository ignore rules. The panel presents their inverses as independent Include Ignored Names and Include VCS-Ignored Paths buttons for the current search; changing either button does not write configuration.

## Teardown

Every `on*` member returns a `Disposable`; collect them and dispose on teardown. The panels belong to `search-panel` — do not destroy them, and do not assume they are gone after you hide them.

## Versioning

`2.0.0` provided, `^2.0.0` consumed. Version 2 separates complete match counts from bounded viewport markers and adds asynchronous search completion. Version 1's promise of one marker per match is no longer provided. Consumers must request `^2.0.0` and use `getSearchState()` for counts.
