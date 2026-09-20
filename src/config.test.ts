import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";

test("uses explicit configuration rather than environment variables", () => {
  const config = parseConfig(["--data-dir", "C:/cmh/data", "--host", "0.0.0.0", "--port", "9080"], "C:/ignored");
  assert.equal(config.dataDir.replaceAll("\\", "/"), "C:/cmh/data");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9080);
});
