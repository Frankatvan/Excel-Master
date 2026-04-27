import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { renameProjectSpreadsheetFile } from "@/lib/project-bootstrap";
import {
  buildProjectLedgerFileName,
  getProjectRegistryProject,
  resolveProjectMainSheetTitle,
} from "@/lib/project-registry";
import { ProjectAccessError, requireDriveOwner, requireProjectCollaborator } from "@/lib/project-access";
import {
  appendAuditLog,
  getProjectState,
  writeProjectState,
  type PersistedProjectState,
  type ProjectState,
} from "@/lib/project-state-sheet";
import { WORKBENCH_STAGES } from "@/lib/workbench-stage";
import { authOptions } from "../auth/[...nextauth]";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const spreadsheetId =
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheetId ??
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheet_id;

  return readString(spreadsheetId);
}

function readAction(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  return readString((body as { action?: unknown }).action);
}

function resolveProjectBootstrapWorkerUrl() {
  const configuredUrl = process.env.PROJECT_BOOTSTRAP_WORKER_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }
  throw new Error("Project bootstrap worker URL is not configured.");
}

function resolveProjectBootstrapWorkerSecret() {
  const configuredSecret = process.env.PROJECT_BOOTSTRAP_WORKER_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  const fallbackSecret = process.env.AIWB_WORKER_SECRET?.trim();
  if (fallbackSecret) {
    return fallbackSecret;
  }

  return undefined;
}

async function parseWorkerBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error("Worker response body is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Worker response body is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Worker response body is not an object");
  }

  return parsed as Record<string, unknown>;
}

function toPersistedState(state: ProjectState): PersistedProjectState {
  const { is_owner_or_admin: _ignored, ...persisted } = state;
  return persisted;
}

async function renameLockedProjectLedgerFile(spreadsheetId: string) {
  const registryProject = await getProjectRegistryProject(spreadsheetId);
  const projectName = typeof registryProject?.name === "string" ? registryProject.name.trim() : "";
  const projectSerial = registryProject ? resolveProjectMainSheetTitle(registryProject) : "";

  if (!projectName || !projectSerial) {
    return false;
  }

  const lockedFileName = buildProjectLedgerFileName({
    projectSerial,
    projectName,
    createdAt: new Date(),
  });
  await renameProjectSpreadsheetFile(spreadsheetId, lockedFileName);
  return true;
}

async function approve109(spreadsheetId: string, actorEmail: string, state: ProjectState) {
  if (state.external_data_dirty || state.manual_input_dirty) {
    return {
      status: 409,
      body: { error: "项目数据已变更，请先完成同步和重分类后再审批" },
    };
  }

  await renameLockedProjectLedgerFile(spreadsheetId);

  const now = new Date().toISOString();
  const nextState: PersistedProjectState = {
    ...toPersistedState(state),
    current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
    locked: true,
    locked_at: now,
    locked_by: actorEmail,
    last_109_initial_approval_at: now,
  };

  await writeProjectState(spreadsheetId, nextState);
  await appendAuditLog(spreadsheetId, {
    actor_email: actorEmail,
    action: "approve_109",
    previous_stage: state.current_stage,
    next_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
    status: "success",
    message: "Audit confirmation recorded and data locked.",
  });

  return {
    status: 200,
    body: { state: nextState },
  };
}

async function validateInput(
  req: NextApiRequest,
  spreadsheetId: string,
  actorEmail: string,
  state: ProjectState,
) {
  try {
    const workerSecret = resolveProjectBootstrapWorkerSecret();
    if (!workerSecret) {
      return {
        status: 500,
        body: { error: "Worker secret is not configured." },
      };
    }

    const workerResponse = await fetch(resolveProjectBootstrapWorkerUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AiWB-Worker-Secret": workerSecret,
      },
      body: JSON.stringify({
        operation: "validate_input",
        spreadsheet_id: spreadsheetId,
      }),
    });

    if (!workerResponse.ok) {
      return {
        status: 502,
        body: { error: "验证录入数据失败" },
      };
    }

    const workerBody = await parseWorkerBody(workerResponse);
    if (workerBody.status !== "success") {
      return {
        status: 502,
        body: { error: "验证录入数据失败" },
      };
    }

    const now = new Date().toISOString();
    const nextState: PersistedProjectState = {
      ...toPersistedState(state),
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: false,
      locked: false,
      last_validate_input_at: now,
    };

    await appendAuditLog(spreadsheetId, {
      actor_email: actorEmail,
      action: "validate_input",
      previous_stage: state.current_stage,
      next_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      status: "success",
      message: "Input data validated and generated.",
    });
    await writeProjectState(spreadsheetId, nextState);

    return {
      status: 200,
      body: { state: nextState, summary: workerBody.summary },
    };
  } catch {
    return {
      status: 502,
      body: { error: "验证录入数据失败" },
    };
  }
}

async function unlockData(spreadsheetId: string, actorEmail: string, state: ProjectState) {
  const now = new Date().toISOString();
  const nextState: PersistedProjectState = {
    ...toPersistedState(state),
    current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
    locked: false,
    unlocked_at: now,
    unlocked_by: actorEmail,
  };

  await writeProjectState(spreadsheetId, nextState);
  await appendAuditLog(spreadsheetId, {
    actor_email: actorEmail,
    action: "unlock_data",
    previous_stage: state.current_stage,
    next_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
    status: "success",
    message: "Data unlocked by project owner.",
  });

  return {
    status: 200,
    body: { state: nextState },
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  const session = await getServerSession(req, res, authOptions);
  const actorEmail = session?.user?.email;
  if (!actorEmail) {
    return res.status(401).json({ error: "未登录" });
  }

  const spreadsheetId = readSpreadsheetId(req.body);
  if (!spreadsheetId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id" });
  }

  const action = readAction(req.body);
  if (!action) {
    return res.status(400).json({ error: "缺少 action" });
  }

  if (action !== "approve_109" && action !== "unlock_data" && action !== "validate_input") {
    return res.status(400).json({ error: "不支持的项目动作" });
  }

  try {
    if (action === "unlock_data") {
      await requireDriveOwner(spreadsheetId, actorEmail);
    } else {
      await requireProjectCollaborator(spreadsheetId, actorEmail);
    }

    const state = await getProjectState(spreadsheetId, actorEmail);
    const result =
      action === "approve_109"
        ? await approve109(spreadsheetId, actorEmail, state)
        : action === "unlock_data"
          ? await unlockData(spreadsheetId, actorEmail, state)
          : await validateInput(req, spreadsheetId, actorEmail, state);

    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "项目动作执行失败" });
  }
}
