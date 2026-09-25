import path from "node:path";

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function absolute(value, label) {
  const safe = text(value, label);
  if (!path.posix.isAbsolute(safe)) throw new Error(`${label} must be an absolute POSIX path`);
  return safe;
}

function unitQuote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function unitPath(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20").replaceAll("\t", "\\x09").replaceAll("\n", "\\x0a").replaceAll('"', "\\x22");
}

export function createLinuxServiceSpec(input) {
  const serviceName = text(input.serviceName, "serviceName");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(serviceName)) throw new Error("serviceName is invalid");
  const description = text(input.description, "description");
  const serviceAccount = text(input.serviceAccount ?? "carmediahub", "serviceAccount");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(serviceAccount)) throw new Error("serviceAccount is invalid");
  const nodePath = absolute(input.nodePath, "nodePath");
  const bundleRoot = absolute(input.bundleRoot, "bundleRoot");
  const dataDir = absolute(input.dataDir, "dataDir");
  const configPath = absolute(input.configPath, "configPath");
  const cliPath = path.posix.join(bundleRoot, "dist", "cli.js");
  const unitName = `${serviceName}.service`;
  const unitText = [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${serviceAccount}`,
    `Group=${serviceAccount}`,
    `WorkingDirectory=${unitPath(bundleRoot)}`,
    `ExecStart=${unitQuote(nodePath)} ${unitQuote(cliPath)} --config ${unitQuote(configPath)} --data-dir ${unitQuote(dataDir)} --host 127.0.0.1 --port 8787`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadWritePaths=${unitPath(dataDir)}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
  return { serviceName, unitName, serviceAccount, unitText };
}
