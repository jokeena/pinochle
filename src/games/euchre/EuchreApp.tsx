import { useEffect, useReducer, useRef, useState } from 'react';
import { botAction } from './bots/bot';
import { GameAction, GameState, TEAM_OF, gameReducer, newGame } from './engine/game';
import { EuchreModals, EuchreRulesModal } from './ui/EuchreModals';
import { EuchreTable } from './ui/EuchreTable';
import { SUIT_NAME, SUIT_SYMBOL, isRed } from './engine/types';

/* ---------- Saved game & lifetime stats (localStorage) ---------- */

const SAVE_KEY = 'euchre-save';
export const EUCHRE_STATS_KEY = 'euchre-stats';

interface SaveData {
  state: GameState;
  names: string[];
}

export function loadEuchreSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (!data?.state?.phase || !data.names || data.state.phase === 'gameOver') return null;
    return data;
  } catch {
    return null;
  }
}

export interface EuchreStats {
  games: number;
  wins: number;
  hands: number;
  calls: number;      // hands your side named trump
  made: number;
  set: number;        // your side's calls that got euchred
  euchres: number;    // times you euchred them
  loners: number;     // times your side went alone
  loneMarches: number;
}

export const emptyEuchreStats = (): EuchreStats => ({
  games: 0, wins: 0, hands: 0, calls: 0, made: 0, set: 0, euchres: 0, loners: 0, loneMarches: 0,
});

export function loadEuchreStats(): EuchreStats {
  try {
    return { ...emptyEuchreStats(), ...JSON.parse(localStorage.getItem(EUCHRE_STATS_KEY) ?? '{}') };
  } catch {
    return emptyEuchreStats();
  }
}

function updateStats(apply: (s: EuchreStats) => void) {
  const stats = loadEuchreStats();
  apply(stats);
  localStorage.setItem(EUCHRE_STATS_KEY, JSON.stringify(stats));
}

const NAME_POOL = ['Audrey', 'James', 'Lorraine', 'Ella', 'Reagan', 'John', 'Sean', 'Cha Cha', 'Carl', 'Blake', 'Jeff'];

