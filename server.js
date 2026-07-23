const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const db = require("./database.js");
const { CATALOGO_PODERES } = require("./poderes.js");

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

function usuarioAutenticado(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const usuarioId = tokens.get(token);
  return usuarioId ? db.buscarPorId(usuarioId) : null;
}

app.get("/api/loja", (req, res) => {
  const usuario = usuarioAutenticado(req);
  if (!usuario) return res.status(401).json({ erro: "Token inválido." });

  res.json({
    moedas: usuario.moedas,
    poderes: JSON.parse(usuario.poderes),
    catalogo: CATALOGO_PODERES
  });
});

app.post("/api/comprar", (req, res) => {
  const usuario = usuarioAutenticado(req);
  if (!usuario) return res.status(401).json({ erro: "Token inválido." });

  const { poderId } = req.body || {};
  const definicao = CATALOGO_PODERES[poderId];
  if (!definicao) return res.status(400).json({ erro: "Poder inválido." });

  const poderesAtuais = JSON.parse(usuario.poderes);
  const nivelAtual = poderesAtuais[poderId] || 0;

  if (nivelAtual >= definicao.niveis.length) {
    return res.status(400).json({ erro: "Esse poder já está no nível máximo." });
  }

  const custo = definicao.niveis[nivelAtual].custo;
  if (usuario.moedas < custo) {
    return res.status(400).json({ erro: "Moedas insuficientes." });
  }

  poderesAtuais[poderId] = nivelAtual + 1;
  db.atualizarPoderes(usuario.id, JSON.stringify(poderesAtuais));
  db.atualizarMoedas(usuario.id, usuario.moedas - custo);

  res.json({ moedas: usuario.moedas - custo, poderes: poderesAtuais });
});

// --- física do jogo (mesmas medidas do jogo original) ---
const LARGURA = 800;
const ALTURA = 500;
const RAQUETE_LARGURA = 12;
const RAQUETE_ALTURA = 90;
const VELOCIDADE_RAQUETE = 6;
const TEMPO_TOTAL = 5 * 60; // 5 minutos
const BONUS_VITORIA = 15;
const DT = 1 / 60; // duração de cada tick de física, em segundos

const IDS_PODERES_ATIVAVEIS = Object.keys(CATALOGO_PODERES).filter((id) => id !== "escudo");

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

function poderesRuntimeDoUsuario(usuarioId) {
  const usuarioDb = db.buscarPorId(usuarioId);
  const poderesSalvos = JSON.parse(usuarioDb.poderes);
  const runtime = {};
  Object.keys(CATALOGO_PODERES).forEach((id) => {
    runtime[id] = {
      nivel: poderesSalvos[id] || 0,
      cooldownRestante: 0,
      ativo: false,
      tempoRestanteEfeito: 0,
      armado: false
    };
  });
  return runtime;
}

function criarJogador(socket, usuarioId, username) {
  return {
    socket,
    usuarioId,
    username,
    y: ALTURA / 2 - RAQUETE_ALTURA / 2,
    altura: RAQUETE_ALTURA,
    cima: false,
    baixo: false,
    travado: false,
    pontos: 0,
    poderes: poderesRuntimeDoUsuario(usuarioId),
    mensagem: null
  };
}

function novaSala(idSala) {
  return {
    id: idSala,
    jogadores: [], // criados via criarJogador()
    bola: novaBola(1),
    bolasExtras: [],
    fatorVelocidadeBola: 1,
    bolaCongelada: false,
    fantasma: { ativoPara: null }, // índice do jogador que fica sem ver a bola
    tempoRestante: TEMPO_TOTAL,
    acabou: false,
    intervaloFisica: null,
    intervaloTempo: null
  };
}

const salas = new Map();
let filaEspera = null; // socket esperando oponente

function desativarPoder(sala, jogador, id) {
  switch (id) {
    case "raqueteGrande":
      jogador.y += (jogador.altura - RAQUETE_ALTURA) / 2;
      jogador.altura = RAQUETE_ALTURA;
      break;
    case "cameraLenta":
      sala.fatorVelocidadeBola = 1;
      break;
    case "congelarOponente": {
      const oponente = sala.jogadores.find((j) => j !== jogador);
      if (oponente) oponente.travado = false;
      break;
    }
    case "bolaFantasma":
      if (sala.fantasma.ativoPara !== null) sala.fantasma.ativoPara = null;
      break;
    case "multibola":
      sala.bolasExtras = [];
      break;
    case "congelarBola":
      sala.bolaCongelada = false;
      break;
  }
}

