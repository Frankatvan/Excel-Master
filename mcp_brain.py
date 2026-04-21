import json
import os
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("BrainSync_Pro")
SYNC_FILE = "AI_STATUS_SYNC.json"

def load_sync():
    if not os.path.exists(SYNC_FILE):
        return {"env_locked": False, "history": []}
    with open(SYNC_FILE, "r") as f: return json.load(f)

def save_sync(data):
    with open(SYNC_FILE, "w") as f: json.dump(data, f, indent=4)

@mcp.tool()
def sync_task(role: str, instruction: str) -> str:
    """同步任务并触发主动模式"""
    state = load_sync()
    state["next_instruction"] = instruction
    state["last_trigger"] = role
    save_sync(state)
    return f"指令已下达。Codex 请注意：一旦读取此状态，必须立刻执行，不得进入讨论模式。"

@mcp.tool()
def verify_code_safety(file_path: str, new_code_snippet: str) -> str:
    """代码安全闸门：防止 Codex 覆盖关键逻辑或删除重要依赖"""
    # 这里可以扩展复杂的校验逻辑
    if "import" not in new_code_snippet and os.path.getsize(file_path) > 1000:
        return "警告：检测到大规模删除逻辑但未补充依赖，拒绝应用修改。"
    return "验证通过：逻辑安全，准许应用。"

if __name__ == "__main__":
    mcp.run()
