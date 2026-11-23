# Ручной деплой прода (:8080) — git-only по QWEN.md «Git-транспорт изменений».
# Запускает ТОЛЬКО владелец вручную (deploy-prod.bat). Агенту запуск запрещён.
$Vps = "root@193.124.112.208"
$Dir = "/opt/medieval-game"
$Branch = "main"
$Pm2 = "game"

$confirm = Read-Host "Введите PROD для подтверждения"
if ($confirm -ne "PROD") { Write-Host "Ввод не PROD — деплой отменён."; exit 1 }

$dirty = ssh $Vps "cd $Dir && git status --porcelain"
if ($dirty) { throw "Серверный репозиторий грязный: деплой запрещён" }
$br = ssh $Vps "cd $Dir && git rev-parse --abbrev-ref HEAD"
if ($br.Trim() -ne $Branch) { throw "На сервере ветка $br, ожидалась $Branch" }
ssh $Vps "cd $Dir && git fetch origin && git merge --ff-only origin/$Branch && pm2 restart $Pm2"
exit $LASTEXITCODE
