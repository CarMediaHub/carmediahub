import path from "node:path";

function fail(message) { throw new Error(`Native install actions failed: ${message}`); }

function absolute(value, platform, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) fail(`${label} is invalid`);
  const valid = platform === "windows" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
  if (!valid) fail(`${label} must be absolute`);
  return value;
}

function action(command, args, description, stdin, idempotency = "repeatable") {
  const metadata = { idempotency };
  return stdin === undefined ? { command, args, description, ...metadata } : { command, args, description, stdin, ...metadata };
}

export function createNativeInstallActions(plan) {
  if (plan?.platform !== "windows" && plan?.platform !== "linux") fail("platform is invalid");
  const platform = plan.platform;
  const bundleRoot = absolute(plan.resources?.bundleRoot, platform, "bundleRoot");
  const configPath = absolute(plan.resources?.configPath, platform, "configPath");
  const dataDir = absolute(plan.resources?.dataDir, platform, "dataDir");
  const account = plan.serviceAccount;
  if (typeof account !== "string" || account.length === 0 || /[\r\n]/u.test(account)) fail("serviceAccount is invalid");
  if (platform === "windows") {
    // icacls requires the trustee in the /grant value; omitting it creates an
    // action that looks plausible in a dry-run but cannot grant Core access.
    const bundleAcl = `${account}:(OI)(CI)(RX)`;
    const configAcl = `${account}:(R)`;
    const dataAcl = `${account}:(OI)(CI)(M)`;
    return [
      action("icacls.exe", [bundleRoot, "/grant", bundleAcl], "grant read-execute access to the bundle"),
      action("icacls.exe", [configPath, "/grant", configAcl], "grant read-only access to configuration"),
      action("icacls.exe", [dataDir, "/grant", dataAcl], "grant read-write access to data"),
      action("sc.exe", plan.service.createArguments, "register the Core Windows service", undefined, "ensure"),
      action("sc.exe", plan.service.descriptionArguments, "set the Core Windows service description"),
      action("sc.exe", ["start", plan.service.serviceName], "start the Core Windows service"),
    ];
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(account)) fail("serviceAccount is invalid for Linux");
  if (typeof plan.service?.unitText !== "string" || plan.service.unitText.length === 0 || /\0/u.test(plan.service.unitText)) fail("systemd unit text is invalid");
  const unitPath = `/etc/systemd/system/${plan.service.unitName}`;
  return [
    action("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", account], "create the restricted service account if absent", undefined, "ensure"),
    action("install", ["-d", "-o", account, "-g", account, "-m", "0750", dataDir], "create the writable data directory"),
    action("install", ["-d", "-o", "root", "-g", "root", "-m", "0755", path.posix.dirname(configPath)], "create the configuration directory"),
    action("install", ["-m", "0644", "--owner=root", "--group=root", "/dev/stdin", unitPath], "write the hardened systemd unit", plan.service.unitText),
    action("chown", ["-R", `${account}:${account}`, dataDir], "apply data directory ownership"),
    action("systemctl", ["daemon-reload"], "reload systemd units"),
    action("systemctl", ["enable", "--now", plan.service.unitName], "enable and start the Core systemd service"),
  ];
}