function drawNames(): string[] {
  const pool = [...NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return ['You', ...pool.slice(0, 3)];
}

function actorFor(state: GameState): number | null {
  switch (state.phase) {
    case 'order1':
    case 'order2':
    case 'play':
      return state.turn;
    case 'discard':
      return state.dealer;
    default:
      return null;
  }
}

/** States the game sits in waiting for the human — undo jump targets. */
function isHumanDecision(s: GameState): boolean {
  return actorFor(s) === 0 || s.phase === 'handReview' || s.phase === 'handEnd';
}

interface Hist {
  present: GameState;
  past: GameState[];
}

type HistAction = GameAction | { type: 'UNDO' };

function histReducer(h: Hist, action: HistAction): Hist {
  if (action.type === 'UNDO') {
    const past = [...h.past];
    while (past.length > 0) {
      const s = past.pop()!;
      if (isHumanDecision(s)) return { present: s, past };
    }
    return h;
  }
  const next = gameReducer(h.present, action);
  if (next === h.present) return h;
  return { present: next, past: [...h.past.slice(-300), h.present] };
}

/** ms of "thinking" per phase — a beat to read each pass, play measured. */
function botDelay(state: GameState): number {
  if (state.phase === 'order1' || state.phase === 'order2') return 800;
  if (state.phase === 'play') {
    // Opening lead right after a burial waits for the flight to land.
    if (state.tricksPlayed === 0 && state.trick.length === 0 && state.discard) return 1250;
    return 380;
  }
  return 950;
}

/* The dealt note owns the bar's center during the order rounds; once trump
   is named the (also-centered) trump chip takes over. */
const ORDERING = new Set(['order1', 'order2']);

/** No menu: clicking Euchre resumes the saved game or deals a fresh one. */
export function EuchreApp({ onExit }: { onExit: () => void }) {
  const [save] = useState<SaveData | null>(loadEuchreSave);
  const [hist, dispatch] = useReducer(
    histReducer, save,
    (sv: SaveData | null): Hist => ({ present: sv?.state ?? newGame(), past: [] }));
  const { present: state, past } = hist;
  const [showRules, setShowRules] = useState(false);
  const [names] = useState(() => save?.names ?? drawNames());
  const [ntEnabled, setNtEnabled] = useState(() => localStorage.getItem('euchre-notrump') === '1');
  const canUndo = past.some(isHumanDecision);

  const toggleNt = () => setNtEnabled((v) => {
    localStorage.setItem('euchre-notrump', v ? '0' : '1');
    return !v;
  });

  // Persist after every change; clear and record the game when it ends.
  const gameRecorded = useRef(false);
  useEffect(() => {
    if (state.phase === 'gameOver') {
      localStorage.removeItem(SAVE_KEY);
      if (!gameRecorded.current) {
        gameRecorded.current = true;
        updateStats((s) => {
          s.games++;
          if (state.winnerTeam === TEAM_OF[0]) s.wins++;
        });
      }
      return;
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify({ state, names } satisfies SaveData));
  }, [state, names]);

  // Per-hand stats, once per hand (a resumed game must not re-count its saved hand).
  const lastHandRecorded = useRef(
    save ? (save.state.phase === 'handEnd' ? save.state.handNumber : save.state.handNumber - 1) : 0);
  useEffect(() => {
    if (state.phase !== 'handEnd' || !state.handResult) return;
    if (state.handNumber <= lastHandRecorded.current) return;
    lastHandRecorded.current = state.handNumber;
    const r = state.handResult;
    const mine = r.makers === TEAM_OF[0];
    updateStats((s) => {
      s.hands++;
      if (mine) {
        s.calls++;
        if (r.euchred) s.set++;
        else s.made++;
        if (r.alone) {
          s.loners++;
          if (r.march) s.loneMarches++;
        }
      } else if (r.euchred) {
        s.euchres++;
      }
    });
  }, [state]);

  // Bot driver + auto-continue. The dealer-draw animation continues itself
  // from the table, and handEnd waits on the modal button.
  useEffect(() => {
    if (state.phase === 'trickEnd') {
      const t = setTimeout(() => dispatch({ type: 'CONTINUE' }), 1550);
      return () => clearTimeout(t);
    }
    const actor = actorFor(state);
    if (actor !== null && actor !== 0) {
      const t = setTimeout(() => {
        const action = botAction(state, actor, { noTrump: ntEnabled });
        if (action) dispatch(action);
      }, botDelay(state));
      return () => clearTimeout(t);
    }
  }, [state, ntEnabled]);

  return (
    <div className="game-root">
      <header className="top-bar">
        <button className="bar-btn" onClick={onExit}>← Menu</button>
        <button className="bar-btn" disabled={!canUndo} onClick={() => dispatch({ type: 'UNDO' })}>
          ↩ Undo
        </button>
        <span className="bar-title">Euchre</span>
        {ORDERING.has(state.phase) && (
          <span className="bar-dealt">{state.dealer === 0 ? 'You' : names[state.dealer]} dealt</span>
        )}
        <span className="bar-spacer" />
        {state.trump && state.phase !== 'gameOver' && (
          <span className="bar-trump">
            <span className={`bar-trump-sym ${isRed(state.trump) ? 'suit-red' : ''}`}>
              {SUIT_SYMBOL[state.trump]}
            </span>
            <span className="bar-trump-name">{SUIT_NAME[state.trump]} trump</span>
          </span>
        )}
        {/* NT needs its own symbol, not just the spelled-out name: the phone
            bar hides .bar-trump-name, and a chip with nothing left inside it
            renders as a bare empty oval. */}
        {state.noTrump && state.phase !== 'gameOver' && (
          <span className="bar-trump bar-trump-nt">
            <span className="bar-trump-sym">NT</span>
            <span className="bar-trump-name">no trump — aces high</span>
          </span>
        )}
        <button className={`switch bar-switch ${ntEnabled ? 'switch-on' : ''}`} onClick={toggleNt}
          role="switch" aria-checked={ntEnabled} title="House rule: allow calling No Trump in round 2">
          <span className="switch-track"><span className="switch-knob" /></span>
          No Trump
        </button>
        <button className="bar-btn bar-btn-round" title="Rules" onClick={() => setShowRules(true)}>i</button>
      </header>
      <EuchreTable state={state} names={names} dispatch={dispatch} noTrumpRule={ntEnabled} />
      <EuchreModals
        state={state}
        names={names}
        onContinue={() => dispatch({ type: 'CONTINUE' })}
        onNewGame={onExit}
      />
      {showRules && <EuchreRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}
