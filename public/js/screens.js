const SCREENS = ["menuScreen", "lobbyScreen", "gameScreen"];

// Показываем один экран, скрываем остальные
export function showScreen(id) {
  for (const screen of SCREENS) {
    document.getElementById(screen).classList.toggle(
      "hidden",
      screen !== id
    );
  }
}