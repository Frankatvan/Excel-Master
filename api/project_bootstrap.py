import json
import os
import hmac
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, Mapping

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# Add both local compatibility logic and canonical package logic to the Python path.
api_dir = Path(__file__).resolve().parent
workspace_root = api_dir.parent.parent if api_dir.parent.name == "excel-master-app" else api_dir.parent
for logic_dir in [api_dir / "logic", workspace_root / "excel-master-app" / "api" / "logic"]:
    logic_path = str(logic_dir)
    if logic_dir.exists() and logic_path not in sys.path:
        sys.path.insert(0, logic_path)

from aiwb_finance.finance_engine import (
    _build_external_import_zone_metadata_requests,
    get_sheets_service,
    initialize_project_workbook,
    run_validate_input_data,
)
from aiwb_finance.finance_utils import _get_service_account_info, _safe_string


SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
PROJECT_SEQUENCE_PATTERN = re.compile(r"^\d{3}$")
DEFAULT_TEMPLATE_ENV_KEYS = ("GOLDEN_TEMPLATE_ID", "GOOGLE_SHEET_TEMPLATE_ID", "GOOGLE_SHEET_ID")


def create_drive_service():
    credentials = Credentials.from_service_account_info(_get_service_account_info(), scopes=SCOPES)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _build_project_creation_file_name(
    project_sequence: str,
    project_short_name: str,
    *,
    created_at: datetime | None = None,
) -> str:
    normalized_sequence = _safe_string(project_sequence)
    if not PROJECT_SEQUENCE_PATTERN.fullmatch(normalized_sequence):
        raise ValueError("project_sequence must be exactly 3 digits.")

    normalized_short_name = " ".join(_safe_string(project_short_name).split())
    if not normalized_short_name:
        raise ValueError("project_short_name is required.")

    creation_date = created_at or datetime.now()
    return f"Project Ledger_{normalized_sequence}_{normalized_short_name}_{creation_date.strftime('%Y.%m.%d')}.xlsx"


def _resolve_template_spreadsheet_id(payload: Mapping[str, Any]) -> str:
    explicit_template_id = (
        _safe_string(payload.get("golden_template_id"))
        or _safe_string(payload.get("template_spreadsheet_id"))
        or _safe_string(payload.get("source_template_id"))
    )
    if explicit_template_id:
        return explicit_template_id

    for env_key in DEFAULT_TEMPLATE_ENV_KEYS:
        candidate = _safe_string(os.getenv(env_key))
        if candidate:
            return candidate
    return ""


def copy_from_template(
    *,
    drive_service,
    template_spreadsheet_id: str,
    project_sequence: str,
    project_short_name: str,
) -> Dict[str, str]:
    normalized_template_id = _safe_string(template_spreadsheet_id)
    if not normalized_template_id:
        raise ValueError("template_spreadsheet_id is required.")

    creation_file_name = _build_project_creation_file_name(project_sequence, project_short_name)
    template_metadata = (
        drive_service.files()
        .get(
            fileId=normalized_template_id,
            fields="name,parents",
            supportsAllDrives=True,
        )
        .execute()
    )
    template_parents = [
        _safe_string(parent_id)
        for parent_id in (template_metadata or {}).get("parents", [])
        if _safe_string(parent_id)
    ]

    copy_request_body: Dict[str, Any] = {"name": creation_file_name}
    if template_parents:
        copy_request_body["parents"] = template_parents

    copy_response = (
        drive_service.files()
        .copy(
            fileId=normalized_template_id,
            fields="id",
            supportsAllDrives=True,
            body=copy_request_body,
        )
        .execute()
    )
    spreadsheet_id = _safe_string((copy_response or {}).get("id"))
    if not spreadsheet_id:
        raise RuntimeError("Template copy failed: missing spreadsheet id.")

    return {
        "spreadsheet_id": spreadsheet_id,
        "spreadsheet_url": f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit",
        "creation_file_name": creation_file_name,
    }


