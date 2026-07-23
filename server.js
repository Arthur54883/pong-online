const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const db = require("./database.js");

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/online.html");
});

// --- autenticação simples por token em memória (token -> id do usuário) ---
const tokens = new Map();

function criarToken(usuarioId) {
  const token = crypto.randomUUID();
  tokens.set(token, usuarioId);
  return token;
}

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    username: usuario.username,
    moedas: usuario.moedas,
    poderes: JSON.parse(usuario.poderes),
    vitorias: usuario.vitorias,
    derrotas: usuario.derrotas
  };
}

app.post("/api/registrar", (req, res) => {
  const { username, senha } = req.body || {};
  if (!username || !senha || username.length < 3 || senha.length < 4) {
    return res.status(400).json({ erro: "Usuário precisa de 3+ letras e senha 4+ caracteres." });
  }
  if (db.buscarPorUsername(username)) {
    return res.status(409).json({ erro: "Esse nome de usuário já existe." });
  }

  const senhaHash = bcrypt.hashSync(senha, 10);
  const usuario = db.criarUsuario(username, senhaHash);
  const token = criarToken(usuario.id);
  res.json({ token, usuario: usuarioPublico(usuario) });
});

app.post("/api/login", (req, res) => {
  const { username, senha } = req.body || {};
  const usuario = db.buscarPorUsername(username || "");
  if (!usuario || !bcrypt.compareSync(senha || "", usuario.senha_hash)) {
    return res.status(401).json({ erro: "Usuário ou senha incorretos." });
  }

  const token = criarToken(usuario.id);
  res.json({ token, usuario: usuarioPublico(usuario) });
});

app.get("/api/perfil", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const usuarioId = tokens.get(token);
  if (!usuarioId) return res.status(401).json({ erro: "Token inválido." });

  const usuario = db.buscarPorId(usuarioId);
  res.json({ usuario: usuarioPublico(usuario) });
});

// --- física do jogo (mesmas medidas do jogo original) ---
const LARGURA = 800;
const ALTURA = 500;
const RAQUETE_LARGURA = 12;
const RAQUETE_ALTURA = 90;
const VELOCIDADE_RAQUETE = 6;
const TEMPO_TOTAL = 5 * 60; // 5 minutos
const BONUS_VITORIA = 15;

function novaBola(direcao) {
  return {
    x: LARGURA / 2,
    y: ALTURA / 2,
    raio: 8,
    velX: 2.2 * direcao,
    velY: Math.random() * 1.8 - 0.9 || 1.5,
    parada: true
  };
}

function novaSala(idSala) {
  return {
    id: idSala,
    jogadores: [], // { socket, usuarioId, username, cima, baixo, pontos }
    bola: novaBola(1),
    tempoRestante: TEMPO_TOTAL,
    acabou: false,
    intervaloFisica: null,
    intervaloTempo: null
  };
}

const salas = new Map();
let filaEspera = null; // socket esperando oponente

function estadoParaCliente(sala, indiceJogador) {
  const eu = sala.jogadores[indiceJogador];
  const oponente = sala.jogadores[1 - indiceJogador];
  return {
    bola: sala.bola,
    meuY: eu.y,
    oponenteY: oponente.y,
    meusPontos: eu.pontos,
    oponentePontos: oponente.pontos,
    meuNome: eu.username,
    oponenteNome: oponente.username,
    tempoRestante: sala.tempoRestante,
    acabou: sala.acabou
  };
}

function iniciarFisica(sala) {
  sala.intervaloFisica = setInterval(() => {
    if (sala.acabou) return;
    const [j1, j2] = sala.jogadores;

    // move as raquetes
    if (j1.cima) j1.y = Math.max(0, j1.y - VELOCIDADE_RAQUETE);
    if (j1.baixo) j1.y = Math.min(ALTURA - RAQUETE_ALTURA, j1.y + VELOCIDADE_RAQUETE);
    if (j2.cima) j2.y = Math.max(0, j2.y - VELOCIDADE_RAQUETE);
    if (j2.baixo) j2.y = Math.min(ALTURA - RAQUETE_ALTURA, j2.y + VELOCIDADE_RAQUETE);

    const bola = sala.bola;
    if (!bola.parada) {
      bola.x += bola.velX;
      bola.y += bola.velY;

      if (bola.y - bola.raio < 0 || bola.y + bola.raio > ALTURA) {
        bola.velY *= -1;
      }

      // colisão com jogador 1 (esquerda)
      if (
        bola.x - bola.raio < 20 + RAQUETE_LARGURA &&
        bola.y > j1.y &&
        bola.y < j1.y + RAQUETE_ALTURA &&
        bola.velX < 0
      ) {
        bola.velX *= -1.05;
        const impacto = (bola.y - (j1.y + RAQUETE_ALTURA / 2)) / (RAQUETE_ALTURA / 2);
        bola.velY = impacto * 5;
      }

      // colisão com jogador 2 (direita)
      const xJogador2 = LARGURA - 20 - RAQUETE_LARGURA;
      if (
        bola.x + bola.raio > xJogador2 &&
        bola.y > j2.y &&
        bola.y < j2.y + RAQUETE_ALTURA &&
        bola.velX > 0
      ) {
        bola.velX *= -1.05;
        const impacto = (bola.y - (j2.y + RAQUETE_ALTURA / 2)) / (RAQUETE_ALTURA / 2);
        bola.velY = impacto * 5;
      }

      // ponto para jogador 2
      if (bola.x < 0) {
        j2.pontos++;
        Object.assign(bola, novaBola(1));
      }

      // ponto para jogador 1
      if (bola.x > LARGURA) {
        j1.pontos++;
        Object.assign(bola, novaBola(-1));
      }
    }

    j1.socket.emit("estadoJogo", estadoParaCliente(sala, 0));
    j2.socket.emit("estadoJogo", estadoParaCliente(sala, 1));
  }, 1000 / 60);

  sala.intervaloTempo = setInterval(() => {
    if (sala.acabou || sala.bola.parada) return;
    sala.tempoRestante--;
    if (sala.tempoRestante <= 0) {
      sala.tempoRestante = 0;
      finalizarSala(sala);
    }
  }, 1000);
}

