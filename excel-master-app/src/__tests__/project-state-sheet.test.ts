import { google } from "googleapis";

import {
  PROJECT_STATE_SHEET,
  AUDIT_LOG_SHEET,
  EDIT_LOG_SHEET,
  type PersistedProjectState,
  getProjectState,
  appendAuditLog,
  writeProjectState,
} from "@/lib/project-state-sheet";
import { WORKBENCH_STAGES } from "@/lib/workbench-stage";

jest.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: jest.fn(() => ({ mocked: true })) },
    sheets: jest.fn(),
  },
}));

jest.mock("@/lib/google-service-account", () => ({
  getGoogleServiceAccountCredentials: jest.fn(() => ({
    client_email: "service@example.com",
    private_key: "private-key",
  })),
}));

const sheetsMock = google.sheets as jest.Mock;

describe("project-state-sheet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads AiWB_Project_State into booleans and labels", async () => {
    sheetsMock.mockReturnValue({
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({
            data: {
              values: [
                ["key", "value"],
                ["current_stage", WORKBENCH_STAGES.EXTERNAL_DATA_READY],
                ["external_data_dirty", "TRUE"],
                ["manual_input_dirty", "FALSE"],
                ["locked", "FALSE"],
                ["owner_email", "owner@example.com"],
              ],
            },
          }),
        },
      },
    });

    await expect(getProjectState("sheet-123", "owner@example.com")).resolves.toMatchObject({
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: true,
      manual_input_dirty: false,
      locked: false,
      owner_email: "owner@example.com",
      is_owner_or_admin: true,
    });
  });

  it("does not treat an empty actor email as owner access", async () => {
    sheetsMock.mockReturnValue({
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({
            data: {
              values: [
                ["key", "value"],
                ["current_stage", WORKBENCH_STAGES.EXTERNAL_DATA_READY],
                ["owner_email", "owner@example.com"],
              ],
            },
          }),
        },
      },
    });

    await expect(getProjectState("sheet-123", "")).resolves.toMatchObject({
      owner_email: "owner@example.com",
      is_owner_or_admin: false,
    });
  });

  it("does not treat a missing owner email as owner access", async () => {
    sheetsMock.mockReturnValue({
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({
            data: {
              values: [
                ["key", "value"],
                ["current_stage", WORKBENCH_STAGES.EXTERNAL_DATA_READY],
              ],
            },
          }),
        },
      },
    });

    await expect(getProjectState("sheet-123", "actor@example.com")).resolves.toMatchObject({
      owner_email: "",
      is_owner_or_admin: false,
    });
  });

  it("does not treat two empty emails as owner access", async () => {
    sheetsMock.mockReturnValue({
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({
            data: {
              values: [
                ["key", "value"],
                ["current_stage", WORKBENCH_STAGES.EXTERNAL_DATA_READY],
              ],
            },
          }),
        },
      },
    });

    await expect(getProjectState("sheet-123", "")).resolves.toMatchObject({
      owner_email: "",
      is_owner_or_admin: false,
    });
  });

  it("creates missing hidden support sheets and returns a default state for legacy workbooks", async () => {
    const valuesGet = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            error: {
              message: "Unable to parse range: AiWB_Project_State!A:B",
            },
          },
        },
      });
    const spreadsheetGet = jest.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "109", sheetId: 1, hidden: false } }],
      },
    });
    const batchUpdate = jest.fn().mockResolvedValue({ data: {} });
    const valuesUpdate = jest.fn().mockResolvedValue({ data: {} });
    sheetsMock.mockReturnValue({
      spreadsheets: {
        get: spreadsheetGet,
        batchUpdate,
        values: {
          get: valuesGet,
          update: valuesUpdate,
        },
      },
    });

    await expect(getProjectState("sheet-legacy", "owner@example.com")).resolves.toMatchObject({
      current_stage: WORKBENCH_STAGES.PROJECT_CREATED,
      external_data_dirty: false,
      manual_input_dirty: false,
      locked: false,
      owner_email: "",
      is_owner_or_admin: false,
    });

    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-legacy",
        requestBody: expect.objectContaining({
          requests: expect.arrayContaining([
            expect.objectContaining({
              addSheet: expect.objectContaining({
                properties: expect.objectContaining({ title: PROJECT_STATE_SHEET, hidden: true }),
              }),
            }),
            expect.objectContaining({
              addSheet: expect.objectContaining({
                properties: expect.objectContaining({ title: AUDIT_LOG_SHEET, hidden: true }),
              }),
            }),
            expect.objectContaining({
              addSheet: expect.objectContaining({
                properties: expect.objectContaining({ title: EDIT_LOG_SHEET, hidden: true }),
              }),
            }),
          ]),
        }),
      }),
    );
    expect(valuesUpdate).toHaveBeenCalledTimes(3);
    expect(valuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-legacy",
        range: `${PROJECT_STATE_SHEET}!A:B`,
      }),
    );
  });

  it("writes state as key-value rows", async () => {
    const update = jest.fn().mockResolvedValue({ data: {} });
    sheetsMock.mockReturnValue({
      spreadsheets: {
        get: jest.fn().mockResolvedValue({
          data: {
            sheets: [{ properties: { title: PROJECT_STATE_SHEET, sheetId: 10, hidden: true } }],
          },
        }),
        batchUpdate: jest.fn().mockResolvedValue({ data: {} }),
        values: { update },
      },
    });

    const state: PersistedProjectState = {
      current_stage: WORKBENCH_STAGES.PROJECT_CREATED,
      external_data_dirty: false,
      manual_input_dirty: false,
      locked: false,
      owner_email: "owner@example.com",
    };

    const stateWithDerivedField = {
      ...state,
      is_owner_or_admin: true,
    } as PersistedProjectState;

    await writeProjectState("sheet-123", stateWithDerivedField);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-123",
        range: `${PROJECT_STATE_SHEET}!A:B`,
        valueInputOption: "USER_ENTERED",
      }),
    );

    const values = update.mock.calls[0][0].requestBody.values as Array<Array<string>>;
    expect(values.some(([key]) => key === "is_owner_or_admin")).toBe(false);
  });

  it("rejects partial writes at the type level", () => {
    // @ts-expect-error - writeProjectState requires the full persisted record shape
    writeProjectState("sheet-123", {
      current_stage: WORKBENCH_STAGES.PROJECT_CREATED,
      external_data_dirty: false,
    });
  });

  it("appends audit log rows to the project workbook", async () => {
    const append = jest.fn().mockResolvedValue({ data: {} });
    sheetsMock.mockReturnValue({
      spreadsheets: {
        get: jest.fn().mockResolvedValue({
          data: {
            sheets: [
              { properties: { title: PROJECT_STATE_SHEET, sheetId: 10, hidden: true } },
              { properties: { title: AUDIT_LOG_SHEET, sheetId: 11, hidden: true } },
              { properties: { title: EDIT_LOG_SHEET, sheetId: 12, hidden: true } },
            ],
          },
        }),
        batchUpdate: jest.fn().mockResolvedValue({ data: {} }),
        values: { append, update: jest.fn().mockResolvedValue({ data: {} }) },
      },
    });

    await appendAuditLog("sheet-123", {
      actor_email: "owner@example.com",
      action: "approve_109",
      previous_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      next_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
      status: "success",
      message: "Audit confirmation recorded.",
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-123",
        range: `${AUDIT_LOG_SHEET}!A:I`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
      }),
    );
  });

  it("exports hidden sheet names for template setup", () => {
    expect(PROJECT_STATE_SHEET).toBe("AiWB_Project_State");
    expect(AUDIT_LOG_SHEET).toBe("AiWB_Audit_Log");
    expect(EDIT_LOG_SHEET).toBe("AiWB_Edit_Log");
  });
});
