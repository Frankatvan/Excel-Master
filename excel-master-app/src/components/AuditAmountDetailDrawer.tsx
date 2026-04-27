export type AuditAmountDetailMode = "external_recon" | "external_recon_diff" | "reclass_audit";

export interface AuditAmountDetailRow {
  source_table: string;
  row_no: number;
  unit_code: string;
  vendor: string;
  old_cost_state: string;
  cost_name: string;
  amount: number;
  reclass_category?: string;
  invoice_label?: string;
  cost_code?: string;
  payable_cost_states?: string[];
  final_detail_cost_states?: string[];
  draw_request_cost_states?: string[];
}

interface AuditAmountDetailDrawerProps {
  open: boolean;
  title?: string;
  mode: AuditAmountDetailMode;
  rows: AuditAmountDetailRow[];
  onClose: () => void;
}

const amountFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

function sanitizeFilePart(value: string) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function buildExportRows(mode: AuditAmountDetailMode, rows: AuditAmountDetailRow[]) {
  const isDiffMode = mode === "external_recon_diff";

  return rows.map((row) => {
    const baseRow = isDiffMode
      ? {
          记录: row.invoice_label || row.source_table || "",
          "Unit Code": row.unit_code || "",
          Vendor: row.vendor || "",
          "Cost Code": row.cost_code || "",
          "Payable 判定": row.payable_cost_states?.join(", ") || "",
          "Final Detail 判定": row.final_detail_cost_states?.join(", ") || "",
          "Draw Request 判定": row.draw_request_cost_states?.join(", ") || "",
        }
      : {
          来源表: row.source_table || "",
          "Row No.": row.row_no || "",
          "Unit Code": row.unit_code || "",
          Vendor: row.vendor || "",
          "Cost State 原值": row.old_cost_state || "",
          "Cost Name": row.cost_name || "",
        };

    return mode === "reclass_audit"
      ? {
          ...baseRow,
          重分类类别: row.reclass_category || "",
          Amount: Number(row.amount || 0),
        }
      : {
          ...baseRow,
          Amount: Number(row.amount || 0),
        };
  });
}

function formatCurrency(value?: number) {
  const amount = Number(value ?? 0);
  if (Math.abs(amount) < 0.005) {
    return "";
  }
  return amountFormatter.format(amount);
}

export default function AuditAmountDetailDrawer({
  open,
  title,
  mode,
  rows,
  onClose,
}: AuditAmountDetailDrawerProps) {
  if (!open) {
    return null;
  }

  const isDiffMode = mode === "external_recon_diff";

  async function handleDownload() {
    if (!rows.length) {
      return;
    }

    const XLSX = await import("xlsx");
    const exportRows = buildExportRows(mode, rows);
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "金额明细");
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const fileTitle = sanitizeFilePart(title || "金额明细") || "金额明细";
    XLSX.writeFile(workbook, `${fileTitle}_${timestamp}.xlsx`);
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="关闭金额明细"
        className="h-full flex-1 bg-slate-900/35"
        onClick={onClose}
      />
      <aside className="h-full w-[90vw] max-w-none overflow-y-auto border-l border-[#D8E3DD] bg-[#FFFDF7] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[#102A38]">金额明细</h2>
            {title ? <div className="mt-1 text-sm text-[#5B7A88]">{title}</div> : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={rows.length === 0}
              className="rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-2 text-sm font-semibold text-[#102A38] transition hover:bg-[#EEF6F1] disabled:cursor-not-allowed disabled:opacity-45"
            >
              下载 Excel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-2 text-sm font-semibold text-[#102A38] transition hover:bg-[#EEF6F1]"
            >
              关闭
            </button>
          </div>
        </div>

        {rows.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-[980px] w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  {isDiffMode ? <th className="pb-3 font-medium">记录</th> : <th className="pb-3 font-medium">来源表</th>}
                  {isDiffMode ? null : <th className="pb-3 font-medium">Row No.</th>}
                  <th className="pb-3 font-medium">Unit Code</th>
                  <th className="pb-3 font-medium">Vendor</th>
                  {isDiffMode ? (
                    <>
                      <th className="pb-3 font-medium">Cost Code</th>
                      <th className="pb-3 font-medium">Payable 判定</th>
                      <th className="pb-3 font-medium">Final Detail 判定</th>
                      <th className="pb-3 font-medium">Draw Request 判定</th>
                    </>
                  ) : (
                    <>
                      <th className="pb-3 font-medium">Cost State 原值</th>
                      <th className="pb-3 font-medium">Cost Name</th>
                    </>
                  )}
                  {mode === "reclass_audit" ? <th className="pb-3 font-medium">重分类类别</th> : null}
                  <th className="pb-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={`${row.source_table}-${row.row_no}-${row.unit_code}-${row.vendor}-${index}`}
                    className="border-b border-slate-100"
                  >
                    <td className="py-3 font-medium">{isDiffMode ? row.invoice_label || row.source_table || "-" : row.source_table || "-"}</td>
                    {isDiffMode ? null : <td className="py-3 text-slate-600">{row.row_no || "-"}</td>}
                    <td className="py-3 text-slate-600">{row.unit_code || "-"}</td>
                    <td className="py-3 text-slate-600">{row.vendor || "-"}</td>
                    {isDiffMode ? (
                      <>
                        <td className="py-3 text-slate-600">{row.cost_code || "-"}</td>
                        <td className="py-3 text-slate-600">{row.payable_cost_states?.join(", ") || "-"}</td>
                        <td className="py-3 text-slate-600">{row.final_detail_cost_states?.join(", ") || "-"}</td>
                        <td className="py-3 text-slate-600">{row.draw_request_cost_states?.join(", ") || "-"}</td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-slate-600">{row.old_cost_state || "-"}</td>
                        <td className="py-3 text-slate-600">{row.cost_name || "-"}</td>
                      </>
                    )}
                    {mode === "reclass_audit" ? (
                      <td className="py-3 text-slate-600">{row.reclass_category || "-"}</td>
                    ) : null}
                    <td className="py-3 text-right font-semibold text-[#102A38]">{formatCurrency(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-6 text-sm text-[#5B7A88]">
            暂无金额明细
          </div>
        )}
      </aside>
    </div>
  );
}
