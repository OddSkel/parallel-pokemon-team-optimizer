// Fitness = taxa de vitórias de uma equipa contra a(s) equipa(s) adversária(s) (empate vale 0.5).
//
// A "tarefa" elementar, que o master/worker vai distribuir, é UM combate: (equipa, adversário j,
// combate k). O resultado de um combate depende só de (equipa, adversário, seed, lado), e a seed
// depende só de (seed base, geração, j, k), nunca da posição do indivíduo na população nem de
// quem a executa. Por isso o fitness é igual em sequencial, com partição fixa ou com work-stealing.
import { Worker } from 'node:worker_threads';
import { extname, join } from 'node:path';

import { runBattle, DEFAULT_FORMAT, BattleResult } from '../battle';
import { Seed } from '../teams';
import { seedFrom } from '../util/seed';
import type {
  BattleTask,
  CloseMessage,
  EvalMessage,
  InitMessage,
  ResultMessage,
  WorkerMessage,
} from '../parallel/worker-protocol';

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
  /** tempo ocupado de cada worker (ms); só nos avaliadores paralelos */
  workerBusyMs?: number[];
  /** nº de tarefas roubadas a outros workers; só no work-stealing */
  steals?: number;
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

// --- Avaliador paralelo com partição fixa -------------------------------------------

export interface FixedEvaluatorConfig extends SequentialEvaluatorConfig {
  /** nº de worker threads (>= 1) */
  threads: number;
}

/**
 * Divide `items` em `parts` blocos contíguos. Os primeiros `items.length % parts`
 * blocos ficam com mais um elemento. É a partição fixa: o worker w recebe sempre
 * o bloco w, independentemente de quanto demora.
 */
function splitFixed<T>(items: readonly T[], parts: number): T[][] {
  const out: T[][] = [];
  const base = Math.floor(items.length / parts);
  const rem = items.length % parts;
  let start = 0;
  for (let p = 0; p < parts; p++) {
    const size = base + (p < rem ? 1 : 0);
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
}

/** Caminho do worker: .ts quando corremos com tsx, .js depois de compilar para dist/. */
function workerPath(): string {
  return join(__dirname, '..', 'parallel', `worker${extname(__filename)}`);
}

/** Lista de tarefas elementares, por ordem estável: equipa, adversário, combate. */
function buildTasks(teams: readonly string[], opponents: readonly string[], K: number): BattleTask[] {
  const tasks: BattleTask[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < opponents.length; j++) {
      for (let k = 0; k < K; k++) {
        tasks.push({ teamIndex: i, team: teams[i], opponent: j, k });
      }
    }
  }
  return tasks;
}

/** Cliente de um worker: garante que o init terminou e correlaciona pedidos/respostas. */
class WorkerClient {
  private readonly worker: Worker;
  private seq = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: ResultMessage) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;

  constructor(workerPath: string, init: InitMessage) {
    this.worker = new Worker(workerPath);

    this.ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.worker.off('message', onReady);
        this.worker.off('error', onError);
      };
      const onReady = (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          cleanup();
          resolve();
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message));
        }
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      this.worker.on('message', onReady);
      this.worker.on('error', onError);
    });

    this.worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } else if (msg.type === 'error' && msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
      }
    });

    const failAll = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    this.worker.on('error', failAll);
    this.worker.on('exit', (code) => {
      if (code !== 0) failAll(new Error(`worker terminou com código ${code}`));
    });

    this.worker.postMessage(init);
  }

  run(gen: number, tasks: BattleTask[]): Promise<ResultMessage> {
    const id = this.seq++;
    return new Promise<ResultMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type: 'eval', id, gen, tasks } satisfies EvalMessage);
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async close(): Promise<void> {
    try {
      this.worker.postMessage({ type: 'close' } satisfies CloseMessage);
    } catch {
      // o worker pode já ter terminado
    }
    await this.worker.terminate();
  }
}

/**
 * Avaliador paralelo com partição fixa: em cada geração, os combates são divididos
 * em `threads` blocos contíguos e cada worker executa sempre o seu bloco.
 *
 * O master só faz a partição e a agregação; os combates correm nos workers. As seeds
 * são derivadas de (baseSeed, gen, adversário, k), por isso o fitness é exatamente o
 * mesmo do avaliador sequencial.
 */
