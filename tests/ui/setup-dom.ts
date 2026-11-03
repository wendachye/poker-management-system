import { JSDOM } from "jsdom";

// Component tests use a DOM, not a running browser or the operations database.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/en/players",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "Document",
  "DocumentFragment",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "MutationObserver",
  "DOMRect",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: dom.window[key],
  });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  writable: true,
  configurable: true,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
);
class PointerEvent extends dom.window.MouseEvent {
  pointerId = 1;
  pointerType = "mouse";
  isPrimary = true;
}
Object.defineProperty(globalThis, "PointerEvent", {
  value: PointerEvent,
  configurable: true,
});
Object.defineProperty(dom.window, "PointerEvent", {
  value: PointerEvent,
  configurable: true,
});
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserver;
dom.window.ResizeObserver = ResizeObserver;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
