import path from "node:path";

function reject(value, message) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n"]/u.test(value)) throw new Error(message);
  return value;
}

function quote(value, label) {
  const safe = reject(value, `${label} is invalid`);
  if (!path.win32.isAbsolute(safe)) throw new Error(`${label} must be absolute Windows path`);
  return `"${safe}"`;
}

export function createWindowsServiceSpec(input) {
  const serviceName = reject(input.serviceName, "serviceName is invalid");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(serviceName)) throw new Error("serviceName is invalid");
  const displayName = reject(input.displayName, "displayName is invalid");
  const description = reject(input.description, "description is invalid");
  const nodePath = quote(input.nodePath, "nodePath");
  const bundleRootValue = reject(input.bundleRoot, "bundleRoot is invalid");
  if (!path.win32.isAbsolute(bundleRootValue)) throw new Error("bundleRoot must be absolute Windows path");
  const bundleRoot = quote(bundleRootValue, "bundleRoot");
  const dataDir = quote(input.dataDir, "dataDir");
  const configPath = quote(input.configPath, "configPath");
  const cliPath = quote(path.win32.join(bundleRootValue, "dist", "cli.js"), "cliPath");
  const command = `${nodePath} ${cliPath} --config ${configPath} --data-dir ${dataDir} --host 127.0.0.1 --port 8787`;
  return {
    serviceName,
    displayName,
    description,
    command,
    createArguments: ["create", serviceName, `binPath= ${command}`, "start= auto", `DisplayName= ${displayName}`],
    descriptionArguments: ["description", serviceName, description]
  };
}
