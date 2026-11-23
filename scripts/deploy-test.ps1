# Ручной деплой ТОЛЬКО тестового контура (:8081) — git-only по QWEN.md «Git-транспорт изменений».
# Сервер: root@193.124.112.208 (доступ по SSH-ключу). Только git + pm2 restart, без правок файлов на сервере.
$Vps = "root@193.124.112.208"
$Dir = "/opt/medieval-game-test"
$Branch = "test"
$Pm2 = "game-test"

$dirty = ssh $Vps "cd $Dir && git status --porcelain"
if ($dirty) { throw "Серверный репозиторий грязный: деплой запрещён" }
$br = ssh $Vps "cd $Dir && git rev-parse --abbrev-ref HEAD"
if ($br.Trim() -ne $Branch) { throw "На сервере ветка $br, ожидалась $Branch" }
ssh $Vps "cd $Dir && git fetch origin && git merge --ff-only origin/$Branch && pm2 restart $Pm2"
exit $LASTEXITCODE
