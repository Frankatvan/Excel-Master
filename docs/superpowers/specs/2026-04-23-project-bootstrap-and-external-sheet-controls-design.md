# Project Bootstrap And External Sheet Controls Design

## Context

当前系统已经具备以下基础能力：

- Python 侧可对 `109`、`Scoping`、`Unit Master` 执行公式同步、保护规则重建、隐藏/格式化控制。
- Next.js 前端已经有登录态、首页工作台、`/api/projects/init` 项目初始化接口雏形。
- Google Drive / Sheets 访问已通过 service account 打通，且前端后端都已存在权限校验与文件访问逻辑。

本次需求需要在此基础上补两条能力链路：

1. 为外部数据表建立稳定、可重放的“可编辑白名单”保护规则，并隐藏 `AiWB_109_Log`。
2. 在前端提供“添加新项目”流程，复制当前工作簿作为模板，在同一 Google Drive 文件夹中创建新项目文件，并完成初始化。

## Goals

- 用户可以在前端点击“添加新项目”，输入 `Project Name` 和 `Project Owner` 后，自动得到一个新的 Google Sheet 项目文件。
- 新项目文件复制自当前工作簿，保留模板结构、格式、公式、保护规则基础能力。
- 新项目文件中，`109!C2:E2` 与 `109!G2:I2` 会写入这次提交的业务信息。
- 新项目文件中的外部数据导入区会被清空，且所有浅灰色手工输入区也会被清空。
- 外部数据表只有指定区域可编辑，其他区域锁定。
- `AiWB_109_Log` 作为系统日志页保持隐藏。

## Non-Goals

- 本轮不引入“创建人自动成为文件 owner”的 Drive ownership transfer 逻辑。
- 本轮不重建新的空白模板文件来源，模板源固定为“当前这份工作簿”。
- 本轮不扩展多模板选择、项目归档、模板版本管理。
- 本轮不要求新增数据库字段持久化 `Project Owner`，它首先是写入 109 页头部的业务信息。

## Key Decisions

### 1. 模板来源

新项目通过复制“当前这份工作簿”创建，而不是复制独立的 `GOOGLE_SHEET_TEMPLATE_ID`。

实现含义：

- 默认模板源文件 ID 为当前工作台使用的 spreadsheet ID。
- 后端需要基于该文件 ID 读取其父文件夹，并将复制出来的新文件放回同一文件夹。

### 2. 文件 owner 与创建者权限

`Project Owner` 是 109 页面的业务字段，不等于 Google Drive 文件 owner。

实现含义：

- 新文件仍由当前自动化 owner 上下文创建与持有，不做 owner 转移。
- 发起“添加新项目”的登录用户会自动被分享为该新文件的 `writer`。
- 这样可以满足“创建者可直接编辑新项目”，同时避免跨账号/跨域 owner 转移的复杂性。

### 3. 初始化策略

新文件创建后不做“从头搭建工作簿”，而是在复制完成后执行一次初始化：

- 回填本次输入的 `Project Name`、`Project Owner`
- 清空外部导入数据区
- 清空所有浅灰色手工输入区
- 重建保护规则
- 隐藏 `AiWB_109_Log`

这样既能保留模板结构，又能避免旧项目数据残留。

## External Sheet Editability Rules

以下规则定义“哪些外部数据表位置可以编辑，其他不可以编辑”。

### Editable ranges

- `Contract`
  - 整张表可编辑。
- `Unit Budget`
  - `S:ZZ` 可编辑。
  - 选择 `ZZ` 作为开放上限，满足“Unit 比较多时需要继续向后扩展”的场景。
- `Payable`
  - `L:AV` 可编辑。
  - 同时额外预留 `5` 列，即实现时实际开放为 `L:AZ`。
- `Final Detail`
  - `N:AH` 可编辑。
  - 同时额外预留 `5` 列，即实现时实际开放为 `N:AL`。
- `Draw request report`
  - `H:AN` 可编辑。
  - 同时额外预留 `5` 列，即实现时实际开放为 `H:AR`。
- `Draw Invoice List`
  - `G:AE` 可编辑。
- `Transfer Log`
  - `G:Z` 可编辑。
- `Change Order Log`
  - `G:AE` 可编辑。

### Protection behavior

- `Contract` 因整张表都可编辑，不需要额外建立局部保护规则。
- 其他外部数据表统一采用“整表保护 + 白名单 unprotectedRanges”的方式。
- 每张表的受管保护规则都需要使用明确的系统 description，便于后续同步时只删除并重建 AiWB 自己的规则，不误删用户其他保护设置。

建议使用描述常量：

- `AiWB managed external protection: Unit Budget`
- `AiWB managed external protection: Payable`
- `AiWB managed external protection: Final Detail`
- `AiWB managed external protection: Draw request report`
- `AiWB managed external protection: Draw Invoice List`
- `AiWB managed external protection: Transfer Log`
- `AiWB managed external protection: Change Order Log`

