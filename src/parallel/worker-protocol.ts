// Protocolo entre o master (avaliadores paralelos) e os workers.
//
// A tarefa elementar é UM combate: (equipa candidata, adversário j, combate k).
// O resultado de cada tarefa só depende de (equipa, adversário, seed, lado), por isso
// a partição do trabalho (fixa ou dinâmica) não altera o fitness.

export interface BattleTask {
  /** índice da equipa candidata no array passado a evaluate() */
  teamIndex: number;
  /** equipa candidata em formato "packed" do Showdown */
  team: string;
  /** índice em opponents (config do avaliador) */
  opponent: number;
  /** nº do combate; decide o lado e entra na seed */
  k: number;
}

export interface InitMessage {
  type: 'init';
  opponents: string[];
  format: string;
  baseSeed: number;
}

export interface EvalMessage {
  type: 'eval';
  id: number;
  gen: number;
  tasks: BattleTask[];
}

export interface CloseMessage {
  type: 'close';
}

export type MasterMessage = InitMessage | EvalMessage | CloseMessage;

export interface ReadyMessage {
  type: 'ready';
}

export interface ResultMessage {
  type: 'result';
  id: number;
  /** pontuação (1 / 0.5 / 0) de cada tarefa, na mesma ordem de tasks */
  scores: number[];
  /** duração de cada tarefa (ms), na mesma ordem de tasks */
  taskMs: number[];
  /** tempo total do lote dentro do worker (ms) */
  ms: number;
}

export interface ErrorMessage {
  type: 'error';
  id?: number;
  message: string;
  stack?: string;
}

export type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;
