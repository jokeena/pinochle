import { useEffect, useMemo, useRef, useState } from 'react';
import { CardView } from '../../../cards/CardView';
import { GameAction, GameState, PLAYERS, TEAM_OF, partnerOf } from '../engine/game';
import { legalPlays, winningIndex } from '../engine/tricks';
import { Card, RANK_POWER, SUITS, SUIT_NAME, SUIT_SYMBOL, Suit, effectiveSuit, isRed, trickPower } from '../engine/types';
import { ScoreFives } from './ScoreFives';

const SEAT_POS: [number, number][] = [[50, 100], [8, 50], [50, 16], [92, 50]];
const MOBILE_SEAT_POS: [number, number][] = [[50, 100], [11, 44], [50, 18], [89, 44]];
const TRICK_OFFSET: [number, number][] = [[0, 76], [-94, 0], [0, -52], [94, 0]];
const MOBILE_TRICK_OFFSET: [number, number][] = [[0, 62], [-68, 0], [0, -46], [68, 0]];

/**
 * Where the kitty sits during the order rounds, in front of whichever seat
 * dealt. On your own deal it sits to the left of the order panel — dead
 * center it would fight the panel and the status bar for the same strip.
 * These anchor the STACK itself; the notes hang off it, out of flow.
 */
const KITTY_POS: [number, number][] = [[30, 80], [25, 51], [50, 40], [75, 51]];
/**
 * On a phone the kitty has to sit close enough to its dealer to read as
 * "theirs" without landing on an avatar, the trick, or the score fives —
 * so it tucks just inside each seat, offset toward the middle of the felt.
 */
const MOBILE_KITTY_POS: [number, number][] = [[50, 56], [33, 42], [50, 35], [67, 42]];

/**
 * Once the hand is underway the kitty retires to the table edge beside
 * the dealer, out of the way of the trick.
 */
const KITTY_PLAY_POS: [number, number][] = [[30, 82], [12, 68], [63, 17], [88, 68]];
const MOBILE_KITTY_PLAY_POS: [number, number][] = [[18, 80], [13, 63], [70, 27], [87, 63]];

/** Your team plays the red 5s, theirs the black — matching the avatar rings. */
export const TEAM_COLORS = ['#e06868', '#4a5568'];
const TEAM_FIVES: ('red' | 'black')[] = ['red', 'black'];

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 740px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 740px)');
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * Sort for display by EFFECTIVE suit (the left bower files with trump),
 * alternating colors where possible, trump first when named.
 */
function sortHand(hand: Card[], trump: Suit | null): Card[] {
  const eff = (c: Card) => (trump ? effectiveSuit(c, trump) : c.suit);
  const wheel: Suit[] = ['C', 'D', 'S', 'H'];
  const present = wheel.filter((s) => hand.some((c) => eff(c) === s));
  const perms = (arr: Suit[]): Suit[][] =>
    arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
  let best = present;
  let bestKey = Infinity;
  for (const perm of perms(present)) {
    let touches = 0;
    for (let i = 1; i < perm.length; i++) if (isRed(perm[i]) === isRed(perm[i - 1])) touches++;
    const key = touches * 10 + (trump && perm[0] === trump ? 0 : 1);
    if (key < bestKey) { bestKey = key; best = perm; }
  }
  // No trump named (or the No Trump call): natural order — jacks are just jacks.
  const rank = (c: Card) => (trump ? trickPower(c, trump) : RANK_POWER[c.rank]);
  return [...hand].sort((a, b) => {
    const sa = best.indexOf(eff(a));
    const sb = best.indexOf(eff(b));
    if (sa !== sb) return sa - sb;
    return rank(b) - rank(a);
  });
}

export function teamName(names: string[], team: number): string {
  return [0, 1, 2, 3].filter((s) => TEAM_OF[s] === team).map((s) => names[s]).join(' & ');
}

