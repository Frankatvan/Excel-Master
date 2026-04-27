import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { buildCostNameLabel } from "@/lib/audit-external-recon";
import { fetchLiveAuditSnapshot } from "@/lib/audit-service";
import { normalizeInternalCompanyName } from "@/lib/internal-company-registry";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "./auth/[...nextauth]";

function readSingle(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function readRequiredQuery(query: NextApiRequest["query"], key: string) {
  const value = readSingle(query[key]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCostState(value?: string) {
  const text = String(value || "").trim();
  return text || "未分配";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "未登录" });
    }

    const spreadsheetId = readRequiredQuery(req.query, "spreadsheet_id");
    const sourceTable = readRequiredQuery(req.query, "source_table");
    const oldCostState = readRequiredQuery(req.query, "old_cost_state");
    const newCostState = readRequiredQuery(req.query, "new_cost_state");
    const companyName = readRequiredQuery(req.query, "company_name");

    if (
      !spreadsheetId ||
      (sourceTable !== "Payable" && sourceTable !== "Final Detail") ||
      oldCostState === undefined ||
      newCostState === undefined
    ) {
      return res.status(400).json({ error: "缺少重分类明细参数" });
    }

    await requireProjectAccess(spreadsheetId, session.user.email);

    const { snapshot } = await fetchLiveAuditSnapshot(spreadsheetId);
    const normalizedCompany = companyName ? normalizeInternalCompanyName(companyName) : "";
    const rows = (snapshot.audit_tabs.reclass_audit.invoice_rows || [])
      .filter((row) => {
        if (row.source_table !== sourceTable) {
          return false;
        }
        if (normalizeCostState(row.old_cost_state) !== normalizeCostState(oldCostState)) {
          return false;
        }
        if (normalizeCostState(row.new_category) !== normalizeCostState(newCostState)) {
          return false;
        }
        if (normalizedCompany && normalizeInternalCompanyName(row.vendor) !== normalizedCompany) {
          return false;
        }
        return true;
      })
      .map((row, index) => ({
        source_table: row.source_table,
        row_no: row.row_no || index + 1,
        unit_code: row.unit_code,
        vendor: row.vendor,
        old_cost_state: row.old_cost_state,
        cost_name: row.cost_name || buildCostNameLabel(row.cost_code, ""),
        cost_code: row.cost_code,
        amount: row.amount,
        reclass_category: row.new_category,
      }));

    return res.status(200).json({
      rows,
      total_count: rows.length,
      total_amount: Number(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2)),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "重分类明细加载失败";
    return res.status(500).json({ error: message });
  }
}
