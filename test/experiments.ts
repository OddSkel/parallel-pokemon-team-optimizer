// Execução das experiências: scheduler × threads × repetições.
//
// O run.ts faz UMA execução (um ponto da matriz). Este script corre a matriz completa,
// lançando o run.ts como processo filho. Como um portátil sofre de deriva térmica (as
// primeiras execuções são mais rápidas do que as últimas), a ordem é intercalada ou
// aleatória e há pausas de arrefecimento entre execuções. A afinidade de CPU é aplicada
// a cada processo filho: `start /affinity` no Windows, `taskset -c` no Linux.
//
// Exemplos:
//   npx tsx test/experiments.ts
//   npx tsx test/experiments.ts --threads 1,2,4,8 --reps 3 --cooldown 20 --affinity 0xffff
//   npx tsx test/experiments.ts --order random --order-seed 7 --dry-run
//   npx tsx test/experiments.ts --schedulers fixed,steal --threads 1,2,4,8,12,16 --affinity 0xffff
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as os from 'node:os';

const ROOT = resolve(__dirname, '..');
const RUN_TS = join(ROOT, 'src', 'run.ts');
// CLI do tsx: evita depender do npx (que acrescenta um processo e pode não estar no PATH).
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SCHEDULERS = ['seq', 'fixed', 'steal'] as const;
const ORDERS = ['interleaved', 'random', 'fixed'] as const;

type Scheduler = (typeof SCHEDULERS)[number];
type Order = (typeof ORDERS)[number];

interface Run {
  scheduler: Scheduler;
  threads: number;
  rep: number;
}

interface Affinity {
  /** máscara de CPUs (bit i = CPU lógico i) */
  mask: bigint;
  /** CPUs selecionadas pela máscara */
  cpus: number[];
}

// --- Argumentos ----------------------------------------------------------------------