function finalizarSala(sala) {
  if (sala.acabou) return;
  sala.acabou = true;
  clearInterval(sala.intervaloFisica);
  clearInterval(sala.intervaloTempo);

  const [j1, j2] = sala.jogadores;
  const ganhador = j1.pontos > j2.pontos ? j1 : j2.pontos > j1.pontos ? j2 : null;

  sala.jogadores.forEach((j) => {
    const usuario = db.buscarPorId(j.usuarioId);
    let moedas = usuario.moedas + j.pontos; // 1 moeda por ponto marcado
    if (ganhador === j) moedas += BONUS_VITORIA;
    db.atualizarMoedas(j.usuarioId, moedas);
    if (ganhador) db.registrarResultado(j.usuarioId, ganhador === j);
    j.socket.emit("fimDeJogo", {
      venceu: ganhador === j,
      empate: !ganhador,
      moedasGanhas: j.pontos + (ganhador === j ? BONUS_VITORIA : 0)
    });
  });

  salas.delete(sala.id);
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const usuarioId = tokens.get(token);
  if (!usuarioId) return next(new Error("Token inválido"));
  socket.usuarioId = usuarioId;
  next();
});

io.on("connection", (socket) => {
  const usuario = db.buscarPorId(socket.usuarioId);

  socket.on("procurarPartida", () => {
    if (filaEspera && filaEspera.connected) {
      const idSala = crypto.randomUUID();
      const sala = novaSala(idSala);

      sala.jogadores.push({
        socket: filaEspera,
        usuarioId: filaEspera.usuarioId,
        username: filaEspera.usernameEsperando,
        y: ALTURA / 2 - RAQUETE_ALTURA / 2,
        cima: false,
        baixo: false,
        pontos: 0
      });
      sala.jogadores.push({
        socket,
        usuarioId: socket.usuarioId,
        username: usuario.username,
        y: ALTURA / 2 - RAQUETE_ALTURA / 2,
        cima: false,
        baixo: false,
        pontos: 0
      });

      salas.set(idSala, sala);
      filaEspera.salaId = idSala;
      socket.salaId = idSala;

      filaEspera.emit("partidaEncontrada", { oponente: usuario.username, indice: 0 });
      socket.emit("partidaEncontrada", { oponente: filaEspera.usernameEsperando, indice: 1 });

      filaEspera = null;
      iniciarFisica(sala);
    } else {
      socket.usernameEsperando = usuario.username;
      filaEspera = socket;
      socket.emit("procurandoOponente");
    }
  });

  socket.on("cancelarBusca", () => {
    if (filaEspera === socket) filaEspera = null;
  });

  socket.on("lancarBola", () => {
    const sala = salas.get(socket.salaId);
    if (sala) sala.bola.parada = false;
  });

  socket.on("mover", ({ direcao }) => {
    const sala = salas.get(socket.salaId);
    if (!sala) return;
    const jogador = sala.jogadores.find((j) => j.socket === socket);
    if (!jogador) return;
    jogador.cima = direcao === "cima";
    jogador.baixo = direcao === "baixo";
  });

  socket.on("disconnect", () => {
    if (filaEspera === socket) filaEspera = null;

    const sala = salas.get(socket.salaId);
    if (sala && !sala.acabou) {
      sala.acabou = true;
      clearInterval(sala.intervaloFisica);
      clearInterval(sala.intervaloTempo);
      const outro = sala.jogadores.find((j) => j.socket !== socket);
      if (outro) outro.socket.emit("oponenteSaiu");
      salas.delete(sala.id);
    }
  });
});

const PORTA = process.env.PORT || process.env.PORTA || 3000;
servidor.listen(PORTA, () => {
  console.log(`Servidor do Pong online rodando em http://localhost:${PORTA}`);
});