## Hidden System Sheet Rule

`AiWB_109_Log` 是系统自动写入的日志页，应在 Google Sheet 层被隐藏，而不是仅在前端忽略显示。

实现要求：

- 每次初始化新项目时都执行一次“确保隐藏”。
- 每次公式同步/布局同步时也可重放这条规则，保证用户手动取消隐藏后系统仍能恢复。
- 不删除日志内容，不影响日志追加逻辑。

## New Project Frontend Flow

### User flow

1. 用户在前端首页点击“添加新项目”按钮。
2. 弹出表单，输入：
   - `Project Name`
   - `Project Owner`
3. 点击确认。
4. 前端调用项目初始化 API。
5. API 返回成功后，前端展示成功提示，并提供新项目 spreadsheet 的跳转入口。

### Frontend scope

前端改动保持最小：

- 继续使用现有工作台首页 `excel-master-app/src/pages/index.tsx`
- 增加一个按钮和一个轻量 modal / inline form
- 不改现有主导航与审计工作流结构

### Validation

- `Project Name` 必填，去首尾空格后不能为空。
- `Project Owner` 必填，去首尾空格后不能为空。
- 重复点击提交时要禁用按钮，防止重复创建。
- 接口失败时要给出明确错误提示，不吞错误。

## Backend Project Creation Flow

### API contract

继续使用并升级现有接口：

- `POST /api/projects/init`

请求体：

```json
{
  "projectName": "WBWT New Project",
  "projectOwner": "WELL WB PORTFOLIO MEMBER LLC",
  "templateSpreadsheetId": "optional-current-sheet-id"
}
```

说明：

- `templateSpreadsheetId` 在 MVP 中可选。
- 若前端未传，则默认使用当前环境中的工作台 spreadsheet ID。
- 为了确保“复制当前这份工作簿”，建议前端显式传当前用户正处于的 spreadsheet ID。

响应体：

```json
{
  "success": true,
  "projectId": "uuid-or-db-id",
  "spreadsheetId": "new-google-sheet-id",
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/..."
}
```

### Backend steps

1. 校验登录态，必须拿到创建者 email。
2. 校验 `projectName`、`projectOwner`。
3. 确定模板源 spreadsheet ID。
4. 使用 Drive API 获取模板文件 metadata，包括：
   - `name`
   - `parents`
5. 调用 `drive.files.copy` 复制模板，文件名优先使用 `projectName`。
6. 若模板有 parent folder，则使用 `drive.files.update(addParents=...)` 或 copy 时直接写 parent，使新文件进入相同文件夹。
7. 使用 `drive.permissions.create` 将当前登录用户分享为 `writer`。
8. 对新 spreadsheet 执行初始化逻辑。
9. 在 Supabase `projects` 中登记项目记录。
10. 返回新文件 ID 与 URL。

## Spreadsheet Initialization Design

初始化逻辑应集中成一个明确的后端流程，而不是散落在 API handler 中。

建议拆成统一入口，例如：

- `initialize_project_workbook(service, drive, spreadsheet_id, project_name, project_owner, creator_email)`

### Step A: write header business info

写入：

- `109!C2:E2` -> `project_name`
- `109!G2:I2` -> `project_owner`

说明：

- 这两个范围是合并区域，写入只需写左上角值即可，但逻辑上要把它们视为同一业务输入区。
- 初始化时先清空所有手工区，再回填这两个值，避免旧项目头信息残留。

### Step B: clear external data regions

外部数据区清空采用“只清值，不清格式/公式/保护规则/列宽”的原则。

#### Contract

- 清空整张表用户内容。
- 因 `Contract` 当前没有独立表头结构要求，按全表 `values.batchClear` 处理即可。

#### Unit Budget

- 仅清空 `S:ZZ`。
- 保留 `A:R` 侧已有结构、公式与基础逻辑。

#### Payable

- 保留第 1 行表头。
- 清空 `L2:AZ`。

#### Final Detail

- 保留第 1 行表头。
- 清空 `N2:AL`。

#### Draw request report

- 保留前 2 行标题与说明。
- 清空 `H3:AR`。

#### Draw Invoice List

- 保留前 4 行头部结构。
- 清空 `G5:AE`。

#### Transfer Log

- 保留前 4 行头部结构。
- 清空 `G5:Z`。

#### Change Order Log

- 保留前 4 行头部结构。
- 清空 `G5:AE`。

### Step C: clear all gray manual-input ranges

除了外部数据区之外，新文件还要清空所有“浅灰色手工输入区”。

这里不应依赖颜色扫描，而应依赖现有系统已经定义的 manual-range helper，原因如下：

- 颜色是表现层，后续若样式调整会导致逻辑不稳定。
- 当前 `109 / Scoping / Unit Master` 已经存在明确的手工输入范围生成逻辑。
- 系统应以“范围白名单”为真相，再由这些范围去渲染浅灰色。

