import { AppstoreOutlined, CloudServerOutlined, FolderOpenOutlined, HistoryOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, Select, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type CatalogEntry = { id: string; pluginId: string; subjectType: string; subjectId: string; title: string; description?: string; category: string; route: string; updatedAt: string };

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
  return <AdminShell pathname="/admin/catalog">
    <ProCard title={t("common.unifiedCatalog")} extra={<Space><Input allowClear placeholder={t("common.searchTitleDescription")} value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => refresh(1)} /><Select allowClear placeholder={t("common.category")} value={category} onChange={setCategory} options={[...new Set(entries.map((entry) => entry.category))].map((value) => ({ label: value, value }))} /><Button onClick={() => refresh(1)}>{t("common.search")}</Button></Space>} style={{ margin: 24 }}><ProTable<CatalogEntry> rowKey="id" search={false} options={false} pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (nextPage) => refresh(nextPage) }} dataSource={entries} columns={[{ title: t("common.title"), dataIndex: "title" }, { title: t("common.plugin"), dataIndex: "pluginId" }, { title: t("common.type"), dataIndex: "subjectType" }, { title: t("common.category"), dataIndex: "category", render: (value) => <Tag color="blue">{value}</Tag> }, { title: t("common.route"), dataIndex: "route" }, { title: t("common.updated"), dataIndex: "updatedAt" }]} /></ProCard>
  </AdminShell>;
}
