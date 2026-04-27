export const WORKBENCH_STAGES = {
  PROJECT_CREATED: "project_created",
  EXTERNAL_DATA_READY: "external_data_ready",
  MANUAL_INPUT_READY: "manual_input_ready",
  LOCKED_109_APPROVED: "locked_109_approved",
} as const;

export type WorkbenchStage = (typeof WORKBENCH_STAGES)[keyof typeof WORKBENCH_STAGES];

export type ProjectAction =
  | "open_sheet"
  | "sync_data"
  | "validate_input"
  | "reclassify"
  | "approve_109"
  | "unlock_data";

export type DirtyState = {
  external_data_dirty: boolean;
  manual_input_dirty: boolean;
};

export type ProjectStateForActions = {
  current_stage: WorkbenchStage;
  locked: boolean;
  isOwnerOrAdmin: boolean;
};

const STAGE_LABELS: Record<WorkbenchStage, string> = {
  [WORKBENCH_STAGES.PROJECT_CREATED]: "项目报表已创建",
  [WORKBENCH_STAGES.EXTERNAL_DATA_READY]: "外部数据表已更新",
  [WORKBENCH_STAGES.MANUAL_INPUT_READY]: "人工录入数据已完善",
  [WORKBENCH_STAGES.LOCKED_109_APPROVED]: "提交审计确认 / 数据已锁定",
};

const UNLOCKED_ACTIONS: ProjectAction[] = [
  "open_sheet",
  "sync_data",
  "validate_input",
  "reclassify",
  "approve_109",
];

const LOCKED_ACTIONS: ProjectAction[] = ["open_sheet", "sync_data"];

export function getStageLabel(stage?: WorkbenchStage | string | null): string {
  if (stage == null) {
    return STAGE_LABELS[WORKBENCH_STAGES.PROJECT_CREATED];
  }

  return Object.prototype.hasOwnProperty.call(STAGE_LABELS, stage)
    ? STAGE_LABELS[stage as WorkbenchStage]
    : stage;
}

export function getRollbackStageForDirtyState(state: DirtyState): WorkbenchStage | null {
  if (state.external_data_dirty) {
    return WORKBENCH_STAGES.PROJECT_CREATED;
  }

  if (state.manual_input_dirty) {
    return WORKBENCH_STAGES.EXTERNAL_DATA_READY;
  }

  return null;
}

export function canShowUnlockData(state: ProjectStateForActions): boolean {
  return (
    state.locked &&
    state.current_stage === WORKBENCH_STAGES.LOCKED_109_APPROVED &&
    state.isOwnerOrAdmin
  );
}

export function getAvailableProjectActions(state: ProjectStateForActions): ProjectAction[] {
  if (state.locked) {
    return state.isOwnerOrAdmin ? [...LOCKED_ACTIONS, "unlock_data"] : [...LOCKED_ACTIONS];
  }

  return [...UNLOCKED_ACTIONS];
}
