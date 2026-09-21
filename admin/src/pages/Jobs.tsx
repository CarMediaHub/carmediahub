import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type Job = { id: string; type: string; status: string; progress: number; userId: string; installationId: string; createdAt: string; updatedAt: string; completedAt?: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const refresh = () => { void fetch("/api/jobs").then((response) => response.ok ? response.json() : { jobs: [] }).then((data) => setJobs(data.jobs ?? [])); };
  useEffect(refresh, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/jobs" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Organization tasks" style={{ margin: 24 }}><ProTable<Job> rowKey="id" search={false} options={{ reload: refresh }} dataSource={jobs} columns={[{ title: "Type", dataIndex: "type" }, { title: "User", dataIndex: "userId" }, { title: "Plugin", dataIndex: "installationId" }, { title: "Progress", dataIndex: "progress", render: (value) => `${value}%` }, { title: "Status", dataIndex: "status", render: (value) => <Tag color={value === "succeeded" ? "green" : value === "failed" ? "red" : value === "running" ? "blue" : "default"}>{value}</Tag> }, { title: "Created", dataIndex: "createdAt" }, { title: "Action", render: (_, row) => <Space><Button danger disabled={!(["queued", "running"].includes(row.status))} onClick={async () => { const response = await fetch(`/api/jobs/${row.id}/cancel`, { method: "POST" }); if (!response.ok) { message.error("Unable to cancel task"); return; } message.success("Task cancelled"); refresh(); }}>Cancel</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
