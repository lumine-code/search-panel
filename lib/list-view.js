const etch = require("@lumine-code/etch");
const $ = etch.dom;

module.exports = class ListView {
  constructor({ items, heightForItem, itemComponent, className }) {
    this.items = items;
    this.heightForItem = heightForItem;
    this.itemComponent = itemComponent;
    this.className = className;
    this.previousScrollTop = 0;
    this.previousClientHeight = 0;
    this.rebuildItemOffsets();
    etch.initialize(this);

    this.resizeObserver = null;
    this.resizeObserverWindow = null;
    this.bindResizeObserver();
    this.element.addEventListener("scroll", () => etch.update(this));
  }

  bindResizeObserver() {
    const domWindow = this.element.ownerDocument.defaultView;
    if (!domWindow) throw new Error("A search results list requires a live owner Window");
    if (this.resizeObserver && this.resizeObserverWindow === domWindow) return;

    this.disconnectResizeObserver();
    this.resizeObserverWindow = domWindow;
    this.resizeObserver = new domWindow.ResizeObserver(() => etch.update(this));
    this.resizeObserver.observe(this.element);
  }

  disconnectResizeObserver() {
    try {
      this.resizeObserver?.disconnect();
    } catch {
      // Recovery can begin after the owning native Window has closed.
    }
    this.resizeObserver = null;
    this.resizeObserverWindow = null;
  }

  prepareWindowSurfaceTransition() {
    this.disconnectResizeObserver();
  }

  finishWindowSurfaceTransition() {
    this.bindResizeObserver();
    return etch.update(this);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectResizeObserver();
  }

  update({ items, heightForItem, itemComponent, className } = {}) {
    let geometryChanged = false;
    if (items) {
      this.items = items;
      geometryChanged = true;
    }
    if (heightForItem) {
      this.heightForItem = heightForItem;
      geometryChanged = true;
    }
    if (itemComponent) this.itemComponent = itemComponent;
    if (className) this.className = className;
    if (geometryChanged) this.rebuildItemOffsets();
    return etch.update(this);
  }

  rebuildItemOffsets() {
    this.itemOffsets = new Float64Array(this.items.length + 1);
    for (let i = 0; i < this.items.length; i++) {
      const itemHeight = this.heightForItem(this.items[i], i);
      this.itemOffsets[i + 1] =
        this.itemOffsets[i] + (Number.isFinite(itemHeight) && itemHeight > 0 ? itemHeight : 0);
    }
  }

  firstVisibleItemIndex(scrollTop) {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.itemOffsets[middle + 1] <= scrollTop) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  render() {
    const children = [];
    const totalHeight = this.itemOffsets[this.itemOffsets.length - 1];

    if (this.element) {
      let { scrollTop, clientHeight } = this.element;
      if (clientHeight > 0) {
        this.previousScrollTop = scrollTop;
        this.previousClientHeight = clientHeight;
      } else {
        scrollTop = this.previousScrollTop;
        clientHeight = this.previousClientHeight;
      }

      const scrollBottom = scrollTop + clientHeight;
      let i = this.firstVisibleItemIndex(scrollTop);
      for (; i < this.items.length; i++) {
        const item = this.items[i];
        const itemTopPosition = this.itemOffsets[i];
        const itemHeight = this.itemOffsets[i + 1] - itemTopPosition;
        children.push(
          $.div(
            {
              style: {
                position: "absolute",
                height: `${itemHeight}px`,
                width: "100%",
                top: `${itemTopPosition}px`,
              },
              key: i,
            },
            etch.dom(this.itemComponent, {
              item: item,
              top: Math.max(0, scrollTop - itemTopPosition),
              bottom: Math.min(itemHeight, scrollBottom - itemTopPosition),
            }),
          ),
        );

        if (this.itemOffsets[i + 1] >= scrollBottom) break;
      }
    }

    return $.div(
      {
        className: "results-view-container",
        style: {
          position: "relative",
          height: "100%",
          overflow: "auto",
        },
      },
      $.ol(
        {
          ref: "list",
          className: this.className,
          style: { height: `${totalHeight}px` },
        },
        ...children,
      ),
    );
  }
};
