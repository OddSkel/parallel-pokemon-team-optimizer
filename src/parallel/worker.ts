// Worker dos avaliadores paralelos (partição fixa e work-stealing).
//
// Recebe um init (adversários, formato, seed base) e depois lotes de combates.
// Não conhece o GA nem a política de escalonamento: executa apenas as tarefas que
// o master lhe manda.
import { parentPort } from 'node:worker_threads';
import { DEFAULT_FORMAT } from '../battle';
import { battleSeed, playTask } from '../ga/fitness';
import type { MasterMessage } from './worker-protocol';

if (!parentPort) throw new Error('worker.ts tem de correr numa worker thread');
const port = parentPort;

let opponents: string[] = [];
let format = DEFAULT_FORMAT;
let baseSeed = 0;

port.on('message', async (msg: MasterMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        opponents = msg.opponents;
        format = msg.format;
        baseSeed = msg.baseSeed;
        port.postMessage({ type: 'ready' });
        return;

      case 'close':
        process.exit(0);

      case 'eval': {
        const t0 = performance.now();
        const scores: number[] = new Array(msg.tasks.length);
        for (let i = 0; i < msg.tasks.length; i++) {
          const t = msg.tasks[i];
          const seed = battleSeed(baseSeed, msg.gen, t.opponent, t.k);
          scores[i] = await playTask(t.team, opponents[t.opponent], seed, t.k, format);
        }
        port.postMessage({ type: 'result', id: msg.id, scores, ms: performance.now() - t0 });
        return;
      }
    }
  } catch (e) {
    const err = e as Error;
    port.postMessage({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      message: err.message,
      stack: err.stack,
    });
  }
});
