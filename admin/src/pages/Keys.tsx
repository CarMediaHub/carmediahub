import { AppstoreOutlined, CloudServerOutlined, KeyOutlined, LogoutOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormDateTimePicker, ProFormSelect, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type Application = { id: string; name: string; route: string };
type EntryKey = { id: string; applicationId: string; applicationName: string; route: string; expiresAt: string | null; revokedAt: string | null; createdAt: string };

export default function Keys() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [keys, setKeys] = useState<EntryKey[]>([]);
  const refresh = () => { void Promise.all([fetch("/api/apps").then((response) => response.json()), fetch("/api/keys").then((response) => response.json())]).then(([apps, entries]) => { setApplications(apps.applications ?? []); setKeys(entries.keys ?? []); }); };
  useEffect(refresh, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes: [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }] }} location={{ pathname: "/admin/keys" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Create entry key" style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); const result = await response.json(); if (!response.ok) { message.error("Unable to create key"); return false; } await navigator.clipboard?.writeText(`${window.location.origin}/k/${result.key}`); message.success("Key created; the URL was copied when supported"); refresh(); return true; }}><ProFormSelect name="applicationId" label="Application" options={applications.map((app) => ({ label: `${app.name} (${app.route})`, value: app.id }))} rules={[{ required: true }]} /><ProFormDateTimePicker name="expiresAt" label="Expires" /></ProForm></ProCard>
    <ProCard title="Issued keys" style={{ margin: 24 }}><ProTable<EntryKey> rowKey="id" search={false} options={false} dataSource={keys} columns={[{ title: "Application", dataIndex: "applicationName" }, { title: "Route", dataIndex: "route" }, { title: "Created", dataIndex: "createdAt" }, { title: "Expires", dataIndex: "expiresAt", render: (value) => value ?? "Never" }, { title: "Status", render: (_, row) => row.revokedAt ? <Tag color="red">Revoked</Tag> : <Tag color="green">Active</Tag> }, { title: "Action", render: (_, row) => <Space><Button disabled={Boolean(row.revokedAt)} onClick={async () => { await fetch(`/api/keys/${row.id}/revoke`, { method: "POST" }); refresh(); }}>Revoke</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
