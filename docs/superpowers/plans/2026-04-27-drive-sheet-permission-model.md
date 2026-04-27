# Drive Sheet Permission Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AiWB's creator-based access model with a project Google Sheet Drive permissions model.

**Architecture:** Supabase `projects` remains the project directory. A new `project-access` helper reads Google Drive permissions for a project spreadsheet and exposes `canAccess`, `canWrite`, `isDriveOwner`, and `driveRole`; all auth, list, and project APIs call that helper instead of trusting `owner_email` or session `sub`.

**Tech Stack:** Next.js API routes, NextAuth, Supabase service-role client, Google Drive API via `googleapis`, Jest with `ts-jest`.

---

## File Structure

- Create: `excel-master-app/src/lib/project-access.ts`
  - Owns Drive permission parsing, role classification, project directory iteration for login, and `requireProjectAccess` / `requireProjectCollaborator` / `requireDriveOwner` guards.
- Create: `excel-master-app/src/__tests__/project-access.test.ts`
  - Unit tests for role mapping, Drive permission lookup, missing permission denial, and any-project login checks.
- Modify: `excel-master-app/src/lib/auth-access.ts`
  - Keep `normalizeEmail`; change `verifySheetAccess` to use `verifyAnyProjectAccess`.
- Modify: `excel-master-app/src/__tests__/nextauth.test.ts`
  - Replace single global `GOOGLE_SHEET_ID` assertions with project-directory permission assertions.
- Modify: `excel-master-app/src/pages/api/projects/list.ts`
  - Query `projects` as a directory, filter returned rows by `getProjectAccess`.
- Modify: `excel-master-app/src/__tests__/projects-list-api.test.ts`
  - Update tests so visible projects are based on Drive permissions, not `owner_email` / `user_id_sub`.
- Modify: project read API routes:
  - `excel-master-app/src/pages/api/audit_summary.ts`
  - `excel-master-app/src/pages/api/audit_snapshots/index.ts`
  - `excel-master-app/src/pages/api/audit_snapshots/diff.ts`
  - `excel-master-app/src/pages/api/audit_sync_status.ts`
  - `excel-master-app/src/pages/api/audit_reclass_detail.ts`
  - `excel-master-app/src/pages/api/live_sheet_status.ts`
  - `excel-master-app/src/pages/api/projects/state.ts`
- Modify: project write / workflow API routes:
  - `excel-master-app/src/pages/api/audit_sync.ts`
  - `excel-master-app/src/pages/api/audit_snapshots/promote.ts`
  - `excel-master-app/src/pages/api/formula_sync_run.ts`
  - `excel-master-app/src/pages/api/projects/action.ts`
  - `excel-master-app/src/pages/api/reclassify.ts`
- Modify route tests touched by guards:
  - `excel-master-app/src/__tests__/audit-api-routes.test.ts`
  - `excel-master-app/src/__tests__/audit-snapshots-api.test.ts`
  - `excel-master-app/src/__tests__/projects-action-api.test.ts`
  - `excel-master-app/src/__tests__/projects-state-api.test.ts`
  - `excel-master-app/src/__tests__/reclassify-api.test.ts`
  - `excel-master-app/src/__tests__/formula-live-api.test.ts`
- Modify: `excel-master-app/src/pages/index.tsx`
  - Use server-provided `is_drive_owner` / `can_write` state if exposed; adjust empty-project copy.
- Modify: `docs/auth-protocol.md`
  - Update the access-control narrative from single global Sheet whitelist to project Sheet permissions union.

---

### Task 1: Add Project Access Helper

**Files:**
- Create: `excel-master-app/src/lib/project-access.ts`
- Create: `excel-master-app/src/__tests__/project-access.test.ts`

- [ ] **Step 1: Write failing tests for Drive role classification and project access**

