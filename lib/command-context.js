const path = require("node:path");

function directoryPathForEvent(event) {
  const target = event?.target;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const directory = element?.closest?.(".directory");
  if (directory)
    return directory.dataset.path ?? directory.querySelector("[data-path]")?.dataset.path;
  let editor = lumine.workspace.getTextEditorForElement(target, { includeMini: false });
  if (editor && lumine.textEditors.roleFor(editor) === "fragment") editor = null;
  editor ??= event?.context
    ? (event.context.fileEditor ?? event.context.editor)
    : lumine.workspace.getWindowForElement(target)?.getEditorContainer().getActiveFileTextEditor();
  const filePath = editor?.getPath?.();
  return filePath ? path.dirname(filePath) : null;
}

module.exports = { directoryPathForEvent };
