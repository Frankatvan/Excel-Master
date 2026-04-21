
import pickle
from pathlib import Path

snapshot_file = Path(".aiwb_local/cloud_snapshot.pkl")
if snapshot_file.exists():
    with open(snapshot_file, "rb") as f:
        data = pickle.load(f)
    print("Keys in snapshot:", data.keys())
    cloud_map = data.get("cloud_map", {})
    print("Sheets in cloud_map:", cloud_map.keys())
    if "Payable" in cloud_map:
        df = cloud_map["Payable"]
        print("Payable columns:", df.columns.tolist())
        print("Payable head:")
        print(df.head())
    if "Unit Budget" in cloud_map:
        df = cloud_map["Unit Budget"]
        print("Unit Budget columns:", df.columns.tolist())
        print("Unit Budget head:")
        print(df.head())
else:
    print("Snapshot not found")
