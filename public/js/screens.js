const langSelect = document.getElementById("lang");
const appElement = document.querySelector(".app");
const gameScreenElement = document.getElementById("gameScreen");

// Держим селектор языка в нужном месте:
// во время игры — внутри игрового экрана, иначе — сверху страницы
function placeLang() {
  const gameVisible = !gameScreenElement.classList.contains("hidden");

  if (gameVisible) {
    if (langSelect.parentElement !== gameScreenElement) {
      gameScreenElement.insertBefore(langSelect, gameScreenElement.firstChild);
    }
  } else if (langSelect.parentElement !== appElement) {
    appElement.insertBefore(langSelect, appElement.firstChild);
  }
}

export function showScreen(screenId) {
  const screens = ["menuScreen", "lobbyScreen", "gameScreen"];

  for (const id of screens) {
    const element = document.getElementById(id);
    element.classList.toggle("hidden", id !== screenId);
  }

  placeLang();
}