Create `excel-master-app/src/__tests__/project-access.test.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import {
  getProjectAccess,
  requireDriveOwner,
  requireProjectAccess,
  requireProjectCollaborator,
  verifyAnyProjectAccess,
} from "@/lib/project-access";

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    drive: jest.fn(),
  },
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

const mockDrive = google.drive as jest.Mock;
const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const originalEnv = process.env;

function mockProjects(projects: Array<Record<string, unknown>>) {
  const order = jest.fn().mockResolvedValue({ data: projects, error: null });
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn((table: string) => {
    if (table !== "projects") {
      throw new Error(`Unexpected table: ${table}`);
    }
    return { select };
  });
  mockCreateClient.mockReturnValue({ from } as never);
  return { from, select, order };
}

function mockDrivePermissions(permissions: Array<{ emailAddress?: string; role?: string }>) {
  const list = jest.fn().mockResolvedValue({ data: { permissions } });
  mockDrive.mockReturnValue({ permissions: { list } });
  return list;
}

describe("project access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("grants owner access and owner override", async () => {
    const list = mockDrivePermissions([{ emailAddress: "owner@example.com", role: "owner" }]);

    await expect(getProjectAccess("sheet-1", "OWNER@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: true,
      isDriveOwner: true,
      driveRole: "owner",
    });
    expect(list).toHaveBeenCalledWith({
      fileId: "sheet-1",
      fields: "permissions(emailAddress,role)",
      supportsAllDrives: true,
    });
  });

  it("grants writer collaborator access without owner override", async () => {
    mockDrivePermissions([{ emailAddress: "writer@example.com", role: "writer" }]);

    await expect(getProjectAccess("sheet-1", "writer@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("grants reader viewing access without write access", async () => {
    mockDrivePermissions([{ emailAddress: "reader@example.com", role: "reader" }]);

    await expect(getProjectAccess("sheet-1", "reader@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: false,
      isDriveOwner: false,
      driveRole: "reader",
    });
  });

  it("denies users missing from the project sheet permissions", async () => {
    mockDrivePermissions([{ emailAddress: "other@example.com", role: "writer" }]);

    await expect(getProjectAccess("sheet-1", "missing@example.com")).resolves.toEqual({
      canAccess: false,
      canWrite: false,
      isDriveOwner: false,
      driveRole: null,
    });
  });

  it("requires access for read operations", async () => {
    mockDrivePermissions([{ emailAddress: "allowed@example.com", role: "reader" }]);

    await expect(requireProjectAccess("sheet-1", "allowed@example.com")).resolves.toMatchObject({
      canAccess: true,
      canWrite: false,
    });
  });

  it("rejects collaborator-only operations for readers", async () => {
    mockDrivePermissions([{ emailAddress: "reader@example.com", role: "reader" }]);

    await expect(requireProjectCollaborator("sheet-1", "reader@example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });

  it("requires Drive owner for owner-only operations", async () => {
    mockDrivePermissions([{ emailAddress: "writer@example.com", role: "writer" }]);

    await expect(requireDriveOwner("sheet-1", "writer@example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVE_OWNER_REQUIRED",
    });
  });

  it("allows login when the user belongs to any registered project sheet", async () => {
    mockProjects([
      { spreadsheet_id: "sheet-denied" },
      { spreadsheet_id: "sheet-allowed" },
    ]);
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: { permissions: [{ emailAddress: "other@example.com", role: "writer" }] },
      })
      .mockResolvedValueOnce({
        data: { permissions: [{ emailAddress: "shared@example.com", role: "reader" }] },
      });
    mockDrive.mockReturnValue({ permissions: { list } });

    await expect(verifyAnyProjectAccess("shared@example.com")).resolves.toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("denies login when the user belongs to no registered project sheet", async () => {
    mockProjects([{ spreadsheet_id: "sheet-denied" }]);
    mockDrivePermissions([{ emailAddress: "other@example.com", role: "writer" }]);

    await expect(verifyAnyProjectAccess("missing@example.com")).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/project-access.test.ts --runInBand
```

Expected: FAIL because `@/lib/project-access` does not exist.

- [ ] **Step 3: Implement project-access helper**

Create `excel-master-app/src/lib/project-access.ts`:

