import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";

type CatalogEntry = { id: string; pluginId: string; subjectType: string; subjectId: string; title: string; description?: string; category: string; route: string; updatedAt: string };
const routes = [{ path: "/admin/overview", name: "Overview", icon: <AppstoreOutlined /> }, { path: "/admin/plugins", name: "Plugins", icon: <ThunderboltOutlined /> }, { path: "/admin/jobs", name: "Tasks", icon: <UnorderedListOutlined /> }, { path: "/admin/history", name: "History", icon: <HistoryOutlined /> }, { path: "/admin/catalog", name: "Catalog", icon: <AppstoreOutlined /> }, { path: "/admin/components", name: "Components", icon: <CloudServerOutlined /> }, { path: "/admin/media", name: "Media roots", icon: <FolderOpenOutlined /> }, { path: "/admin/keys", name: "Entry keys", icon: <KeyOutlined /> }, { path: "/admin/security", name: "Security", icon: <SafetyCertificateOutlined /> }, { path: "/admin/users", name: "Users", icon: <TeamOutlined /> }];

export default function Catalog() {
  const { t } = useAdminI18n();
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string>();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;
  const refresh = (nextPage = page) => { const params = new URLSearchParams({ limit: String(pageSize), offset: String((nextPage - 1) * pageSize), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }), ...(category === undefined ? {} : { category }) }); void fetch(`/api/catalog?${params}`).then((response) => response.ok ? response.json() : { entries: [], total: 0 }).then((data) => { setEntries(data.entries ?? []); setTotal(data.total ?? 0); setPage(nextPage); }); };
  useEffect(() => { refresh(1); }, [category]);
  return <ProLayout title="CarMediaHub" logo={false} route={{ routes }} location={{ pathname: "/admin/catalog" }} menuItemRender={(item, dom) => <a href={item.path}>{dom}</a>} actionsRender={() => [<Button key="logout" icon={<LogoutOutlined />} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/admin/login"; }}>Sign out</Button>]}> 
    <ProCard title={t("common.unifiedCatalog")} extra={<Space><Input allowClear placeholder={t("common.searchTitleDescription")} value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => refresh(1)} /><Select allowClear placeholder={t("common.category")} value={category} onChange={setCategory} options={[...new Set(entries.map((entry) => entry.category))].map((value) => ({ label: value, value }))} /><Button onClick={() => refresh(1)}>{t("common.search")}</Button></Space>} style={{ margin: 24 }}><ProTable<CatalogEntry> rowKey="id" search={false} options={false} pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (nextPage) => refresh(nextPage) }} dataSource={entries} columns={[{ title: t("common.title"), dataIndex: "title" }, { title: t("common.plugin"), dataIndex: "pluginId" }, { title: t("common.type"), dataIndex: "subjectType" }, { title: t("common.category"), dataIndex: "category", render: (value) => <Tag color="blue">{value}</Tag> }, { title: t("common.route"), dataIndex: "route" }, { title: t("common.updated"), dataIndex: "updatedAt" }]} /></ProCard>
  </ProLayout>;
}
