import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.42", username="gian", password="eureka", timeout=10)

commands = [
    ("IMAGE healthcheck", "docker image inspect woot-alert-bot-woot-bot:latest --format='{{.Config.Healthcheck.Test}}' 2>/dev/null"),
    ("CONTAINER healthcheck", "docker inspect woot-alert-bot --format='{{.Config.Healthcheck.Test}}' 2>/dev/null"),
    ("Container health log", "docker inspect --format='{{range .State.Health.Log}}EXIT={{.ExitCode}} OUT={{.Output}}---{{end}}' woot-alert-bot 2>/dev/null"),
    ("Container status", "docker ps --filter name=woot --format '{{.Names}} {{.Status}}'"),
    ("Test wget inside container", "docker exec woot-alert-bot wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/login 2>&1"),
]

for label, cmd in commands:
    print(f"=== {label} ===")
    _, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    print(out or err or "(empty)")
    print()

client.close()
