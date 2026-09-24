import { AppstoreOutlined, CloudServerOutlined, DashboardOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, Statistic } from "@ant-design/pro-components";
import { Button, Progress, Space, message } from "antd";
import { useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";


export default function Speed() {
  const { t } = useAdminI18n();
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
    } catch { message.error(t("common.speedTestFailed")); } finally { setRunning(false); }
  };
  return <AdminShell pathname="/admin/speed">
    <Space direction="vertical" size="large" style={{ width: "100%", padding: 24 }}>
      <ProCard title={t("common.connectionSpeed")} extra={<Button type="primary" onClick={() => void run()} loading={running}>{t("common.runTest")}</Button>}>
        <Progress percent={progress} status={running ? "active" : "normal"} />
        <ProCard split="vertical"><Statistic title={t("common.latency")} value={latency ?? "-"} suffix={latency === undefined ? "" : "ms"} /><Statistic title={t("common.download")} value={throughput ?? "-"} suffix={throughput === undefined ? "" : "Mbps"} /><Statistic title={t("common.upload")} value={uploadThroughput ?? "-"} suffix={uploadThroughput === undefined ? "" : "Mbps"} /></ProCard>
      </ProCard>
    </Space>
  </AdminShell>;
}