```ts
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import { DEFAULT_SUPABASE_URL } from "@/lib/project-registry";

export type DriveProjectRole = "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";

export type ProjectAccess = {
  canAccess: boolean;
  canWrite: boolean;
  isDriveOwner: boolean;
  driveRole: DriveProjectRole | null;
};

export class ProjectAccessError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "ProjectAccessError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const WRITABLE_ROLES = new Set<DriveProjectRole>(["owner", "organizer", "fileOrganizer", "writer"]);
const ACCESS_ROLES = new Set<DriveProjectRole>([
  "owner",
  "organizer",
  "fileOrganizer",
  "writer",
  "commenter",
  "reader",
]);

export function normalizeAccessEmail(email: string) {
  return email.trim().toLowerCase();
}

function isDriveProjectRole(role: unknown): role is DriveProjectRole {
  return typeof role === "string" && ACCESS_ROLES.has(role as DriveProjectRole);
}

function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export async function getProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  const normalizedEmail = normalizeAccessEmail(email);
  if (!normalizedSpreadsheetId || !normalizedEmail) {
    return {
      canAccess: false,
      canWrite: false,
      isDriveOwner: false,
      driveRole: null,
    };
  }

  const drive = createDriveClient();
  const res = await drive.permissions.list({
    fileId: normalizedSpreadsheetId,
    fields: "permissions(emailAddress,role)",
    supportsAllDrives: true,
  });
  const matchedPermission = (res.data.permissions || []).find(
    (permission) => permission.emailAddress?.toLowerCase() === normalizedEmail,
  );
  const driveRole = isDriveProjectRole(matchedPermission?.role) ? matchedPermission.role : null;

  return {
    canAccess: Boolean(driveRole),
    canWrite: Boolean(driveRole && WRITABLE_ROLES.has(driveRole)),
    isDriveOwner: driveRole === "owner",
    driveRole,
  };
}

export async function requireProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(spreadsheetId, email);
  if (!access.canAccess) {
    throw new ProjectAccessError("无权访问该项目", 403, "PROJECT_ACCESS_FORBIDDEN");
  }
  return access;
}

export async function requireProjectCollaborator(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const access = await requireProjectAccess(spreadsheetId, email);
  if (!access.canWrite) {
    throw new ProjectAccessError("无权执行该项目操作", 403, "PROJECT_WRITE_FORBIDDEN");
  }
  return access;
}

export async function requireDriveOwner(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const access = await requireProjectAccess(spreadsheetId, email);
  if (!access.isDriveOwner) {
    throw new ProjectAccessError("仅 Drive Owner 可以执行该操作", 403, "DRIVE_OWNER_REQUIRED");
  }
  return access;
}

export async function listRegisteredProjectSpreadsheetIds() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select("spreadsheet_id")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || [])
    .map((row: { spreadsheet_id?: unknown }) => (typeof row.spreadsheet_id === "string" ? row.spreadsheet_id.trim() : ""))
    .filter(Boolean);
}

export async function verifyAnyProjectAccess(email: string): Promise<boolean> {
  const spreadsheetIds = await listRegisteredProjectSpreadsheetIds();
  for (const spreadsheetId of spreadsheetIds) {
    try {
      const access = await getProjectAccess(spreadsheetId, email);
      if (access.canAccess) {
        return true;
      }
    } catch (error) {
      console.warn(
        `[Auth] Project permission check failed for ${spreadsheetId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/project-access.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add excel-master-app/src/lib/project-access.ts excel-master-app/src/__tests__/project-access.test.ts
git commit -m "feat: add project drive access helper"
```

---

### Task 2: Change Login Access To Project Permissions Union

**Files:**
- Modify: `excel-master-app/src/lib/auth-access.ts`
- Modify: `excel-master-app/src/__tests__/nextauth.test.ts`
- Test: `excel-master-app/src/__tests__/email-otp.test.ts`

- [ ] **Step 1: Update NextAuth tests to expect project permission union**

In `excel-master-app/src/__tests__/nextauth.test.ts`, replace direct Google Drive permission mocks for single `GOOGLE_SHEET_ID` access with a mock of `@/lib/project-access`.

Add this mock near existing mocks:

```ts
jest.mock("@/lib/project-access", () => ({
  verifyAnyProjectAccess: jest.fn(),
}));
```

Add this import near the top:

```ts
import { verifyAnyProjectAccess } from "@/lib/project-access";
```

Add this typed mock after existing mock constants:

```ts
const mockVerifyAnyProjectAccess = verifyAnyProjectAccess as jest.MockedFunction<typeof verifyAnyProjectAccess>;
```

Replace the old "allows users already cached" and "caches the user when Google Drive permissions contain the email" tests with:

```ts
it("allows sign-in when the user has access to any registered project sheet", async () => {
  mockVerifyAnyProjectAccess.mockResolvedValue(true);

  const signIn = await loadSignInCallback();
  const result = await signIn({ user: { email: "shared@example.com" } });

  expect(result).toBe(true);
  expect(mockVerifyAnyProjectAccess).toHaveBeenCalledWith("shared@example.com");
});

it("rejects sign-in when the user has no registered project sheet access", async () => {
  mockVerifyAnyProjectAccess.mockResolvedValue(false);

  const signIn = await loadSignInCallback();
  const result = await signIn({ user: { email: "missing@example.com" } });

  expect(result).toBe(false);
  expect(mockVerifyAnyProjectAccess).toHaveBeenCalledWith("missing@example.com");
});
```

Keep provider registration and email OTP provider tests.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/nextauth.test.ts --runInBand
```

Expected: FAIL because `auth-access.ts` still reads `whitelisted_users` / `GOOGLE_SHEET_ID`.

- [ ] **Step 3: Simplify auth-access to delegate to project-access**

Replace the contents of `excel-master-app/src/lib/auth-access.ts` with:

```ts
import { normalizeAccessEmail, verifyAnyProjectAccess } from "@/lib/project-access";

export function normalizeEmail(email: string) {
  return normalizeAccessEmail(email);
}

export async function verifySheetAccess(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return false;
  }

  try {
    const allowed = await verifyAnyProjectAccess(normalizedEmail);
    if (!allowed) {
      console.warn(`[Auth] Access DENIED for ${normalizedEmail}: no registered project sheet permission.`);
    }
    return allowed;
  } catch (error) {
    console.error(
      `[Auth] Project permission verification failed for ${normalizedEmail}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return false;
  }
}
```

- [ ] **Step 4: Run auth tests**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/nextauth.test.ts src/__tests__/email-otp.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add excel-master-app/src/lib/auth-access.ts excel-master-app/src/__tests__/nextauth.test.ts excel-master-app/src/__tests__/email-otp.test.ts
git commit -m "feat: authenticate against project sheet permissions"
```

