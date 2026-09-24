import { AppstoreOutlined, CloudServerOutlined, DeleteOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, message, Popconfirm, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";

type HistoryEntry = { id: string; pluginId: string; subjectType: string; title: string; category?: string; route: string; visitedAt: string; sourceDevice: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function History() {
  const { t } = useAdminI18n();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string>();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;
  const refresh = (nextPage = page) => { const params = new URLSearchParams({ limit: String(pageSize), offset: String((nextPage - 1) * pageSize), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }), ...(category === undefined ? {} : { category }) }); void fetch(`/api/history?${params}`).then((response) => response.ok ? response.json() : { entries: [], total: 0 }).then((data) => { setEntries(data.entries ?? []); setTotal(data.total ?? 0); setPage(nextPage); }); };
  useEffect(() => { refresh(1); }, [category]);
  const clear = async () => { const response = await fetch("/api/history", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(category === undefined ? {} : { category }) }); if (!response.ok) { message.error(t("common.clearHistoryFailed")); return; } message.success(category === undefined ? t("common.historyCleared") : t("common.categoryCleared")); refresh(); };
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/history" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title={t("nav.history")} extra={<Space><Input allowClear placeholder={t("common.search")} value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => refresh(1)} /><Select allowClear placeholder={t("common.category")} value={category} onChange={setCategory} options={[...new Set(entries.map((entry) => entry.category).filter((value): value is string => value !== undefined))].map((value) => ({ label: value, value }))} /><Button onClick={() => refresh(1)}>{t("common.search")}</Button><Popconfirm title={category === undefined ? t("common.clearAllHistory") : t("common.clearCategoryHistory")} onConfirm={clear}><Button danger icon={<DeleteOutlined />}>{t("common.clear")}</Button></Popconfirm></Space>} style={{ margin: 24 }}><ProTable<HistoryEntry> rowKey="id" search={false} options={false} pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (nextPage) => refresh(nextPage) }} dataSource={entries} columns={[{ title: t("common.title"), dataIndex: "title" }, { title: t("common.plugin"), dataIndex: "pluginId" }, { title: t("common.category"), dataIndex: "category", render: (value) => value === undefined ? <Tag>{t("common.uncategorized")}</Tag> : <Tag color="blue">{value}</Tag> }, { title: t("common.route"), dataIndex: "route" }, { title: t("common.device"), dataIndex: "sourceDevice" }, { title: t("common.visited"), dataIndex: "visitedAt" }]} /></ProCard>
  </ProLayout>;
}
