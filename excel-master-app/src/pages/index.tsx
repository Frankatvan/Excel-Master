import Head from "next/head";
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import ReclassSankey from "@/components/ReclassSankey";

interface DashboardData {
  project_name: string;
  workflow_stage?: string;
  from_cache?: boolean;
  last_synced_at?: string;
  highlights?: Array<{ label: string; value: string; color: string }>;
  audit_tabs?: {
    external_recon?: {
      summary?: string;
      discrepancies?: Array<{
        state: string;
        payable: number;
        final: number;
        diff: number;
      }>;
      unit_budget_variances?: Array<{
        unit_code: string;
        total_budget: number;
        wip_budget: number;
        diff: number;
      }>;
      invoice_match_overview?: {
        payable_total_invoices: number;
        final_total_invoices: number;
        draw_total_invoices: number;
        matched_to_final: number;
        matched_to_draw: number;
        matched_to_both: number;
        payable_unmatched: number;
        final_only: number;
        draw_only: number;
      };
    };
    reclass_audit?: {
      overview?: {
        old_total: number;
        new_total: number;
        diff_amount: number;
        diff_invoice_count: number;
      };
      category_rows?: Array<{
        category: string;
        old_total: number;
        new_total: number;
        diff_amount: number;
        diff_invoice_count: number;
      }>;
      rule_rows?: Array<{
        rule_id: string;
        category: string;
        old_cost_states: string[];
        amount: number;
        diff_amount: number;
        invoice_count: number;
      }>;
      invoice_rows?: Array<{
        vendor: string;
        amount: number;
        incurred_date: string;
        unit_code: string;
        cost_code: string;
        old_cost_state: string;
        new_category: string;
        rule_id: string;
      }>;
      sankey?: {
        nodes: Array<{ name: string }>;
        links: Array<{ source: number; target: number; value: number }>;
      };
    };
    compare_109?: {
      metric_rows?: Array<{
        label: string;
        year_rows: Array<{
          year_offset: number;
          company: number;
          audit: number;
          diff: number;
        }>;
      }>;
    };
    scoping_logic?: Array<{
      group_number: string;
      group_name: string;
      statuses: string[];
      budget: number;
      incurred_amount: number;
    }>;
  };
}

const tabs = ["Overview", "External Recon", "Reclass Audit", "109 Compare"] as const;
const DEFAULT_SPREADSHEET_ID = "1N6iQ3-7H-I_p0p_Pq_G9U8U5k5l-Mv1mKz_N7D_8_8";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatCurrency(value?: number) {
  return currencyFormatter.format(value ?? 0);
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "Not synced yet";
  }

  return new Date(value).toLocaleString();
}

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    props: {},
  };
};

