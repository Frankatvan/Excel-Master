# AiWB 访问控制协议 (Auth Protocol)

## 1. 核心准则：分享即授权 (Share-to-Auth)
AiWB 采用**“以数据为中心的访问控制 (Data-Centric AC)”**架构。Google Sheet 的“分享”列表即为系统的唯一白名单。

## 2. 身份验证流程
系统支持两种登录方式，均需通过白名单校验：
1.  **Google OAuth**: 针对 Gmail 或已关联 Google 的企业邮箱。
2.  **Magic Link (Email)**: 针对非 Google 邮箱，系统会发送一次性登录链接。

## 3. 白名单校验逻辑 (verifySheetAccess)
每当用户尝试登录时，系统执行以下操作：
1.  **数据库缓存检索**: 检查 Supabase `whitelisted_users` 表中是否有该邮箱。
2.  **Google API 穿透**: 若缓存未命中，实时调用 Google Drive API 获取 Sheet 的权限列表。
3.  **结果判定**: 若邮箱存在于列表中，授予登录权限并更新缓存；否则拒绝。

## 4. 管理员操作
欲授权新用户访问系统，管理员只需：
1.  打开目标 Google Sheet。
2.  点击 **Share (分享)**。
3.  输入用户邮箱并保存。
用户即可在 30 秒内登录 [audit.frankzh.top](https://audit.frankzh.top)。

---
© 2026 Wanbridge Group | AiWB Security Engine
