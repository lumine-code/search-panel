// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript"],
  viewport: { width: 1100, height: 730 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editing/signal.js");
    await lumine.project.setPaths([fixture("editing")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Find occurrences of a symbol in the current file.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(lumine.views.getView(state.editor), "search-panel:show");
          lumine.packages
            .getActivePackage("search-panel")
            .mainModule.findView.findEditor.setText("samples");
        }
      },
      ready() {
        return Boolean(
          document.querySelector(".search-panel-editor")?.innerText.includes("7 results found"),
        );
      },
    },
  ],
  async cleanup() {},
};
