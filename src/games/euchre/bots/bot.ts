import { buildDeck } from '../../../cards/deck';
import { GameAction, GameState, TARGET, TEAM_OF, activePlayers, nextActive } from '../engine/game';
import { legalPlays, winningIndex } from '../engine/tricks';
import { Card, RANK_POWER, Rank, SAME_COLOR, SUITS, Suit, effectiveSuit, isLeftBower, isRightBower, trickPower } from '../engine/types';

/**
 * Heuristic euchre bot. Like the pinochle bot it reads the shared GameState
 * but only uses what a player at the table would know: its own hand, the
 * upcard's fate, completed tricks (`played`), and observed voids.
 */

/** Each higher trump you don't hold costs an honour this much. */
const HONOUR_DISCOUNT = 0.12;
/** No honour falls below this: even a dead one still ruffs. */
const HONOUR_FLOOR = 0.5;

/** The seven trump when `s` is trump, strongest first. */
function trumpRanking(s: Suit): { suit: Suit; rank: Rank }[] {
  return [
    { suit: s, rank: 'J' }, { suit: SAME_COLOR[s], rank: 'J' },
    { suit: s, rank: 'A' }, { suit: s, rank: 'K' }, { suit: s, rank: 'Q' },
    { suit: s, rank: '10' }, { suit: s, rank: '9' },
  ];
}

/**
 * Worth of a card as trump in suit `s`, in "trump points" (right bower = 3).
 *
 * An honour is only as good as what's above it: A-Q of trump with both bowers
 * out is nothing like A-Q with them in hand, so each higher trump missing from
 * `context` shaves the honour down, never below HONOUR_FLOOR — even a dead
 * honour still ruffs. The discount is deliberately gentle: it has to separate
 * A-K-10 (a call at John's table) from A-Q-9 (not one) without turning the
 * bots timid. The 10 and 9 are pure ruffers and priced flat. Pass `context` =
 * the hand the card would be played from ([] when nothing else is known).
 */
function trumpValue(c: Card, s: Suit, context: Card[]): number {
  if (isRightBower(c, s)) return 3;
  if (isLeftBower(c, s)) return 2.5;
  if (c.suit !== s) return 0;
  if (c.rank === '10' || c.rank === '9') return 1;
  const base = { A: 2, K: 1.5, Q: 1.25 }[c.rank as 'A' | 'K' | 'Q'];
  const power = trickPower(c, s);
  const above = trumpRanking(s).filter((t) =>
    trickPower({ id: '', ...t }, s) > power &&
    !context.some((h) => h.suit === t.suit && h.rank === t.rank)).length;
  return Math.max(HONOUR_FLOOR, base - HONOUR_DISCOUNT * above);
}

/**
 * Strength of `hand` if `s` were trump: trump points + off-suit aces + a
 * little for voids (ruffing power). ~5.5 is a sound call; ~8.5 plays alone.
 */
export function handScore(hand: Card[], s: Suit): number {
  let score = 0;
  for (const c of hand) {
    const tv = trumpValue(c, s, hand);
    if (tv > 0) score += tv;
    else if (c.rank === 'A') score += 1;
  }
  for (const suit of SUITS) {
    if (suit === s) continue;
    if (!hand.some((c) => effectiveSuit(c, s) === suit)) score += 0.6;
  }
  return score;
}

const CALL = 5.5;
const ALONE = 8.5;

/**
 * Strength of `hand` played at No Trump, scored suit by suit — nothing ruffs,
 * so tricks come from running a suit top-down. What matters is not how many
 * honours you hold but whether they're backed: a queen behind your own ace is
 * a trick once the ace pulls, the same queen bare is a discard. Length in an
 * ace suit gives the honours room to run. Scaled to the same CALL/ALONE bar.
 */
export function ntScore(hand: Card[]): number {
  let score = 0;
  for (const suit of SUITS) {
    const cards = hand.filter((c) => c.suit === suit);
    if (cards.length === 0) continue;
    const has = (rank: Rank) => cards.some((c) => c.rank === rank);
    const ace = has('A');
    if (ace) score += 2.2;
    if (has('K')) score += ace ? 1.8 : 1;
    if (has('Q')) score += ace && has('K') ? 1.6 : ace || has('K') ? 0.9 : 0.3;
    // Small cards under your own ace are stoppers, not dead weight.
    if (ace) score += 0.15 * (cards.length - 1);
  }
  return score;
}

/**
 * At 8 or 9 a plain march already wins the game, so the extra two points a
 * loner pays are worth nothing against the risk of playing a man short.
 * Bots hold back there; the human is never stopped from trying it.
 */
function mayGoAlone(state: GameState, seat: number): boolean {
  return (state.scores[TEAM_OF[seat]] ?? 0) < TARGET - 2;
}

