import { AppstoreOutlined, AuditOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, InputNumber, message } from "antd";
import { useEffect, useState } from "react";

type AuditEvent = { id: string; actorId: string | null; type: string; subject: string; createdAt: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/audit", name: "Audit", icon: <AuditOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [limit, setLimit] = useState(200);
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [keyword, setKeyword] = useState("");
  const refresh = async () => { const params = new URLSearchParams({ limit: String(limit), ...(type.trim() === "" ? {} : { type: type.trim() }), ...(actor.trim() === "" ? {} : { actor: actor.trim() }), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }) }); const response = await fetch(`/api/audit?${params.toString()}`); if (!response.ok) { message.error("Unable to load audit events"); return; } setEvents((await response.json()).events ?? []); };
  const exportCsv = async () => { const params = new URLSearchParams({ limit: String(limit), format: "csv", ...(type.trim() === "" ? {} : { type: type.trim() }), ...(actor.trim() === "" ? {} : { actor: actor.trim() }), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }) }); const response = await fetch(`/api/audit?${params.toString()}`); if (!response.ok) { message.error("Unable to export audit events"); return; } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "car-media-hub-audit.csv"; anchor.click(); URL.revokeObjectURL(url); };
  useEffect(() => { void refresh(); }, [limit]);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/audit" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Audit events" extra={<><Input placeholder="Action type" value={type} onChange={(event) => setType(event.target.value)} style={{ width: 150, marginRight: 8 }} /><Input placeholder="Actor ID" value={actor} onChange={(event) => setActor(event.target.value)} style={{ width: 150, marginRight: 8 }} /><Input placeholder="Keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} style={{ width: 150, marginRight: 8 }} /><InputNumber min={1} max={500} value={limit} onChange={(value) => { if (value !== null) setLimit(value); }} style={{ marginRight: 8 }} /><Button onClick={() => void refresh()} style={{ marginRight: 8 }}>Refresh</Button><Button onClick={() => void exportCsv()}>Export CSV</Button></>} style={{ margin: 24 }}><ProTable<AuditEvent> rowKey="id" search={false} options={false} dataSource={events} columns={[{ title: "Time", dataIndex: "createdAt" }, { title: "Action", dataIndex: "type" }, { title: "Actor", dataIndex: "actorId", render: (value) => value ?? "System" }, { title: "Subject", dataIndex: "subject" }]} /></ProCard>
  </ProLayout>;
}
