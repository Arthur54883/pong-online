const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const db = new DatabaseSync(path.join(__dirname, "jogadores.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    moedas INTEGER NOT NULL DEFAULT 0,
    poderes TEXT NOT NULL DEFAULT '{}',
    vitorias INTEGER NOT NULL DEFAULT 0,
    derrotas INTEGER NOT NULL DEFAULT 0
  )
`);

function criarUsuario(username, senhaHash) {
  const info = db
    .prepare("INSERT INTO usuarios (username, senha_hash) VALUES (?, ?)")
    .run(username, senhaHash);
  return buscarPorId(info.lastInsertRowid);
}

function buscarPorUsername(username) {
  return db.prepare("SELECT * FROM usuarios WHERE username = ?").get(username);
}

function buscarPorId(id) {
  return db.prepare("SELECT * FROM usuarios WHERE id = ?").get(id);
}

function atualizarMoedas(id, moedas) {
  db.prepare("UPDATE usuarios SET moedas = ? WHERE id = ?").run(moedas, id);
}

function atualizarPoderes(id, poderesJson) {
  db.prepare("UPDATE usuarios SET poderes = ? WHERE id = ?").run(poderesJson, id);
}

function registrarResultado(id, venceu) {
  if (venceu) {
    db.prepare("UPDATE usuarios SET vitorias = vitorias + 1 WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE usuarios SET derrotas = derrotas + 1 WHERE id = ?").run(id);
  }
}

module.exports = {
  criarUsuario,
  buscarPorUsername,
  buscarPorId,
  atualizarMoedas,
  atualizarPoderes,
  registrarResultado
};
