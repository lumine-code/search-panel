# search.adapter

Makes a pane item that is not a `TextEditor` searchable with the ordinary find panel — a notebook, a data grid, a rendered preview.

|             |                                                          |
| ----------- | -------------------------------------------------------- |
| Version     | `1.0.0`                                                  |
| Provided by | `provideSearchAdapter()` returning an adapter factory    |
| Consumed by | `consumeSearchAdapter(service)` returning a `Disposable` |
| Owner       | `search-panel` (bundled)                                 |

The find panel normally binds to the active text editor. An adapter lets your item take that slot instead: the panel's UI, options, and commands stay exactly as the user knows them, and your item answers the search.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "search.adapter": {
      "versions": { "1.0.0": "provideSearchAdapter" }
    }
  }
}
```

## Contract

The service is a **factory**, asked which item it handles; the adapter it returns is what does the work.

```ts
type SearchAdapterService = {
  handlesItem(paneItem: object): boolean;
  canReplaceItem?(paneItem: object): boolean;
  getAdapterForItem(paneItem: object): SearchAdapter | null;
};
```

Both `handlesItem` and `getAdapterForItem` are required. The former declares which items the service can search; the latter creates or returns the adapter for that exact item when a search needs it. A service with missing methods is rejected when consumed.

`handlesItem` and optional `canReplaceItem` are passive capability predicates: return a strict Boolean synchronously from cached item metadata without creating an adapter, initializing a runtime, reading files, or scanning text. Non-Boolean answers are rejected. They let command availability work before the first search. A handled item supports replacement before adapter creation only when `canReplaceItem(item)` returns `true`; after creation, the adapter's `canReplace` flag applies.

The adapter itself. These are required:

| Member                                             | Description                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `search(findOptions)`                              | Runs a search. Read the pattern and flags off the options object. |
| `getResultCount()`                                 | How many matches the last search found.                           |
| `getCurrentResultIndex()`                          | Which one is current, for the "3 of 17" counter.                  |
| `selectNext(options?)`, `selectPrevious(options?)` | Move the current match with the requested scroll mode.            |
| `onDidUpdate(callback)`                            | Fires when the result set changes.                                |
| `onDidChangeCurrentResult(callback)`               | Fires when the current match moves.                               |

And these are optional, each with a defined fallback:

| Member                                                     | Fallback when absent                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `canReplace`                                               | Replace is disabled.                                     |
| `replaceCurrentMatch(text, direction)`, `replaceAll(text)` | Only called when `canReplace` is truthy.                 |
| `selectFirstFromCursor(options?)`                          | Falls back to `selectNext(options)`.                     |
| `selectAll(options?)`                                      | Select-all does nothing.                                 |
| `hasSelectionMatchingResult()`                             | Treated as `false`.                                      |
| `isSelectionEmpty()`                                       | Treated as `true`.                                       |
| `getSelectedText()`, `getWordUnderCursor()`                | Empty string — so "use selection for find" does nothing. |
| `getWrapIconHost()`                                        | No wrap indicator is shown.                              |
| `onDidError(callback)`                                     | Errors are not surfaced.                                 |
| `deactivate()`                                             | Nothing is torn down when focus leaves your item.        |
| `refresh()`                                                | Not called.                                              |

Navigation options use the editor's scroll modes:

```ts
type SearchNavigationOptions = {
  mode?: "nearest" | "zone" | "center" | number | [number, number];
};
```

The panel requests `zone` for explicit result navigation and `nearest` while the user types a live query. An adapter should reveal the current result with that mode; `zone` follows `editor.scrollZone`, and omitted options default to `zone`. Numeric modes specify a viewport percentage or a pair of percentages using the same semantics as the text editor's scrolling API. The options belong to the navigation call and are never stored in `findOptions`.

## Minimal example

```js
module.exports = {
  provideSearchAdapter() {
    return {
      handlesItem: (paneItem) => paneItem instanceof MyGridView,
      getAdapterForItem: (paneItem) => paneItem.getSearchAdapter(),
    };
  },
};
```

with the adapter on your view:

```js
getSearchAdapter() {
  return {
    canReplace: false,
    search: (findOptions) => this.runSearch(findOptions.findPattern, findOptions),
    getResultCount: () => this.matches.length,
    getCurrentResultIndex: () => this.currentIndex,
    selectNext: (options) => this.step(+1, options),
    selectPrevious: (options) => this.step(-1, options),
    onDidUpdate: (callback) => this.emitter.on("did-update-matches", callback),
    onDidChangeCurrentResult: (callback) => this.emitter.on("did-change-current", callback),
  };
}
```

## Behavior

Registered services are consulted **in registration order**. Only services whose `handlesItem(item)` returns `true` are asked for an adapter, and the first adapter returned wins. Availability queries use the same passive matching without calling any adapter factory.

The panel re-resolves the adapter on every active-pane-item change, and registering or unregistering a service re-resolves immediately — so an adapter that becomes available later takes over the currently focused item without the user doing anything.

When an adapter is active the panel detaches from any text editor entirely, so your adapter is the only thing answering. `deactivate()` is your signal that focus has moved on.

`search` is called with the panel's live `findOptions`, not a plain string: read `findPattern` plus the case, regex, and whole-word flags from it so your results match what the checkboxes say.

## Teardown

`consumeSearchAdapter` returns a `Disposable` that unregisters the service and re-resolves the active item. Your adapter's own `deactivate()` is called when the panel switches away from your item, which is where per-item highlight state should be cleared.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
