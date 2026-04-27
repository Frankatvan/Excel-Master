import {
  WORKBENCH_STAGES,
  getStageLabel,
  getRollbackStageForDirtyState,
  canShowUnlockData,
  getAvailableProjectActions,
} from "@/lib/workbench-stage";

describe("workbench stage model", () => {
  it("uses user-facing stage labels", () => {
    expect(getStageLabel(WORKBENCH_STAGES.PROJECT_CREATED)).toBe("项目报表已创建");
    expect(getStageLabel(WORKBENCH_STAGES.EXTERNAL_DATA_READY)).toBe("外部数据表已更新");
    expect(getStageLabel(WORKBENCH_STAGES.MANUAL_INPUT_READY)).toBe("人工录入数据已完善");
    expect(getStageLabel(WORKBENCH_STAGES.LOCKED_109_APPROVED)).toBe("提交审计确认 / 数据已锁定");
  });

  it("rolls back by dirty data priority", () => {
    expect(getRollbackStageForDirtyState({ external_data_dirty: true, manual_input_dirty: false })).toBe(
      WORKBENCH_STAGES.PROJECT_CREATED,
    );
    expect(getRollbackStageForDirtyState({ external_data_dirty: false, manual_input_dirty: true })).toBe(
      WORKBENCH_STAGES.EXTERNAL_DATA_READY,
    );
    expect(getRollbackStageForDirtyState({ external_data_dirty: true, manual_input_dirty: true })).toBe(
      WORKBENCH_STAGES.PROJECT_CREATED,
    );
    expect(getRollbackStageForDirtyState({ external_data_dirty: false, manual_input_dirty: false })).toBeNull();
  });

  it("shows unlock only for owners or admins in locked state", () => {
    expect(
      canShowUnlockData({
        current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
        locked: true,
        isOwnerOrAdmin: true,
      }),
    ).toBe(true);
    expect(
      canShowUnlockData({
        current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
        locked: true,
        isOwnerOrAdmin: false,
      }),
    ).toBe(false);
  });

  it("keeps sync and sheet actions available while locked", () => {
    expect(
      getAvailableProjectActions({
        current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
        locked: true,
        isOwnerOrAdmin: false,
      }),
    ).toEqual(["open_sheet", "sync_data"]);
    expect(
      getAvailableProjectActions({
        current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
        locked: true,
        isOwnerOrAdmin: true,
      }),
    ).toEqual(["open_sheet", "sync_data", "unlock_data"]);
  });
});
