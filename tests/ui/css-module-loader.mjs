import { readFile } from "node:fs/promises";

export function cssModuleClasses(css) {
  return Object.fromEntries(
    [...css.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g)].map((match) => [
      match[1],
      match[1],
    ]),
  );
}

// JSDOM exercises the real component behavior; it does not evaluate CSS layout.
export async function load(url, context, nextLoad) {
  if (
    url.startsWith("file:") &&
    new URL(url).pathname.endsWith(".module.css")
  ) {
    const css = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(cssModuleClasses(css))};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
