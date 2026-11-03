import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const stylesheet = new URL(
  "../../src/components/page/PokerManagementPage/components/poker-table-map.module.css",
  import.meta.url,
);

test("component CSS modules expose class names through CommonJS loading", () => {
  const styles = createRequire(import.meta.url)(fileURLToPath(stylesheet));
  assert.equal(styles.map, "map");
  assert.equal(styles.arena, "arena");
});

test("component CSS modules expose class names through ESM loading", async () => {
  const { default: styles } = await import(stylesheet.href);
  assert.equal(styles.map, "map");
  assert.equal(styles.arena, "arena");
});
