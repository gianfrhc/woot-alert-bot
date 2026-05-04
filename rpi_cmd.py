import paramiko, sys

host = "192.168.1.42"
user = "gian"
pw = "eureka"

commands = [
    ("CLEAN BUILD CACHE", "docker builder prune -af 2>&1"),
    ("REMOVE GRASS-NODE IMAGE", "docker rmi mrcolorrain/grass-node:latest 2>&1"),
    ("DISK AFTER CLEANUP", "docker system df && echo '' && df -h /"),
]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, password=pw, timeout=10)

for label, cmd in commands:
    print(f"=== {label} ===")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print(out)
    if err and not out: print(f"(stderr) {err}")
    print()

client.close()
print("Done!")
