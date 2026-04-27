from .finance_mapping import ExcelSemanticMapper


class SemanticFormattingEngine:
    def __init__(self, mapper: ExcelSemanticMapper, sheet_id: int):
        self.mapper = mapper
        self.sheet_id = sheet_id

    def build_bold_row_request(self, label: str, start_col_idx: int = 4, end_col_idx: int = 25):
        """
        动态定位特定标签行，为其添加加粗样式。
        GSheets API 的列索引也是 0-based，E=4, Z=25
        """
        try:
            row_idx = self.mapper.get_row(label) - 1
        except KeyError:
            return None

        return {
            "repeatCell": {
                "range": {
                    "sheetId": self.sheet_id,
                    "startRowIndex": row_idx,
                    "endRowIndex": row_idx + 1,
                    "startColumnIndex": start_col_idx,
                    "endColumnIndex": end_col_idx,
                },
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {"bold": True}
                    }
                },
                "fields": "userEnteredFormat.textFormat.bold",
            }
        }

    def build_number_format_row_request(
        self,
        label: str,
        number_format: dict[str, str],
        start_col_idx: int = 4,
        end_col_idx: int = 11,
    ):
        try:
            row_idx = self.mapper.get_row(label) - 1
        except KeyError:
            return None

        return {
            "repeatCell": {
                "range": {
                    "sheetId": self.sheet_id,
                    "startRowIndex": row_idx,
                    "endRowIndex": row_idx + 1,
                    "startColumnIndex": start_col_idx,
                    "endColumnIndex": end_col_idx,
                },
                "cell": {
                    "userEnteredFormat": {
                        "numberFormat": dict(number_format)
                    }
                },
                "fields": "userEnteredFormat.numberFormat",
            }
        }