export function createFixedEvaluator(cfg: FixedEvaluatorConfig): Evaluator {
  if (!Number.isInteger(cfg.threads) || cfg.threads < 1) {
    throw new Error('threads tem de ser um inteiro >= 1');
  }
  if (cfg.battlesPerOpponent % 2 !== 0) {
    throw new Error('battlesPerOpponent tem de ser par');
  }

  const format = cfg.format ?? DEFAULT_FORMAT;
  const workers = Array.from(
    { length: cfg.threads },
    () =>
      new WorkerClient(workerPath(), {
        type: 'init',
        opponents: cfg.opponents,
        format,
        baseSeed: cfg.baseSeed,
      }),
  );

  return {
    async evaluate(teams, gen, opts) {
      const K = opts?.battlesPerOpponent ?? cfg.battlesPerOpponent;
      if (K % 2 !== 0) throw new Error('battlesPerOpponent tem de ser par');

      const t0 = performance.now();
      await Promise.all(workers.map((w) => w.ready));

      const tasks = buildTasks(teams, cfg.opponents, K);

      // Partição fixa: bloco w -> worker w.
      const chunks = splitFixed(tasks, workers.length);
      const results = await Promise.all(chunks.map((chunk, w) => workers[w].run(gen, chunk)));

      const sums = new Array<number>(teams.length).fill(0);
      const workerBusyMs = new Array<number>(workers.length).fill(0);
      let battles = 0;
      for (let w = 0; w < chunks.length; w++) {
        const chunk = chunks[w];
        const res = results[w];
        if (res.scores.length !== chunk.length) {
          throw new Error(`worker ${w} devolveu ${res.scores.length} pontuações para ${chunk.length} tarefas`);
        }
        for (let i = 0; i < chunk.length; i++) sums[chunk[i].teamIndex] += res.scores[i];
        workerBusyMs[w] = res.ms;
        battles += chunk.length;
      }

      const perTeam = cfg.opponents.length * K;
      return {
        fitness: sums.map((s) => s / perTeam),
        battles,
        ms: performance.now() - t0,
        workerBusyMs,
      };
    },

    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}

// --- Avaliador paralelo com work-stealing -------------------------------------------

export interface StealingEvaluatorConfig extends SequentialEvaluatorConfig {
  /** nº de worker threads (>= 1) */
  threads: number;
}

/**
 * Avaliador paralelo com work-stealing (master-mediated).
 *
 * O master mantém uma fila (deque) de tarefas por worker, com a mesma partição inicial
 * da versão fixa. Cada worker pede uma tarefa de cada vez à sua fila. Quando a sua fila
 * fica vazia, rouba metade da maior fila dos restantes workers. Assim, um worker rápido
 * não fica à espera dos lentos no fim da geração.
 *
 * A ordem de execução não afeta o fitness: cada tarefa tem a sua seed derivada de
 * (baseSeed, gen, adversário, k).
 */
export function createStealingEvaluator(cfg: StealingEvaluatorConfig): Evaluator {
  if (!Number.isInteger(cfg.threads) || cfg.threads < 1) {
    throw new Error('threads tem de ser um inteiro >= 1');
  }
  if (cfg.battlesPerOpponent % 2 !== 0) {
    throw new Error('battlesPerOpponent tem de ser par');
  }

  const format = cfg.format ?? DEFAULT_FORMAT;
  const workers = Array.from(
    { length: cfg.threads },
    () =>
      new WorkerClient(workerPath(), {
        type: 'init',
        opponents: cfg.opponents,
        format,
        baseSeed: cfg.baseSeed,
      }),
  );

  return {
    async evaluate(teams, gen, opts) {
      const K = opts?.battlesPerOpponent ?? cfg.battlesPerOpponent;
      if (K % 2 !== 0) throw new Error('battlesPerOpponent tem de ser par');

      const t0 = performance.now();
      await Promise.all(workers.map((w) => w.ready));

      // Partição inicial igual à fixa; a partir daqui as filas podem ser roubadas.
      const queues = splitFixed(buildTasks(teams, cfg.opponents, K), workers.length);

      const sums = new Array<number>(teams.length).fill(0);
      const workerBusyMs = new Array<number>(workers.length).fill(0);
      let battles = 0;
      let steals = 0;

      /** Próxima tarefa do worker w: da sua fila ou roubada à maior fila dos outros. */
      const takeTask = (w: number): BattleTask | undefined => {
        const own = queues[w];
        if (own.length > 0) return own.pop();

        let victim = -1;
        for (let v = 0; v < queues.length; v++) {
          if (v !== w && queues[v].length > (victim === -1 ? 0 : queues[victim].length)) {
            victim = v;
          }
        }
        if (victim === -1) return undefined;

        // Rouba metade das tarefas que o vitimado ainda tem por executar.
        const n = Math.ceil(queues[victim].length / 2);
        own.push(...queues[victim].splice(-n, n));
        steals++;
        return own.pop();
      };

      await Promise.all(
        workers.map(async (worker, w) => {
          for (;;) {
            const task = takeTask(w);
            if (!task) return;

            const res = await worker.run(gen, [task]);
            if (res.scores.length !== 1) {
              throw new Error(`worker ${w} devolveu ${res.scores.length} pontuações para 1 tarefa`);
            }
            sums[task.teamIndex] += res.scores[0];
            workerBusyMs[w] += res.ms;
            battles++;
          }
        }),
      );

      const perTeam = cfg.opponents.length * K;
      return {
        fitness: sums.map((s) => s / perTeam),
        battles,
        ms: performance.now() - t0,
        workerBusyMs,
        steals,
      };
    },

    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}