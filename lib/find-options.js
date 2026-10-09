const { Emitter } = require("lumine");

const Params = [
  "findPattern",
  "replacePattern",
  "pathsPattern",
  "useRegex",
  "wholeWord",
  "caseSensitive",
  "useCoreIgnoredNames",
  "excludeVcsIgnoredPaths",
  "inCurrentSelection",
  "leadingContextLineCount",
  "trailingContextLineCount",
];

const DiscoveryParams = new Set(["useCoreIgnoredNames", "excludeVcsIgnoredPaths"]);
const SerializedParams = Params.filter((param) => !DiscoveryParams.has(param));

module.exports = class FindOptions {
  constructor(state) {
    let left, left1, left2, left3, left4, left5;
    if (state == null) {
      state = {};
    }
    this.emitter = new Emitter();

    this.findPattern = "";
    this.replacePattern = state.replacePattern != null ? state.replacePattern : "";
    this.pathsPattern = state.pathsPattern != null ? state.pathsPattern : "";
    this.useRegex =
      (left =
        state.useRegex != null ? state.useRegex : lumine.config.get("search-panel.useRegex")) !=
      null
        ? left
        : false;
    this.caseSensitive =
      (left1 =
        state.caseSensitive != null
          ? state.caseSensitive
          : lumine.config.get("search-panel.caseSensitive")) != null
        ? left1
        : false;
    this.wholeWord =
      (left2 =
        state.wholeWord != null ? state.wholeWord : lumine.config.get("search-panel.wholeWord")) !=
      null
        ? left2
        : false;
    this.useCoreIgnoredNames = true;
    this.excludeVcsIgnoredPaths = lumine.config.get("core.excludeVcsIgnoredPaths");
    this.inCurrentSelection =
      (left3 =
        state.inCurrentSelection != null
          ? state.inCurrentSelection
          : lumine.config.get("search-panel.inCurrentSelection")) != null
        ? left3
        : false;
    this.leadingContextLineCount =
      (left4 =
        state.leadingContextLineCount != null
          ? state.leadingContextLineCount
          : lumine.config.get("search-panel.leadingContextLineCount")) != null
        ? left4
        : 0;
    this.trailingContextLineCount =
      (left5 =
        state.trailingContextLineCount != null
          ? state.trailingContextLineCount
          : lumine.config.get("search-panel.trailingContextLineCount")) != null
        ? left5
        : 0;
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidChangeUseRegex(callback) {
    return this.emitter.on("did-change-useRegex", callback);
  }

  onDidChangeReplacePattern(callback) {
    return this.emitter.on("did-change-replacePattern", callback);
  }

  serialize() {
    const result = {};
    for (let param of Array.from(SerializedParams)) {
      result[param] = this[param];
    }
    return result;
  }

  set(newParams) {
    if (newParams == null) {
      newParams = {};
    }
    let changedParams = {};
    for (let key of Array.from(Params)) {
      if (newParams[key] != null && newParams[key] !== this[key]) {
        if (changedParams == null) {
          changedParams = {};
        }
        this[key] = changedParams[key] = newParams[key];
      }
    }

    if (Object.keys(changedParams).length) {
      for (let param in changedParams) {
        this.emitter.emit(`did-change-${param}`);
      }
      this.emitter.emit("did-change", changedParams);
    }
    return changedParams;
  }

  getFindPatternRegex(forceUnicode) {
    let expression;
    if (forceUnicode == null) {
      forceUnicode = false;
    }
    for (
      let i = 0, end = this.findPattern.length, asc = 0 <= end;
      asc ? i <= end : i >= end;
      asc ? i++ : i--
    ) {
      if (this.findPattern.charCodeAt(i) > 128) {
        forceUnicode = true;
        break;
      }
    }

    let flags = "gm";
    if (!this.caseSensitive) {
      flags += "i";
    }
    if (forceUnicode) {
      flags += "u";
    }

    if (this.useRegex) {
      expression = this.findPattern;
      expression = normalizeNewlineEscapes(expression);
    } else {
      expression = escapeRegExp(this.findPattern);
    }

    if (this.wholeWord) {
      expression = `\\b(?:${expression})\\b`;
    }

    return new RegExp(expression, flags);
  }
};

// This is different from _.escapeRegExp, which escapes dashes. Escaped dashes
// are not allowed outside of character classes in RegExps with the `u` flag.
//
// See atom/find-and-replace#1022
var escapeRegExp = (string) => string.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");

function normalizeNewlineEscapes(expression) {
  // Consume complete character classes and escape pairs. A literal backslash
  // or a newline inside a class must retain its regular expression meaning.
  return expression.replace(/\[(?:\\[\s\S]|[^\]\\])*\]|\\[\s\S]/g, (token, index) => {
    if (token !== "\\n") return token;
    const prefix = expression.slice(0, index);
    // An explicit CR or optional CR already supplies the line ending policy.
    return /(?:^|[^\\])(?:\\\\)*\\r\??$/.test(prefix) ? token : "(?:\\r?\\n)";
  });
}
