# Spec: ExcelSemanticMapper (Refactor Step 1)

## 1. 目标
构建一个“语义发现引擎”，将硬编码的行号（如 Row 23）解耦为基于标签的动态引用。这是解决 Google Sheets 坐标漂移问题的核心底层组件。

## 2. 代码实现 (finance_mapping.py)

```python
import re
import logging

class ExcelSemanticMapper:
    """
    财务逻辑编译器核心：双轨标签驱动的动态行号映射器。
    核心能力：
    1. 动态扫描：实时建立标签与行号的映射。
    2. 双轨锁定：同时兼容 A 列（中文）与 C 列（英文）标签。
    3. 模糊容错：处理空格、大小写及微小的描述差异。
    """
    def __init__(self):
        self.en_map = {}  # C列: English Label -> Row Number
        self.cn_map = {}  # A列: Chinese Name -> Row Number
        self.raw_data = {} # Row Number -> {cn: ..., en: ...}
        self.logger = logging.getLogger("ExcelSemanticMapper")

    def scan_sheet(self, sheet_values):
        """
        扫描 109 表全量数据并构建语义索引。
        sheet_values: 列表的列表 (GSheets API 返回的 values)
        """
        self.en_map = {}
        self.cn_map = {}
        
        for idx, row in enumerate(sheet_values):
            row_num = idx + 1  # Google Sheets 行号从 1 开始
            
            # A列 (Index 0): 中文名称
            cn_label = str(row[0]).strip() if len(row) > 0 else ""
            # C列 (Index 2): 英文标签 (财务穿透逻辑的核心)
            en_label = str(row[2]).strip() if len(row) > 2 else ""

            if cn_label:
                cn_key = self._normalize(cn_label)
                self.cn_map[cn_key] = row_num
            
            if en_label:
                en_key = self._normalize(en_label)
                self.en_map[en_key] = row_num
                
            self.raw_data[row_num] = {"cn": cn_label, "en": en_label}

        self.logger.info(f"Scan complete. Indexed {len(self.en_map)} English and {len(self.cn_map)} Chinese labels.")

    def get_row(self, label):
        """
        根据标签寻找行号。
        优先级：英文精确匹配 > 中文精确匹配 > 英文模糊匹配 > 中文模糊匹配。
        """
        clean_key = self._normalize(label)
        
        # 1. 尝试英文精确匹配
        if clean_key in self.en_map:
            return self.en_map[clean_key]
        
        # 2. 尝试中文精确匹配
        if clean_key in self.cn_map:
            return self.cn_map[clean_key]
        
        # 3. 模糊匹配逻辑 (子串匹配)
        for target_map in [self.en_map, self.cn_map]:
            for k, v in target_map.items():
                if clean_key in k or k in clean_key:
                    self.logger.warning(f"Fuzzy Match: '{label}' -> matched to existing key '{k}' at row {v}")
                    return v
                    
        raise KeyError(f"Critical Error: Semantic label '{label}' not found in either Column A or C. Check sheet structure.")

    def get_ref(self, label, col_letter="F"):
        """便捷方法：直接返回 A1 风格引用，例如 'F23'"""
        return f"{col_letter}{self.get_row(label)}"

    def _normalize(self, text):
        """内部标签归一化：移除特殊字符、空格、转小写，支持中文字符"""
        return re.sub(r'[^a-zA-Z0-9\u4e00-\u9fa5]', '', str(text).lower())
```

## 3. 验证逻辑 (tests/test_semantic_mapper.py)

```python
import pytest
from finance_mapping import ExcelSemanticMapper

def test_semantic_discovery_accuracy():
    # 模拟 109 表数据结构
    # 场景：WB Home Income 在第 5 行，Initial Budget 在第 23 行
    mock_values = [[""] * 5 for _ in range(30)]
    
    # 注入测试标签
    mock_values[4][0] = "WB 房屋收入 "  # 带空格
    mock_values[4][2] = "WB Home Income"
    
    mock_values[22][0] = "初始预算"
    mock_values[22][2] = "Initial Budget (Original Contract Sum)"

    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(mock_values)

    # 验证点 1：英文精确与模糊匹配
    assert mapper.get_row("Initial Budget") == 23
    assert mapper.get_row("WB Home Income") == 5
    
    # 验证点 2：中文匹配
    assert mapper.get_row("初始预算") == 23
    
    # 验证点 3：公式生成
    assert mapper.get_ref("Initial Budget", "G") == "G23"
    
    # 验证点 4：坐标漂移场景（头部插入 2 行）
    shifted_values = [[""] * 5 for _ in range(2)] + mock_values
    mapper.scan_sheet(shifted_values)
    assert mapper.get_row("Initial Budget") == 25
    
    print("\n✅ Verification Passed: Semantic Discovery Engine is stable.")
```

## 4. 交付协议
1. Codex 将 `ExcelSemanticMapper` 写入 `finance_mapping.py`。
2. Codex 将测试代码写入 `tests/test_semantic_mapper.py`。
3. CLI 运行 `pytest tests/test_semantic_mapper.py`。
4. 验证通过后，方可进行 Step 2 的公式逻辑重构。
