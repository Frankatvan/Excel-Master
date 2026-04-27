# AiWB Drive/Sheet 权限模型设计

日期：2026-04-27
状态：讨论确认稿

## 1. 背景

当前 AiWB 工作台的权限实现把“创建项目的人”近似当成“项目 owner”。这与实际业务口径不一致，也导致被分享到 Google Sheet 的协作者登录后看不到项目。例如 `ricky@wanbridgegroup.com` 已在白名单中，可以登录，但由于 `projects.owner_email` 不是 Ricky，项目列表为空。

本设计将权限源头统一调整为每个项目 Google Sheet 的 Drive permissions。Supabase `projects` 表继续作为 AiWB 项目目录和元数据来源，但不再作为访问控制来源。

## 2. 已确认业务口径

1. 谁是 Drive 文件 owner，谁就是所有项目 Google Sheet 的 owner，和谁在 AiWB 里点击创建项目无关。
2. Drive owner 可以修改 Google Sheet 的任意区域，不受 protected ranges 限制，但这些操作必须被记录。
3. 协作者可以填写或修改人工录入区，以及外部数据导入覆盖区。
4. 所有项目 Google Sheet 白名单用户都可以看到该项目，也可以下载。
5. 项目可见性以该项目 Google Sheet 的实际 Drive permissions 为准。若某个具体项目 Sheet 排除了某人，该用户不能看到该项目。
6. 登录准入以所有 AiWB 项目 Sheet 的 Drive permissions 并集为准。用户只要属于任意项目 Sheet 白名单，即可登录。
7. 项目目录以 Supabase `projects` 表为准。系统不全盘扫描 Drive 文件，避免模板、测试表、临时表误入项目列表。

## 3. 当前实现偏差

### 3.1 登录准入

现状：`verifySheetAccess()` 先查 `whitelisted_users`，未命中时查一个全局 `GOOGLE_SHEET_ID` 的 Drive permissions。

偏差：登录准入不应绑定单个全局 Sheet，也不应把 `whitelisted_users` 当作永久事实来源。它应来自所有项目 Sheet 权限的并集。

### 3.2 项目可见性

现状：`/api/projects/list` 只返回 `projects.user_id_sub = 当前用户 sub` 或 `projects.owner_email = 当前邮箱` 的项目。

偏差：项目可见性应来自每个项目 Sheet 的 Drive permissions，而不是创建人字段。

### 3.3 项目 owner 判断

现状：`AiWB_Project_State.owner_email` 等于当前邮箱时，`is_owner_or_admin = true`。

偏差：项目 owner 应来自 Drive file owner。`AiWB_Project_State.owner_email` 可保留为历史记录或业务显示字段，但不能作为最终权限判断。

### 3.4 API 防护

现状：多个 API 只校验是否登录和是否传入 `spreadsheet_id`，没有统一校验当前用户是否有该项目 Sheet 权限。

偏差：所有项目级读写 API 都必须先校验当前邮箱是否在该项目 Google Sheet 的 Drive permissions 中。

## 4. 目标权限模型

### 4.1 数据来源

| 数据 | 来源 | 用途 |
|---|---|---|
| 项目目录 | Supabase `projects` | 枚举 AiWB 项目、展示项目元数据 |
| 项目访问权限 | Google Drive permissions for `spreadsheet_id` | 登录、项目列表、读取、下载、操作按钮准入 |
| Drive owner | Google Drive file owner permission | 解除锁定、owner override 标记 |
| Sheet 区域编辑规则 | Google Sheet protected ranges | 限制协作者可编辑区域 |
| 创建人 | `projects.owner_email` / `projects.user_id_sub` | 审计和追踪，不参与 ACL |

### 4.2 角色定义

| 角色 | 判定方式 | 权限含义 |
|---|---|---|
| Drive owner | Drive permissions 中该用户为 owner | 可查看、下载、执行所有 App 动作；可修改保护区，但必须记录 |
| 项目访问用户 | Drive permissions 中该用户有 owner / organizer / fileOrganizer / writer / commenter / reader 之一 | 可查看、下载项目 |
| 项目协作者 | Drive role 为 owner / organizer / fileOrganizer / writer | 可填写允许区域，并触发协作者可用的 App 写入动作 |
| 只读访问用户 | Drive role 为 commenter / reader | 可查看、下载，不触发写入型动作 |
| 未授权用户 | 不在项目 Sheet permissions 中 | 不可看到项目，不可访问项目 API |

说明：业务已确认“所有协作者都能点成本重分类、提交审计确认”。本设计中“协作者”指 Drive 可写角色，即 owner / organizer / fileOrganizer / writer。reader / commenter 属于项目访问用户，可以查看和下载，但不通过 App 间接写入 Sheet。

## 5. 操作权限矩阵

| 操作 | 允许对象 | 权限来源 |
|---|---|---|
| 登录 AiWB | 属于任意项目 Sheet permissions 的用户 | 所有 `projects.spreadsheet_id` 的 Drive permissions 并集 |
| 查看项目列表 | 属于该项目 Sheet permissions 的用户 | 单项目 Drive permissions |
| 查看 dashboard / 快照 / 差异 | 属于该项目 Sheet permissions 的用户 | 单项目 Drive permissions |
| 下载项目 | 属于该项目 Sheet permissions 的用户 | 单项目 Drive permissions |
| 修改人工录入区 | 项目协作者 | Google Sheet protected ranges |
| 修改外部数据导入覆盖区 | 项目协作者 | Google Sheet protected ranges |
| 成本重分类 | 项目协作者 | 单项目 Drive permissions 中的可写角色 |
| 提交审计确认 | 项目协作者 | 单项目 Drive permissions 中的可写角色 |
| 解除锁定数据 | Drive owner | 单项目 Drive owner |
| Owner 修改保护区 | Drive owner | Drive owner override + edit log |

