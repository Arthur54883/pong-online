// catálogo dos poderes compráveis — usado tanto pela loja (custo) quanto pelo jogo (efeitos)
const CATALOGO_PODERES = {
  superChute: {
    nome: "Super Chute",
    tecla: "e",
    cooldown: 8,
    niveis: [
      { custo: 8, multiplicador: 1.3 },
      { custo: 12, multiplicador: 1.4 },
      { custo: 16, multiplicador: 1.6 }
    ]
  },
  raqueteGrande: {
    nome: "Raquete Grande",
    tecla: "1",
    cooldown: 15,
    niveis: [
      { custo: 10, duracao: 6, multiplicador: 1.4 },
      { custo: 14, duracao: 7, multiplicador: 1.6 },
      { custo: 20, duracao: 8, multiplicador: 1.8 }
    ]
  },
  cameraLenta: {
    nome: "Câmera Lenta",
    tecla: "2",
    cooldown: 16,
    niveis: [
      { custo: 10, duracao: 5, fator: 0.5 },
      { custo: 14, duracao: 6, fator: 0.4 },
      { custo: 20, duracao: 7, fator: 0.3 }
    ]
  },
  congelarOponente: {
    nome: "Congelar Oponente",
    tecla: "3",
    cooldown: 18,
    niveis: [
      { custo: 10, duracao: 2 },
      { custo: 14, duracao: 3 },
      { custo: 20, duracao: 4 }
    ]
  },
  bolaFantasma: {
    nome: "Bola Fantasma",
    tecla: "4",
    cooldown: 16,
    niveis: [
      { custo: 10, duracao: 3 },
      { custo: 14, duracao: 4 },
      { custo: 20, duracao: 5 }
    ]
  },
  multibola: {
    nome: "Multi-bola",
    tecla: "5",
    cooldown: 22,
    niveis: [
      { custo: 16, duracao: 8, extras: 1 },
      { custo: 20, duracao: 10, extras: 1 },
      { custo: 28, duracao: 12, extras: 2 }
    ]
  },
  congelarBola: {
    nome: "Congelar Bola",
    tecla: "6",
    cooldown: 14,
    niveis: [
      { custo: 10, duracao: 1.5 },
      { custo: 14, duracao: 2.5 },
      { custo: 18, duracao: 3.5 }
    ]
  },
  sorte: {
    nome: "Poder da Sorte",
    tecla: "7",
    cooldown: 25,
    niveis: [
      { custo: 10, chance: 0.25 },
      { custo: 14, chance: 0.4 },
      { custo: 18, chance: 0.55 }
    ]
  },
  escudo: {
    nome: "Escudo",
    tecla: null, // automático
    niveis: [
      { custo: 12, chance: 0.35, cooldown: 20 },
      { custo: 16, chance: 0.5, cooldown: 15 },
      { custo: 22, chance: 0.7, cooldown: 10 }
    ]
  }
};

module.exports = { CATALOGO_PODERES };