export interface BotOptions {
  /** House rule: No Trump may be called in round 2. */
  noTrump?: boolean;
}

/** The dealer's best discard from 6 cards: shed a lone low off-suit card, else the lowest. */
export function pickDiscard(hand: Card[], trump: Suit): Card {
  const offSuit = hand.filter((c) => effectiveSuit(c, trump) !== trump);
  if (offSuit.length === 0) {
    return hand.reduce((lo, c) => (trickPower(c, trump) < trickPower(lo, trump) ? c : lo));
  }
  // Prefer creating a void: a suit holding exactly one non-ace card.
  const singletons = offSuit.filter((c) =>
    c.rank !== 'A' && offSuit.filter((o) => o.suit === c.suit).length === 1);
  const pool = singletons.length > 0 ? singletons : offSuit;
  return pool.reduce((lo, c) => {
    if ((c.rank === 'A') !== (lo.rank === 'A')) return c.rank === 'A' ? lo : c;
    return RANK_POWER[c.rank] < RANK_POWER[lo.rank] ? c : lo;
  });
}

/** Cards not in my hand, not seen on the table, and not known dead. */
function unseen(state: GameState, seat: number): Card[] {
  const gone = new Set([
    ...state.hands[seat].map((c) => c.id),
    ...state.played.map((c) => c.id),
    ...state.trick.map((t) => t.card.id),
  ]);
  // A turned-down upcard is buried in the kitty; a picked-up one is live.
  if (state.upcard && !state.pickedUp) gone.add(state.upcard.id);
  return buildDeck(1).filter((c) => !gone.has(c.id));
}

/** True when no card still unaccounted for beats `card` in its own lane. */
function isBoss(state: GameState, seat: number, card: Card): boolean {
  const trump = state.trump;
  const mySuit = effectiveSuit(card, trump);
  return !unseen(state, seat).some((c) =>
    effectiveSuit(c, trump) === mySuit && trickPower(c, trump) > trickPower(card, trump));
}

/** Sort key that spends plain cards before trump, and low before high. */
function spendCost(c: Card, trump: Suit | null): number {
  return (effectiveSuit(c, trump) === trump ? 100 : 0) + trickPower(c, trump);
}

function cheapest(cards: Card[], trump: Suit | null): Card {
  return cards.reduce((lo, c) => (spendCost(c, trump) < spendCost(lo, trump) ? c : lo));
}

function dearest(cards: Card[], trump: Suit | null): Card {
  return cards.reduce((hi, c) => (trickPower(c, trump) > trickPower(hi, trump) ? c : hi));
}

/** Seats that still play to the current trick after `seat` does. */
function seatsAfter(state: GameState, seat: number): number[] {
  const rest: number[] = [];
  let s = nextActive(state, seat);
  for (let n = state.trick.length + 1; n < activePlayers(state); n++) {
    rest.push(s);
    s = nextActive(state, s);
  }
  return rest;
}

function chooseLead(state: GameState, seat: number): Card {
  const trump = state.trump;
  const hand = state.hands[seat];
  const makers = TEAM_OF[state.maker] === TEAM_OF[seat];
  const trumps = hand.filter((c) => effectiveSuit(c, trump) === trump);
  const plain = hand.filter((c) => effectiveSuit(c, trump) !== trump);
  const enemyTrumpLive = unseen(state, seat).some((c) => effectiveSuit(c, trump) === trump);

  // A boss trump is a guaranteed trick: makers lead it to pull the
  // opponents' trump, and once no enemy trump is live ANYONE cashes it —
  // banking the sure winner first can promote a weak off-suit card as
  // the others discard. (Defenders don't lead trump into live enemy trump.)
  if (trumps.length > 0 && (makers || !enemyTrumpLive)) {
    const best = dearest(trumps, trump);
    if (isBoss(state, seat, best)) return best;
  }
  // A boss plain card (an ace, or promoted by play) cashes now.
  const bossPlain = plain.filter((c) => isBoss(state, seat, c));
  if (bossPlain.length > 0) {
    return bossPlain.reduce((hi, c) => (RANK_POWER[c.rank] > RANK_POWER[hi.rank] ? c : hi));
  }
  // Endgame: nothing left is a sure thing, so hold on to the lead. Trump
  // beats every plain suit, so leading a plain loser just hands the trick
  // (and the lead) over and lets them draw or ruff the trump away. With the
  // hand nearly spent there is no ruffing left to save it for — lead it.
  if (trumps.length > 0 && hand.length <= 2) return dearest(trumps, trump);
  // Nothing good: lead the cheapest plain card; all-trump hands lead low trump.
  return plain.length > 0 ? cheapest(plain, trump) : cheapest(trumps, trump);
}