---

### Task 3: Filter Project List By Drive Permissions

**Files:**
- Modify: `excel-master-app/src/pages/api/projects/list.ts`
- Modify: `excel-master-app/src/__tests__/projects-list-api.test.ts`

- [ ] **Step 1: Add project list tests for collaborator visibility**

In `excel-master-app/src/__tests__/projects-list-api.test.ts`, mock project access:

```ts
jest.mock("@/lib/project-access", () => ({
  getProjectAccess: jest.fn(),
}));
```

Import and type the mock:

```ts
import { getProjectAccess } from "@/lib/project-access";

const mockGetProjectAccess = getProjectAccess as jest.MockedFunction<typeof getProjectAccess>;
```

Replace the "returns direct mode when the authenticated user has one accessible project" test with:

```ts
it("returns projects where the authenticated user has Drive permission", async () => {
  await mockSession("ricky@wanbridgegroup.com", "ricky-sub");
  const visibleProject = {
    id: "project-1",
    name: "WBWT Sandy Cove",
    spreadsheet_id: "sheet-visible",
    sheet_109_title: "109",
    project_sequence: "109",
    owner_email: "frankz@wanbridgegroup.com",
    created_at: "2026-04-23T08:00:00.000Z",
  };
  const hiddenProject = {
    id: "project-2",
    name: "Hidden",
    spreadsheet_id: "sheet-hidden",
    sheet_109_title: "110",
    project_sequence: "110",
    owner_email: "other@example.com",
    created_at: "2026-04-23T09:00:00.000Z",
  };
  const supabase = await mockSupabase({
    projects: [visibleProject, hiddenProject],
  });
  mockGetProjectAccess.mockImplementation(async (spreadsheetId: string) => ({
    canAccess: spreadsheetId === "sheet-visible",
    canWrite: spreadsheetId === "sheet-visible",
    isDriveOwner: false,
    driveRole: spreadsheetId === "sheet-visible" ? "writer" : null,
  }));

  const handler = await loadHandler();
  const req = { method: "GET" } as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(supabase.mockProjectsSelect).toHaveBeenCalledWith(
    "id,name,spreadsheet_id,sheet_109_title,project_sequence,owner_email,created_at",
  );
  expect(supabase.mockProjectsOrder).toHaveBeenCalledWith("created_at", { ascending: false });
  expect(mockGetProjectAccess).toHaveBeenCalledWith("sheet-visible", "ricky@wanbridgegroup.com");
  expect(mockGetProjectAccess).toHaveBeenCalledWith("sheet-hidden", "ricky@wanbridgegroup.com");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ mode: "direct", projects: [visibleProject] });
});
```

Delete assertions that expect `.or("user_id_sub.eq...,owner_email.eq...")`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-list-api.test.ts --runInBand
```

Expected: FAIL because the route still filters Supabase by `owner_email` / `user_id_sub`.

- [ ] **Step 3: Update projects/list route**

In `excel-master-app/src/pages/api/projects/list.ts`:

1. Add import:

```ts
import { getProjectAccess } from "@/lib/project-access";
```

2. Remove `sanitizePostgrestFilterValue`, `sessionSub`, `safeEmail`, `safeSub`, and `projectFilter`.

3. Change `queryProjects` to query the directory:

```ts
const queryProjects = async (includeProjectSequence: boolean) =>
  supabase
    .from("projects")
    .select(
      includeProjectSequence
        ? "id,name,spreadsheet_id,sheet_109_title,project_sequence,owner_email,created_at"
        : "id,name,spreadsheet_id,sheet_109_title,owner_email,created_at",
    )
    .order("created_at", { ascending: false });
```

4. Replace `const projectList = projects || [];` with:

```ts
const projectList = [];
for (const project of projects || []) {
  const spreadsheetId =
    typeof (project as { spreadsheet_id?: unknown }).spreadsheet_id === "string"
      ? ((project as { spreadsheet_id: string }).spreadsheet_id || "").trim()
      : "";
  if (!spreadsheetId) {
    continue;
  }

  try {
    const access = await getProjectAccess(spreadsheetId, email);
    if (access.canAccess) {
      projectList.push(project);
    }
  } catch (accessError) {
    console.warn(
      `[Projects] Skipping project ${spreadsheetId} after permission lookup failed: ${
        accessError instanceof Error ? accessError.message : "unknown error"
      }`,
    );
  }
}
```

- [ ] **Step 4: Run project list tests**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-list-api.test.ts --runInBand
```

