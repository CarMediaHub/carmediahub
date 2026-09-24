import { AppstoreOutlined, AuditOutlined, CloudServerOutlined, FolderOpenOutlined, KeyOutlined, LogoutOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { ProCard, ProLayout, ProTable } from "@ant-design/pro-components";
import { Button, Input, InputNumber, message } from "antd";
import { useEffect, useState } from "react";
import { useAdminI18n } from "../i18n";
import { AdminShell } from "../navigation";

type AuditEvent = { id: string; actorId: string | null; type: string; subject: string; createdAt: string };

export default function Audit() {
  const { t } = useAdminI18n();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [limit, setLimit] = useState(200);
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [keyword, setKeyword] = useState("");
  const refresh = async () => { const params = new URLSearchParams({ limit: String(limit), ...(type.trim() === "" ? {} : { type: type.trim() }), ...(actor.trim() === "" ? {} : { actor: actor.trim() }), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }) }); const response = await fetch(`/api/audit?${params.toString()}`); if (!response.ok) { message.error(t("common.auditLoadFailed")); return; } setEvents((await response.json()).events ?? []); };
  const exportCsv = async () => { const params = new URLSearchParams({ limit: String(limit), format: "csv", ...(type.trim() === "" ? {} : { type: type.trim() }), ...(actor.trim() === "" ? {} : { actor: actor.trim() }), ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }) }); const response = await fetch(`/api/audit?${params.toString()}`); if (!response.ok) { message.error(t("common.auditExportFailed")); return; } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "car-media-hub-audit.csv"; anchor.click(); URL.revokeObjectURL(url); };
  useEffect(() => { void refresh(); }, [limit]);
  return <AdminShell pathname="/admin/audit">
    <ProCard title={t("common.auditEvents")} extra={<><Input placeholder={t("common.actionType")} value={type} onChange={(event) => setType(event.target.value)} style={{ width: 150, marginRight: 8 }} /><Input placeholder={t("common.actorId")} value={actor} onChange={(event) => setActor(event.target.value)} style={{ width: 150, marginRight: 8 }} /><Input placeholder={t("common.keyword")} value={keyword} onChange={(event) => setKeyword(event.target.value)} style={{ width: 150, marginRight: 8 }} /><InputNumber min={1} max={500} value={limit} onChange={(value) => { if (value !== null) setLimit(value); }} style={{ marginRight: 8 }} /><Button onClick={() => void refresh()} style={{ marginRight: 8 }}>{t("common.refresh")}</Button><Button onClick={() => void exportCsv()}>{t("common.exportCsv")}</Button></>} style={{ margin: 24 }}><ProTable<AuditEvent> rowKey="id" search={false} options={false} dataSource={events} columns={[{ title: t("common.time"), dataIndex: "createdAt" }, { title: t("common.action"), dataIndex: "type" }, { title: t("common.actor"), dataIndex: "actorId", render: (value) => value ?? t("common.system") }, { title: t("common.subject"), dataIndex: "subject" }]} /></ProCard>
  </AdminShell>;
}
