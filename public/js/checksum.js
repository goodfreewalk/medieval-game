// Компактная контрольная сумма игрового состояния.
// Модуль общий для клиента и сервера: после каждого хода сервер шлёт
// свою сумму, клиент сверяет со своей; при расхождении клиент молча
// перезапрашивает полное состояние из серверного зеркала.

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// st — объект состояния (клиентский state или загруженное зеркало)
export function computeChecksum(st) {
  if (!st || !st.map) {
    return "empty";
  }

  const units = (st.units || [])
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(u => `${u.id}:${u.owner}:${u.type}:${u.x},${u.y}:${u.hp}`)
    .join("|");

  let ownersEntries;
  if (st.owners instanceof Map) {
    ownersEntries = Array.from(st.owners.entries());
  } else if (Array.isArray(st.owners)) {
    ownersEntries = st.owners;
  } else {
    ownersEntries = [];
  }
  const ownersStr = ownersEntries
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");

  const playersStr = Object.keys(st.players || {})
    .map(Number)
    .sort((a, b) => a - b)
    .map(id => `${id}:${(st.players[id] || {}).gold || 0}`)
    .join("|");

  const eliminatedStr = Array.from(st.eliminated || [])
    .map(Number)
    .sort((a, b) => a - b)
    .join(",");

  const payload = [
    units,
    ownersStr,
    playersStr,
    eliminatedStr,
    st.currentPlayer,
    st.gameOver ? 1 : 0,
    st.winner === null || st.winner === undefined ? "-" : st.winner
  ].join("#");

  return hashString(payload);
}