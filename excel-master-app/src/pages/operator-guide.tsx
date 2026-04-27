import fs from "fs";
import path from "path";

import Head from "next/head";
import type { GetStaticProps } from "next";

type OperatorGuidePageProps = {
  content: string;
};

const GUIDE_CANDIDATE_PATHS = [
  path.join(process.cwd(), "../docs/AiWB_财务人员操作说明_v1.0.md"),
  path.join(process.cwd(), "docs/AiWB_财务人员操作说明_v1.0.md"),
];

const FALLBACK_GUIDE = `# AiWB 财务人员操作说明

## Scoping

- GMP 保留为预算口径。
- Final GMP 为重分类口径，需人工维护。
- 新增 Final GMP 时系统会先复制 GMP 的现有值。
- Final GMP 为空时，按非 GMP 参与重分类。

## 常用流程

1. 同步数据。
2. 检查 Scoping、Unit Master、Payable、Final Detail。
3. 验证录入数据。
4. 执行成本重分类。
5. 复核项目利润表与重分类审计结果。
`;

export default function OperatorGuidePage({ content }: OperatorGuidePageProps) {
  return (
    <div className="min-h-screen bg-[#F7F3EA] px-6 py-8 text-[#102A38]">
      <Head>
        <title>财务人员操作说明</title>
      </Head>
      <main className="mx-auto max-w-5xl rounded-[28px] border border-[#D8E3DD] bg-[#FFFDF7] p-6 shadow-[0_18px_60px_rgba(16,42,56,0.08)]">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">财务人员操作说明</h1>
          <a href="/" className="rounded-2xl border border-[#C9D8D1] px-4 py-2 text-sm font-semibold text-[#287A5C]">
            返回工作台
          </a>
        </div>
        <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-[#335768]">{content}</pre>
      </main>
    </div>
  );
}

export const getStaticProps: GetStaticProps<OperatorGuidePageProps> = async () => {
  const guidePath = GUIDE_CANDIDATE_PATHS.find((candidate) => fs.existsSync(candidate));
  const content = guidePath ? fs.readFileSync(guidePath, "utf-8") : FALLBACK_GUIDE;

  return {
    props: {
      content,
    },
  };
};
