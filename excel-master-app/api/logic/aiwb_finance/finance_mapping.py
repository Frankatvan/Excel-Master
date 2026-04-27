import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

import yaml


DEFAULT_SEMANTIC_CONFIG_PATH = Path("docs/finance_semantic_config.yaml")
FIELD_ALIASES: Dict[str, Tuple[str, ...]] = {
    "amount": ("Amount",),
    "cost_code": ("Cost Code", "CostCode"),
    "cost_name": ("Cost Name", "CostName"),
    "draw_invoice": ("Draw Invoice",),
    "invoice_no": ("Invoice No", "Invoice No.", "Invoice Number", "Invoice #", "Invoiced No", "Invoiced No."),
    "posting_date": ("Posting Date", "Posting Date 1", "Post Date"),
    "raw_cost_state": ("Cost State", "Raw Cost State"),
    "unit_code": ("Unit Code", "Unit", "Unit No", "Unit No."),
    "vendor": ("Vendor",),
    "year": ("Year", "实际结算年份"),
}
FIXED_FIELD_COLUMNS: Dict[Tuple[str, str], int] = {
    ("draw request report", "raw_cost_state"): 3,
}


def _normalize_header_match_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def resolve_sheet_field_columns(
    headers: Sequence[Any],
    sheet_name: str,
    fields: Sequence[str] = (),
) -> Dict[str, int]:
    layout, _ = resolve_sheet_field_columns_with_fallback(
        headers=headers,
        sheet_name=sheet_name,
        fields=fields,
    )
    return layout


def resolve_sheet_field_columns_with_fallback(
    *,
    headers: Sequence[Any],
    sheet_name: str,
    fallback_columns: Mapping[str, Any] | None = None,
    fields: Sequence[str] = (),
) -> Tuple[Dict[str, int], List[Dict[str, Any]]]:
    logger = logging.getLogger("SheetFieldSemanticResolver")
    normalized_headers = {
        _normalize_header_match_key(header): index
        for index, header in enumerate(headers, start=1)
        if _normalize_header_match_key(header)
    }
    fallback_columns = fallback_columns or {}
    normalized_sheet = str(sheet_name or "").strip().lower()
    layout: Dict[str, int] = {}
    warnings: List[Dict[str, Any]] = []

    for field in fields:
        fixed_column = FIXED_FIELD_COLUMNS.get((normalized_sheet, field))
        if fixed_column:
            layout[field] = fixed_column
            continue

        for alias in FIELD_ALIASES.get(field, (field,)):
            column_index = normalized_headers.get(_normalize_header_match_key(alias))
            if column_index:
                layout[field] = column_index
                break
        if field in layout:
            continue

        fallback_column = fallback_columns.get(field)
        if fallback_column:
            event = {
                "event_code": "FALLBACK_TO_PHYSICAL_INDEX",
                "sheet_name": sheet_name,
                "logical_field": field,
                "physical_index": int(fallback_column),
            }
            layout[field] = int(fallback_column)
            warnings.append(event)
            logger.warning(
                "FALLBACK_TO_PHYSICAL_INDEX sheet=%s field=%s column=%s",
                sheet_name,
                field,
                fallback_column,
            )

    return layout, warnings