def grant_creator_write_access(
    *,
    drive_service,
    spreadsheet_id: str,
    creator_email: str,
) -> bool:
    normalized_email = _safe_string(creator_email)
    if not normalized_email:
        return False

    drive_service.permissions().create(
        fileId=spreadsheet_id,
        sendNotificationEmail=False,
        supportsAllDrives=True,
        body={
            "type": "user",
            "role": "writer",
            "emailAddress": normalized_email,
        },
    ).execute()
    return True


def cleanup_copied_spreadsheet(
    *,
    drive_service,
    spreadsheet_id: str,
) -> None:
    normalized_id = _safe_string(spreadsheet_id)
    if not normalized_id:
        return
    drive_service.files().delete(
        fileId=normalized_id,
        supportsAllDrives=True,
    ).execute()


def sanitize_project_data(
    *,
    sheets_service,
    spreadsheet_id: str,
    project_name: str,
    project_owner: str,
    creator_email: str,
    project_sequence: str,
) -> Dict[str, Any]:
    return initialize_project_workbook(
        service=sheets_service,
        spreadsheet_id=spreadsheet_id,
        project_name=project_name,
        project_owner=project_owner,
        creator_email=creator_email,
        sheet_109_title=project_sequence,
    )


def backfill_external_import_zone_metadata(*, sheets_service, spreadsheet_id: str) -> Dict[str, Any]:
    requests = _build_external_import_zone_metadata_requests(sheets_service, spreadsheet_id)
    if requests:
        sheets_service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": requests}).execute()

    zone_keys = []
    source_roles = []
    for request in requests:
        metadata = request.get("createDeveloperMetadata", {}).get("developerMetadata", {})
        metadata_value = metadata.get("metadataValue")
        if not metadata_value:
            continue
        try:
            payload = json.loads(metadata_value)
        except Exception:
            continue
        zone_key = _safe_string(payload.get("zone_key"))
        source_role = _safe_string(payload.get("source_role"))
        if zone_key:
            zone_keys.append(zone_key)
        if source_role:
            source_roles.append(source_role)

    return {
        "external_import_zone_metadata_request_count": len(requests),
        "external_import_zone_count": len(zone_keys),
        "zone_keys": zone_keys,
        "source_roles": source_roles,
    }


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        worker_secret = self._resolve_worker_secret()
        if not worker_secret:
            self._send_error(500, "Worker secret is not configured.")
            return

        provided_secret = self.headers.get("X-AiWB-Worker-Secret")
        if not isinstance(provided_secret, str) or not hmac.compare_digest(provided_secret, worker_secret):
            self._send_error(401, "Unauthorized")
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        post_data = self.rfile.read(content_length)

        try:
            data = json.loads(post_data or b"{}")
        except Exception as error:
            self._send_error(400, f"Invalid JSON: {error}")
            return

        operation = self._read_optional_string(data, "operation") or "bootstrap"
        spreadsheet_id = self._read_optional_string(data, "spreadsheet_id")

        if operation == "backfill_external_import_zones":
            if not spreadsheet_id:
                self._send_error(400, "Missing required fields: spreadsheet_id")
                return

            try:
                service = get_sheets_service()
                summary = backfill_external_import_zone_metadata(
                    sheets_service=service,
                    spreadsheet_id=spreadsheet_id,
                )
            except Exception as error:
                self._send_error(500, f"Processing failed: {error}")
                return

            self._send_json(
                200,
                {
                    "status": "success",
                    "spreadsheet_id": spreadsheet_id,
                    "summary": summary,
                },
            )
            return

        if operation == "validate_input":
            if not spreadsheet_id:
                self._send_error(400, "Missing required fields: spreadsheet_id")
                return

            try:
                service = get_sheets_service()
                summary = run_validate_input_data(service, spreadsheet_id)
            except Exception as error:
                self._send_error(500, f"Processing failed: {error}")
                return

            self._send_json(
                200,
                {
                    "status": "success",
                    "spreadsheet_id": spreadsheet_id,
                    "summary": summary,
                },
            )
            return

        if operation == "bootstrap_from_template":
            project_sequence = self._read_required_string(data, "project_sequence") or self._read_required_string(
                data, "project_serial"
            )
            project_short_name = self._read_required_string(data, "project_short_name") or self._read_required_string(
                data, "short_name"
            )
            project_name = self._read_required_string(data, "project_name") or project_short_name
            project_owner = self._read_required_string(data, "project_owner")
            creator_email = self._read_optional_string(data, "creator_email")
            template_spreadsheet_id = _resolve_template_spreadsheet_id(data)

            missing_fields = [
                field_name
                for field_name, value in (
                    ("project_sequence", project_sequence),
                    ("project_short_name", project_short_name),
                    ("project_owner", project_owner),
                    ("template_spreadsheet_id", template_spreadsheet_id),
                )
                if not value
            ]
            if missing_fields:
                self._send_error(400, f"Missing required fields: {', '.join(missing_fields)}")
                return

            copied_spreadsheet_id = ""
            writer_permission_granted = False
            try:
                drive_service = create_drive_service()
                copy_result = copy_from_template(
                    drive_service=drive_service,
                    template_spreadsheet_id=template_spreadsheet_id,
                    project_sequence=project_sequence,
                    project_short_name=project_short_name,
                )
                copied_spreadsheet_id = copy_result["spreadsheet_id"]
                writer_permission_granted = grant_creator_write_access(
                    drive_service=drive_service,
                    spreadsheet_id=copied_spreadsheet_id,
                    creator_email=creator_email or "",
                )
                sheets_service = get_sheets_service()
                summary = sanitize_project_data(
                    sheets_service=sheets_service,
                    spreadsheet_id=copied_spreadsheet_id,
                    project_name=project_name,
                    project_owner=project_owner,
                    creator_email=creator_email or "",
                    project_sequence=project_sequence,
                )
            except Exception as error:
                if copied_spreadsheet_id:
                    try:
                        cleanup_copied_spreadsheet(
                            drive_service=drive_service,
                            spreadsheet_id=copied_spreadsheet_id,
                        )
                    except Exception:
                        pass
                self._send_error(500, f"Processing failed: {error}")
                return

            self._send_json(
                200,
                {
                    "status": "success",
                    "message": "Project workbook cloned and initialized successfully",
                    "spreadsheet_id": copy_result["spreadsheet_id"],
                    "spreadsheet_url": copy_result["spreadsheet_url"],
                    "creation_file_name": copy_result["creation_file_name"],
                    "writer_permission_granted": writer_permission_granted,
                    "summary": summary,
                },
            )
            return

        if operation != "bootstrap":
            self._send_error(400, f"Unsupported operation: {operation}")
            return

        project_name = self._read_required_string(data, "project_name")
        project_owner = self._read_required_string(data, "project_owner")
        creator_email = self._read_optional_string(data, "creator_email")
        project_sequence = self._read_required_string(data, "project_sequence") or self._read_required_string(
            data, "project_serial"
        )

        missing_fields = [
            field_name
            for field_name, value in (
                ("spreadsheet_id", spreadsheet_id),
                ("project_name", project_name),
                ("project_owner", project_owner),
                ("project_sequence", project_sequence),
            )
            if not value
        ]
        if missing_fields:
            self._send_error(400, f"Missing required fields: {', '.join(missing_fields)}")
            return

        try:
            summary = sanitize_project_data(
                sheets_service=get_sheets_service(),
                spreadsheet_id=spreadsheet_id,
                project_name=project_name,
                project_owner=project_owner,
                creator_email=creator_email or "",
                project_sequence=project_sequence,
            )
        except Exception as error:
            self._send_error(500, f"Processing failed: {error}")
            return

        self._send_json(
            200,
            {
                "status": "success",
                "message": "Project workbook initialized successfully",
                "spreadsheet_id": spreadsheet_id,
                "summary": summary,
            },
        )

    def _read_required_string(self, data, key):
        value = data.get(key)
        if isinstance(value, str):
            value = value.strip()
        return value if value else None

    def _read_optional_string(self, data, key):
        value = data.get(key)
        if isinstance(value, str):
            return value.strip()
        return ""

    def _resolve_worker_secret(self):
        secret = os.getenv("PROJECT_BOOTSTRAP_WORKER_SECRET") or os.getenv("AIWB_WORKER_SECRET") or ""
        return secret.strip()

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _send_error(self, status_code, message):
        self._send_json(status_code, {"status": "error", "message": message})
