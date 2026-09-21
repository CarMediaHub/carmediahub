import { AppstoreOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, Statistic } from "@ant-design/pro-components";
import { Button, Progress, Space, message } from "antd";
import { useState } from "react";

const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/speed", name: "Speed test", icon: <DashboardOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Speed() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [latency, setLatency] = useState<number>();
  const [throughput, setThroughput] = useState<number>();
  const [uploadThroughput, setUploadThroughput] = useState<number>();
  const run = async () => {
    setRunning(true); setProgress(0); setLatency(undefined); setThroughput(undefined); setUploadThroughput(undefined);
    const started = performance.now();
    try {
      const response = await fetch("/api/diagnostics/speed/download?bytes=1048576", { cache: "no-store" });
      if (!response.ok || response.body === null) throw new Error("speed test failed");
      const reader = response.body.getReader(); let total = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; setProgress(Math.min(100, Math.round(total / 1048576 * 100))); }
      const elapsed = Math.max(1, performance.now() - started); setLatency(Math.round(elapsed)); setThroughput(Number((total * 8 / (elapsed / 1000) / 1_000_000).toFixed(2)));
      const uploadStarted = performance.now(); const uploadResponse = await fetch("/api/diagnostics/speed/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(1024 * 1024) });
      if (!uploadResponse.ok) throw new Error("upload speed test failed");
      const uploadElapsed = Math.max(1, performance.now() - uploadStarted); setUploadThroughput(Number((1024 * 1024 * 8 / (uploadElapsed / 1000) / 1_000_000).toFixed(2)));
    } catch { message.error("Speed test failed"); } finally { setRunning(false); }
  };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/speed" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <Space direction="vertical" size="large" style={{ width: "100%", padding: 24 }}>
      <ProCard title="Connection speed" extra={<Button type="primary" onClick={() => void run()} loading={running}>Run test</Button>}>
        <Progress percent={progress} status={running ? "active" : "normal"} />
        <ProCard split="vertical"><Statistic title="Latency" value={latency ?? "-"} suffix={latency === undefined ? "" : "ms"} /><Statistic title="Download" value={throughput ?? "-"} suffix={throughput === undefined ? "" : "Mbps"} /><Statistic title="Upload" value={uploadThroughput ?? "-"} suffix={uploadThroughput === undefined ? "" : "Mbps"} /></ProCard>
      </ProCard>
    </Space>
  </ProLayout>;
}
