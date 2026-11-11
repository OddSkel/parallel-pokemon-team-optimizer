// Ponto de entrada das experiências: corre o GA com um avaliador (sequencial, partição fixa ou
// work-stealing) e grava um JSON por execução em results/.
//
// Exemplos:
//   npx tsx src/run.ts --scheduler seq --pop 48 --gens 20 --k 4
//   npx tsx src/run.ts --scheduler fixed --threads 8 --rep 3
//
// O que fica fixo entre execuções (tem de ser igual para comparar schedulers): seed, pop, gens,
// k, nº de adversários e formato. O que muda: --scheduler e --threads.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';

import { runGA, DEFAULT_GA_CONFIG, GAConfig, GenerationStats } from './ga/ga';
import {
  Evaluator,
  SequentialEvaluatorConfig,
  createSequentialEvaluator,
  createFixedEvaluator,
  createStealingEvaluator,
} from './ga/fitness';
import { generateTeam, packTeam, describeTeam } from './teams';
import { DEFAULT_FORMAT } from './battle';

const SCHEDULERS = ['seq', 'fixed', 'steal'] as const;
type Scheduler = (typeof SCHEDULERS)[number];

// Tag da seed dos adversários; as equipas candidatas usam 7 e o banco de genes usa 9 (teams.ts).
const OPPONENT_TAG = 5;