## 6. 目标后端边界

### 6.1 统一访问 helper

后续实现应引入统一访问判断，而不是各 API 自行拼权限逻辑。

建议接口：

```ts
type ProjectAccess = {
  canAccess: boolean;
  canWrite: boolean;
  isDriveOwner: boolean;
  driveRole: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader" | null;
};

async function getProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess>;
```

建议再提供封装：

```ts
async function requireProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess>;
async function requireProjectCollaborator(spreadsheetId: string, email: string): Promise<ProjectAccess>;
async function requireDriveOwner(spreadsheetId: string, email: string): Promise<ProjectAccess>;
```

`requireProjectAccess` 用于项目读取和下载；`requireProjectCollaborator` 用于成本重分类、审计确认等会写入或推进流程的协作者动作；`requireDriveOwner` 用于解除锁定。

### 6.2 登录准入

登录时从 `projects` 表读取项目目录，按项目 `spreadsheet_id` 检查 Drive permissions。只要当前邮箱命中任一项目，则登录通过。

`whitelisted_users` 只能作为短缓存。缓存记录需要有过期时间或最后同步时间，过期后必须回源 Drive permissions，避免用户从 Drive 分享名单移除后仍长期可登录。

### 6.3 项目列表

`/api/projects/list` 应：

1. 查询 `projects` 表作为项目目录。
2. 对每个项目的 `spreadsheet_id` 查询或批量读取 Drive permissions。
3. 只返回当前邮箱有访问权的项目。
4. 不再用 `owner_email` 或 `user_id_sub` 过滤可见项目。

### 6.4 项目级 API

所有接受 `spreadsheet_id` 的项目 API 都应先调用统一权限 helper。

读类 API 使用 `requireProjectAccess`：

- `audit_summary`
- `audit_snapshots`
- `audit_sync_status`
- `live_sheet_status`
- `audit_reclass_detail`
- `projects/state`

写或流程类 API 使用 `requireProjectCollaborator`，其中解除锁定使用 `requireDriveOwner`：

- `reclassify`
- `audit_sync`
- `formula_sync_run`
- `projects/action`
- `audit_snapshots/promote`

### 6.5 Owner override 和日志

Drive owner 对 protected ranges 的修改由 Google Sheet 层允许，但必须进入 `AiWB_Edit_Log`。验收时检查：

1. 每个项目 Sheet 都安装或绑定 edit tracker。
2. edit tracker 能记录 owner 在保护区内的编辑。
3. 日志至少包含时间、操作者、sheet、range、旧值、新值、来源。
4. App 侧触发的写入动作也要写入审计日志或运行日志，方便区分人工编辑与系统动作。

## 7. 非目标

1. 不引入新的用户账号体系。
2. 不把 Supabase RLS 作为本阶段核心 ACL。
3. 不扫描 Drive 全盘文件。
4. 不以创建人决定项目访问权。
5. 不在本设计中改变 Google Sheet protected ranges 的具体区域定义。

## 8. 迁移影响

1. 已有 `projects.owner_email` 和 `projects.user_id_sub` 保留，用于历史追踪和审计。
2. 前端空项目状态需要调整文案，避免把“无 owner 项目”误导成“无访问项目”。
3. 线上 `projects` 表缺少 `project_sequence` 字段的问题与权限模型无直接关系，但项目列表实现仍需保持兼容。
4. 如果 Drive permissions 查询频率较高，需要加短缓存，缓存必须有过期机制。

## 9. 验收标准

1. `ricky@wanbridgegroup.com` 只要仍在 `WBWT Sandy Cove` 对应 Google Sheet 分享名单中，登录后应看到该项目。
2. 被某个项目 Sheet 移除的用户登录后不应看到该项目。
3. 如果用户不属于任何项目 Sheet permissions，则不能登录，或登录后被明确提示无项目权限。
4. 已登录但无某项目权限的用户，即使知道 `spreadsheet_id`，也不能读取该项目 API。
5. Drive 可写角色的项目协作者可以触发成本重分类。
6. Drive 可写角色的项目协作者可以提交审计确认。
7. 非 Drive owner 不能解除锁定数据。
8. Drive owner 可以解除锁定数据。
9. Drive owner 对保护区的编辑能在日志里查到。

## 10. 建议实施顺序

1. 新增统一 Drive permission access helper 和单元测试。
2. 改造登录准入，使用所有项目 Sheet permissions 并集。
3. 改造项目列表，按单项目 Drive permissions 过滤。
4. 为所有项目级 API 补 `requireProjectAccess`。
5. 将解除锁定从隐藏 Sheet owner 判断改为 Drive owner 判断。
6. 验证 edit tracker 覆盖 owner override 日志。
7. 更新 `docs/auth-protocol.md`，废弃“单个全局 Sheet 分享名单即唯一白名单”的旧描述。