function atualizarPoderesJogador(sala, jogador) {
  Object.entries(jogador.poderes).forEach(([id, p]) => {
    if (p.cooldownRestante > 0) p.cooldownRestante = Math.max(0, p.cooldownRestante - DT);
    if (p.ativo) {
      p.tempoRestanteEfeito = Math.max(0, p.tempoRestanteEfeito - DT);
      if (p.tempoRestanteEfeito <= 0) {
        p.ativo = false;
        desativarPoder(sala, jogador, id);
      }
    }
  });
  if (jogador.mensagem) {
    jogador.mensagem.tempo -= DT;
    if (jogador.mensagem.tempo <= 0) jogador.mensagem = null;
  }
}

function moverBolaExtra(sala, b) {
  const [j1, j2] = sala.jogadores;
  b.x += b.velX * sala.fatorVelocidadeBola;
  b.y += b.velY * sala.fatorVelocidadeBola;

  if (b.y - b.raio < 0 || b.y + b.raio > ALTURA) b.velY *= -1;

  if (b.x - b.raio < 20 + RAQUETE_LARGURA && b.y > j1.y && b.y < j1.y + j1.altura && b.velX < 0) {
    b.velX *= -1.05;
  }
  const xJogador2 = LARGURA - 20 - RAQUETE_LARGURA;
  if (b.x + b.raio > xJogador2 && b.y > j2.y && b.y < j2.y + j2.altura && b.velX > 0) {
    b.velX *= -1.05;
  }

  if (b.x < 0) {
    j2.pontos++;
    return false;
  }
  if (b.x > LARGURA) {
    j1.pontos++;
    return false;
  }
  return true;
}

function estadoParaCliente(sala, indiceJogador) {
  const eu = sala.jogadores[indiceJogador];
  const oponente = sala.jogadores[1 - indiceJogador];
  const bolaOculta = sala.fantasma.ativoPara === indiceJogador;

  return {
    bola: { x: sala.bola.x, y: sala.bola.y, raio: sala.bola.raio, parada: sala.bola.parada, oculta: bolaOculta },
    bolasExtras: sala.bolasExtras,
    meuY: eu.y,
    oponenteY: oponente.y,
    minhaAltura: eu.altura,
    oponenteAltura: oponente.altura,
    meusPontos: eu.pontos,
    oponentePontos: oponente.pontos,
    meuNome: eu.username,
    oponenteNome: oponente.username,
    tempoRestante: sala.tempoRestante,
    acabou: sala.acabou,
    mensagem: eu.mensagem,
    meusPoderes: Object.fromEntries(
      Object.entries(eu.poderes).map(([id, p]) => [
        id,
        {
          nivel: p.nivel,
          ativo: p.ativo,
          armado: p.armado,
          cooldownRestante: Math.round(p.cooldownRestante * 10) / 10,
          tempoRestanteEfeito: Math.round(p.tempoRestanteEfeito * 10) / 10
        }
      ])
    )
  };
}

