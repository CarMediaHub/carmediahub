import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormText, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space } from "antd";
import { useEffect, useState } from "react";

type MediaRoot = { id: string; name: string; createdAt: string };

const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Media() {
  const [roots, setRoots] = useState<MediaRoot[]>([]);
  const refresh = () => { void fetch("/api/media-roots").then(async (response) => response.ok ? response.json() : { roots: [] }).then((data) => setRoots(data.roots ?? [])); };
  useEffect(refresh, []);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/media" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}>
    <ProCard title="Add media root" style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/media-roots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error("Unable to add media root"); return false; } message.success("Media root added"); refresh(); return true; }}><ProFormText name="name" label="Name" rules={[{ required: true, max: 80 }]} /><ProFormText name="path" label="Selected directory" rules={[{ required: true }]} /></ProForm></ProCard>
    <ProCard title="Managed media roots" style={{ margin: 24 }}><ProTable<MediaRoot> rowKey="id" search={false} options={false} dataSource={roots} columns={[{ title: "Name", dataIndex: "name" }, { title: "Added", dataIndex: "createdAt" }, { title: "Action", render: (_, row) => <Space><Button danger onClick={async () => { const response = await fetch(`/api/media-roots/${row.id}/revoke`, { method: "POST" }); if (!response.ok) { message.error("Unable to revoke media root"); return; } refresh(); }}>Revoke</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
