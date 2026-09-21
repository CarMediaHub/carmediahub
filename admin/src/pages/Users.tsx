import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProForm, ProFormSelect, ProFormText, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, message, Space, Tag } from "antd";
import { useEffect, useState } from "react";

type User = { id: string; username: string; role: "admin" | "member"; locale: string; createdAt: string; revokedAt: string | null };

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const refresh = () => { void fetch("/api/users").then((response) => response.json()).then((data) => setUsers(data.users ?? [])); };
  useEffect(refresh, []);
  const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/users" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title="Add user" style={{ margin: 24 }}><ProForm layout="inline" onFinish={async (values) => { const response = await fetch("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); if (!response.ok) { message.error("Unable to add user"); return false; } message.success("User added"); refresh(); return true; }}><ProFormText name="username" label="Username" rules={[{ required: true, min: 3 }]} /><ProFormText.Password name="password" label="Temporary password" rules={[{ required: true, min: 12 }]} /><ProFormSelect name="role" label="Role" initialValue="member" options={[{ label: "Member", value: "member" }, { label: "Administrator", value: "admin" }]} /></ProForm></ProCard>
    <ProCard title="Organization users" style={{ margin: 24 }}><ProTable<User> rowKey="id" search={false} options={false} dataSource={users} columns={[{ title: "Username", dataIndex: "username" }, { title: "Role", dataIndex: "role", render: (value) => <Tag color={value === "admin" ? "blue" : "default"}>{value}</Tag> }, { title: "Locale", dataIndex: "locale" }, { title: "Status", render: (_, row) => row.revokedAt ? <Tag color="red">Revoked</Tag> : <Tag color="green">Active</Tag> }, { title: "Action", render: (_, row) => <Space><Button disabled={Boolean(row.revokedAt)} danger onClick={async () => { const response = await fetch(`/api/users/${row.id}/revoke`, { method: "POST" }); if (!response.ok) { message.error((await response.json()).code === "CMH.USER.LAST_ADMIN" ? "At least one administrator must remain active" : "Unable to revoke user"); return; } refresh(); }}>Revoke</Button></Space> }]} /></ProCard>
  </ProLayout>;
}