Expected: PASS after replacing owner/sub filter assertions with directory query and Drive permission assertions.

- [ ] **Step 5: Commit Task 3**

```bash
git add excel-master-app/src/pages/api/projects/list.ts excel-master-app/src/__tests__/projects-list-api.test.ts
git commit -m "feat: list projects by drive permissions"
```

---

### Task 4: Guard Project Read APIs

**Files:**
- Modify: `excel-master-app/src/pages/api/audit_summary.ts`
- Modify: `excel-master-app/src/pages/api/audit_snapshots/index.ts`
- Modify: `excel-master-app/src/pages/api/audit_snapshots/diff.ts`
- Modify: `excel-master-app/src/pages/api/audit_sync_status.ts`
- Modify: `excel-master-app/src/pages/api/audit_reclass_detail.ts`
- Modify: `excel-master-app/src/pages/api/live_sheet_status.ts`
- Modify: `excel-master-app/src/pages/api/projects/state.ts`
- Modify: `excel-master-app/src/__tests__/audit-api-routes.test.ts`
- Modify: `excel-master-app/src/__tests__/audit-snapshots-api.test.ts`
- Modify: `excel-master-app/src/__tests__/projects-state-api.test.ts`
- Modify: `excel-master-app/src/__tests__/formula-live-api.test.ts`

- [ ] **Step 1: Add a reusable test mock pattern**

For each touched read-route test file, add this mock if the file does not already mock `@/lib/project-access`:

```ts
jest.mock("@/lib/project-access", () => ({
  requireProjectAccess: jest.fn(),
}));
```

Add:

```ts
import { requireProjectAccess } from "@/lib/project-access";

const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
```

In each `beforeEach`, add:

```ts
mockRequireProjectAccess.mockResolvedValue({
  canAccess: true,
  canWrite: true,
  isDriveOwner: false,
  driveRole: "writer",
});
```

- [ ] **Step 2: Add one explicit forbidden test per read API**

For `projects/state`, add to `excel-master-app/src/__tests__/projects-state-api.test.ts`:

```ts
it("rejects users without Drive permission for the project", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "denied@example.com" },
  } as never);
  mockRequireProjectAccess.mockRejectedValue({
    statusCode: 403,
    code: "PROJECT_ACCESS_FORBIDDEN",
    message: "无权访问该项目",
  });

  const req = {
    method: "GET",
    query: { spreadsheet_id: "sheet-123" },
  } as unknown as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "denied@example.com");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: "无权访问该项目", code: "PROJECT_ACCESS_FORBIDDEN" });
  expect(mockGetProjectState).not.toHaveBeenCalled();
});
```

Add equivalent forbidden tests with these route-specific service assertions:

| Test file | Request | Downstream mock that must not run |
|---|---|---|
| `audit-api-routes.test.ts` | `GET /api/audit_summary?spreadsheet_id=sheet-123` | `getAuditSummary` |
| `audit-snapshots-api.test.ts` | `GET /api/audit_snapshots?spreadsheet_id=sheet-123` | `listAuditSnapshots` |
| `audit-snapshots-api.test.ts` | `GET /api/audit_snapshots/diff?spreadsheet_id=sheet-123&target_snapshot_id=snap-2` | `diffAuditSnapshot` |
| `formula-live-api.test.ts` | `GET /api/live_sheet_status?spreadsheet_id=sheet-123` | `getLiveSheetStatus` |

The expected forbidden response in each test is:

```ts
expect(res.status).toHaveBeenCalledWith(403);
expect(res.json).toHaveBeenCalledWith({ error: "无权访问该项目", code: "PROJECT_ACCESS_FORBIDDEN" });
```