function isActing(state: GameState, seat: number): boolean {
  switch (state.phase) {
    case 'order1':
    case 'order2':
    case 'play':
      return state.turn === seat;
    case 'discard':
      return state.dealer === seat;
    default:
      return false;
  }
}

/** Seats that have already passed this order round (turn walks from left of dealer). */
function passedThisRound(state: GameState): boolean[] {
  const passed = Array(PLAYERS).fill(false);
  if (state.phase !== 'order1' && state.phase !== 'order2') return passed;
  for (let i = 1; i <= PLAYERS; i++) {
    const seat = (state.dealer + i) % PLAYERS;
    if (seat === state.turn) break;
    passed[seat] = true;
  }
  return passed;
}

/** Going-alone toggle: gray/left = off, green/right = on. */
function AloneSwitch({ on, toggle }: { on: boolean; toggle: () => void }) {
  return (
    <button className={`switch ${on ? 'switch-on' : ''}`} onClick={toggle}
      role="switch" aria-checked={on}>
      <span className="switch-track"><span className="switch-knob" /></span>
      Alone
    </button>
  );
}

interface Props {
  state: GameState;
  names: string[];
  dispatch: (a: GameAction) => void;
  /** House rule: the No Trump call is on the table in round 2. */
  noTrumpRule: boolean;
}

interface Flight {
  key: number;
  /** Face-up turn card into the dealer's hand, or a face-down burial back out. */
  card: Card | null;
  from: [number, number];
  to: [number, number];
}

