import { AppstoreOutlined, AuditOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, InputNumber, message } from "antd";
import { useEffect, useState } from "react";

type AuditEvent = { id: string; actorId: string | null; type: string; subject: string; createdAt: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/audit", name: "Audit", icon: <AuditOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [limit, setLimit] = useState(200);
  const refresh = async () => { const response = await fetch(`/api/audit?limit=${limit}`); if (!response.ok) { message.error("Unable to load audit events"); return; } setEvents((await response.json()).events ?? []); };
  useEffect(() => { void refresh(); }, [limit]);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/audit" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Audit events" extra={<><InputNumber min={1} max={500} value={limit} onChange={(value) => { if (value !== null) setLimit(value); }} style={{ marginRight: 8 }} /><Button onClick={() => void refresh()}>Refresh</Button></>} style={{ margin: 24 }}><ProTable<AuditEvent> rowKey="id" search={false} options={false} dataSource={events} columns={[{ title: "Time", dataIndex: "createdAt" }, { title: "Action", dataIndex: "type" }, { title: "Actor", dataIndex: "actorId", render: (value) => value ?? "System" }, { title: "Subject", dataIndex: "subject" }]} /></ProCard>
  </ProLayout>;
}