function intArg(name: string, v: string, min: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} tem de ser um inteiro >= ${min} (recebi "${v}")`);
  return n;
}

function intList(name: string, spec: string, min: number): number[] {
  const xs = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => intArg(name, s, min));
  return [...new Set(xs)];
}

function schedulerList(spec: string): Scheduler[] {
  const xs = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const x of xs) {
    if (!SCHEDULERS.includes(x as Scheduler)) {
      throw new Error(`--schedulers tem de ser uma lista de: ${SCHEDULERS.join(', ')} (recebi "${x}")`);
    }
  }
  return [...new Set(xs)] as Scheduler[];
}

/**
 * `--affinity` é uma máscara em hexadecimal (bit i = CPU lógico i): 0x3 = CPUs 0 e 1,
 * 0xffff = primeiras 16 CPUs. "all" usa todas as CPUs lógicas e "none" desliga a afinidade.
 * Num CPU híbrido isto permite comparar P-cores e E-cores (ex.: 0x0fff vs 0xf000).
 */
function parseAffinity(spec: string, cpus: number): Affinity | null {
  if (spec === 'none') return null;
  const hex = /^0x/i.test(spec) ? spec : `0x${spec}`;
  const mask = spec === 'all' ? (1n << BigInt(cpus)) - 1n : BigInt(hex);
  if (mask <= 0n) throw new Error('--affinity tem de ser uma máscara não nula (ou "all"/"none")');
  if (mask >> BigInt(cpus) !== 0n) {
    throw new Error(`--affinity 0x${mask.toString(16)} seleciona CPUs inexistentes (a máquina tem ${cpus})`);
  }
  const list: number[] = [];
  for (let i = 0; i < cpus; i++) if ((mask >> BigInt(i)) & 1n) list.push(i);
  return { mask, cpus: list };
}

/** "0-7,16-23" em vez de "0,1,2,...,23". */
function formatCpuList(cpus: number[]): string {
  const parts: string[] = [];
  let start = cpus[0];
  let prev = cpus[0];
  for (let i = 1; i <= cpus.length; i++) {
    const c = cpus[i];
    if (c === prev + 1) {
      prev = c;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = c;
  }
  return parts.join(',');
}

// --- Ordem das execuções -------------------------------------------------------------

/** PRNG pequeno e determinístico, só para baralhar a ordem (não é o do Showdown). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Constrói a sequência de execuções.
 *
 * - `interleaved` (omissão): cada repetição corre todos os pontos da matriz por ordem
 *   baralhada. Assim a deriva térmica afeta todos os schedulers de forma semelhante.
 * - `random`: baralha a matriz completa (pontos e repetições misturados).
 * - `fixed`: ordem natural (rep, scheduler, threads), só para depuração.
 *
 * O scheduler sequencial só faz sentido com uma thread, por isso os pontos `seq t>1` são
 * descartados (o run.ts ignora --threads no seq e avisaria).
 */
function buildPlan(schedulers: Scheduler[], threads: number[], reps: number, order: Order, orderSeed: number): Run[] {
  const points: Array<Omit<Run, 'rep'>> = [];
  for (const scheduler of schedulers) {
    for (const t of threads) {
      if (scheduler === 'seq' && t !== 1) continue;
      points.push({ scheduler, threads: t });
    }
  }
  if (points.length === 0) throw new Error('a matriz ficou vazia (verifica --schedulers e --threads)');

  const rand = mulberry32(orderSeed);
  const plan: Run[] = [];
  if (order === 'random') {
    for (const p of shuffled(points, rand)) {
      for (let rep = 0; rep < reps; rep++) plan.push({ ...p, rep });
    }
    return shuffled(plan, rand);
  }
  for (let rep = 0; rep < reps; rep++) {
    const round = order === 'fixed' ? points : shuffled(points, rand);
    for (const p of round) plan.push({ ...p, rep });
  }
  return plan;
}

// --- Lançamento de um run ------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function quote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Linha de comando completa (incluindo o wrapper de afinidade), para logs e --dry-run. */
function describeCommand(args: string[], affinity: Affinity | null): string {
  const inner = [process.execPath, TSX_CLI, RUN_TS, ...args].map(quote).join(' ');
  if (affinity && process.platform === 'win32') {
    return `start /b /wait /affinity ${affinity.mask.toString(16)} ${inner}`;
  }
  if (affinity && process.platform === 'linux') {
    return `taskset -c ${affinity.cpus.join(',')} ${inner}`;
  }
  return inner;
}

/**
 * Lança o run.ts com a afinidade aplicada ao processo.
 *
 * Windows: `start /affinity` aplica a máscara no momento da criação (sem corrida com o
 * arranque do processo), mas o `start /wait` devolve sempre 0. Por isso o sucesso é
 * confirmado pelo JSON que o run.ts escreve no fim, não pelo código de saída.
 * Linux: `taskset -c` e o código de saída é fiável.
 */
function spawnRun(args: string[], affinity: Affinity | null): Promise<void> {
  const options = { cwd: ROOT, stdio: 'inherit' as const, windowsHide: true };

  let child: ChildProcess;
  if (affinity && process.platform === 'win32') {
    child = spawn(
      'cmd.exe',
      ['/c', 'start', '', '/b', '/wait', '/affinity', affinity.mask.toString(16), process.execPath, TSX_CLI, RUN_TS, ...args],
      options,
    );
  } else if (affinity && process.platform === 'linux') {
    child = spawn('taskset', ['-c', affinity.cpus.join(','), process.execPath, TSX_CLI, RUN_TS, ...args], options);
  } else {
    child = spawn(process.execPath, [TSX_CLI, RUN_TS, ...args], options);
  }

  return new Promise((res, rej) => {
    child.on('error', rej);
    child.on('exit', (code, signal) => {
      if (signal) return rej(new Error(`run.ts terminou com o sinal ${signal}`));
      // No Windows o `start` devolve sempre 0; a validação é feita pelo ficheiro de saída.
      if (code !== 0 && process.platform !== 'win32') return rej(new Error(`run.ts saiu com código ${code}`));
      res();
    });
  });
}

// --- Programa principal --------------------------------------------------------------

async function main() {
  const { values: a } = parseArgs({
    options: {
      schedulers: { type: 'string', default: SCHEDULERS.join(',') },
      threads: { type: 'string', default: '1,2,4,8' },
      reps: { type: 'string', default: '3' },
      pop: { type: 'string', default: '48' },
      gens: { type: 'string', default: '20' },
      k: { type: 'string', default: '4' },
      seed: { type: 'string', default: '1' },
      warmup: { type: 'string', default: '1' }, // 0 desliga o aquecimento do run.ts
      validate: { type: 'string', default: '0' }, // combates (par) da validação final
      out: { type: 'string', default: 'results/exp' },
      order: { type: 'string', default: 'interleaved' },
      'order-seed': { type: 'string', default: '1' },
      cooldown: { type: 'string', default: '15' }, // segundos entre execuções
      affinity: { type: 'string', default: 'all' }, // máscara hex, "all" ou "none"
      'keep-going': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false }, // não passar --quiet ao run.ts
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const schedulers = schedulerList(a.schedulers!);
  const threads = intList('threads', a.threads!, 1);
  const reps = intArg('reps', a.reps!, 1);
  const pop = intArg('pop', a.pop!, 3); // o GA exige elites (2) < pop
  const gens = intArg('gens', a.gens!, 1);
  const k = intArg('k', a.k!, 2);
  if (k % 2 !== 0) throw new Error('--k tem de ser par (os dois lados jogam o mesmo nº de vezes)');
  const seed = intArg('seed', a.seed!, 0);
  if (seed > 0xffff) throw new Error('--seed tem de estar em 0..65535');
  const warmup = intArg('warmup', a.warmup!, 0) !== 0;
  const validate = intArg('validate', a.validate!, 0);
  if (validate % 2 !== 0) throw new Error('--validate tem de ser par');
  const cooldownMs = intArg('cooldown', a.cooldown!, 0) * 1000;
  const order = a.order as Order;
  if (!ORDERS.includes(order)) throw new Error(`--order tem de ser um de: ${ORDERS.join(', ')}`);
  const orderSeed = intArg('order-seed', a['order-seed']!, 0);

  const cpus = os.cpus().length;
  let affinity = parseAffinity(a.affinity!, cpus);
  if (affinity && process.platform !== 'win32' && process.platform !== 'linux') {
    console.warn(`aviso: afinidade de CPU não é suportada em ${process.platform}; a correr sem máscara`);
    affinity = null;
  }
  if (affinity) {
    for (const t of threads) {
      if (t > affinity.cpus.length) {
        console.warn(`aviso: --threads ${t} > ${affinity.cpus.length} CPUs na máscara (sobre-subscrição)`);
      }
    }
  }
  if (!existsSync(TSX_CLI)) throw new Error(`não encontrei o CLI do tsx em ${TSX_CLI} (corre npm install)`);

  const out = resolve(a.out!);
  const skippedSeq = schedulers.includes('seq') && !threads.includes(1);
  if (skippedSeq) console.warn('aviso: seq só corre com 1 thread, mas --threads não inclui 1; seq vai ser ignorado');
  const plan = buildPlan(schedulers, threads, reps, order, orderSeed);

  console.log(
    `Experiência: ${schedulers.join(', ')} × threads ${threads.join(', ')} × ${reps} rep(s) = ${plan.length} execuções`,
  );
  if (schedulers.includes('seq') && threads.some((t) => t !== 1)) {
    console.log('Nota: seq só corre com 1 thread (os restantes pontos seq são ignorados)');
  }
  console.log(`Ordem: ${order} (seed ${orderSeed})${cooldownMs ? `, arrefecimento ${cooldownMs / 1000} s` : ''}`);
  console.log(
    affinity
      ? `Afinidade: 0x${affinity.mask.toString(16)} (CPUs ${formatCpuList(affinity.cpus)})`
      : 'Afinidade: desligada',
  );
  console.log(`Saída: ${out}\n`);

  const baseArgs = [
    '--pop', String(pop),
    '--gens', String(gens),
    '--k', String(k),
    '--seed', String(seed),
    '--warmup', warmup ? '1' : '0',
    '--validate', String(validate),
    '--out', out,
  ];

  if (a['dry-run']) {
    plan.forEach((run, i) => {
      const args = ['--scheduler', run.scheduler, '--threads', String(run.threads), '--rep', String(run.rep), ...baseArgs];
      if (!a.verbose) args.push('--quiet');
      console.log(`[${i + 1}/${plan.length}] ${describeCommand(args, affinity)}`);
    });
    return;
  }

  mkdirSync(out, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    logicalCpus: cpus,
    affinity: affinity ? { mask: `0x${affinity.mask.toString(16)}`, cpus: affinity.cpus } : null,
    order,
    orderSeed,
    cooldownMs,
    fixedArgs: { pop, gens, k, seed, warmup, validate },
    runs: [] as Array<{
      index: number;
      scheduler: Scheduler;
      threads: number;
      rep: number;
      file: string;
      startedAt: string;
      durationMs: number;
      ok: boolean;
      error?: string;
    }>,
  };
  const manifestFile = join(out, 'manifest.json');
  const writeManifest = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const failures: string[] = [];
  for (let i = 0; i < plan.length; i++) {
    const run = plan[i];
    if (i > 0 && cooldownMs > 0) {
      console.log(`  (arrefecimento ${cooldownMs / 1000} s)`);
      await sleep(cooldownMs);
    }

    const file = join(out, `${run.scheduler}-t${run.threads}-s${seed}-r${run.rep}.json`);
    const before = existsSync(file) ? statSync(file).mtimeMs : 0;
    const args = ['--scheduler', run.scheduler, '--threads', String(run.threads), '--rep', String(run.rep), ...baseArgs];
    if (!a.verbose) args.push('--quiet');

    const label = `[${i + 1}/${plan.length}] ${run.scheduler} t=${run.threads} rep=${run.rep}`;
    console.log(`${label}`);
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    let ok = false;
    let error: string | undefined;
    try {
      await spawnRun(args, affinity);
      // O run.ts grava o JSON no fim; é essa a prova de sucesso (ver spawnRun).
      ok = existsSync(file) && statSync(file).mtimeMs > before;
      if (!ok) error = `não gerou ${file}`;
    } catch (e) {
      error = (e as Error).message;
    }
    const durationMs = Date.now() - t0;

    manifest.runs.push({ index: i + 1, scheduler: run.scheduler, threads: run.threads, rep: run.rep, file, startedAt, durationMs, ok, error });
    writeManifest();

    if (ok) {
      console.log(`${label} ok ${(durationMs / 1000).toFixed(1)} s -> ${file}`);
    } else {
      failures.push(`${label}: ${error}`);
      console.error(`${label} FALHOU: ${error}`);
      if (!a['keep-going']) {
        writeManifest();
        throw new Error(`execução ${i + 1}/${plan.length} falhou; ver ${manifestFile}`);
      }
    }
  }

  console.log(`\nConcluído: ${plan.length - failures.length}/${plan.length} execuções ok`);
  console.log(`Manifesto: ${manifestFile}`);
  if (failures.length > 0) {
    console.error(`Falhas:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