function chooseFollow(state: GameState, seat: number, legal: Card[]): Card {
  const trump = state.trump;
  const wi = winningIndex(state.trick, trump);
  const winner = state.trick[wi];
  const partnerWinning = TEAM_OF[winner.seat] === TEAM_OF[seat] && winner.seat !== seat;
  const lastToAct = state.trick.length === activePlayers(state) - 1;
  const led = effectiveSuit(state.trick[0].card, trump);
  const enemiesAfter = seatsAfter(state, seat).filter((s) => TEAM_OF[s] !== TEAM_OF[seat]);

  const winners = legal.filter((c) => {
    const suitOk = effectiveSuit(c, trump) === effectiveSuit(winner.card, trump)
      ? trickPower(c, trump) > trickPower(winner.card, trump)
      : effectiveSuit(c, trump) === trump;
    return suitOk;
  });
  const bossWinners = winners.filter((c) => isBoss(state, seat, c));

  if (partnerWinning) {
    // Partner has it locked — nobody left to beat them, or the card can't be
    // beaten: save everything.
    if (lastToAct || enemiesAfter.length === 0 || isBoss(state, seat, winner.card)) {
      return cheapest(legal, trump);
    }
    // Their card IS beatable and an opponent still acts. Overtake with a sure
    // winner if I hold one — sitting back with the ace behind partner's ten
    // just gifts the trick, and against a loner that's the whole hand.
    if (bossWinners.length > 0) return cheapest(bossWinners, trump);
    return cheapest(legal, trump);
  }

  if (winners.length > 0) {
    if (lastToAct || enemiesAfter.length === 0) return cheapest(winners, trump);
    // Ruffing a plain lead: every trump in hand already beats the trick, so
    // spend the smallest. Burning the right bower on a trick the nine wins
    // throws away a guaranteed trick — only step up when an opponent behind
    // me is known void in the led suit and can ruff over the top.
    const ruffing = trump !== null && led !== trump &&
      winners.every((c) => effectiveSuit(c, trump) === trump);
    if (ruffing) {
      const overRuffRisk = enemiesAfter.some((s) => state.voids[s]?.[SUITS.indexOf(led)]);
      if (!overRuffRisk) return cheapest(winners, trump);
    }
    // Otherwise prefer a winner that can't be beaten back.
    if (bossWinners.length > 0) return cheapest(bossWinners, trump);
    return cheapest(winners, trump);
  }
  return cheapest(legal, trump);
}

export function botAction(state: GameState, seat: number, opts: BotOptions = {}): GameAction | null {
  if (seat === state.inactive) return null;
  const hand = state.hands[seat];

  switch (state.phase) {
    case 'order1': {
      if (seat !== state.turn || !state.turnCard) return null;
      const s = state.turnCard.suit;
      let score: number;
      if (seat === state.dealer) {
        const six = [...hand, state.turnCard];
        const kept = six.filter((c) => c.id !== pickDiscard(six, s).id);
        score = handScore(kept, s);
      } else {
        score = handScore(hand, s);
        // Ordering up hands the dealer a trump: good for their partner, bad
        // for their opponents. Priced on its own — we know nothing about the
        // rest of the hand it lands in.
        const gift = trumpValue(state.turnCard, s, []) / 2;
        score += TEAM_OF[seat] === TEAM_OF[state.dealer] ? gift : -gift;
      }
      if (score >= CALL) {
        return { type: 'ORDER_UP', seat, alone: score >= ALONE && mayGoAlone(state, seat) };
      }
      return { type: 'PASS', seat };
    }

    case 'order2': {
      if (seat !== state.turn) return null;
      let bestSuit: Suit | 'NT' | null = null;
      let bestScore = -1;
      for (const s of SUITS) {
        if (s === state.turnedDown) continue;
        const sc = handScore(hand, s);
        if (sc > bestScore) {
          bestScore = sc;
          bestSuit = s;
        }
      }
      if (opts.noTrump) {
        const nt = ntScore(hand);
        if (nt > bestScore) {
          bestScore = nt;
          bestSuit = 'NT';
        }
      }
      if (seat === state.dealer || bestScore >= CALL) {
        // Stuck dealers name their least-bad call and play it straight.
        return {
          type: 'NAME_TRUMP', seat, suit: bestSuit!,
          alone: bestScore >= ALONE && mayGoAlone(state, seat),
        };
      }
      return { type: 'PASS', seat };
    }

    case 'discard': {
      if (seat !== state.dealer || seat !== state.turn) return null;
      return { type: 'DISCARD', seat, cardId: pickDiscard(hand, state.trump!).id };
    }

    case 'play': {
      if (seat !== state.turn) return null;
      const legal = legalPlays(hand, state.trick, state.trump);
      const card = legal.length === 1
        ? legal[0]
        : state.trick.length === 0
          ? chooseLead(state, seat)
          : chooseFollow(state, seat, legal);
      return { type: 'PLAY', seat, cardId: card.id };
    }

    default:
      return null;
  }
}
