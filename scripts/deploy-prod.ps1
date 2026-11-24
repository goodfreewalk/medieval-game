# Деплой прода (:8080) — git-only по QWEN.md «Git-транспорт изменений».
# Запуск: владелец вручную (deploy-prod.bat) либо агент ТОЛЬКО после фразы
# «ПРИНИМАЮ ПРОД» в последнем сообщении владельца (workflow v2, фаза 3).
# Без -Confirm "ПРИНИМАЮ ПРОД" скрипт отказывает; после успеха пишет audit.
param(
  [Parameter(Mandatory=$true)][string]$Confirm
)
if ($Confirm -ne "ПРИНИМАЮ ПРОД") { Write-Host "Нет подтверждения — деплой отменён"; exit 1 }

$Vps = "root@193.124.112.208"
$Dir = "/opt/medieval-game"
$Branch = "main"
$Pm2 = "game"

$dirty = ssh $Vps "cd $Dir && git status --porcelain"
if ($dirty) { throw "Серверный репозиторий грязный: деплой запрещён" }
$br = ssh $Vps "cd $Dir && git rev-parse --abbrev-ref HEAD"
if ($br.Trim() -ne $Branch) { throw "На сервере ветка $br, ожидалась $Branch" }
ssh $Vps "cd $Dir && git fetch origin && git merge --ff-only origin/$Branch && pm2 restart $Pm2"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$head = ssh $Vps "cd $Dir && git rev-parse HEAD"
$audit = Join-Path $PSScriptRoot "..\notes\deploy-audit.log"
Add-Content -Path $audit -Encoding UTF8 -Value ("{0} main={1} confirm={2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $head.Trim(), $Confirm)
exit 0
