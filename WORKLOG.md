# AiWB 项目执行日志 (Worklog)

## [2026-04-20] - 模式回归与 M1 完成 (Logic Refactored)
- **状态同步**: 根据 `AI_MISSION.md` 最高宪章，全面回归 **Architect-Codex** 模式。
- **模式切换**: 移除“只读/文档更新”限制，恢复 100% 的代码控制权与重构权。
- **M1 任务完成**: 彻底重构了成本重分类判定引擎。
    - **优先级重构**: 实现了 R101-R108 (结算前) 和 R201-R205 (结算后) 的完整逻辑链，支持 GC2, GC Income, Direct (fallback) 等新分类。
    - **审计完整性**: 取消了 Scoping E=1 的硬过滤，通过 R108 (Direct) 确保全量成本入账，实现账平。
    - **保修期算法**: 接入 Unit Master，实现了基于 C/O Date 的动态保修期 (Warranty Expiry Date) 计算。
    - **TBD 精准判定**: R203 逻辑升级为 (日期窗口 + Scoping J=6) 双重校验。
    - **公式适配**: 在 `finance_formulas.py` 和 `finance_engine.py` 中完成了对新分类的 109 表 SUMIFS 公式支持。
- **下一步**: 执行 TDD 验证，确保所有 Rule ID 在测试用例中 100% 跑通。
