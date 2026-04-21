import { signIn, signOut, useSession } from "next-auth/react";
import Head from "next/head";
import { useEffect, useState, Fragment } from "react";

export default function Home() {
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState("External Recon");
  const [projectData, setProjectData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [expandedState, setExpandedState] = useState<string | null>(null);

  useEffect(() => {
    if (session) {
      fetchProjectData();
    }
  }, [session]);

  const fetchProjectData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/audit_summary?spreadsheet_id=MOCK_ID");
      const data = await res.json();
      setProjectData(data);
    } catch (err) {
      console.error("Fetch failed", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col font-sans">
      <Head>
        <title>AiWB - Intelligent Workbook</title>
      </Head>

      <nav className="px-8 py-4 flex justify-between items-center border-b border-gray-50">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="AiWB Logo" className="h-8 w-auto" />
          <span className="text-xl font-black text-gray-900 tracking-tighter">AiWB</span>
        </div>
        {session && (
          <div className="flex items-center gap-6">
            <span className="text-xs font-bold text-gray-400">{session.user?.email}</span>
            <button onClick={() => signOut()} className="text-gray-400 hover:text-gray-900 text-xs font-bold transition-colors uppercase tracking-widest">Logout</button>
          </div>
        )}
      </nav>

      <main className="flex-grow flex flex-col overflow-hidden">
        {!session ? (
          <div className="flex-grow flex items-center justify-center">
            <div className="flex flex-col items-center gap-12 animate-fade-in">
              <div className="text-center">
                <h1 className="text-4xl font-black text-gray-900 mb-2 tracking-tight">Welcome</h1>
                <p className="text-gray-400 font-medium">Sign in to your audit workspace.</p>
              </div>
              <button onClick={() => signIn("google")} className="flex items-center gap-4 bg-white border border-gray-200 hover:border-gray-900 text-gray-900 px-12 py-5 rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 hover:-translate-y-1 group">
                <img src="https://www.google.com/favicon.ico" alt="Google" className="w-6 h-6 grayscale group-hover:grayscale-0 transition-all" />
                <span className="text-xl font-bold tracking-tight">Start</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-grow flex overflow-hidden">
            <aside className="w-1/5 bg-gray-50 border-r border-gray-100 p-6 flex flex-col gap-8 overflow-y-auto">
              <div>
                <h2 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-6">Active Projects</h2>
                <div className="flex flex-col gap-2">
                  <div className="px-4 py-3 bg-white border border-gray-200 rounded-xl shadow-sm text-sm font-bold text-blue-600 border-l-4 border-l-blue-600">
                    {loading ? "Syncing..." : (projectData?.project_name || "109 Formula Master")}
                  </div>
                  {[1, 2, 3].map(i => (
                    <div key={i} className="px-4 py-3 text-sm font-medium text-gray-400 hover:text-gray-600 cursor-pointer transition-colors">Historical Project {i}</div>
                  ))}
                </div>
              </div>
              <div className="mt-auto">
                <button className="w-full py-3 border border-dashed border-gray-300 rounded-xl text-gray-400 text-[10px] font-black uppercase tracking-widest hover:border-blue-300 hover:text-blue-500 transition-all">+ New Audit Scope</button>
              </div>
            </aside>

            <section className="flex-grow p-10 overflow-y-auto bg-white">
              <div className="max-w-6xl mx-auto">
                <header className="mb-10 flex justify-between items-end">
                  <div>
                    <p className="text-blue-600 font-black text-[10px] uppercase tracking-[0.3em] mb-2">Audit Dashboard</p>
                    <h2 className="text-4xl font-black text-gray-900 tracking-tight">{projectData?.project_name || "Workbook Summary"}</h2>
                  </div>
                  <button className="bg-gray-900 text-white px-6 py-2.5 rounded-xl text-xs font-bold shadow-xl shadow-gray-100 hover:bg-black transition-all flex items-center gap-2">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" /><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" /></svg>
                    Google Sheet
                  </button>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
                  {(projectData?.highlights || [
                    { label: "Revenue", value: "-", color: "blue" },
                    { label: "Actual Cost", value: "-", color: "indigo" },
                    { label: "Gross Margin", value: "-", color: "emerald" },
                    { label: "POC (%)", value: "-", color: "purple" }
                  ]).map((card: any, idx: number) => (
                    <div key={idx} className="bg-white p-6 rounded-3xl border border-gray-100 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-xl transition-shadow">
                      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{card.label}</p>
                      <h3 className="text-2xl font-black text-gray-900">{card.value}</h3>
                      <div className={`h-1 w-8 bg-${card.color}-500 mt-2 rounded-full opacity-50`}></div>
                    </div>
                  ))}
                </div>

                <div className="border-b border-gray-100 mb-8 flex gap-8">
                  {["External Recon", "Reclass Audit", "Mapping Consistency", "Scoping Logic", "Rule Manual"].map((tab) => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`pb-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-400 hover:text-gray-600'}`}>
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="min-h-[400px]">
                  {activeTab === "External Recon" && (
                    <div className="animate-fade-in">
                      <div className="bg-blue-50/50 border border-blue-100 p-6 rounded-2xl mb-8 flex justify-between items-center">
                        <p className="text-blue-700 text-sm font-bold">{projectData?.audit_tabs?.external_recon?.summary}</p>
                        <span className="text-[10px] bg-blue-600 text-white px-3 py-1 rounded-full font-black uppercase tracking-widest">Live Sync</span>
                      </div>
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-[10px] font-black text-gray-400 uppercase tracking-widest border-b border-gray-100">
                            <th className="pb-4">Cost State</th>
                            <th className="pb-4">Payable Total</th>
                            <th className="pb-4">Final Detail Total</th>
                            <th className="pb-4">Variance</th>
                            <th className="pb-4 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm font-medium">
                          {projectData?.audit_tabs?.external_recon?.discrepancies.map((d: any, i: number) => (
                            <Fragment key={i}>
                              <tr className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors cursor-pointer ${expandedState === d.state ? 'bg-gray-50/80' : ''}`} onClick={() => setExpandedState(expandedState === d.state ? null : d.state)}>
                                <td className="py-5 font-black text-gray-900">{d.state}</td>
                                <td className="py-5 text-gray-600">${d.payable?.toLocaleString()}</td>
                                <td className="py-5 text-gray-600">${d.final?.toLocaleString()}</td>
                                <td className={`py-5 font-black ${Math.abs(d.diff) > 1 ? 'text-red-500' : 'text-emerald-500'}`}>
                                  {Math.abs(d.diff) > 1 ? `$${d.diff?.toLocaleString()}` : '✓ Matched'}
                                </td>
                                <td className="py-5 text-right">
                                  <button className={`text-[10px] font-black uppercase tracking-tighter ${Math.abs(d.diff) > 1 ? 'text-blue-600' : 'text-gray-300'}`}>
                                    {expandedState === d.state ? 'Close' : 'View Details'}
                                  </button>
                                </td>
                              </tr>
                              {expandedState === d.state && (
                                <tr>
                                  <td colSpan={5} className="bg-gray-50/50 px-8 py-6 border-b border-gray-100">
                                    <div className="animate-slide-down">
                                      <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-4">Discrepancy Line Items (Top 10)</h4>
                                      <div className="space-y-2">
                                        {(projectData?.audit_tabs?.external_recon?.details?.[d.state] || []).length > 0 ? (
                                          projectData?.audit_tabs?.external_recon?.details[d.state].map((item: any, idx: number) => (
                                            <div key={idx} className="flex items-center justify-between bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                                              <div className="flex gap-6 items-center">
                                                <span className="text-xs font-mono text-gray-400">{item.uid}</span>
                                                <div className="flex flex-col">
                                                  <span className="text-sm font-bold text-gray-900">{item.vendor}</span>
                                                  <span className="text-[10px] text-gray-400">{item.desc}</span>
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-6">
                                                <span className="text-sm font-black text-gray-900">${item.amount?.toLocaleString()}</span>
                                                <span className="px-2 py-0.5 bg-red-50 text-red-600 text-[10px] font-black rounded uppercase">{item.status}</span>
                                              </div>
                                            </div>
                                          ))
                                        ) : (
                                          <div className="text-center py-4 text-gray-400 text-xs font-medium italic">No specific line discrepancies found (possible formula aggregate difference).</div>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {activeTab === "Mapping Consistency" && (
                    <div className="animate-fade-in space-y-4">
                      <div className="p-4 bg-indigo-50 text-indigo-700 rounded-xl text-xs font-bold">Comparing AiWB GMP Logic (Unit Master B) vs Deloitte Global Framework (Unit Master D)</div>
                      <div className="grid grid-cols-1 gap-4">
                        {projectData?.audit_tabs?.mapping_consistency?.variances.map((v: any, i: number) => (
                          <div key={i} className="flex items-center justify-between p-4 border border-gray-100 rounded-2xl">
                            <div>
                              <p className="text-sm font-bold text-gray-900">{v.item}</p>
                              <div className="flex gap-4 mt-1">
                                <span className="text-[10px] text-gray-400 uppercase font-black">AiWB: {v.aiwb}</span>
                                <span className="text-[10px] text-gray-400 uppercase font-black">Auditor: {v.auditor}</span>
                              </div>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${v.status === 'Match' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{v.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeTab === "Scoping Logic" && (
                    <div className="animate-fade-in">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-[10px] font-black text-gray-400 uppercase tracking-widest border-b border-gray-50">
                            <th className="pb-4">Group (M/N Filtered)</th>
                            <th className="pb-4">Category 1</th>
                            <th className="pb-4">Category 2</th>
                            <th className="pb-4">M Value</th>
                            <th className="pb-4">N Value</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm font-medium">
                          {projectData?.audit_tabs?.scoping_logic
                            .filter((item: any) => item.m_val !== null || item.n_val !== null)
                            .map((s: any, i: number) => (
                            <tr key={i} className="border-b border-gray-50">
                              <td className="py-4 font-black text-gray-900">{s.group}</td>
                              <td className="py-4 text-gray-500">{s.cat1}</td>
                              <td className="py-4 text-gray-500">{s.cat2}</td>
                              <td className="py-4 font-mono text-xs">{s.m_val || '-'}</td>
                              <td className="py-4 font-mono text-xs">{s.n_val || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {activeTab === "Rule Manual" && (
                    <div className="animate-fade-in grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[
                        { id: "R101", desc: "General Condition Keyword Match", cat: "GC" },
                        { id: "R107", desc: "Standard ROE features (GMP/Fee)", cat: "ROE" },
                        { id: "R201", desc: "Post-settlement Accrual (Final vs Incurred)", cat: "ACC" }
                      ].map((rule, i) => (
                        <div key={i} className="p-6 border border-gray-100 rounded-3xl bg-gray-50/30">
                          <div className="flex justify-between mb-4">
                            <span className="text-blue-600 font-black text-xs">{rule.id}</span>
                            <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded text-[10px] font-bold">{rule.cat}</span>
                          </div>
                          <p className="text-sm text-gray-600 font-medium leading-relaxed">{rule.desc}</p>
                        </div>
                      ))}
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
