# Spec: 109 Final Cleanup (The Last Puzzle)

## 1. 目标
完成 109 表 100% 的语义化覆盖，重点解决 Retention, Tax 和 Net Profit 的动态引用问题。

## 2. 逻辑扩展 (finance_formulas.py)

```python
    def get_retention_formula(self, col: str):
        """
        Retention = Confirmed_Revenue * Retention_Rate
        """
        ref_rev = self.mapper.get_ref("Revenue Recognized (Current Period)", col)
        # 假设 Retention Rate 标签为 "Retention Percentage"
        ref_rate = self.mapper.get_ref("Retention Percentage", col)
        return f"=N({ref_rev}) * N({ref_rate})"

    def get_net_profit_formula(self, col: str):
        """
        Net Profit = ROE * (1 - Tax_Rate)
        """
        ref_roe = self.mapper.get_ref("ROE (Current Period)", col)
        ref_tax_rate = self.mapper.get_ref("Corporate Tax Rate", col)
        return f"=N({ref_roe}) * (1 - N({ref_tax_rate}))"
```

## 3. 配置同步 (docs/finance_semantic_config.yaml)
在 109 部分增加：
```yaml
      retention_rate: "Retention Percentage"
      tax_rate: "Corporate Tax Rate"
      net_profit: "Net Profit (Post-Tax)"
```

## 4. 交付验收
- 确保 F 到 V 列的每一列都能生成包含 Retention 和 Net Profit 的公式。
- 验证税率引用是否能随行号漂移。