function intArg(name: string, v: string, min: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} tem de ser um inteiro >= ${min} (recebi "${v}")`);
  return n;
}

function makeEvaluator(scheduler: Scheduler, threads: number, base: SequentialEvaluatorConfig): Evaluator {
  switch (scheduler) {
    case 'seq':
      if (threads !== 1) console.warn('aviso: --threads é ignorado com o avaliador sequencial');
      return createSequentialEvaluator(base);
    case 'fixed':
      return createFixedEvaluator({ ...base, threads });
    case 'steal':
      return createStealingEvaluator({ ...base, threads });
    default:
      throw new Error(`scheduler "${scheduler}" ainda não implementado`);
  }
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      scheduler: { type: 'string', default: 'seq' },
      threads: { type: 'string', default: '1' },
      pop: { type: 'string', default: String(DEFAULT_GA_CONFIG.populationSize) },
      gens: { type: 'string', default: String(DEFAULT_GA_CONFIG.generations) },
      k: { type: 'string', default: '4' }, // combates por adversário (par)
      opponents: { type: 'string', default: '1' },
      seed: { type: 'string', default: String(DEFAULT_GA_CONFIG.baseSeed) },
      rep: { type: 'string', default: '0' }, // nº da repetição (só entra no nome do ficheiro)
      warmup: { type: 'string', default: '1' }, // 0 desliga o aquecimento
      validate: { type: 'string', default: '0' }, // combates (par) da validação final; 0 = não validar
      out: { type: 'string', default: 'results/runs' },
      quiet: { type: 'boolean', default: false },
    },
  });

  const scheduler = a.scheduler as Scheduler;
  if (!SCHEDULERS.includes(scheduler)) throw new Error(`--scheduler tem de ser um de: ${SCHEDULERS.join(', ')}`);
  const threads = intArg('threads', a.threads!, 1);
  const K = intArg('k', a.k!, 2);
  if (K % 2 !== 0) throw new Error('--k tem de ser par (os dois lados jogam o mesmo nº de vezes)');
  const nOpp = intArg('opponents', a.opponents!, 1);
  const seed = intArg('seed', a.seed!, 0);
  if (seed > 0xffff) throw new Error('--seed tem de estar em 0..65535');
  const validate = intArg('validate', a.validate!, 0);
  if (validate % 2 !== 0) throw new Error('--validate tem de ser par');

  const cfg: GAConfig = {
    ...DEFAULT_GA_CONFIG,
    populationSize: intArg('pop', a.pop!, 2),
    generations: intArg('gens', a.gens!, 1),
    baseSeed: seed,
  };

  // Adversários: determinísticos a partir da seed, iguais em todas as execuções.
  const opponentTeams = Array.from({ length: nOpp }, (_, j) => generateTeam([seed, j, OPPONENT_TAG, OPPONENT_TAG]));
  const opponents = opponentTeams.map(packTeam);
  if (!a.quiet) opponentTeams.forEach((t, j) => console.log(`adversário ${j}: ${describeTeam(t)}`));

  const evaluator = makeEvaluator(scheduler, threads, {
    opponents,
    battlesPerOpponent: K,
    baseSeed: seed,
    format: DEFAULT_FORMAT,
  });

  try {
    // Aquecimento fora da medição (JIT, caches do Dex, arranque dos workers). gen = -2 não é
    // usada pelo GA nem pela validação, por isso não mexe nos resultados.
    if (a.warmup !== '0') {
      const warm = Array.from({ length: Math.max(4, threads) }, (_, i) => packTeam(generateTeam([seed, i, 3, 3])));
      await evaluator.evaluate(warm, -2, { battlesPerOpponent: 2 });
    }

    const log = (s: GenerationStats) => {
      if (a.quiet) return;
      // desequilíbrio de carga: tempo ocupado do worker mais ocupado / média
      const busy = s.workerBusyMs;
      const meanBusy = busy && busy.length ? busy.reduce((x, y) => x + y, 0) / busy.length : 0;
      const imb = busy && meanBusy > 0 ? Math.max(...busy) / meanBusy : undefined;
      console.log(
        `gen ${String(s.gen).padStart(2)}  best ${s.best.toFixed(3)}  mean ${s.mean.toFixed(3)}  ` +
          `battles ${s.battles}  eval ${s.evalMs.toFixed(0)} ms  serial ${s.serialMs.toFixed(0)} ms` +
          (imb !== undefined ? `  imb ${imb.toFixed(2)}` : '') +
          (s.steals !== undefined ? `  steals ${s.steals}` : ''),
      );
    };

    const t0 = process.hrtime.bigint();
    const res = await runGA(cfg, evaluator, log);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // O fitness do GA é ruidoso (o melhor é o máximo de várias medições): validar à parte,
    // com seeds de validação (gen = -1) e fora da medição de tempo.
    let validation: { battles: number; fitness: number } | null = null;
    if (validate > 0) {
      const v = await evaluator.evaluate([packTeam(res.best)], -1, { battlesPerOpponent: validate });
      validation = { battles: v.battles, fitness: v.fitness[0] };
    }

    const sum = (f: (s: GenerationStats) => number) => res.history.reduce((acc, s) => acc + f(s), 0);
    const summary = {
      wallMs,
      totalMs: res.totalMs,
      evalMs: sum((s) => s.evalMs),
      evalWallMs: sum((s) => s.evalWallMs),
      serialMs: sum((s) => s.serialMs),
      totalBattles: res.totalBattles,
      bestFitness: res.bestFitness,
      bestGen: res.bestGen,
      best: describeTeam(res.best),
      validation,
    };

    const cpus = os.cpus();
    const out = {
      config: { scheduler, threads, K, opponents: nOpp, rep: Number(a.rep), ga: cfg, format: DEFAULT_FORMAT },
      env: {
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        cpu: cpus[0]?.model,
        logicalCpus: cpus.length,
        argv: process.argv.slice(2),
        date: new Date().toISOString(),
      },
      summary,
      history: res.history,
    };

    mkdirSync(a.out!, { recursive: true });
    const file = join(a.out!, `${scheduler}-t${threads}-s${seed}-r${a.rep}.json`);
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(
      `\n${scheduler} t=${threads}: wall ${(wallMs / 1000).toFixed(2)} s, eval ${(summary.evalMs / 1000).toFixed(2)} s, ` +
        `serial ${(summary.serialMs / 1000).toFixed(2)} s, ${res.totalBattles} combates -> ${file}`,
    );
    if (validation) console.log(`validação do melhor: ${validation.fitness.toFixed(3)} (${validation.battles} combates)`);
  } finally {
    await evaluator.close?.();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});