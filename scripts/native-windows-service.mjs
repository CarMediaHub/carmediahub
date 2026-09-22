import path from "node:path";

function reject(value, message) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n"]/u.test(value)) throw new Error(message);
  return value;
}

function quote(value, label) {
  const safe = reject(value, `${label} is invalid`);
  if (!path.isAbsolute(safe)) throw new Error(`${label} must be absolute`);
  return `"${safe}"`;
}

export function createWindowsServiceSpec(input) {
  const serviceName = reject(input.serviceName, "serviceName is invalid");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(serviceName)) throw new Error("serviceName is invalid");
  const displayName = reject(input.displayName, "displayName is invalid");
  const description = reject(input.description, "description is invalid");
  const nodePath = quote(input.nodePath, "nodePath");
  const bundleRoot = quote(input.bundleRoot, "bundleRoot");
  const dataDir = quote(input.dataDir, "dataDir");
  const configPath = quote(input.configPath, "configPath");
  const cliPath = `${bundleRoot.slice(0, -1)}\\dist\\cli.js"`;
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
