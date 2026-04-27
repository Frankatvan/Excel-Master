# AiWB 访问控制协议 (Auth Protocol)

## 1. 核心准则：项目访问即授权 (Project Access)
AiWB 采用以项目为中心的访问控制。Supabase project access records 是应用侧权限事实来源；Google Drive / Sheet permissions 用于同步和校验项目成员角色，但不是 UI 运行时唯一白名单。

## 2. 身份验证流程
系统支持两种登录方式，均需通过 project access 校验：
1.  **Google OAuth**: 针对 Gmail 或已关联 Google 的企业邮箱。
2.  **Magic Link (Email)**: 针对非 Google 邮箱，系统会发送一次性登录链接。

## 3. 项目权限校验逻辑
每当用户尝试登录时，系统执行以下操作：
1.  **项目权限检索**: 检查 Supabase project access / collaborators 记录。
2.  **Drive 权限同步**: 对需要校验的项目，调用 Google Drive API 同步 Sheet 权限角色。
3.  **结果判定**: 若邮箱具备项目访问权，授予对应 Reader / Commenter / Collaborator 能力；否则拒绝。

## 4. 管理员操作
欲授权新用户访问系统，管理员需要：
1.  打开目标 Google Sheet。
2.  点击 **Share (分享)**。
3.  输入用户邮箱并保存。
4.  等待项目权限同步完成，用户即可按同步后的项目角色登录 [audit.frankzh.top](https://audit.frankzh.top)。

## 5. External Import 权限
External Import 遵循项目访问权限，不要求用户是 Google Drive owner：
1.  **写入权限**: 只有 Collaborator / writer 可上传并确认外部表导入；Reader 与 Commenter 不能上传或确认。
2.  **状态可见**: 所有 project-access users 均可查看 external import status、manifest、warnings 与 blocking items。
3.  **所有权要求**: Drive owner is not required；只要用户具备项目访问权且是 collaborator-only write 角色，即可执行写入。
4.  **事实来源**: Supabase durable jobs + manifests is source of truth；UI 只展示 durable job/status/manifest，不以本地上传状态作为最终事实。

---
© 2026 Wanbridge Group | AiWB Security Engine
