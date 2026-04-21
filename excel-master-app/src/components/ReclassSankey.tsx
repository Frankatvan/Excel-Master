import { ResponsiveContainer, Sankey, Tooltip } from "recharts";

interface SankeyProps {
  data: {
    nodes: Array<{ name: string }>;
    links: Array<{ source: number; target: number; value: number }>;
  };
}

export default function ReclassSankey({ data }: SankeyProps) {
  const hasFlow = data.nodes.length > 0 && data.links.length > 0;

  return (
    <div className="h-[500px] w-full rounded-3xl border border-gray-100 bg-white p-8 shadow-sm">
      <h3 className="mb-3 text-sm font-black uppercase tracking-widest text-gray-400">Cost Reclassification Flow</h3>
      <p className="mb-8 max-w-2xl text-sm leading-6 text-slate-500">
        Use this flow to understand how old cost states move into the new reclassification categories once snapshot
        data is available.
      </p>
      {hasFlow ? (
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            node={{ stroke: "#f1f5f9", strokeWidth: 2 }}
            link={{ stroke: "#e2e8f0" }}
            margin={{ top: 20, right: 100, bottom: 20, left: 10 }}
          >
            <Tooltip
              contentStyle={{
                borderRadius: "12px",
                border: "none",
                boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
              }}
            />
          </Sankey>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[360px] items-center justify-center rounded-[1.75rem] border border-dashed border-slate-200 bg-slate-50 px-6 text-center text-sm font-medium leading-6 text-slate-500">
          Reclassification flow will appear here after the snapshot contains source-to-target movement data.
        </div>
      )}
    </div>
  );
}
