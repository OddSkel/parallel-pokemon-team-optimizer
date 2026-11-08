// Fitness = taxa de vitórias de uma equipa contra a(s) equipa(s) adversária(s) (empate vale 0.5).
//
// A "tarefa" elementar, que o master/worker vai distribuir, é UM combate: (equipa, adversário j,
// combate k). O resultado de um combate depende só de (equipa, adversário, seed, lado), e a seed
// depende só de (seed base, geração, j, k), nunca da posição do indivíduo na população nem de
// quem a executa. Por isso o fitness é igual em sequencial, com partição fixa ou com work-stealing.
import { runBattle, DEFAULT_FORMAT, BattleResult } from '../battle';
import { Seed } from '../teams';
import { seedFrom } from '../util/seed';

export interface EvalOptions {
  /** substitui o nº de combates por adversário configurado (usado na validação final) */
  battlesPerOpponent?: number;
}

export interface EvalResult {
  /** fitness de cada equipa, na mesma ordem em que foram passadas */
  fitness: number[];
  /** nº de combates executados */
  battles: number;
  /** tempo total (ms) */
  ms: number;
}

/**
 * Contrato entre o GA e quem avalia. O GA só conhece isto; a versão paralela (master/worker)
 * implementa a mesma interface e o ciclo do GA não muda.
 */
export interface Evaluator {
  evaluate(teams: string[], gen: number, opts?: EvalOptions): Promise<EvalResult>;
  close?(): Promise<void>;
}

/** Seed do combate k contra o adversário j na geração gen (gen = -1 na validação final). */
export function battleSeed(baseSeed: number, gen: number, opponent: number, k: number): Seed {
  return seedFrom(baseSeed, gen, opponent, k);
}

/**
 * Pontuação (1 / 0.5 / 0) da equipa candidata num combate. Os lados alternam com k (k par: a
 * candidata é o lado A; k ímpar: é o B), para o resultado não depender de que lado joga.
 */
export function scoreBattle(result: BattleResult, k: number): number {
  if (result.winner === -1) return 0.5;
  const candidateSide = k % 2 === 0 ? 0 : 1;
  return result.winner === candidateSide ? 1 : 0;
}

/** Executa um combate (a tarefa elementar) e devolve a pontuação da candidata. */
export async function playTask(
  candidate: string,
  opponent: string,
  seed: Seed,
  k: number,
  format: string = DEFAULT_FORMAT,
): Promise<number> {
  const r = k % 2 === 0 ? await runBattle(candidate, opponent, seed, format) : await runBattle(opponent, candidate, seed, format);
  return scoreBattle(r, k);
}

export interface SequentialEvaluatorConfig {
  /** equipas adversárias em formato "packed" (no caso normal, uma só) */
  opponents: string[];
  /** combates por adversário (K); par, para os dois lados jogarem o mesmo nº de vezes */
  battlesPerOpponent: number;
  baseSeed: number;
  format?: string;
}

export function createSequentialEvaluator(cfg: SequentialEvaluatorConfig): Evaluator {
  return {
    async evaluate(teams, gen, opts) {
      const K = opts?.battlesPerOpponent ?? cfg.battlesPerOpponent;
      const t0 = performance.now();
      const fitness: number[] = [];
      let battles = 0;
      for (const team of teams) {
        let score = 0;
        for (let j = 0; j < cfg.opponents.length; j++) {
          for (let k = 0; k < K; k++) {
            score += await playTask(team, cfg.opponents[j], battleSeed(cfg.baseSeed, gen, j, k), k, cfg.format);
            battles++;
          }
        }
        fitness.push(score / (cfg.opponents.length * K));
      }
      return { fitness, battles, ms: performance.now() - t0 };
    },
  };
}