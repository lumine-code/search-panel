const { Emitter } = require("lumine");

const HISTORY_MAX = 25;

class History {
  constructor(items = [], storage, key) {
    this.storage = storage;
    this.storageKey = key;
    this.items = items;
    this.emitter = new Emitter();
    this.length = this.items.length;
    this.storageSubscription = storage?.observe(key, (stored) => {
      this.items = (Array.isArray(stored) ? stored : [])
        .filter((item) => typeof item === "string")
        .slice(-HISTORY_MAX);
      this.length = this.items.length;
      this.emitter.emit("did-change");
    });
  }

  dispose() {
    this.storageSubscription?.dispose();
    this.emitter.dispose();
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidAddItem(callback) {
    return this.emitter.on("did-add-item", callback);
  }

  getLast() {
    return this.items.at(-1);
  }

  getAtIndex(index) {
    return this.items[index];
  }

  add(text) {
    this.items.push(text);
    this.length = this.items.length;
    this.emitter.emit("did-add-item", text);
    if (this.storage)
      return this.save(
        this.storage.mutate(this.storageKey, (items) =>
          [...(Array.isArray(items) ? items : []), text].slice(-HISTORY_MAX),
        ),
      );
  }

  save(operation) {
    void operation.catch((error) =>
      lumine.notifications.addError("Unable to save search history", {
        detail: error.message,
      }),
    );
    return operation;
  }

  clear() {
    this.items = [];
    this.length = 0;
    this.emitter.emit("did-change");
    if (this.storage) return this.save(this.storage.update(this.storageKey, undefined));
  }
}

// Adds the ability to cycle through history
class HistoryCycler {
  // * `buffer` an {Editor} instance to attach the cycler to
  // * `history` a {History} object
  constructor(buffer, history, { syncBuffer = true } = {}) {
    this.buffer = buffer;
    this.history = history;
    this.index = this.history.length;
    this.scratch = null;

    this.changeSubscription = this.history.onDidChange(() => {
      this.index = this.history.length;
      this.scratch = null;
    });
    this.subscription = this.history.onDidAddItem((text) => {
      if (!syncBuffer) {
        this.index = this.history.length;
        return;
      }
      if (text !== this.buffer.getText()) {
        this.buffer.setText(text);
      }
    });
  }

  dispose() {
    this.subscription.dispose();
    this.changeSubscription.dispose();
  }

  addEditorElement(editorElement) {
    return lumine.commands.add(editorElement, {
      "core:move-up": () => this.previous(),
      "core:move-down": () => this.next(),
    });
  }

  previous() {
    if (
      this.history.length === 0 ||
      (this.atLastItem() && this.buffer.getText() !== this.history.getLast())
    ) {
      this.scratch = this.buffer.getText();
    } else if (this.index > 0) {
      this.index--;
    }

    const item = this.history.getAtIndex(this.index);
    this.buffer.setText(item != null ? item : "");
  }

  next() {
    let item;
    if (this.index < this.history.length - 1) {
      this.index++;
      item = this.history.getAtIndex(this.index);
    } else if (this.scratch) {
      item = this.scratch;
    } else {
      item = "";
    }

    this.buffer.setText(item);
  }

  atLastItem() {
    return this.index === this.history.length - 1;
  }

  store() {
    const text = this.buffer.getText();
    if (!text || text === this.history.getLast()) {
      return;
    }
    this.scratch = null;
    this.history.add(text);
    this.index = this.history.length - 1;
  }
}

module.exports = { History, HistoryCycler };
