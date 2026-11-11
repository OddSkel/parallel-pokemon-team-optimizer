// Ciclo do algoritmo genético. Não sabe quem é o adversário nem como se avalia: só fala com a
// interface Evaluator (ver fitness.ts). O mesmo ciclo corre com o avaliador sequencial, com
// partição fixa ou com work-stealing; só o avaliador muda.
//
// Tudo o que é aleatório aqui (seleção, crossover, mutação) sai de prngFrom(baseSeed, gen, ...),
// por isso a evolução é reproduzível e independente do avaliador usado.
import { Team, generatePopulation, generateGenePool, packTeam } from '../teams';
import { prngFrom } from '../util/seed';
import { Evaluator } from './fitness';
import { crossover, mutate, tournamentSelect, MutationParams } from './operators';

export interface GAConfig {
  populationSize: number;
  generations: number; // nº de gerações avaliadas (a última é avaliada mas não gera filhos)
  tournamentSize: number;
  elites: number; // indivíduos copiados sem alteração para a geração seguinte
  pCrossover: number; // probabilidade de um filho vir de crossover (senão é cópia de um pai + mutação)
  mutation: MutationParams;
  genePoolSize: number; // tamanho do banco de Pokémon usado na mutação
  baseSeed: number; // 0..65535 (é usada diretamente como componente de seed do Showdown)
}

export const DEFAULT_GA_CONFIG: GAConfig = {
  populationSize: 48,
  generations: 20,
  tournamentSize: 3,
  elites: 2,
  pCrossover: 0.9,
  mutation: { pMon: 0.1, pMove: 0.15 },
  genePoolSize: 300,
  baseSeed: 1,
};

export interface GenerationStats {
  gen: number;
  best: number;
  mean: number;
  worst: number;
  battles: number;
  /** tempo reportado pelo avaliador (ms) */
  evalMs: number;
  /** tempo de parede à volta de evaluate(), inclui packTeam e comunicação (ms) */
  evalWallMs: number;
  /** parte serial do master: packTeam + seleção + crossover + mutação (ms) */
  serialMs: number;
  /** tempo ocupado de cada worker (ms); só nos avaliadores paralelos */
  workerBusyMs?: number[];
  /** nº de tarefas roubadas a outros workers; só no work-stealing */
  steals?: number;
}

export interface GAResult {
  /** melhor indivíduo visto (pelo fitness medido DENTRO do GA, que é ruidoso: validar à parte) */
  best: Team;
  bestFitness: number;
  bestGen: number;
  finalPopulation: Team[];
  finalFitness: number[];
  history: GenerationStats[];
  totalBattles: number;
  totalMs: number;
}

export async function runGA(
  cfg: GAConfig,
  evaluator: Evaluator,
  onGeneration?: (s: GenerationStats) => void,
): Promise<GAResult> {
  if (cfg.elites >= cfg.populationSize) throw new Error('elites tem de ser < populationSize');

  const tStart = performance.now();
  let pop: Team[] = generatePopulation(cfg.populationSize, cfg.baseSeed);
  const pool = generateGenePool(cfg.genePoolSize, cfg.baseSeed);

  const history: GenerationStats[] = [];
  let best: Team = pop[0];
  let bestFitness = -1;
  let bestGen = 0;
  let fitness: number[] = [];
  let totalBattles = 0;

  for (let gen = 0; gen < cfg.generations; gen++) {
    // --- avaliação ---
    let t = performance.now();
    const packed = pop.map(packTeam);
    let serialMs = performance.now() - t;

    t = performance.now();
    const res = await evaluator.evaluate(packed, gen);
    const evalWallMs = performance.now() - t;
    if (res.fitness.length !== pop.length) throw new Error('o avaliador devolveu um nº errado de fitness');
    fitness = res.fitness;
    totalBattles += res.battles;

    // --- estatísticas e melhor de sempre ---
    let gBest = 0;
    let sum = 0;
    for (let i = 0; i < fitness.length; i++) {
      sum += fitness[i];
      if (fitness[i] > fitness[gBest]) gBest = i;
    }
    if (fitness[gBest] > bestFitness) {
      bestFitness = fitness[gBest];
      best = pop[gBest];
      bestGen = gen;
    }

    // --- reprodução (não na última geração) ---
    if (gen < cfg.generations - 1) {
      t = performance.now();
      const prng = prngFrom(cfg.baseSeed, gen, 1000);
      const order = fitness.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a] || a - b);
      const next: Team[] = order.slice(0, cfg.elites).map((i) => pop[i]);
      while (next.length < cfg.populationSize) {
        const a = pop[tournamentSelect(fitness, cfg.tournamentSize, prng)];
        let child: Team = a;
        if (prng.random() < cfg.pCrossover) {
          const b = pop[tournamentSelect(fitness, cfg.tournamentSize, prng)];
          child = crossover(a, b, prng);
        }
        next.push(mutate(child, pool, cfg.mutation, prng));
      }
      pop = next;
      serialMs += performance.now() - t;
    }

    const stats: GenerationStats = {
      gen,
      best: fitness[gBest],
      mean: sum / fitness.length,
      worst: Math.min(...fitness),
      battles: res.battles,
      evalMs: res.ms,
      evalWallMs,
      serialMs,
      workerBusyMs: res.workerBusyMs,
      steals: res.steals,
    };
    history.push(stats);
    onGeneration?.(stats);
  }

  return {
    best,
    bestFitness,
    bestGen,
    // atenção: após a última geração `pop` ainda é a população avaliada (não se gerou a seguinte)
    finalPopulation: pop,
    finalFitness: fitness,
    history,
    totalBattles,
    totalMs: performance.now() - tStart,
  };
}