- [ ] **Step 3: Run read API tests to verify failures**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-state-api.test.ts src/__tests__/audit-api-routes.test.ts src/__tests__/audit-snapshots-api.test.ts --runInBand
```

Expected: FAIL because read routes do not call `requireProjectAccess` yet.

- [ ] **Step 4: Add guard helper usage to each read route**

For each read route, import:

```ts
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
```

After reading `spreadsheetId` and before calling the route's service, add:

```ts
try {
  await requireProjectAccess(spreadsheetId, session.user.email);
} catch (error) {
  if (error instanceof ProjectAccessError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  throw error;
}
```

For `projects/state.ts`, the session email variable is `actorEmail`, so use:

```ts
try {
  await requireProjectAccess(spreadsheetId, actorEmail);
} catch (error) {
  if (error instanceof ProjectAccessError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  throw error;
}
```

- [ ] **Step 5: Run read API tests**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-state-api.test.ts src/__tests__/audit-api-routes.test.ts src/__tests__/audit-snapshots-api.test.ts src/__tests__/formula-live-api.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add excel-master-app/src/pages/api/audit_summary.ts excel-master-app/src/pages/api/audit_snapshots/index.ts excel-master-app/src/pages/api/audit_snapshots/diff.ts excel-master-app/src/pages/api/audit_sync_status.ts excel-master-app/src/pages/api/audit_reclass_detail.ts excel-master-app/src/pages/api/live_sheet_status.ts excel-master-app/src/pages/api/projects/state.ts excel-master-app/src/__tests__/audit-api-routes.test.ts excel-master-app/src/__tests__/audit-snapshots-api.test.ts excel-master-app/src/__tests__/projects-state-api.test.ts excel-master-app/src/__tests__/formula-live-api.test.ts
git commit -m "feat: guard project read APIs"
```

---

### Task 5: Guard Project Write And Workflow APIs

**Files:**
- Modify: `excel-master-app/src/pages/api/audit_sync.ts`
- Modify: `excel-master-app/src/pages/api/audit_snapshots/promote.ts`
- Modify: `excel-master-app/src/pages/api/formula_sync_run.ts`
- Modify: `excel-master-app/src/pages/api/projects/action.ts`
- Modify: `excel-master-app/src/pages/api/reclassify.ts`
- Modify: `excel-master-app/src/__tests__/projects-action-api.test.ts`
- Modify: `excel-master-app/src/__tests__/reclassify-api.test.ts`
- Modify: `excel-master-app/src/__tests__/audit-snapshots-api.test.ts`
- Modify: `excel-master-app/src/__tests__/formula-live-api.test.ts`

- [ ] **Step 1: Add collaborator and Drive owner route tests**

In `excel-master-app/src/__tests__/projects-action-api.test.ts`, mock access:

```ts
jest.mock("@/lib/project-access", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {
    statusCode: number;
    code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = "ProjectAccessError";
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  requireDriveOwner: jest.fn(),
  requireProjectCollaborator: jest.fn(),
}));
```

Add imports:

```ts
import { requireDriveOwner, requireProjectCollaborator } from "@/lib/project-access";

const mockRequireDriveOwner = requireDriveOwner as jest.MockedFunction<typeof requireDriveOwner>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<typeof requireProjectCollaborator>;
```

In `beforeEach`, add:

```ts
mockRequireProjectCollaborator.mockResolvedValue({
  canAccess: true,
  canWrite: true,
  isDriveOwner: false,
  driveRole: "writer",
});
mockRequireDriveOwner.mockResolvedValue({
  canAccess: true,
  canWrite: true,
  isDriveOwner: true,
  driveRole: "owner",
});
```

Add this test:

```ts
it("allows collaborators to approve 109", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "writer@example.com" },
  } as never);
  const state = createState({
    current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
    is_owner_or_admin: false,
  });
  mockGetProjectState.mockResolvedValue(state);

  const req = {
    method: "POST",
    body: { spreadsheet_id: "sheet-123", action: "approve_109" },
  } as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "writer@example.com");
  expect(mockRequireDriveOwner).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});
```

Add this test:

```ts
it("requires Drive owner to unlock data", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "writer@example.com" },
  } as never);
  mockRequireDriveOwner.mockRejectedValue({
    statusCode: 403,
    code: "DRIVE_OWNER_REQUIRED",
    message: "仅 Drive Owner 可以执行该操作",
  });

  const req = {
    method: "POST",
    body: { spreadsheet_id: "sheet-123", action: "unlock_data" },
  } as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(mockRequireDriveOwner).toHaveBeenCalledWith("sheet-123", "writer@example.com");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: "仅 Drive Owner 可以执行该操作", code: "DRIVE_OWNER_REQUIRED" });
  expect(mockGetProjectState).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add reclassify collaborator forbidden test**

In `excel-master-app/src/__tests__/reclassify-api.test.ts`, mock `requireProjectCollaborator`, default it to writer access, then add:

```ts
it("rejects reclassification when the user is not a writable Drive collaborator", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "reader@example.com" },
  } as never);
  mockRequireProjectCollaborator.mockRejectedValue({
    statusCode: 403,
    code: "PROJECT_WRITE_FORBIDDEN",
    message: "无权执行该项目操作",
  });

  const req = {
    method: "POST",
    body: { spreadsheet_id: "sheet-123" },
    headers: {},
    socket: {},
  } as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: "无权执行该项目操作", code: "PROJECT_WRITE_FORBIDDEN" });
  expect(global.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run write API tests to verify failures**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-action-api.test.ts src/__tests__/reclassify-api.test.ts --runInBand
```

Expected: FAIL because routes do not call the new guards.

- [ ] **Step 4: Add collaborator / owner guards to write routes**

In each write route, import:

```ts
import { ProjectAccessError, requireDriveOwner, requireProjectCollaborator } from "@/lib/project-access";
```

For `projects/action.ts`, after validating `spreadsheetId` and `action`, add:

```ts
try {
  if (action === "unlock_data") {
    await requireDriveOwner(spreadsheetId, actorEmail);
  } else {
    await requireProjectCollaborator(spreadsheetId, actorEmail);
  }
} catch (error) {
  if (error instanceof ProjectAccessError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  throw error;
}
```

Then remove the `if (!state.is_owner_or_admin)` block from `unlockData()`, because Drive owner is now checked before state mutation.

For `reclassify.ts`, after validating `spreadsheetId`, add:

```ts
try {
  await requireProjectCollaborator(spreadsheetId, session.user.email);
} catch (error) {
  if (error instanceof ProjectAccessError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  throw error;
}
```

Apply the same `requireProjectCollaborator` pattern to:

- `audit_sync.ts`
- `audit_snapshots/promote.ts`
- `formula_sync_run.ts`

- [ ] **Step 5: Run write API tests**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-action-api.test.ts src/__tests__/reclassify-api.test.ts src/__tests__/audit-snapshots-api.test.ts src/__tests__/formula-live-api.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add excel-master-app/src/pages/api/audit_sync.ts excel-master-app/src/pages/api/audit_snapshots/promote.ts excel-master-app/src/pages/api/formula_sync_run.ts excel-master-app/src/pages/api/projects/action.ts excel-master-app/src/pages/api/reclassify.ts excel-master-app/src/__tests__/projects-action-api.test.ts excel-master-app/src/__tests__/reclassify-api.test.ts excel-master-app/src/__tests__/audit-snapshots-api.test.ts excel-master-app/src/__tests__/formula-live-api.test.ts
git commit -m "feat: guard project write actions by drive role"
```

---

### Task 6: Surface Drive Access In Project State And UI

**Files:**
- Modify: `excel-master-app/src/pages/api/projects/state.ts`
- Modify: `excel-master-app/src/pages/index.tsx`
- Modify: `excel-master-app/src/__tests__/projects-state-api.test.ts`
- Modify: `excel-master-app/src/__tests__/workbench-phase1.test.tsx`

- [ ] **Step 1: Add state API test for access flags**

In `projects-state-api.test.ts`, assert the payload includes access flags:

```ts
it("returns Drive access flags with project state", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "owner@example.com" },
  } as never);
  mockRequireProjectAccess.mockResolvedValue({
    canAccess: true,
    canWrite: true,
    isDriveOwner: true,
    driveRole: "owner",
  });
  mockGetProjectState.mockResolvedValue({
    current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
    external_data_dirty: false,
    manual_input_dirty: false,
    locked: false,
    owner_email: "legacy-owner@example.com",
  });

  const req = {
    method: "GET",
    query: { spreadsheet_id: "sheet-123" },
  } as unknown as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({
    state: expect.objectContaining({
      can_write: true,
      drive_role: "owner",
      is_drive_owner: true,
      is_owner_or_admin: true,
    }),
  });
});
```

- [ ] **Step 2: Run state test to verify it fails**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-state-api.test.ts --runInBand
```

Expected: FAIL because state API does not return Drive access flags.

- [ ] **Step 3: Add access flags to state response**

In `projects/state.ts`, store the access result:

```ts
const access = await requireProjectAccess(spreadsheetId, actorEmail);
```

Return:

```ts
return res.status(200).json({
  state: {
    ...state,
    can_write: access.canWrite,
    drive_role: access.driveRole,
    is_drive_owner: access.isDriveOwner,
    is_owner_or_admin: access.isDriveOwner,
  },
});
```

- [ ] **Step 4: Update frontend state type and unlock visibility**

In `index.tsx`, extend `ProjectStateSnapshot`:

```ts
  can_write?: boolean;
  drive_role?: string;
  is_drive_owner?: boolean;
```

In `parseProjectStatePayload`, include:

```ts
          can_write: typeof stateCandidate.can_write === "boolean" ? stateCandidate.can_write : undefined,
          drive_role: typeof stateCandidate.drive_role === "string" ? stateCandidate.drive_role : undefined,
          is_drive_owner: typeof stateCandidate.is_drive_owner === "boolean" ? stateCandidate.is_drive_owner : undefined,
```

Where the UI derives unlock permission, prefer:

```ts
isOwnerOrAdmin: Boolean(activeProjectState?.is_drive_owner ?? activeProjectState?.is_owner_or_admin),
```

For empty project copy, replace:

```tsx
<p className="mt-3 text-sm text-[#5B7A88]">当前账号暂无项目，先创建一个项目开始。</p>
```

with:

```tsx
<p className="mt-3 text-sm text-[#5B7A88]">当前账号暂无可访问项目。请确认该邮箱已加入项目 Google Sheet 分享名单，或创建一个新项目。</p>
```

- [ ] **Step 5: Run frontend and state tests**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/projects-state-api.test.ts src/__tests__/workbench-phase1.test.tsx --runInBand
```

Expected: PASS after updating any snapshots or text expectations to the new copy.

- [ ] **Step 6: Commit Task 6**

```bash
git add excel-master-app/src/pages/api/projects/state.ts excel-master-app/src/pages/index.tsx excel-master-app/src/__tests__/projects-state-api.test.ts excel-master-app/src/__tests__/workbench-phase1.test.tsx
git commit -m "feat: expose drive role in project state"
```

---

### Task 7: Update Auth Documentation And Run Full Verification

**Files:**
- Modify: `docs/auth-protocol.md`
- Test: `excel-master-app/src/__tests__/project-access.test.ts`
- Test: `excel-master-app/src/__tests__/nextauth.test.ts`
- Test: `excel-master-app/src/__tests__/email-otp.test.ts`
- Test: `excel-master-app/src/__tests__/projects-list-api.test.ts`
- Test: `excel-master-app/src/__tests__/projects-state-api.test.ts`
- Test: `excel-master-app/src/__tests__/projects-action-api.test.ts`
- Test: `excel-master-app/src/__tests__/reclassify-api.test.ts`
- Test: `excel-master-app/src/__tests__/audit-api-routes.test.ts`
- Test: `excel-master-app/src/__tests__/audit-snapshots-api.test.ts`
- Test: `excel-master-app/src/__tests__/formula-live-api.test.ts`

- [ ] **Step 1: Update auth protocol**

Replace the current "核心准则" and "白名单校验逻辑" sections in `docs/auth-protocol.md` with:

```md
## 1. 核心准则：项目 Sheet 即授权
AiWB 采用以项目 Google Sheet 为中心的访问控制。Supabase `projects` 表只登记哪些 spreadsheet 属于 AiWB 项目；真正的访问权限来自每个项目 Google Sheet 的 Drive permissions。

## 2. 身份验证流程
系统支持两种登录方式，均需通过项目权限校验：
1. **Google OAuth**：针对 Gmail 或已关联 Google 的企业邮箱。
2. **Email OTP**：针对被项目 Sheet 分享但没有 Google 身份的非 Gmail 邮箱。

## 3. 白名单校验逻辑
用户登录时，系统读取 Supabase `projects` 目录，并检查这些项目 Sheet 的 Drive permissions。只要该邮箱属于任意项目 Sheet permissions，即允许登录。登录后，项目列表只展示该邮箱对具体项目 Sheet 有权限的项目。

`whitelisted_users` 不再作为长期事实来源。若保留缓存，只能作为短期加速层，并必须能回源 Drive permissions。

## 4. 项目操作权限
1. Drive owner 可以查看、下载、执行所有 App 动作，并可解除锁定。
2. Drive 可写协作者可以查看、下载、填写允许区域、触发成本重分类、提交审计确认。
3. reader/commenter 可以查看和下载，但不能通过 App 间接写入 Sheet。
4. 创建人字段只用于审计记录，不决定访问权。
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
cd excel-master-app
npx jest src/__tests__/project-access.test.ts src/__tests__/nextauth.test.ts src/__tests__/email-otp.test.ts src/__tests__/projects-list-api.test.ts src/__tests__/projects-state-api.test.ts src/__tests__/projects-action-api.test.ts src/__tests__/reclassify-api.test.ts src/__tests__/audit-api-routes.test.ts src/__tests__/audit-snapshots-api.test.ts src/__tests__/formula-live-api.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd excel-master-app
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Run full Jest suite if focused verification passes**

Run:

```bash
cd excel-master-app
npm test -- --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add docs/auth-protocol.md
git commit -m "docs: update auth protocol for project permissions"
```

---

## Self-Review Notes

- Spec coverage: login union, project list filtering, project read APIs, collaborator write actions, Drive-owner unlock, UI state, and docs are each represented by tasks.
- Type consistency: `ProjectAccess` consistently uses `canAccess`, `canWrite`, `isDriveOwner`, and `driveRole`.
- Risk called out in plan: reader/commenter are access users, while App write actions require Drive writable roles.
- Execution risk: the workspace is already dirty. Implementers must stage only files named in each task and avoid reverting unrelated changes.
