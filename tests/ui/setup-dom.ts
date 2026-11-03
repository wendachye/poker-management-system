import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { cssModuleClasses } from "./css-module-loader.mjs";

register(new URL("./css-module-loader.mjs", import.meta.url));
// Node22/tsx can load components through CommonJS, which bypasses the async
// ESM hook. Keep both paths on the same class map without evaluating CSS.
const require = createRequire(import.meta.url);
const previousCssLoader =
  require.extensions[".css"] ?? require.extensions[".js"];
require.extensions[".css"] = (module, filename) => {
  if (!filename.endsWith(".module.css"))
    return previousCssLoader(module, filename);
  module.exports = cssModuleClasses(readFileSync(filename, "utf8"));
};

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
// Keep animations inactive while retaining the browser media-query API.
dom.window.matchMedia = (media: string): MediaQueryList => ({
  media,
  matches: media.includes("prefers-reduced-motion: reduce"),
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
Object.defineProperty(dom.window.document, "fonts", {
  configurable: true,
  value: { ready: Promise.resolve() },
});
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