本轮需要清空的浅灰色手工区至少包括：

- `109` 的手工输入范围
  - 包括但不限于 `C2:E2`、`G2:I2` 及所有现有 manual ranges
  - 初始化顺序上先清，再回填新 `Project Name / Project Owner`
- `Scoping` 手工输入范围
- `Unit Master` 手工输入范围
- 外部数据表开放编辑区
  - 它们本身既属于开放区，也属于新项目初始化时要清值的范围

实现上应统一为：

1. 收集所有现有 helper 产生的 manual ranges
2. 加上外部数据表清空 ranges
3. 对这些 ranges 做压缩/去重
4. 执行一次批量 clear

### Step D: rebuild protections and hidden states

初始化后重新应用：

- `109` 保护规则
- `Scoping` 保护规则
- `Unit Master` 保护规则
- 新增的外部数据表保护规则
- `AiWB_109_Log` 隐藏规则

这样即使模板在复制前有用户临时改动，新项目也会在初始化后回归系统定义状态。

## Data And Permission Model

### Supabase

当前 `projects` 记录最少需要继续保存：

- `user_id_sub`
- `spreadsheet_id`
- `name`

本轮不强依赖新增 `project_owner` 字段；若后续前端需要项目列表直接展示，可再单独加字段。

### Google Drive permissions

新文件创建后至少需要存在以下权限关系：

- 自动化 owner / 现有模板 owner 上下文继续持有完整控制权
- 当前创建者 email 被新增为 `writer`

若添加分享权限失败，则整个创建流程应视为失败，并返回清晰错误，避免“文件已生成但用户无权访问”的半成功状态。

## Error Handling

以下场景必须明确处理：

- 未登录：返回 `401`
- `projectName` 或 `projectOwner` 缺失：返回 `400`
- 模板 ID 缺失：返回 `500`，并记录配置错误
- 模板父文件夹读取失败：返回 `500`
- Drive copy 失败：返回 `500`
- 分享创建者为 writer 失败：返回 `500`
- 新文件初始化失败：返回 `500`
- Supabase 入库失败：返回 `500`

### Partial failure policy

若发生以下“后半段失败”：

- 文件复制成功
- 但初始化或 Supabase 记录失败

系统应优先返回错误，而不是假装成功。

MVP 阶段不强制自动回滚删除新文件，但必须在日志中记录：

- 新文件 ID
- 失败步骤
- 创建者 email

便于后续人工清理。

## Testing Strategy

### Python tests

新增或调整 Python 单测，覆盖：

- 外部数据表 manual / editable ranges 生成
- 外部数据表保护请求生成
- `AiWB_109_Log` 隐藏请求
- 新项目初始化时的 clear 范围拼装
- `109 C2:E2 / G2:I2` 先清空再回填的顺序性

### Next.js API tests

覆盖：

- 未登录请求返回 `401`
- 缺少 `projectName` / `projectOwner` 返回 `400`
- 正常 copy + share + init + db insert 成功
- copy 失败时返回错误
- share 失败时返回错误
- init 失败时返回错误

### Frontend tests

覆盖：

- “添加新项目”按钮展示
- 弹窗表单输入
- 提交中禁用
- 成功提示
- 接口失败提示

## File Responsibilities

建议实现时按以下职责拆分：

- `finance_engine.py`
  - 新增外部数据表保护、隐藏日志页、初始化清值 helpers
- `api/logic/finance_engine.py`
  - 镜像同步 Python 逻辑
- `excel-master-app/api/logic/finance_engine.py`
  - 镜像同步 Python 逻辑
- `excel-master-app/src/pages/api/projects/init.ts`
  - 升级为复制当前工作簿、同文件夹创建、writer 分享、初始化新文件
- `excel-master-app/src/pages/index.tsx`
  - 增加“添加新项目”入口与提交流程
- `excel-master-app/src/__tests__/...`
  - 增加 API 与首页交互测试

## Rollout Notes

- 先在测试中锁定范围和创建流程，再实现。
- 初始化入口要可重复执行，便于后续“重新初始化项目”或“修复保护规则”复用。
- 外部数据表保护规则不应依赖前端页面触发，后端同步逻辑也应能单独重放。

## Acceptance Criteria

以下结果全部满足时，本次设计视为完成：

1. 首页可发起“添加新项目”。
2. 新文件复制自当前工作簿，并出现在模板同一个 Google Drive 文件夹中。
3. 创建者自动拥有新文件编辑权限。
4. `109!C2:E2` 与 `109!G2:I2` 正确写入本次提交的业务值。
5. 外部数据区被清空，但格式保留。
6. 所有浅灰色手工输入区被清空。
7. 指定外部数据表只有白名单区域可编辑。
8. `AiWB_109_Log` 隐藏。
9. 初始化后的新项目仍可继续跑现有公式同步与工作台流程。
