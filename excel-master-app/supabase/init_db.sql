-- 1. 开启 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. 创建 profiles 表 (用户档案)
-- sub 是 NextAuth 提供的 Google 用户唯一标识符 (Google Sub ID)
CREATE TABLE IF NOT EXISTS profiles (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  last_login TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. 创建 projects 表 (项目列表)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  owner_sub TEXT REFERENCES profiles(sub) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. 创建 jobs 表 (异步任务状态)
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- 'reclassify' or 'formula_sync'
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    result_meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 5. 开启 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- 6. 策略：允许 Service Role 拥有所有权限 (Supabase 默认行为)

-- 7. 策略：用户只能查看自己的 profile
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid()::text = sub);

-- 8. 策略：用户只能管理自己的项目
CREATE POLICY "Users can manage own projects" ON projects
  FOR ALL USING (owner_sub = (SELECT sub FROM profiles WHERE sub = auth.uid()::text));

-- 9. 策略：用户可以查看其项目关联的任务
CREATE POLICY "Users can view project jobs" ON jobs
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_sub = (SELECT sub FROM profiles WHERE sub = auth.uid()::text)
    )
  );

-- 10. 更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 11. 添加注释
COMMENT ON TABLE profiles IS '用户档案表，同步自 NextAuth';
COMMENT ON TABLE projects IS '项目表，关联 Google Spreadsheet';
COMMENT ON TABLE jobs IS '任务表，记录后台处理进度';

-- 12. 创建权限缓存表
CREATE TABLE IF NOT EXISTS whitelisted_users (
  email TEXT PRIMARY KEY,
  role TEXT,
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 开启 RLS
ALTER TABLE whitelisted_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON whitelisted_users FOR ALL USING (true);