function iniciarFisica(sala) {
  sala.intervaloFisica = setInterval(() => {
    if (sala.acabou) return;
    const [j1, j2] = sala.jogadores;

    atualizarPoderesJogador(sala, j1);
    atualizarPoderesJogador(sala, j2);

    // move as raquetes (jogador travado pelo poder Congelar Oponente não se move)
    if (!j1.travado) {
      if (j1.cima) j1.y = Math.max(0, j1.y - VELOCIDADE_RAQUETE);
      if (j1.baixo) j1.y = Math.min(ALTURA - j1.altura, j1.y + VELOCIDADE_RAQUETE);
    }
    if (!j2.travado) {
      if (j2.cima) j2.y = Math.max(0, j2.y - VELOCIDADE_RAQUETE);
      if (j2.baixo) j2.y = Math.min(ALTURA - j2.altura, j2.y + VELOCIDADE_RAQUETE);
    }
    j1.y = Math.max(0, Math.min(ALTURA - j1.altura, j1.y));
    j2.y = Math.max(0, Math.min(ALTURA - j2.altura, j2.y));

    const bola = sala.bola;
    if (!bola.parada && !sala.bolaCongelada) {
      bola.x += bola.velX * sala.fatorVelocidadeBola;
      bola.y += bola.velY * sala.fatorVelocidadeBola;

      if (bola.y - bola.raio < 0 || bola.y + bola.raio > ALTURA) {
        bola.velY *= -1;
      }

      // colisão com jogador 1 (esquerda)
      if (
        bola.x - bola.raio < 20 + RAQUETE_LARGURA &&
        bola.y > j1.y &&
        bola.y < j1.y + j1.altura &&
        bola.velX < 0
      ) {
        const impacto = (bola.y - (j1.y + j1.altura / 2)) / (j1.altura / 2);
        if (j1.poderes.superChute.armado) {
          const cfg = CATALOGO_PODERES.superChute.niveis[j1.poderes.superChute.nivel - 1];
          bola.velX = Math.abs(bola.velX) * cfg.multiplicador;
          j1.poderes.superChute.armado = false;
          j1.poderes.superChute.cooldownRestante = CATALOGO_PODERES.superChute.cooldown;
        } else {
          bola.velX *= -1.05;
        }
        bola.velY = impacto * 5;

        if (j1.poderes.bolaFantasma.armado) {
          const cfg = CATALOGO_PODERES.bolaFantasma.niveis[j1.poderes.bolaFantasma.nivel - 1];
          j1.poderes.bolaFantasma.armado = false;
          j1.poderes.bolaFantasma.ativo = true;
          j1.poderes.bolaFantasma.tempoRestanteEfeito = cfg.duracao;
          j1.poderes.bolaFantasma.cooldownRestante = CATALOGO_PODERES.bolaFantasma.cooldown;
          sala.fantasma.ativoPara = 1;
        }
      }

      // colisão com jogador 2 (direita)
      const xJogador2 = LARGURA - 20 - RAQUETE_LARGURA;
      if (
        bola.x + bola.raio > xJogador2 &&
        bola.y > j2.y &&
        bola.y < j2.y + j2.altura &&
        bola.velX > 0
      ) {
        const impacto = (bola.y - (j2.y + j2.altura / 2)) / (j2.altura / 2);
        if (j2.poderes.superChute.armado) {
          const cfg = CATALOGO_PODERES.superChute.niveis[j2.poderes.superChute.nivel - 1];
          bola.velX = -Math.abs(bola.velX) * cfg.multiplicador;
          j2.poderes.superChute.armado = false;
          j2.poderes.superChute.cooldownRestante = CATALOGO_PODERES.superChute.cooldown;
        } else {
          bola.velX *= -1.05;
        }
        bola.velY = impacto * 5;

        if (j2.poderes.bolaFantasma.armado) {
          const cfg = CATALOGO_PODERES.bolaFantasma.niveis[j2.poderes.bolaFantasma.nivel - 1];
          j2.poderes.bolaFantasma.armado = false;
          j2.poderes.bolaFantasma.ativo = true;
          j2.poderes.bolaFantasma.tempoRestanteEfeito = cfg.duracao;
          j2.poderes.bolaFantasma.cooldownRestante = CATALOGO_PODERES.bolaFantasma.cooldown;
          sala.fantasma.ativoPara = 0;
        }
      }

      // ponto para jogador 2 — a não ser que o Escudo do jogador 1 bloqueie
      if (bola.x < 0) {
        const escudo = j1.poderes.escudo;
        if (escudo.nivel > 0 && escudo.cooldownRestante <= 0) {
          const cfg = CATALOGO_PODERES.escudo.niveis[escudo.nivel - 1];
          escudo.cooldownRestante = cfg.cooldown;
          if (Math.random() < cfg.chance) {
            bola.x = bola.raio + 1;
            bola.velX = Math.abs(bola.velX);
            j1.mensagem = { texto: "Escudo bloqueou o gol!", cor: "#00e5ff", tempo: 2 };
          } else {
            j2.pontos++;
            Object.assign(bola, novaBola(1));
            j1.mensagem = { texto: "Escudo falhou...", cor: "#888", tempo: 2 };
          }
        } else {
          j2.pontos++;
          Object.assign(bola, novaBola(1));
        }
      }

      // ponto para jogador 1 — a não ser que o Escudo do jogador 2 bloqueie
      if (bola.x > LARGURA) {
        const escudo = j2.poderes.escudo;
        if (escudo.nivel > 0 && escudo.cooldownRestante <= 0) {
          const cfg = CATALOGO_PODERES.escudo.niveis[escudo.nivel - 1];
          escudo.cooldownRestante = cfg.cooldown;
          if (Math.random() < cfg.chance) {
            bola.x = LARGURA - bola.raio - 1;
            bola.velX = -Math.abs(bola.velX);
            j2.mensagem = { texto: "Escudo bloqueou o gol!", cor: "#00e5ff", tempo: 2 };
          } else {
            j1.pontos++;
            Object.assign(bola, novaBola(-1));
            j2.mensagem = { texto: "Escudo falhou...", cor: "#888", tempo: 2 };
          }
        } else {
          j1.pontos++;
          Object.assign(bola, novaBola(-1));
        }
      }

      sala.bolasExtras = sala.bolasExtras.filter((b) => moverBolaExtra(sala, b));
    }

    j1.socket.emit("estadoJogo", estadoParaCliente(sala, 0));
    j2.socket.emit("estadoJogo", estadoParaCliente(sala, 1));
  }, 1000 * DT);

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

      sala.jogadores.push(criarJogador(filaEspera, filaEspera.usuarioId, filaEspera.usernameEsperando));
      sala.jogadores.push(criarJogador(socket, socket.usuarioId, usuario.username));

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

  socket.on("usarPoder", ({ poderId }) => {
    const sala = salas.get(socket.salaId);
    if (!sala || sala.acabou) return;
    if (!IDS_PODERES_ATIVAVEIS.includes(poderId)) return;

    const jogador = sala.jogadores.find((j) => j.socket === socket);
    if (!jogador) return;
    const oponente = sala.jogadores.find((j) => j !== jogador);

    const p = jogador.poderes[poderId];
    const definicao = CATALOGO_PODERES[poderId];
    if (!p || p.nivel <= 0 || p.cooldownRestante > 0 || p.ativo || p.armado) return;
    const cfg = definicao.niveis[p.nivel - 1];

    switch (poderId) {
      case "superChute":
      case "bolaFantasma":
        p.armado = true; // o efeito acontece de verdade na próxima rebatida
        break;

      case "raqueteGrande": {
        const alturaAntiga = jogador.altura;
        const alturaNova = RAQUETE_ALTURA * cfg.multiplicador;
        jogador.y -= (alturaNova - alturaAntiga) / 2;
        jogador.altura = alturaNova;
        p.ativo = true;
        p.tempoRestanteEfeito = cfg.duracao;
        p.cooldownRestante = definicao.cooldown;
        break;
      }

      case "cameraLenta":
        sala.fatorVelocidadeBola = cfg.fator;
        p.ativo = true;
        p.tempoRestanteEfeito = cfg.duracao;
        p.cooldownRestante = definicao.cooldown;
        break;

      case "congelarOponente":
        if (oponente) oponente.travado = true;
        p.ativo = true;
        p.tempoRestanteEfeito = cfg.duracao;
        p.cooldownRestante = definicao.cooldown;
        break;

      case "multibola":
        for (let i = 0; i < cfg.extras; i++) {
          sala.bolasExtras.push({
            x: sala.bola.x,
            y: sala.bola.y,
            raio: 8,
            velX: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 2),
            velY: Math.random() * 4 - 2 || 2
          });
        }
        p.ativo = true;
        p.tempoRestanteEfeito = cfg.duracao;
        p.cooldownRestante = definicao.cooldown;
        break;

      case "congelarBola":
        sala.bolaCongelada = true;
        p.ativo = true;
        p.tempoRestanteEfeito = cfg.duracao;
        p.cooldownRestante = definicao.cooldown;
        break;

      case "sorte":
        p.cooldownRestante = definicao.cooldown;
        if (Math.random() < cfg.chance) {
          jogador.pontos++;
          const direcaoServico = jogador === sala.jogadores[0] ? -1 : 1;
          Object.assign(sala.bola, novaBola(direcaoServico));
          jogador.mensagem = { texto: "SORTE GRANDE! Ponto garantido!", cor: "#ffcc00", tempo: 2 };
        } else {
          jogador.mensagem = { texto: "Sem sorte dessa vez...", cor: "#888", tempo: 2 };
        }
        break;
    }
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
