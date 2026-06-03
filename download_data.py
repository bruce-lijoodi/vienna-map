import kagglehub
import os

try:
    path = kagglehub.dataset_download("julianjohs/shape-file-for-districts-in-vienna")
    print("Path:", path)
    for f in os.listdir(path):
        print(f)
except Exception as e:
    print("Error:", e)