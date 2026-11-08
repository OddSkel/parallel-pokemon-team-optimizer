// Representação de equipas e conversão de/para o Showdown.

// Um "gene" é um Pokémon completo (espécie, movimentos, item, nível, EVs/IVs, ...); uma equipa
// são 6 genes. O gene é uma unidade atómica: quando passa de uma equipa para outra, leva
// consigo o nível e o item. Todos os genes vêm do gerador do Showdown (Teams.generate);
// a mutação/crossover vivem em ga/operators.ts e usam o que está exportado aqui.

import { Dex, Teams, TeamValidator } from 'pokemon-showdown';

export const TEAM_SIZE = 6;
export const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export const GENERATOR_FORMAT = 'gen9randombattle';

export type Seed = [number, number, number, number];

export interface PokemonGene {
  species: string; /** nome da espécie (ex.: "Garchomp") */
  moves: string[]; /** 1 a 4 movimentos distintos (ids) */
  item: string; /** item (nome ou id; '' = sem item) */
  ability: string; /** nome da habilidade */
  nature: string; /** nome da natureza ('' = neutra por omissão) */
  evs: number[]; /** EVs por estatística, na ordem de STATS */
  ivs: number[]; /** IVs por estatística, na ordem de STATS */
  level: number; /** nível (o gerador do Showdown usa 64-100 conforme a espécie) */
  gender: string; /** 'M', 'F', 'N' ou '' */
  teraType: string; /** tipo Tera */
}

export type Team = PokemonGene[];

const dex = Dex.forFormat('gen9customgame');
const baseSpeciesCache = new Map<string, string>();

// --- Conversão de/para o Showdown ---------------------------------------------------

/** Converte um PokemonSet do Showdown no nosso gene, sem perder nenhum campo que afete o combate. */
export function geneFromSet(p: any): PokemonGene {
  return {
    species: p.species,
    moves: [...p.moves],
    item: p.item ?? '',
    ability: p.ability ?? '',
    nature: p.nature ?? '',
    evs: STATS.map((s) => p.evs?.[s] ?? 0),
    ivs: STATS.map((s) => p.ivs?.[s] ?? 31),
    level: p.level ?? 100,
    gender: p.gender ?? '',
    teraType: p.teraType ?? '',
  };
}

function toPokemonSet(g: PokemonGene) {
  const evs: Record<string, number> = {};
  const ivs: Record<string, number> = {};
  STATS.forEach((s, i) => {
    evs[s] = g.evs[i];
    ivs[s] = g.ivs[i];
  });
  return {
    name: g.species,
    species: g.species,
    item: g.item,
    ability: g.ability,
    moves: g.moves,
    nature: g.nature,
    gender: g.gender,
    evs,
    ivs,
    level: g.level,
    teraType: g.teraType,
  } as any;
}

/** Equipa no formato "packed" do Showdown (é o que o avaliador e os workers trocam). */
export function packTeam(team: Team): string {
  return Teams.pack(team.map(toPokemonSet));
}

/** Legalidade segundo o validador do Showdown: null se válida, ou a lista de problemas. */
export function validateTeam(team: Team, formatid = 'gen9anythinggoes'): string[] | null {
  return TeamValidator.get(formatid).validateTeam(team.map(toPokemonSet));
}

// --- Geração (gerador do Showdown) --------------------------------------------------

/**
 * Lê uma equipa dada pelo utilizador: texto de exportação do Showdown (o que o teambuilder
 * exporta, várias linhas) ou o formato "packed" (uma linha, com '|').
 */
export function teamFromText(text: string): Team {
  const t = text.trim();
  const sets = /\n/.test(t) ? Teams.import(t) : Teams.unpack(t);
  if (!sets || sets.length === 0) throw new Error('equipa inválida: não consegui ler nenhum Pokémon');
  return sets.map(geneFromSet);
}

/** Uma equipa gerada pelo Showdown; a mesma seed dá sempre a mesma equipa. */
export function generateTeam(seed: Seed): Team {
  return Teams.generate(GENERATOR_FORMAT, { seed } as any).map(geneFromSet);
}

/** População inicial: `size` equipas com seeds derivadas de `baseSeed`. */
export function generatePopulation(size: number, baseSeed: number): Team[] {
  return Array.from({ length: size }, (_, i) => generateTeam([baseSeed, i, 7, 7]));
}

/**
 * "Banco" de Pokémon completos para a mutação trocar um Pokémon por outro novo.
 * Vêm de equipas geradas pelo Showdown (seeds distintas das da população), por isso cada
 * gene traz o seu próprio nível e item; nunca se inventam valores.
 */
export function generateGenePool(size: number, baseSeed: number): PokemonGene[] {
  const genes: PokemonGene[] = [];
  for (let i = 0; genes.length < size; i++) genes.push(...generateTeam([baseSeed, i, 9, 9]));
  return genes.slice(0, size);
}

// --- Mutação de movimentos ----------------------------------------------------------

const movePoolCache = new Map<string, string[]>();

/** Movimentos que a espécie pode aprender legalmente em gen9 (ordenados, para determinismo). */
export function movePoolOf(species: string): string[] {
  const cached = movePoolCache.get(species);
  if (cached) return cached;
  const id = dex.species.get(species).id;
  const pool = [...dex.species.getMovePool(id)]
    .filter((m) => {
      const mv = dex.moves.get(m);
      return mv.exists && !mv.isNonstandard && !mv.isZ && !mv.isMax;
    })
    .sort();
  movePoolCache.set(species, pool);
  return pool;
}

/**
 * Movimentos que a mutação pode pôr neste Pokémon: o pool legal da espécie menos os que já tem
 * (sem repetições). Pode ser vazio (ex.: Ditto só aprende Transform), e nesse caso a mutação
 * deixa o gene como está. Os movimentos que o gerador do Showdown deu ao gene mantêm-se mesmo
 * que não estejam no pool (acontece com algumas formas do Pikachu).
 */
export function replaceableMoves(gene: PokemonGene): string[] {
  return movePoolOf(gene.species).filter((m) => !gene.moves.includes(m));
}

/** Descrição curta para logs. */
export function describeTeam(team: Team): string {
  return team.map((g) => `${g.species} L${g.level}`).join(', ');
}

/** Espécie "base" (ex.: Pikachu-Original -> Pikachu); é a chave do Species Clause (sem repetidos numa equipa). */
export function baseSpeciesOf(species: string): string {
  let b = baseSpeciesCache.get(species);
  if (b === undefined) {
    b = dex.species.get(species).baseSpecies || species;
    baseSpeciesCache.set(species, b);
  }
  return b;
}