export default function Home() {
  const { data: session } = useSession();
  const router = useRouter();
  const spreadsheetId = Array.isArray(router.query.spreadsheetId)
    ? router.query.spreadsheetId[0]
    : router.query.spreadsheetId;

  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Overview");
  const [projectData, setProjectData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [fetchTime, setFetchTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const currentId = spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const externalRecon = projectData?.audit_tabs?.external_recon;
  const reclassAudit = projectData?.audit_tabs?.reclass_audit;
  const compare109 = projectData?.audit_tabs?.compare_109;
  const scopingLogic = projectData?.audit_tabs?.scoping_logic || [];
  const invoiceMatchOverview = externalRecon?.invoice_match_overview;
  const discrepancyCount = externalRecon?.discrepancies?.filter((item) => Math.abs(item.diff) > 1).length ?? 0;
  const unitVarianceCount = externalRecon?.unit_budget_variances?.filter((item) => Math.abs(item.diff) > 1).length ?? 0;
  const categoryDiffCount = reclassAudit?.category_rows?.filter((row) => Math.abs(row.diff_amount) > 1).length ?? 0;
  const compareDiffTotal =
    compare109?.metric_rows?.reduce(
      (total, metric) => total + metric.year_rows.reduce((sum, row) => sum + Math.abs(row.diff), 0),
      0,
    ) ?? 0;
  const compareYearCount = compare109?.metric_rows?.reduce((total, metric) => total + metric.year_rows.length, 0) ?? 0;
  const stageLabel = projectData?.workflow_stage || "External Recon";
  const nextAction =
    (reclassAudit?.overview?.diff_invoice_count ?? 0) > 0
      ? `Review ${reclassAudit?.overview?.diff_invoice_count ?? 0} reclassified invoices`
      : "Ready for cost reclassification";

  async function loadDashboard() {
    const start = performance.now();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/audit_summary?spreadsheet_id=${encodeURIComponent(currentId)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load dashboard");
      }
      setProjectData(data);
      setFetchTime(Math.round(performance.now() - start));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load dashboard";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);

    try {
      const res = await fetch("/api/audit_sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: currentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to sync dashboard");
      }
      await loadDashboard();
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "Failed to sync dashboard";
      setError(message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleReclassify() {
    setReclassifying(true);
    setError(null);

    try {
      const res = await fetch("/api/reclassify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: currentId, project_id: currentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to run reclassification");
      }
      await loadDashboard();
      setActiveTab("Reclass Audit");
    } catch (reclassifyError) {
      const message =
        reclassifyError instanceof Error ? reclassifyError.message : "Failed to run reclassification";
      setError(message);
    } finally {
      setReclassifying(false);
    }
  }

  async function handleRequestOtp() {
    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to send verification code.");
      }

      setOtpRequested(true);
      setAuthMessage(`Verification code sent to ${data.email}.`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Failed to send verification code.";
      setAuthMessage(message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleOtpSignIn() {
    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const result = await signIn("email-otp", {
        redirect: false,
        email,
        code: otpCode,
        callbackUrl: "/",
      });

      if (!result || result.error) {
        throw new Error("Invalid or expired verification code.");
      }

      await router.replace(router.asPath);
    } catch (signInError) {
      const message = signInError instanceof Error ? signInError.message : "Failed to sign in.";
      setAuthMessage(message);
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    if (session?.user?.email) {
      void loadDashboard();
    }
  }, [session?.user?.email, currentId]);

  return (
    <div className="flex min-h-screen flex-col bg-white font-sans">
      <Head>
        <title>AiWB Audit - Performance Unleashed</title>
      </Head>

      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-gray-50 bg-white/80 px-8 py-4 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="AiWB Logo" className="h-8 w-auto" />
          <span className="text-xl font-black tracking-tighter text-gray-900">AiWB Audit</span>
        </div>

        {session && (
          <div className="flex items-center gap-8">
            {fetchTime !== null && (
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                  Load Speed
                </span>
                <span className={`text-xs font-bold ${fetchTime < 500 ? "text-emerald-500" : "text-orange-500"}`}>
                  {fetchTime}ms
                </span>
              </div>
            )}
            <div className="h-8 w-px bg-gray-100" />
            <div className="flex items-center gap-6">
              <span className="text-xs font-bold text-gray-400">{session.user?.email}</span>
              <button
                onClick={() => signOut()}
                className="text-xs font-bold uppercase text-gray-400 transition-colors hover:text-gray-900"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </nav>

      <main className="flex flex-grow flex-col overflow-hidden">
        {!session ? (
          <div className="flex flex-grow items-center justify-center px-6">
            <div className="grid w-full max-w-5xl gap-6 rounded-[2rem] border border-gray-100 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,0.08)] md:grid-cols-[1.3fr_1fr] md:p-10">
              <div className="rounded-[1.75rem] bg-[linear-gradient(135deg,#f8fafc_0%,#dbeafe_100%)] p-8">
                <p className="mb-4 text-[11px] font-black uppercase tracking-[0.3em] text-blue-600">
                  Share-To-Login Workspace
                </p>
                <h1 className="max-w-xl text-4xl font-black tracking-tight text-slate-900">
                  Audit access stays tied to the Google Sheet sharing list.
                </h1>
                <p className="mt-4 max-w-lg text-sm leading-6 text-slate-600">
                  Google identities can continue with OAuth. Shared non-Google inboxes can request a one-time
                  verification code without needing a Gmail account.
                </p>
                <div className="mt-8 flex flex-wrap gap-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
                  <span className="rounded-full border border-white/70 bg-white/70 px-3 py-1">Google OAuth</span>
                  <span className="rounded-full border border-white/70 bg-white/70 px-3 py-1">Email OTP</span>
                  <span className="rounded-full border border-white/70 bg-white/70 px-3 py-1">Sheet Share Sync</span>
                </div>
              </div>

              <div className="rounded-[1.75rem] border border-gray-100 bg-slate-50 p-6">
                <div className="space-y-3">
                  <button
                    onClick={() => signIn("google")}
                    className="group flex w-full items-center justify-center gap-4 rounded-2xl border border-gray-200 bg-white px-6 py-4 text-gray-900 shadow-sm transition-all hover:-translate-y-1 hover:border-gray-900 active:scale-95"
                  >
                    <img
                      src="https://www.google.com/favicon.ico"
                      alt="Google"
                      className="h-5 w-5 grayscale transition-all group-hover:grayscale-0"
                    />
                    <span className="text-sm font-bold tracking-tight">Continue with Google</span>
                  </button>

                  <div className="flex items-center gap-3 py-2">
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">or</span>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>

                  <div className="space-y-3 rounded-2xl bg-white p-4">
                    <div>
                      <label className="mb-2 block text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                        Shared Work Email
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="name@company.com"
                        className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-500"
                      />
                    </div>

                    {otpRequested && (
                      <div>
                        <label className="mb-2 block text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                          Verification Code
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={otpCode}
                          onChange={(event) => setOtpCode(event.target.value)}
                          placeholder="6-digit code"
                          className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-500"
                        />
                      </div>
                    )}

                    {authMessage && (
                      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">
                        {authMessage}
                      </div>
                    )}

                    <div className="flex flex-col gap-3">
                      <button
                        onClick={otpRequested ? handleOtpSignIn : handleRequestOtp}
                        disabled={authLoading || !email.trim() || (otpRequested && !otpCode.trim())}
                        className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-bold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {authLoading
                          ? "Working..."
                          : otpRequested
                            ? "Sign In with Verification Code"
                            : "Email Me a Verification Code"}
                      </button>
                      {otpRequested && (
                        <button
                          onClick={handleRequestOtp}
                          disabled={authLoading || !email.trim()}
                          className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Resend Code
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-grow overflow-hidden">
            <aside className="hidden w-[280px] flex-col gap-8 overflow-y-auto border-r border-gray-100 bg-[linear-gradient(180deg,#f8fafc_0%,#eef2ff_100%)] p-6 lg:flex">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500">Project Rail</p>
                <div className="mt-4 rounded-[1.75rem] border border-white/70 bg-white/80 p-5 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">Current Project</p>
                  <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                    {loading ? "Synchronizing..." : projectData?.project_name || "Audit Snapshot"}
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    当前工作台围绕外部数据接入、成本重分类与 109 结果差异三个动作组织。
                  </p>
                </div>
              </div>

              <div className="rounded-[1.75rem] border border-white/70 bg-white/80 p-5 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Stage</p>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600">Live Stage</p>
                    <p className="mt-2 text-lg font-black text-slate-900">{stageLabel}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Next Action</p>
                    <p className="mt-2 text-sm font-semibold text-slate-700">{nextAction}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-[1.75rem] border border-white/70 bg-white/80 p-5 shadow-sm">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Workbench Modules</p>
                <div className="mt-4 space-y-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition ${
                        activeTab === tab
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-900 hover:text-slate-900"
                      }`}
                    >
                      <span className="text-sm font-bold">{tab}</span>
                      <span className="text-[10px] font-black uppercase tracking-[0.2em]">
                        {tab === "Overview" ? "Deck" : "Open"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </aside>

            <section className="flex-grow overflow-y-auto bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-6 md:p-10">
              <div className="mx-auto max-w-7xl">
                <header className="mb-10 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_380px]">
                  <div className="rounded-[2rem] border border-slate-100 bg-[radial-gradient(circle_at_top_left,#dbeafe,transparent_35%),linear-gradient(135deg,#0f172a_0%,#1e293b_55%,#334155_100%)] p-8 text-white shadow-[0_30px_80px_rgba(15,23,42,0.18)]">
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.35em] text-blue-200">Audit Command Deck</p>
                      {projectData?.from_cache && (
                        <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-200">
                          Cloud Mirror
                        </span>
                      )}
                      <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-200">
                        {stageLabel}
                      </span>
                    </div>
                    <h2 className="mt-5 text-4xl font-black tracking-tight md:text-5xl">
                      {projectData?.project_name || "Synchronizing..."}
                    </h2>
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
                      把外部数据接入、成本重分类和 109 结果差异放到一张工作台上，先看金额，再看差异，
                      再下钻到具体 Rule_ID 与 Invoice 明细。
                    </p>
                    <div className="mt-8 grid gap-4 sm:grid-cols-3">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Last Snapshot</p>
                        <p className="mt-2 text-sm font-semibold text-white">{formatTimestamp(projectData?.last_synced_at)}</p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Open Issues</p>
                        <p className="mt-2 text-2xl font-black text-white">
                          {formatNumber(discrepancyCount + categoryDiffCount)}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Next Focus</p>
                        <p className="mt-2 text-sm font-semibold text-white">{nextAction}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400">Action Rail</p>
                        <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">Run and review</h3>
                      </div>
                      {fetchTime !== null && (
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-right">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Load Speed</p>
                          <p className={`mt-1 text-sm font-black ${fetchTime < 500 ? "text-emerald-600" : "text-orange-500"}`}>
                            {fetchTime}ms
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="mt-6 space-y-3">
                      <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="flex w-full items-center justify-between rounded-[1.25rem] bg-blue-600 px-5 py-4 text-left text-sm font-bold text-white shadow-xl shadow-blue-100 transition-all hover:bg-blue-700 disabled:opacity-50"
                      >
                        <span>{syncing ? "Rerunning Engine..." : "Live Sync"}</span>
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-100">
                          Snapshot
                        </span>
                      </button>
                      <button
                        onClick={handleReclassify}
                        disabled={reclassifying}
                        className="flex w-full items-center justify-between rounded-[1.25rem] bg-slate-900 px-5 py-4 text-left text-sm font-bold text-white transition hover:bg-black disabled:opacity-50"
                      >
                        <span>{reclassifying ? "成本重分类中..." : "成本重分类"}</span>
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">
                          Action
                        </span>
                      </button>
                    </div>
                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Current ID</p>
                        <p className="mt-2 break-all text-sm font-semibold text-slate-700">{currentId}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Audit Route</p>
                        <p className="mt-2 text-sm font-semibold text-slate-700">
                          Amount first, variance second, drilldown last.
                        </p>
                      </div>
                    </div>
                  </div>
                </header>

                {error && (
                  <div className="mb-8 rounded-2xl border border-red-100 bg-red-50 px-5 py-4 text-sm font-semibold text-red-700">
                    {error}
                  </div>
                )}

                <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-4">
                  {(projectData?.highlights || Array.from({ length: 4 }, () => ({ label: "Pending", value: "-", color: "slate" }))).map(
                    (card, idx) => (
                      <div key={`${card.label}-${idx}`} className="rounded-[1.75rem] border border-slate-100 bg-white p-5 shadow-sm">
                        <p className="mb-1 text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                          {card.label}
                        </p>
                        <h3 className="text-2xl font-black text-slate-900">{card.value}</h3>
                      </div>
                    ),
                  )}
                </div>

                <div className="mb-8 flex flex-wrap gap-3 border-b border-slate-100 pb-4">
                  {tabs.map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.18em] transition-all ${
                        activeTab === tab
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-500 hover:border-slate-900 hover:text-slate-900"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="min-h-[400px]">
                  {activeTab === "Overview" && (
                    <div className="space-y-8">
                      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
                        <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">
                                Overview
                              </p>
                              <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                                Audit Command Deck
                              </h3>
                            </div>
                            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-600">
                              {projectData?.from_cache ? "Cached + Live" : "Live Ready"}
                            </span>
                          </div>
                          <div className="mt-6 grid gap-4 sm:grid-cols-2">
                            <div className="rounded-[1.5rem] bg-slate-950 p-5 text-white">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Workflow Stage</p>
                              <p className="mt-3 text-3xl font-black">{stageLabel}</p>
                              <p className="mt-3 text-sm leading-6 text-slate-300">
                                先跑外部数据核查，再看成本重分类，最后看 109 结果差异。
                              </p>
                            </div>
                            <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Next Move</p>
                              <p className="mt-3 text-2xl font-black text-slate-900">{nextAction}</p>
                              <p className="mt-3 text-sm leading-6 text-slate-600">
                                点击差异模块后直接下钻到异常位置，不在首页堆过多明细。
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-[2rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400">
                            Audit Signals
                          </p>
                          <div className="mt-5 space-y-4">
                            <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">External Recon</p>
                              <p className="mt-2 text-sm font-semibold text-slate-700">
                                {externalRecon?.summary || "Waiting for snapshot data"}
                              </p>
                            </div>
                            <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Reclass Focus</p>
                              <p className="mt-2 text-sm font-semibold text-slate-700">
                                {nextAction}
                              </p>
                            </div>
                            <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">109 Focus</p>
                              <p className="mt-2 text-sm font-semibold text-slate-700">
                                {compareYearCount > 0
                                  ? `${formatNumber(compareYearCount)} year buckets ready for review`
                                  : "109 comparison is waiting for metrics"}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-5 lg:grid-cols-3">
                        <button
                          onClick={() => setActiveTab("External Recon")}
                          className="rounded-[1.75rem] border border-slate-100 bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-slate-900"
                        >
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">External Recon</p>
                          <h4 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            {formatNumber(discrepancyCount)} active discrepancies
                          </h4>
                          <p className="mt-3 text-sm leading-6 text-slate-600">
                            {externalRecon?.summary || "Review Payable, Final Detail, Draw request report and Unit Budget alignment."}
                          </p>
                          <p className="mt-5 text-xs font-black uppercase tracking-[0.2em] text-slate-500">
                            Open mismatch table
                          </p>
                        </button>

                        <button
                          onClick={() => setActiveTab("Reclass Audit")}
                          className="rounded-[1.75rem] border border-slate-100 bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-slate-900"
                        >
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">Reclass Audit</p>
                          <h4 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            {formatCurrency(reclassAudit?.overview?.diff_amount)}
                          </h4>
                          <p className="mt-3 text-sm leading-6 text-slate-600">
                            Review {reclassAudit?.overview?.diff_invoice_count ?? 0} reclassified invoices before audit drilldown.
                          </p>
                          <p className="mt-5 text-xs font-black uppercase tracking-[0.2em] text-slate-500">
                            Open rule comparison
                          </p>
                        </button>

                        <button
                          onClick={() => setActiveTab("109 Compare")}
                          className="rounded-[1.75rem] border border-slate-100 bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-slate-900"
                        >
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">109 Compare</p>
                          <h4 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            {formatCurrency(compareDiffTotal)}
                          </h4>
                          <p className="mt-3 text-sm leading-6 text-slate-600">
                            Compare company results against audit values for revenue, cost and gross profit by year.
                          </p>
                          <p className="mt-5 text-xs font-black uppercase tracking-[0.2em] text-slate-500">
                            Open year breakdown
                          </p>
                        </button>
                      </div>
                    </div>
                  )}

                  {activeTab === "External Recon" && (
                    <div className="animate-fade-in space-y-8">
                      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">External Recon</p>
                          <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            Reconcile incoming WBS and request data
                          </h3>
                          <p className="mt-3 text-sm leading-7 text-slate-600">
                            {externalRecon?.summary ||
                              "Use Payable as the base ledger, then compare Final Detail, Draw request report and Unit Budget variance by audit logic."}
                          </p>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                          <div className="rounded-[1.75rem] border border-slate-100 bg-white p-5 shadow-sm">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Cost State Mismatches</p>
                            <p className="mt-3 text-3xl font-black text-slate-900">{formatNumber(discrepancyCount)}</p>
                          </div>
                          <div className="rounded-[1.75rem] border border-slate-100 bg-white p-5 shadow-sm">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Unit Variances</p>
                            <p className="mt-3 text-3xl font-black text-slate-900">{formatNumber(unitVarianceCount)}</p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                        <div className="mb-5 flex items-center justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Cost State Alignment</p>
                            <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                              Payable vs Final Detail
                            </h4>
                          </div>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                            Amount variance
                          </span>
                        </div>
                        {externalRecon?.discrepancies && externalRecon.discrepancies.length > 0 ? (
                          <table className="w-full text-left">
                            <thead>
                              <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                                <th className="pb-4">Cost State</th>
                                <th className="pb-4 text-right">Payable</th>
                                <th className="pb-4 text-right">Final Detail</th>
                                <th className="pb-4 text-right">Variance</th>
                              </tr>
                            </thead>
                            <tbody className="text-sm font-medium">
                              {externalRecon.discrepancies.map((item) => (
                                <tr
                                  key={item.state}
                                  className={`border-b border-slate-50 ${Math.abs(item.diff) > 1 ? "bg-red-50/40" : ""}`}
                                >
                                  <td className="py-5 font-black text-slate-900">{item.state}</td>
                                  <td className="py-5 text-right font-mono text-slate-500">
                                    {formatCurrency(item.payable)}
                                  </td>
                                  <td className="py-5 text-right font-mono text-slate-500">
                                    {formatCurrency(item.final)}
                                  </td>
                                  <td
                                    className={`py-5 text-right font-black ${
                                      Math.abs(item.diff) > 1 ? "text-red-500" : "text-emerald-500"
                                    }`}
                                  >
                                    {Math.abs(item.diff) > 1 ? formatCurrency(item.diff) : "Matched"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                            No discrepancy rows in the current snapshot.
                          </div>
                        )}
                      </div>

                      <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                              Invoice Match Overview
                            </p>
                            <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                              Payable, Final Detail and Draw request match coverage
                            </h4>
                          </div>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                            Matched vs unmatched
                          </span>
                        </div>
                        {invoiceMatchOverview ? (
                          <div className="space-y-5">
                            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                              <div className="rounded-[1.25rem] border border-slate-100 bg-slate-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Payable total
                                </p>
                                <p className="mt-2 text-2xl font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.payable_total_invoices)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-slate-100 bg-slate-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Final total
                                </p>
                                <p className="mt-2 text-2xl font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.final_total_invoices)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-slate-100 bg-slate-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Draw total
                                </p>
                                <p className="mt-2 text-2xl font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.draw_total_invoices)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-emerald-100 bg-emerald-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-500">
                                  Matched to both
                                </p>
                                <p className="mt-2 text-2xl font-black text-emerald-600">
                                  {formatNumber(invoiceMatchOverview.matched_to_both)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-blue-100 bg-blue-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-500">
                                  Matched to final
                                </p>
                                <p className="mt-2 text-2xl font-black text-blue-600">
                                  {formatNumber(invoiceMatchOverview.matched_to_final)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-amber-100 bg-amber-50 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-500">
                                  Payable unmatched
                                </p>
                                <p className="mt-2 text-2xl font-black text-amber-600">
                                  {formatNumber(invoiceMatchOverview.payable_unmatched)}
                                </p>
                              </div>
                            </div>

                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="rounded-[1.25rem] border border-slate-100 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Matched to draw
                                </p>
                                <p className="mt-2 text-lg font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.matched_to_draw)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-slate-100 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Final only
                                </p>
                                <p className="mt-2 text-lg font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.final_only)}
                                </p>
                              </div>
                              <div className="rounded-[1.25rem] border border-slate-100 px-4 py-4">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                                  Draw only
                                </p>
                                <p className="mt-2 text-lg font-black text-slate-900">
                                  {formatNumber(invoiceMatchOverview.draw_only)}
                                </p>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                            Invoice match coverage will populate after Payable, Final Detail and Draw request sync.
                          </div>
                        )}
                      </div>

                      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <div className="mb-5 flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                Unit Budget Variance
                              </p>
                              <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                                Total Budget vs WIP Budget
                              </h4>
                            </div>
                          </div>
                          <div className="space-y-3 text-sm">
                            {(externalRecon?.unit_budget_variances || []).length > 0 ? (
                              externalRecon?.unit_budget_variances?.map((item) => (
                                <div
                                  key={item.unit_code}
                                  className="flex flex-col gap-2 rounded-[1.25rem] border border-slate-100 bg-slate-50 px-4 py-4 md:flex-row md:items-center md:justify-between"
                                >
                                  <span className="font-black text-slate-900">{item.unit_code}</span>
                                  <span className="text-slate-600">
                                    Total {formatCurrency(item.total_budget)} / WIP {formatCurrency(item.wip_budget)} /
                                    Diff {formatCurrency(item.diff)}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                                Unit variance rows will appear after Unit Master is refreshed.
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <div className="mb-5 flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                Scoping Logic
                              </p>
                              <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                                Active groups with budget or incurred amounts
                              </h4>
                            </div>
                          </div>
                          <div className="space-y-3">
                            {scopingLogic.length > 0 ? (
                              scopingLogic.slice(0, 6).map((item) => (
                                <div key={`${item.group_number}-${item.group_name}`} className="rounded-[1.25rem] border border-slate-100 bg-slate-50 px-4 py-4">
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-black text-slate-900">
                                        {item.group_number} · {item.group_name}
                                      </p>
                                      <p className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                                        {item.statuses.join(" / ")}
                                      </p>
                                    </div>
                                    <div className="text-right text-sm text-slate-600">
                                      <div>Budget {formatCurrency(item.budget)}</div>
                                      <div>Incurred {formatCurrency(item.incurred_amount)}</div>
                                    </div>
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                                No scoping logic rows are available in this snapshot yet.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === "Reclass Audit" && (
                    <div className="animate-fade-in space-y-8">
                      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">Reclass Audit</p>
                          <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            Old Cost State vs new Category / Rule ID
                          </h3>
                          <p className="mt-3 text-sm leading-7 text-slate-600">
                            审计先看总金额、分类金额和差异金额，再点进去看具体 Rule_ID 和 Invoice 明细。
                          </p>
                        </div>
                        <div className="rounded-[1.75rem] border border-slate-100 bg-slate-950 p-6 text-white shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Priority</p>
                          <h4 className="mt-3 text-3xl font-black">{nextAction}</h4>
                          <p className="mt-3 text-sm leading-6 text-slate-300">
                            Default ordering stays on Rule ID, while the homepage keeps amount variance first.
                          </p>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-4">
                        <div className="rounded-[1.5rem] border border-slate-100 bg-white p-5 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Old Total</p>
                          <h3 className="mt-2 text-2xl font-black text-slate-900">
                            {formatCurrency(reclassAudit?.overview?.old_total)}
                          </h3>
                        </div>
                        <div className="rounded-[1.5rem] border border-slate-100 bg-white p-5 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">New Total</p>
                          <h3 className="mt-2 text-2xl font-black text-slate-900">
                            {formatCurrency(reclassAudit?.overview?.new_total)}
                          </h3>
                        </div>
                        <div className="rounded-[1.5rem] border border-red-100 bg-red-50 p-5 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-red-500">Diff Amount</p>
                          <h3 className="mt-2 text-2xl font-black text-red-600">
                            {formatCurrency(reclassAudit?.overview?.diff_amount)}
                          </h3>
                        </div>
                        <div className="rounded-[1.5rem] border border-slate-100 bg-white p-5 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Diff Invoices</p>
                          <h3 className="mt-2 text-2xl font-black text-slate-900">
                            {formatNumber(reclassAudit?.overview?.diff_invoice_count)}
                          </h3>
                        </div>
                      </div>

                      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <div className="mb-5 flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Category Comparison</p>
                              <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                                Amount and invoice count by new category
                              </h4>
                            </div>
                          </div>
                          {(reclassAudit?.category_rows || []).length > 0 ? (
                            <table className="w-full text-left text-sm">
                              <thead>
                                <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                                  <th className="pb-4">Category</th>
                                  <th className="pb-4 text-right">Old</th>
                                  <th className="pb-4 text-right">New</th>
                                  <th className="pb-4 text-right">Diff</th>
                                  <th className="pb-4 text-right">Invoices</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reclassAudit?.category_rows?.map((row) => (
                                  <tr key={row.category} className="border-b border-slate-50">
                                    <td className="py-4 font-black text-slate-900">{row.category}</td>
                                    <td className="py-4 text-right text-slate-500">{formatCurrency(row.old_total)}</td>
                                    <td className="py-4 text-right text-slate-500">{formatCurrency(row.new_total)}</td>
                                    <td className="py-4 text-right font-black text-red-500">{formatCurrency(row.diff_amount)}</td>
                                    <td className="py-4 text-right text-slate-500">{formatNumber(row.diff_invoice_count)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                              Category rows will populate after reclassification results are available.
                            </div>
                          )}
                        </div>

                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <div className="mb-5 flex items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Rule Drilldown</p>
                              <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                                Rule ID comparison
                              </h4>
                            </div>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                              Default: Rule ID
                            </span>
                          </div>
                          {(reclassAudit?.rule_rows || []).length > 0 ? (
                            <table className="w-full text-left text-sm">
                              <thead>
                                <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                                  <th className="pb-4">Rule ID</th>
                                  <th className="pb-4">Category</th>
                                  <th className="pb-4 text-right">Amount</th>
                                  <th className="pb-4 text-right">Diff</th>
                                  <th className="pb-4 text-right">Invoices</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reclassAudit?.rule_rows?.map((row) => (
                                  <tr key={row.rule_id} className="border-b border-slate-50">
                                    <td className="py-4 font-black text-slate-900">{row.rule_id}</td>
                                    <td className="py-4 text-slate-500">{row.category}</td>
                                    <td className="py-4 text-right text-slate-500">{formatCurrency(row.amount)}</td>
                                    <td className="py-4 text-right font-black text-red-500">{formatCurrency(row.diff_amount)}</td>
                                    <td className="py-4 text-right text-slate-500">{formatNumber(row.invoice_count)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                              Rule-level rows will appear after reclassification completes.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                              Invoice Drilldown
                            </p>
                            <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">
                              Invoice-level reclassification rows
                            </h4>
                          </div>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                            Single invoice view
                          </span>
                        </div>
                        {(reclassAudit?.invoice_rows || []).length > 0 ? (
                          <div className="overflow-x-auto">
                            <table className="min-w-[980px] w-full text-left text-sm">
                              <thead>
                                <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                                  <th className="pb-4">Vendor</th>
                                  <th className="pb-4">Date</th>
                                  <th className="pb-4">Unit</th>
                                  <th className="pb-4">Cost Code</th>
                                  <th className="pb-4">Old State</th>
                                  <th className="pb-4">New Category</th>
                                  <th className="pb-4">Rule ID</th>
                                  <th className="pb-4 text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reclassAudit?.invoice_rows?.map((row, index) => (
                                  <tr key={`${row.rule_id}-${row.vendor}-${index}`} className="border-b border-slate-50">
                                    <td className="py-4 font-black text-slate-900">{row.vendor || "Unknown vendor"}</td>
                                    <td className="py-4 text-slate-500">{row.incurred_date || "-"}</td>
                                    <td className="py-4 text-slate-500">{row.unit_code || "-"}</td>
                                    <td className="py-4 text-slate-500">{row.cost_code || "-"}</td>
                                    <td className="py-4 text-slate-500">{row.old_cost_state || "-"}</td>
                                    <td className="py-4 text-slate-500">{row.new_category || "-"}</td>
                                    <td className="py-4">
                                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                        {row.rule_id || "-"}
                                      </span>
                                    </td>
                                    <td className="py-4 text-right font-black text-slate-900">
                                      {formatCurrency(row.amount)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm font-medium text-slate-500">
                            Invoice drilldown rows will appear after reclassification completes.
                          </div>
                        )}
                      </div>

                      {reclassAudit?.sankey && <ReclassSankey data={reclassAudit.sankey} />}
                    </div>
                  )}

                  {activeTab === "109 Compare" && (
                    <div className="animate-fade-in space-y-8">
                      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                        <div className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600">109 Compare</p>
                          <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                            Company vs audit values by year
                          </h3>
                          <p className="mt-3 text-sm leading-7 text-slate-600">
                            重点看 19 行当期确认收入、30 行当期确认成本和 52 行 Gross Profit，并默认按年份展开。
                          </p>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="rounded-[1.75rem] border border-slate-100 bg-white p-5 shadow-sm">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Tracked Metrics</p>
                            <p className="mt-3 text-3xl font-black text-slate-900">
                              {formatNumber(compare109?.metric_rows?.length)}
                            </p>
                          </div>
                          <div className="rounded-[1.75rem] border border-red-100 bg-red-50 p-5 shadow-sm">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-red-500">Total Variance</p>
                            <p className="mt-3 text-3xl font-black text-red-600">{formatCurrency(compareDiffTotal)}</p>
                          </div>
                        </div>
                      </div>

                      {(compare109?.metric_rows || []).length > 0 ? (
                        <div className="grid gap-6">
                          {compare109?.metric_rows?.map((metric) => (
                            <div key={metric.label} className="rounded-[1.75rem] border border-slate-100 bg-white p-6 shadow-sm">
                              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                    109 Metric
                                  </p>
                                  <h4 className="mt-2 text-xl font-black tracking-tight text-slate-900">{metric.label}</h4>
                                </div>
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                  Year breakdown
                                </span>
                              </div>
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                                    <th className="pb-4">Year</th>
                                    <th className="pb-4 text-right">Company</th>
                                    <th className="pb-4 text-right">Audit</th>
                                    <th className="pb-4 text-right">Diff</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {metric.year_rows.map((row) => (
                                    <tr key={`${metric.label}-${row.year_offset}`} className="border-b border-slate-50">
                                      <td className="py-4 font-black text-slate-900">Y{row.year_offset + 1}</td>
                                      <td className="py-4 text-right text-slate-500">{formatCurrency(row.company)}</td>
                                      <td className="py-4 text-right text-slate-500">{formatCurrency(row.audit)}</td>
                                      <td className="py-4 text-right font-black text-red-500">{formatCurrency(row.diff)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-[1.75rem] border border-dashed border-slate-200 bg-white px-6 py-10 text-sm font-medium text-slate-500 shadow-sm">
                          109 comparison rows are not available in the current snapshot yet.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
