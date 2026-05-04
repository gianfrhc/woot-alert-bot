import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.42", username="gian", password="eureka", timeout=10)

# Full logs
stdin, stdout, stderr = client.exec_command("docker logs woot-alert-bot 2>&1", timeout=10)
print(stdout.read().decode().strip())

client.close()
