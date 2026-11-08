// Derivação determinística de seeds. Tudo o que é aleatório no projeto (população inicial,
// adversários, operadores, combates) sai de uma seed única, por isso uma experiência é
// reproduzível mesmo quando corre em paralelo.
import { PRNG } from 'pokemon-showdown';
import type { Seed } from '../teams';

/** Mistura inteiros num hash de 32 bits sem sinal (estilo murmur3). */
export function mix(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** Seed de 4 componentes de 16 bits (o formato do PRNG do Showdown) derivada de uma lista de inteiros. */
export function seedFrom(...xs: number[]): Seed {
  const a = mix(...xs, 1);
  const b = mix(...xs, 2);
  return [a & 0xffff, a >>> 16, b & 0xffff, b >>> 16];
}

export function prngFrom(...xs: number[]): PRNG {
  return new PRNG(seedFrom(...xs) as any);
}