//
// Avaliador: corre um combate completo entre duas equipas.
//
// Usa o BattleStream do Showdown com o RandomPlayerAI oficial como jogador

import { BattleStream, getPlayerStreams } from 'pokemon-showdown';
import { RandomPlayerAI } from 'pokemon-showdown/sim/tools/random-player-ai';

export type Seed = [number, number, number, number];

export interface BattleResult {
  // 0 = vitória da equipa A, 1 = vitória da equipa B, -1 = empate / limite de turnos
  winner: 0 | 1 | -1;
  turns: number;
}

export const DEFAULT_FORMAT = 'gen9customgame';
export const MAX_TURNS = 300;

/**
 * Corre um combate entre duas equipas (strings "packed" do Showdown).
 * O resultado depende apenas de (teamA, teamB, seed, format).
 */
export async function runBattle(
  teamA: string,
  teamB: string,
  seed: Seed,
  formatid: string = DEFAULT_FORMAT,
  maxTurns: number = MAX_TURNS,
): Promise<BattleResult> {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);

  // Cada jogador tem o seu PRNG, derivado da seed do combate
  const p1 = new RandomPlayerAI(streams.p1, { seed: [seed[0], seed[1], 1, 1] as any });
  const p2 = new RandomPlayerAI(streams.p2, { seed: [seed[0], seed[1], 2, 2] as any });
  void p1.start();
  void p2.start();

  // Consome a stream até ao fim do combate; força empate se passar o limite de turnos
  const done = (async () => {
    for await (const _chunk of streams.omniscient) {
      const b = battleStream.battle;
      if (b && !b.ended && b.turn > maxTurns) {
        void streams.omniscient.write('>forcetie');
      }
    }
  })();

  void streams.omniscient.write(
    `>start ${JSON.stringify({ formatid, seed })}\n` +
      `>player p1 ${JSON.stringify({ name: 'A', team: teamA })}\n` +
      `>player p2 ${JSON.stringify({ name: 'B', team: teamB })}`,
  );
  await done;

  const b = battleStream.battle!;
  const winner: BattleResult['winner'] = b.winner === 'A' ? 0 : b.winner === 'B' ? 1 : -1;
  return { winner, turns: b.turn };
}