export function EuchreTable({ state, names, dispatch, noTrumpRule }: Props) {
  const narrow = useIsNarrow();
  const positions = narrow ? MOBILE_SEAT_POS : SEAT_POS;
  const trickOffsets = narrow ? MOBILE_TRICK_OFFSET : TRICK_OFFSET;
  // The kitty parks by the dealer's edge once play starts; the CSS transition glides it over.
  const kittyPos = state.phase === 'play' || state.phase === 'trickEnd'
    ? (narrow ? MOBILE_KITTY_PLAY_POS : KITTY_PLAY_POS)[state.dealer]
    : (narrow ? MOBILE_KITTY_POS : KITTY_POS)[state.dealer];
  const [collect, setCollect] = useState(false);
  const [aloneSel, setAloneSel] = useState(false);
  const [drawN, setDrawN] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  /** The turn card mid-flip, after everyone passed round 1. */
  const [flipDown, setFlipDown] = useState<{ key: number; card: Card } | null>(null);
  const prevPhase = useRef(state.phase);
  const flightKey = useRef(0);

  useEffect(() => setAloneSel(false), [state.handNumber, state.phase]);

  // Pickup and burial flights: the turn card sails into the dealer's hand,
  // and the buried card sails back out to the kitty. Removal timers live in
  // a ref cleared only on unmount so a quick phase change can't strand one.
  const flightTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = state.phase;
    let flight: Flight | null = null;
    if (prev === 'order1' && state.phase === 'discard' && state.upcard) {
      flight = { key: flightKey.current++, card: state.upcard, from: kittyPos, to: positions[state.dealer] };
    } else if (prev === 'discard' && state.phase === 'play') {
      flight = { key: flightKey.current++, card: null, from: positions[state.dealer], to: kittyPos };
    } else if (prev === 'order1' && state.phase === 'order2' && state.upcard) {
      // Everyone passed: the turn card rolls face down onto the kitty.
      const f = { key: flightKey.current++, card: state.upcard };
      setFlipDown(f);
      const t = setTimeout(() => {
        flightTimers.current.delete(t);
        setFlipDown((cur) => (cur?.key === f.key ? null : cur));
      }, 700);
      flightTimers.current.add(t);
    }
    if (flight) {
      const f = flight;
      setFlights((fs) => [...fs, f]);
      const t = setTimeout(() => {
        flightTimers.current.delete(t);
        setFlights((fs) => fs.filter((x) => x.key !== f.key));
      }, 800);
      flightTimers.current.add(t);
    }
  }, [state.phase, state.dealer, state.upcard, kittyPos, positions]);
  useEffect(() => {
    const timers = flightTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Trick pickup: let the completed trick sit, then sweep it to the winner.
  useEffect(() => {
    if (state.phase === 'trickEnd') {
      setCollect(false);
      const t = setTimeout(() => setCollect(true), 750);
      return () => clearTimeout(t);
    }
    setCollect(false);
  }, [state.phase, state.tricksPlayed]);

  // Opening ritual: flip the draw cards around the table until the black
  // jack lands, hold on it, then deal. drawCards is fixed in state; drawN
  // is just the reveal cursor.
  const isDraw = state.phase === 'dealerDraw';
  useEffect(() => {
    if (!isDraw) return;
    setDrawN(0);
    const iv = setInterval(() => {
      setDrawN((n) => {
        if (n >= state.drawCards.length) { clearInterval(iv); return n; }
        return n + 1;
      });
    }, 260);
    return () => clearInterval(iv);
  }, [isDraw, state.drawCards.length]);
  const drawDone = isDraw && drawN >= state.drawCards.length;
  useEffect(() => {
    if (!drawDone) return;
    const t = setTimeout(() => dispatch({ type: 'CONTINUE' }), 1600);
    return () => clearTimeout(t);
  }, [drawDone, dispatch]);

  const passed = passedThisRound(state);
  const humanTurnToPlay = state.phase === 'play' && state.turn === 0 && state.inactive !== 0;
  const humanDiscarding = state.phase === 'discard' && state.dealer === 0;
  const legal = useMemo(
    () => (humanTurnToPlay ? legalPlays(state.hands[0], state.trick, state.trump) : []),
    [state, humanTurnToPlay],
  );
  const legalIds = new Set(legal.map((c) => c.id));

  const hand = sortHand(
    (state.phase === 'handReview' ? state.playHands[0] : state.hands[0]) ?? [],
    state.trump ?? state.turnCard?.suit ?? null,
  );

  const onCardClick = (card: Card) => {
    if (humanDiscarding) dispatch({ type: 'DISCARD', seat: 0, cardId: card.id });
    else if (humanTurnToPlay && legalIds.has(card.id)) dispatch({ type: 'PLAY', seat: 0, cardId: card.id });
  };

  const statusText = (() => {
    switch (state.phase) {
      case 'dealerDraw':
        return drawDone
          ? `${state.dealer === 0 ? 'You draw' : `${names[state.dealer]} draws`} the black jack and deal${state.dealer === 0 ? '' : 's'}.`
          : 'First black jack deals…';
      case 'order1':
      case 'order2':
        return state.turn === 0 ? '' : `${names[state.turn]} is thinking…`;
      case 'discard':
        if (state.dealer !== 0) return `${names[state.dealer]} picks it up…`;
        return state.maker === 0
          ? 'Click a card to bury it.'
          : `${names[state.maker]} ordered you up, discard a card`;
      case 'play':
        return humanTurnToPlay ? 'Your play.' : '';
      case 'trickEnd':
        return `${names[state.trickWinner]} take${state.trickWinner === 0 ? '' : 's'} the trick.`;
      default:
        return '';
    }
  })();

  const showOrderPanel = (state.phase === 'order1' || state.phase === 'order2') &&
    state.turn === 0 && !isDraw;
  const makerVisible = state.maker >= 0 && state.phase !== 'gameOver';

  return (
    <div className="table-wrap">
      <div className={`felt ${state.noTrump ? 'felt-nt' : ''}`}
        data-mark={state.trump ? SUIT_SYMBOL[state.trump] : state.noTrump ? 'NT' : ''}>
        {/* Compact board: target, trump, and this hand's trick tally. Every
            slot is always rendered so nothing inside jumps when trump lands. */}
        <div className="board board-euchre">
          <div className="board-head">
            <span className="board-goal">First to 10</span>
            {/* Trump lives on the right of the head all hand long — on a phone
                the goal drops away and the strip keeps just this. */}
            <span
              className={`board-trump ${state.trump && isRed(state.trump) ? 'suit-red' : ''} ${state.noTrump ? 'board-nt' : ''}`}
              style={{ visibility: state.trump || state.noTrump ? 'visible' : 'hidden' }}>
              <span className="board-trump-sym">
                {state.trump ? SUIT_SYMBOL[state.trump] : 'NT'}
              </span>
              <span className="board-trump-name">
                {state.trump ? SUIT_NAME[state.trump] : 'aces high'}
              </span>
            </span>
          </div>
          {[0, 1].map((team) => (
            <div key={team} className="board-row">
              <span className="team-dot" style={{ background: TEAM_COLORS[team] }} />
              <span className="board-name">{teamName(names, team)}</span>
              <span className="tally">
                {Array.from({ length: 5 }).map((_, i) => (
                  <i key={i} className={i < (state.tricksTaken[team] ?? 0) ? 'tally-won' : ''} />
                ))}
              </span>
              <span className="board-score">{state.scores[team]}</span>
            </div>
          ))}
          <div className="board-bid">
            {makerVisible
              ? <>{state.maker === 0 ? 'You' : names[state.maker]} called it{state.alone ? ' — alone' : ''}</>
              : state.phase !== 'dealerDraw' && state.phase !== 'gameOver'
                ? <>{state.dealer === 0 ? 'You' : names[state.dealer]} dealt</>
                : ' '}
          </div>
        </div>

        {/* The score fives, kept at each team's edge of the table */}
        <div className="fives-spot fives-you">
          <ScoreFives score={state.scores[0] ?? 0} color={TEAM_FIVES[0]} />
        </div>
        <div className="fives-spot fives-them">
          <ScoreFives score={state.scores[1] ?? 0} color={TEAM_FIVES[1]} />
        </div>

        {/* Opponent seats */}
        {positions.map(([x, y], seat) => seat !== 0 && (
          <div key={seat} className="seat" style={{ left: `${x}%`, top: `${y}%` }}>
            <div className={[
              'avatar',
              isActing(state, seat) ? 'avatar-active' : '',
              state.inactive === seat ? 'avatar-out' : '',
              state.maker === seat && makerVisible ? 'avatar-bid' : '',
            ].filter(Boolean).join(' ')}
              style={{ ['--team' as string]: TEAM_COLORS[TEAM_OF[seat]] }}>
              {names[seat][0]}
              {state.dealer === seat && !isDraw && <span className="chip chip-dealer">D</span>}
              {state.maker === seat && makerVisible && (state.trump || state.noTrump) && (
                <span className={`chip chip-bid chip-trump ${state.trump && isRed(state.trump) ? 'chip-red' : ''} ${state.noTrump ? 'chip-nt' : ''}`}>
                  {state.trump ? SUIT_SYMBOL[state.trump] : 'NT'}
                </span>
              )}
            </div>
            <div className="seat-name">
              {names[seat]}
              {state.inactive === seat && <span className="out-note"> · sitting out</span>}
            </div>
            <div className="seat-fan">
              {state.inactive !== seat && state.hands[seat]?.map((c, i, arr) => (
                <div key={c.id} className="fan-back"
                  style={{ transform: `rotate(${(i - (arr.length - 1) / 2) * 5}deg)` }} />
              ))}
            </div>
            {(state.phase === 'order1' || state.phase === 'order2') && passed[seat] && (
              <div className="seat-bubble bubble-pass">Pass</div>
            )}
            {state.maker === seat && state.alone && makerVisible && (
              <div className="seat-bubble bubble-alone">Alone</div>
            )}
          </div>
        ))}

        {/* Dealer draw: cards flipping around the table until the black jack */}
        {isDraw && (
          <div className="draw-layer">
            {state.drawCards.slice(0, drawN).map((d, i) => {
              // Cards land between the seat and the table center, fanning
              // slightly with each lap so nothing hides the avatars. The
              // narrow felt needs a stronger pull toward the middle.
              const [sx, sy] = positions[d.seat];
              const cx = sx + (50 - sx) * (narrow ? 0.55 : 0.34);
              const cy = sy + (52 - sy) * (narrow ? 0.55 : 0.36);
              const round = Math.floor(i / PLAYERS);
              const isJack = i === state.drawCards.length - 1 && drawN === state.drawCards.length;
              const dx = ((round % 3) - 1) * 26;
              const dy = Math.floor(round / 3) * 16;
              return (
                <div key={`${d.card.id}-${i}`}
                  className={`draw-card ${isJack ? 'draw-jack' : ''}`}
                  style={{
                    left: `calc(${cx}% + ${dx}px)`,
                    top: `calc(${cy}% + ${dy}px)`,
                  }}>
                  <CardView card={d.card} size="small" />
                </div>
              );
            })}
          </div>
        )}

        {/* Kitty and the turn card, sitting in front of whoever dealt.
            It stays on the felt all hand — the burial flies back into it. */}
        {!isDraw && ['order1', 'order2', 'discard', 'play', 'trickEnd'].includes(state.phase) && (
          <div className={`kitty-spot ${state.trump || state.noTrump ? 'kitty-quiet' : ''}`}
            style={{ left: `${kittyPos[0]}%`, top: `${kittyPos[1]}%` }}>
            <div className="kitty-stack">
              {/* The card mid-flip is the one it's about to become — don't
                  count it twice or the pile visibly grows under it. */}
              {Array.from({
                length: state.kitty.length + (state.discard ? 1 : 0) - (flipDown ? 1 : 0),
              }).map((_, i) => (
                <div key={i} className="fan-back" style={{ transform: `translate(${i * 2}px, ${-i * 2}px)` }} />
              ))}
              {state.turnCard && (
                <div className="upcard"><CardView card={state.turnCard} size={narrow ? 'small' : 'mid'} /></div>
              )}
              {flipDown && (
                <div className="upcard turn-flip" key={flipDown.key}>
                  <div className="turn-flip-face">
                    <CardView card={flipDown.card} size={narrow ? 'small' : 'mid'} />
                  </div>
                  <div className="turn-flip-back">
                    <CardView card={flipDown.card} faceDown size={narrow ? 'small' : 'mid'} />
                  </div>
                </div>
              )}
            </div>
            {/* Notes hang off the stack without taking layout space — the pile
                must not hop when a line appears or goes away. */}
            <div className="kitty-notes">
              <span className="kitty-tag">
                {state.dealer === 0 ? 'your deal' : `${names[state.dealer]}'s deal`}
              </span>
              {state.phase === 'order1' && state.turnCard && (
                <span className="kitty-note">up for grabs</span>
              )}
              {state.phase === 'order2' && state.turnedDown && (
                <span className="kitty-note">
                  <span className={isRed(state.turnedDown) ? 'suit-red' : ''}>{SUIT_SYMBOL[state.turnedDown]}</span> turned down
                </span>
              )}
            </div>
          </div>
        )}

        {/* Pickup / burial in flight */}
        {flights.map((f) => (
          <div key={f.key} className={f.card ? 'flight-face' : 'flight-card'} style={{
            ['--fx' as string]: `${f.from[0]}%`,
            ['--fy' as string]: `${Math.min(f.from[1], 94)}%`,
            ['--tx' as string]: `${f.to[0]}%`,
            ['--ty' as string]: `${Math.min(f.to[1], 94)}%`,
          }}>
            {f.card && <CardView card={f.card} size="small" />}
          </div>
        ))}

        {/* End of hand: the kitty flipped up and every hand as played */}
        {state.phase === 'handReview' && (
          <>
            {!narrow && positions.map(([sx, sy], seat) => {
              if (seat === 0) return null;
              const cards = sortHand(state.playHands[seat] ?? [], state.trump);
              if (cards.length === 0) return null;
              const rx = sx + (50 - sx) * 0.52;
              const ry = sy + (47 - sy) * 0.6;
              return (
                <div key={`review-${seat}`} className="review-row review-static" style={{ left: `${rx}%`, top: `${ry}%` }}>
                  <span className="review-name">{names[seat]}</span>
                  <div className="review-cards">
                    {cards.map((c) => <CardView key={c.id} card={c} size="small" />)}
                  </div>
                </div>
              );
            })}
            {!narrow && (
              <div className="review-row review-kitty review-static">
                <span className="review-name">In the kitty</span>
                <div className="review-cards">
                  {state.kitty.map((c) => <CardView key={c.id} card={c} size="small" />)}
                  {state.discard && (
                    <div className="review-buried">
                      <CardView card={state.discard} size="small" />
                      <span className="review-buried-tag">buried</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {!narrow && (
              <div className="action-panel review-panel">
                <div className="panel-label">The hands, as played this round</div>
                <button className="btn btn-gold" onClick={() => dispatch({ type: 'CONTINUE' })}>
                  Show the score
                </button>
              </div>
            )}
            {narrow && (
              <div className="table-sheet review-sheet">
                <div className="sheet-title">The hands, as played</div>
                <div className="sheet-body">
                  {[1, 2, 3, 0].map((seat) => {
                    const cards = sortHand(state.playHands[seat] ?? [], state.trump);
                    if (cards.length === 0) return null;
                    return (
                      <div key={`rsheet-${seat}`} className="sheet-row">
                        <div className="sheet-row-head">
                          <span className="team-dot" style={{ background: TEAM_COLORS[TEAM_OF[seat]] }} />
                          {seat === 0 ? 'You' : names[seat]}
                        </div>
                        <div className="sheet-cards">
                          {cards.map((c) => <CardView key={c.id} card={c} size="small" />)}
                        </div>
                      </div>
                    );
                  })}
                  <div className="sheet-row">
                    <div className="sheet-row-head">In the kitty</div>
                    <div className="sheet-cards">
                      {state.kitty.map((c) => <CardView key={c.id} card={c} size="small" />)}
                      {state.discard && <CardView card={state.discard} size="small" />}
                    </div>
                  </div>
                </div>
                <div className="bid-controls sheet-actions">
                  <button className="btn btn-gold" onClick={() => dispatch({ type: 'CONTINUE' })}>
                    Show the score
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Trick */}
        <div className="trick-area">
          {state.trick.map((p, i) => {
            const [sx, sy] = positions[p.seat];
            const [ox, oy] = trickOffsets[p.seat];
            const doCollect = state.phase === 'trickEnd' && collect;
            const [wx, wy] = doCollect ? positions[state.trickWinner] : [0, 0];
            const leading = (state.phase === 'play' || state.phase === 'trickEnd') &&
              i === winningIndex(state.trick, state.trump);
            return (
              <div
                key={p.card.id}
                className={[
                  'trick-card',
                  doCollect ? 'trick-collect' : '',
                  leading ? 'trick-leading' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  left: doCollect ? `${wx}%` : `calc(50% + ${ox}px)`,
                  top: doCollect ? `${Math.min(wy, 88)}%` : `calc(52% + ${oy}px)`,
                  ['--fx' as string]: `${sx}%`,
                  ['--fy' as string]: `${Math.min(sy, 96)}%`,
                  ['--rot' as string]: `${((p.seat * 47 + i * 13) % 9) - 4}deg`,
                }}
              >
                <CardView card={p.card} />
              </div>
            );
          })}
        </div>

        {statusText && <div className="status-bar">{statusText}</div>}

        {/* Order round 1: order it up / pass. On your own deal the panel
            rides higher so the kitty fits between it and your hand. */}
        {showOrderPanel && state.phase === 'order1' && state.turnCard && (
          <div className={`action-panel panel-euchre ${state.dealer === 0 ? 'panel-raised' : ''}`}>
            <div className="panel-label">
              Order up the{' '}
              <span className={isRed(state.turnCard.suit) ? 'suit-red' : ''}>
                {SUIT_SYMBOL[state.turnCard.suit]}
              </span>{' '}
              to {state.dealer === 0 ? 'yourself' : names[state.dealer]}?
            </div>
            <div className="bid-controls">
              <button className="bid-pass" onClick={() => dispatch({ type: 'PASS', seat: 0 })}>
                {state.dealer === 0 ? 'Turn it down' : 'Pass'}
              </button>
              <button className="bid-main"
                onClick={() => dispatch({ type: 'ORDER_UP', seat: 0, alone: aloneSel })}>
                {state.dealer === 0 ? 'Pick it up' : 'Order it up'}
              </button>
              <AloneSwitch on={aloneSel} toggle={() => setAloneSel((a) => !a)} />
            </div>
          </div>
        )}

        {/* Order round 2: name a suit / pass (dealer is stuck) */}
        {showOrderPanel && state.phase === 'order2' && (
          <div className={`action-panel panel-euchre ${state.dealer === 0 ? 'panel-raised' : ''}`}>
            <div className="panel-label">Name trump</div>
            <div className="suit-buttons">
              {SUITS.filter((s) => s !== state.turnedDown).map((s) => (
                <button key={s} className={`suit-btn ${isRed(s) ? 'suit-red' : ''}`}
                  onClick={() => dispatch({ type: 'NAME_TRUMP', seat: 0, suit: s, alone: aloneSel })}>
                  {SUIT_SYMBOL[s]}
                </button>
              ))}
              {noTrumpRule && (
                <button className="suit-btn suit-nt" title="No trump — aces high"
                  onClick={() => dispatch({ type: 'NAME_TRUMP', seat: 0, suit: 'NT', alone: aloneSel })}>
                  NT
                </button>
              )}
            </div>
            <div className="bid-controls">
              {state.dealer !== 0 && (
                <button className="bid-pass bid-pass-sm" onClick={() => dispatch({ type: 'PASS', seat: 0 })}>
                  Pass
                </button>
              )}
              <AloneSwitch on={aloneSel} toggle={() => setAloneSel((a) => !a)} />
            </div>
          </div>
        )}
      </div>

      {/* Human hand. hand-row-euchre pins the card area's width so the
          avatar never drifts as the hand empties. */}
      <div className="hand-row hand-row-euchre">
        <div className="hand-side">
          <div className={[
            'avatar avatar-you',
            isActing(state, 0) || humanTurnToPlay ? 'avatar-active' : '',
            state.inactive === 0 ? 'avatar-out' : '',
            state.maker === 0 && makerVisible ? 'avatar-bid' : '',
          ].filter(Boolean).join(' ')}
            style={{ ['--team' as string]: TEAM_COLORS[0] }}>
            You
            {state.dealer === 0 && !isDraw && <span className="chip chip-dealer">D</span>}
            {state.maker === 0 && makerVisible && (state.trump || state.noTrump) && (
              <span className={`chip chip-bid chip-trump ${state.trump && isRed(state.trump) ? 'chip-red' : ''} ${state.noTrump ? 'chip-nt' : ''}`}>
                {state.trump ? SUIT_SYMBOL[state.trump] : 'NT'}
              </span>
            )}
          </div>
          {(state.phase === 'order1' || state.phase === 'order2') && passed[0] && (
            <div className="seat-bubble bubble-pass">Pass</div>
          )}
          {state.maker === 0 && state.alone && makerVisible && (
            <div className="seat-bubble bubble-alone">Alone</div>
          )}
        </div>
        <div className="hand-cards">
          {hand.map((c, i) => (
            <div key={c.id} className="hand-slot" style={{ ['--i' as string]: i }}>
              <CardView
                card={c}
                dimmed={(humanTurnToPlay && !legalIds.has(c.id)) || state.inactive === 0}
                onClick={
                  humanDiscarding || (humanTurnToPlay && legalIds.has(c.id))
                    ? () => onCardClick(c)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
        <div className="hand-side" />
      </div>
    </div>
  );
}
