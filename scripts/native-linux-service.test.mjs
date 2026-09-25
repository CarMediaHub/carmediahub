import assert from "node:assert/strict";
import test from "node:test";
import { createLinuxServiceSpec } from "./native-linux-service.mjs";

const valid = { serviceName: "carmediahub-core", description: "CarMediaHub Core service", nodePath: "/opt/carmediahub/runtime/node", bundleRoot: "/opt/carmediahub", dataDir: "/var/lib/carmediahub", configPath: "/etc/carmediahub/core.json" };

test("creates a hardened explicit systemd unit", () => {
  const spec = createLinuxServiceSpec(valid);
  assert.equal(spec.unitName, "carmediahub-core.service");
  assert.match(spec.unitText, /ExecStart=.*dist\/cli\.js.*--config.*--data-dir/iu);
  assert.match(spec.unitText, /NoNewPrivileges=true/iu);
  assert.match(spec.unitText, /User=carmediahub/iu);
  assert.match(spec.unitText, /Group=carmediahub/iu);
  assert.match(spec.unitText, /ProtectSystem=strict/iu);
  assert.match(spec.unitText, /ReadWritePaths=\/var\/lib\/carmediahub/u);
  assert.doesNotMatch(spec.unitText, /Environment=/u);
});

test("quotes paths and rejects implicit or unsafe values", () => {
  const spec = createLinuxServiceSpec({ ...valid, bundleRoot: "/opt/car media", description: "Core $service" });
  assert.match(spec.unitText, /WorkingDirectory=\/opt\/car\\x20media/u);
  assert.match(spec.unitText, /Core \$service/u);
  assert.throws(() => createLinuxServiceSpec({ ...valid, nodePath: "node" }), /nodePath.*absolute POSIX/);
  assert.throws(() => createLinuxServiceSpec({ ...valid, serviceName: "Core.Service" }), /serviceName/);
  assert.throws(() => createLinuxServiceSpec({ ...valid, description: "bad\nunit" }), /description/);
});
