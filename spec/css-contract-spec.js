const fs = require("fs");
const path = require("path");

describe("Search source-preview CSS roles", () => {
  it("uses the editor's code font while keeping colors on the surrounding UI palette", () => {
    const stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/search-panel.css"), "utf8"),
      { priority: 1000 },
    );
    try {
      const pane = document.createElement("div");
      pane.className = "preview-pane";
      pane.style.fontFamily = "serif";
      pane.style.setProperty("--editor-font-family", "monospace");
      pane.style.setProperty("--text-color-highlight", "rgb(10, 20, 30)");
      pane.style.setProperty("--syntax-text-color", "rgb(230, 240, 250)");
      pane.innerHTML =
        '<div class="results-view"><div class="match-row"><span class="preview">  const answer = 42;</span></div></div>';
      jasmine.attachToDOM(pane);
      const preview = getComputedStyle(pane.querySelector(".preview"));
      expect(preview.fontFamily).toBe("monospace");
      expect(preview.color).toBe("rgb(10, 20, 30)");
    } finally {
      stylesheet.dispose();
    }
  });
});
