// Operadores genéticos. Os genes (Pokémon) são IMUTÁVEIS: nenhum operador altera um gene ou uma
// equipa recebida; devolvem equipas novas que podem partilhar genes com os pais.
import { PRNG } from 'pokemon-showdown';
import { PokemonGene, Team, baseSpeciesOf, replaceableMoves } from '../teams';

export interface MutationParams {
  /** probabilidade, por posição, de trocar o Pokémon por outro do banco */
  pMon: number;
  /** probabilidade, por posição, de trocar 1 movimento por outro do pool legal da espécie */
  pMove: number;
}

/** Torneio: sorteia `size` indivíduos (com reposição) e devolve o índice do melhor. */
export function tournamentSelect(fitness: readonly number[], size: number, prng: PRNG): number {
  let best = prng.random(fitness.length);
  for (let i = 1; i < size; i++) {
    const c = prng.random(fitness.length);
    if (fitness[c] > fitness[best]) best = c;
  }
  return best;
}

/**
 * Crossover uniforme por posição, com Pokémon inteiros: em cada posição o filho recebe o Pokémon
 * de um dos pais (50/50). Se a espécie já está no filho, tenta o do outro pai; se também estiver,
 * a posição é preenchida no fim com um Pokémon de qualquer dos pais cuja espécie ainda falte.
 * Mantém a ordem das posições (a primeira é o Pokémon que abre o combate).
 */
export function crossover(a: Team, b: Team, prng: PRNG): Team {
  const n = a.length;
  const child: (PokemonGene | undefined)[] = new Array(n).fill(undefined);
  const used = new Set<string>();

  for (let i = 0; i < n; i++) {
    const pair = prng.random() < 0.5 ? [a[i], b[i]] : [b[i], a[i]];
    const g = pair.find((x) => x && !used.has(baseSpeciesOf(x.species)));
    if (g) {
      child[i] = g;
      used.add(baseSpeciesOf(g.species));
    }
  }

  const leftovers = [...a, ...b];
  prng.shuffle(leftovers);
  for (let i = 0; i < n; i++) {
    if (child[i]) continue;
    const g = leftovers.find((x) => !used.has(baseSpeciesOf(x.species)));
    // só falha se os pais já tivessem espécies repetidas; nesse caso copia-se o pai A
    child[i] = g ?? a[i];
    used.add(baseSpeciesOf(child[i]!.species));
  }
  return child as Team;
}

/**
 * Mutação, por posição e de forma independente:
 *  - com prob. pMon: o Pokémon é trocado por outro do banco `pool` (espécie que ainda não esteja
 *    na equipa), que traz consigo o seu nível, item, etc.;
 *  - com prob. pMove: 1 movimento do Pokémon é trocado por outro do pool legal da espécie.
 */
export function mutate(team: Team, pool: readonly PokemonGene[], p: MutationParams, prng: PRNG): Team {
  const out = team.slice();
  for (let i = 0; i < out.length; i++) {
    if (prng.random() < p.pMon) {
      const taken = new Set(out.filter((_, j) => j !== i).map((g) => baseSpeciesOf(g.species)));
      const candidates = pool.filter((g) => !taken.has(baseSpeciesOf(g.species)) && g.species !== out[i].species);
      if (candidates.length) out[i] = prng.sample(candidates);
    }
    if (prng.random() < p.pMove) {
      const g = out[i];
      const free = replaceableMoves(g);
      if (free.length && g.moves.length) {
        const moves = g.moves.slice();
        moves[prng.random(moves.length)] = prng.sample(free);
        out[i] = { ...g, moves };
      }
    }
  }
  return out;
}