class ExcelSemanticMapper:
    """
    财务逻辑编译器核心：双轨标签驱动的动态行号映射器。

    核心能力：
    1. 动态扫描：实时建立标签与行号的映射。
    2. 双轨锁定：同时兼容 A 列（中文）与 C 列（英文）标签。
    3. 模糊容错：处理空格、大小写及微小的描述差异。
    """

    def __init__(self):
        self.en_map = {}
        self.cn_map = {}
        self.col_map = {}
        self.raw_data = {}
        self.config = {}
        self.sheet_name = ""
        self.label_col_idx = 2
        self.logger = logging.getLogger("ExcelSemanticMapper")

    def scan_sheet(self, sheet_values, label_col_idx=2):
        """
        扫描财务报表全量数据并构建语义索引。
        同时扫描首行作为列名映射。
        """
        self.en_map = {}
        self.cn_map = {}
        self.col_map = {}
        self.raw_data = {}
        self.label_col_idx = int(label_col_idx)

        if not sheet_values:
            return

        # 扫描列头
        header_row = sheet_values[0]
        for idx, col_name in enumerate(header_row):
            if col_name:
                self.col_map[self._normalize(col_name)] = idx + 1

        for idx, row in enumerate(sheet_values):
            row_num = idx + 1

            cn_label = str(row[0]).strip() if len(row) > 0 else ""
            en_label = str(row[self.label_col_idx]).strip() if len(row) > self.label_col_idx else ""

            if cn_label:
                cn_key = self._normalize(cn_label)
                self.cn_map[cn_key] = row_num

            if en_label:
                en_key = self._normalize(en_label)
                self.en_map[en_key] = row_num

            self.raw_data[row_num] = {"cn": cn_label, "en": en_label}

        self.logger.info(
            "Scan complete. Indexed %s English and %s Chinese labels.",
            len(self.en_map),
            len(self.cn_map),
        )

    def get_row(self, label):
        """
        根据标签寻找行号。
        优先级：英文精确匹配 > 中文精确匹配 > 英文模糊匹配 > 中文模糊匹配。
        """
        clean_key = self._normalize(label)

        if clean_key in self.en_map:
            return self.en_map[clean_key]

        if clean_key in self.cn_map:
            return self.cn_map[clean_key]

        for target_map in (self.en_map, self.cn_map):
            for existing_key, row_num in target_map.items():
                if clean_key in existing_key or existing_key in clean_key:
                    self.logger.warning(
                        "Fuzzy Match: '%s' -> matched to existing key '%s' at row %s",
                        label,
                        existing_key,
                        row_num,
                    )
                    return row_num

        raise KeyError(
            f"Critical Error: Semantic label '{label}' not found in either Column A or C. Check sheet structure."
        )

    def get_col(self, semantic_label):
        """
        根据语义标签寻找列号（1-based）。
        """
        # 1. 从配置中获取标准列名
        columns_config = self.config.get("columns", {})
        standard_name = columns_config.get(semantic_label, semantic_label)

        # 2. 查找该列名的索引（归一化匹配）
        clean_key = self._normalize(standard_name)
        if clean_key in self.col_map:
            return self.col_map[clean_key]

        # 模糊匹配列名
        for existing_key, col_idx in self.col_map.items():
            if clean_key in existing_key or existing_key in clean_key:
                self.logger.warning(
                    "Fuzzy Column Match: '%s' -> matched to existing header '%s' at column %s",
                    semantic_label,
                    existing_key,
                    col_idx,
                )
                return col_idx

        return None

    def get_ref(self, label, col_letter="F"):
        """便捷方法：直接返回 A1 风格引用，例如 'F23'"""
        return f"{col_letter}{self.get_row(label)}"

    def _normalize(self, text):
        """内部标签归一化：移除特殊字符、空格、转小写，支持中文字符"""
        return re.sub(r"[^a-zA-Z0-9\u4e00-\u9fa5]", "", str(text).lower())


class MapperFactory:
    @staticmethod
    def create(sheet_name, values, config_path=DEFAULT_SEMANTIC_CONFIG_PATH):
        text = Path(config_path).read_text(encoding="utf-8")
        config = yaml.safe_load(text) or {}
        sheet_config = dict((config.get("finance_sheets") or {}).get(sheet_name, {}))
        if not sheet_config:
            raise KeyError(f"unknown semantic sheet config: {sheet_name}")

        mapper = ExcelSemanticMapper()
        mapper.sheet_name = str(sheet_name)
        mapper.config = sheet_config
        mapper.scan_sheet(values, label_col_idx=int(sheet_config.get("label_col_idx", 2)))
        return mapper
