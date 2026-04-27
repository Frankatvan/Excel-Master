import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

import yaml


DEFAULT_SEMANTIC_CONFIG_PATH = Path("docs/finance_semantic_config.yaml")
SHEET_FIELD_RESOLVER_LOGGER = logging.getLogger("SheetFieldSemanticResolver")


SEMANTIC_SHEET_FIELD_ALIASES: Dict[str, Dict[str, Sequence[str]]] = {
    "Payable": {
        "vendor": ("Vendor",),
        "invoice_no": ("Invoice No", "Invoice #", "Vendor No."),
        "cost_name": ("Cost Name", "Activity"),
        "cost_code": ("Cost Code",),
        "raw_cost_state": ("Cost State",),
        "unit_code": ("Unit Code", "Unit"),
        "incurred_date": ("Incurred Date",),
        "amount": ("Amount",),
    },
    "Final Detail": {
        "vendor": ("Vendor",),
        "unit_code": ("Unit Code", "Unit"),
        "cost_code": ("Cost Code",),
        "amount": ("Amount",),
        "incurred_date": ("Incurred Date", "Posting Date 1"),
        "posting_date": ("Posting Date 1", "Final Date"),
        "type": ("Type",),
    },
    "Draw request report": {
        "vendor": ("Vendor",),
        "unit_code": ("Unit Code",),
        "invoice_no": ("Invoiced No", "Invoice No", "Invoice #"),
        "draw_invoice": ("Draw Invoice",),
        "cost_code": ("Cost Code",),
        "amount": ("Amount",),
        "raw_cost_state": ("Cost State",),
    },
}

SEMANTIC_SHEET_FIXED_COLUMNS: Dict[str, Dict[str, int]] = {
    # 语义契约：Draw Request report 的 cost_state 固定来自 C 列
    "Draw request report": {
        "raw_cost_state": 3,
    }
}


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


def _normalize_header_token(text: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9\u4e00-\u9fa5]", "", str(text).lower())


def resolve_sheet_field_columns(
    headers: Sequence[Any],
    sheet_name: str,
    fields: Sequence[str] | None = None,
) -> Dict[str, int]:
    """
    按语义字段解析列号（1-based）。
    优先级：fixed column > exact header alias > fuzzy alias。
    """
    aliases = dict(SEMANTIC_SHEET_FIELD_ALIASES.get(sheet_name, {}))
    fixed_columns = dict(SEMANTIC_SHEET_FIXED_COLUMNS.get(sheet_name, {}))
    target_fields = list(fields) if fields is not None else list(aliases.keys())

    normalized_headers = [_normalize_header_token(cell) for cell in headers]
    resolved: Dict[str, int] = {}

    for field in target_fields:
        fixed = fixed_columns.get(field)
        if isinstance(fixed, int) and fixed >= 1:
            resolved[field] = fixed
            continue

        candidates = aliases.get(field, (field,))
        normalized_candidates = [_normalize_header_token(alias) for alias in candidates if _normalize_header_token(alias)]
        if not normalized_candidates:
            continue

        matched_col: int | None = None
        for idx, header_token in enumerate(normalized_headers, start=1):
            if header_token in normalized_candidates:
                matched_col = idx
                break

        if matched_col is None:
            for idx, header_token in enumerate(normalized_headers, start=1):
                for candidate in normalized_candidates:
                    if candidate and candidate in header_token:
                        matched_col = idx
                        break
                if matched_col is not None:
                    break

        if matched_col is not None:
            resolved[field] = matched_col

    return resolved


def resolve_sheet_field_columns_with_fallback(
    headers: Sequence[Any],
    sheet_name: str,
    fallback_columns: Mapping[str, int],
    fields: Sequence[str] | None = None,
    logger: logging.Logger | None = None,
) -> Tuple[Dict[str, int], List[Dict[str, Any]]]:
    """
    语义优先解析 + 物理索引兜底，并输出可审计的 fallback 事件。
    """
    resolved = resolve_sheet_field_columns(headers=headers, sheet_name=sheet_name, fields=fields)
    fallback_events: List[Dict[str, Any]] = []
    target_fields = list(fields) if fields is not None else list(fallback_columns.keys())
    active_logger = logger or SHEET_FIELD_RESOLVER_LOGGER

    for field in target_fields:
        if field in resolved:
            continue
        fallback_index = fallback_columns.get(field)
        if not isinstance(fallback_index, int) or fallback_index < 1:
            continue

        resolved[field] = fallback_index
        event = {
            "event_code": "FALLBACK_TO_PHYSICAL_INDEX",
            "sheet_name": sheet_name,
            "logical_field": field,
            "fallback_column_index": fallback_index,
        }
        fallback_events.append(event)
        active_logger.warning(
            "FALLBACK_TO_PHYSICAL_INDEX sheet=%s field=%s column=%s",
            sheet_name,
            field,
            fallback_index,
        )

    return resolved, fallback_events
