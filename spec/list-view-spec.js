const etch = require("@lumine-code/etch");
const ListView = require("../lib/list-view");
const ResultsView = require("../lib/results-view");
const $ = etch.dom;

class ItemView {
  constructor({ item }) {
    this.item = item;
    etch.initialize(this);
  }

  update({ item }) {
    this.item = item;
    return etch.update(this);
  }

  destroy() {
    return etch.destroy(this);
  }

  render() {
    return $.li({}, this.item.name);
  }
}

describe("ListView", () => {
  let listView;

  afterEach(async () => {
    if (listView) await listView.destroy();
  });

  it("uses cached offsets to render only the visible rows while scrolling", async () => {
    const items = [
      { name: "a", height: 10 },
      { name: "b", height: 20 },
      { name: "c", height: 30 },
      { name: "d", height: 40 },
    ];
    const heightForItem = jasmine.createSpy("heightForItem").and.callFake((item) => item.height);
    listView = new ListView({
      items,
      heightForItem,
      itemComponent: ItemView,
      className: "items",
    });
    Object.defineProperties(listView.element, {
      clientHeight: { value: 25 },
      scrollTop: { value: 10, writable: true },
    });
    jasmine.attachToDOM(listView.element);

    heightForItem.calls.reset();
    listView.element.dispatchEvent(new UIEvent("scroll"));
    await etch.update(listView);

    expect(heightForItem).not.toHaveBeenCalled();
    expect(Array.from(listView.refs.list.children, (element) => element.textContent)).toEqual([
      "b",
      "c",
    ]);
    expect(listView.refs.list.style.height).toBe("100px");
  });

  it("rebuilds cached offsets when its items change", async () => {
    const heightForItem = jasmine.createSpy("heightForItem").and.callFake((item) => item.height);
    listView = new ListView({
      items: [{ name: "a", height: 10 }],
      heightForItem,
      itemComponent: ItemView,
      className: "items",
    });
    heightForItem.calls.reset();

    await listView.update({
      items: [
        { name: "b", height: 20 },
        { name: "c", height: 30 },
      ],
      heightForItem,
      itemComponent: ItemView,
      className: "items",
    });

    expect(heightForItem.calls.count()).toBe(2);
    expect(listView.refs.list.style.height).toBe("50px");
  });

  it("reveals a bottom result above the horizontal overlay without changing row offsets", () => {
    listView = new ListView({
      items: [{ name: "last", height: 100 }],
      heightForItem: (item) => item.height,
      itemComponent: ItemView,
      className: "items",
    });
    listView.scrollbarGeometry = { viewportHeight: 100, scrollEndInset: 10 };
    const view = Object.create(ResultsView.prototype);
    Object.assign(view, {
      refs: { listView },
      selectedRowIndex: 0,
      positionOfSelectedResult: () => 80,
      getRowHeight: () => 20,
      selectedRow: () => ({}),
      getScrollTop: () => 0,
      setScrollTop: jasmine.createSpy("setScrollTop"),
    });
    view.scrollToSelectedMatch();
    expect(view.setScrollTop).toHaveBeenCalledWith(10);
    expect(listView.refs.list.style.height).toBe("100px");
    listView.scrollbarGeometry = { viewportHeight: 100, scrollEndInset: 0 };
    view.setScrollTop.calls.reset();
    view.scrollToSelectedMatch();
    expect(view.setScrollTop).not.toHaveBeenCalled();
  });
});
