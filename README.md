# AiWB: GMP Financial Audit & Reclassification Engine

## 1. 项目本质
AiWB (AI Working Board) 是一个符合 **HKFRS 15 (投入法)** 标准的项目级财务核算引擎。它通过对 WBS 原始成本数据进行智能打标与重分类，自动化生成 109 表（项目级利润表），实现收入、成本与毛利的闭环核算。

## 2. 核心架构
本项目采用 **Vercel + Supabase + Google Sheets** 的生产级 PaaS 架构：
- **数据源 (White-box Audit)**: 所有财务逻辑最终沉淀在 Google Sheet 的原生公式中，支持审计师逐格复核。
- **计算内核 (Python)**: 运行在 Serverless Functions 中，执行复杂的 Rule ID 判定与保修期计算。
- **访问控制 (Share-to-Login)**: 利用 Google Sheet 共享机制作为白名单。只有被授权访问 Sheet 的邮箱方可登录本平台。

## 3. 部署状态 (audit.frankzh.top)
- **域名**: https://audit.frankzh.top
- **后端**: Supabase PostgreSQL
- **验证**: NextAuth (Google Provider)

## 4. 维护说明
本项目遵循 **《AiWB 最高授权协议 (Architect-Codex)》**，由 AI 架构师 (Gemini CLI) 负责 100% 的逻辑闭环与重构。任何逻辑变更必须同步更新审计手册并跑通 TDD 验证。

---
© 2026 Wanbridge Group | Proprietary and Confidential
