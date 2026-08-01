import { describe, expect, it } from 'vitest';
import { GameState, PLAYERS } from '../engine/game';
import { Card, Rank, Suit } from '../engine/types';
import { botAction, pickDiscard } from './bot';

const c = (suit: Suit, rank: Rank): Card => ({ id: `${suit}${rank}#0`, suit, rank });

function st(over: Partial<GameState>): GameState {
  return {
    phase: 'play',
    scores: [0, 0],
    dealer: 3,
    handNumber: 1,
    drawCards: [],
    hands: [[], [], [], []],
    kitty: [],
    turnCard: null,
    turnedDown: null,
    discard: null,
    upcard: null,
    pickedUp: false,
    played: [],
    turn: 0,
    trump: 'S',
    noTrump: false,
    maker: 0,
    alone: false,
    inactive: null,
    voids: Array.from({ length: PLAYERS }, () => Array(4).fill(false)),
    trick: [],
    trickWinner: -1,
    tricksPlayed: 0,
    tricksTaken: [0, 0],
    playHands: [],
    handResult: null,
    winnerTeam: null,
    log: [],
    ...over,
  };
}

describe('ordering decisions', () => {
  const order1 = (hand: Card[], seat: number, dealer: number, turnCard: Card) =>
    st({
      phase: 'order1', turn: seat, dealer, turnCard, upcard: turnCard,
      trump: null, maker: -1,
      hands: [[], [], [], []].map((h, i) => (i === seat ? hand : h)),
    });

  it('orders up alone on a monster', () => {
    const hand = [c('S', 'J'), c('C', 'J'), c('S', 'A'), c('S', 'K'), c('H', 'A')];
    const a = botAction(order1(hand, 1, 3, c('S', '9')), 1);
    expect(a).toEqual({ type: 'ORDER_UP', seat: 1, alone: true });
  });

  it('orders up (not alone) on a solid hand', () => {
    const hand = [c('S', 'J'), c('S', 'A'), c('S', 'Q'), c('H', '9'), c('H', '10')];
    const a = botAction(order1(hand, 1, 3, c('S', '9')), 1);
    expect(a).toEqual({ type: 'ORDER_UP', seat: 1, alone: false });
  });

  it('passes junk', () => {
    const hand = [c('H', '9'), c('D', '10'), c('C', 'Q'), c('S', '9'), c('H', '10')];
    const a = botAction(order1(hand, 1, 3, c('S', 'A')), 1);
    expect(a).toEqual({ type: 'PASS', seat: 1 });
  });

  it('calls No Trump on an ace-heavy hand — but only when the house rule is on', () => {
    const aces = [c('S', 'A'), c('H', 'A'), c('D', 'A'), c('C', 'A'), c('S', 'K')];
    const base = st({
      phase: 'order2', turnedDown: 'S', trump: null, maker: -1, turn: 1, dealer: 3,
      hands: [[], [], [], []].map((h, i) => (i === 1 ? aces : h)),
    });
    const withRule = botAction(base, 1, { noTrump: true });
    expect(withRule).toEqual({ type: 'NAME_TRUMP', seat: 1, suit: 'NT', alone: true });
    // Without the rule, bare aces don't make a 5.5-point suit call: pass.
    expect(botAction(base, 1)).toEqual({ type: 'PASS', seat: 1 });
  });

  it('prefers No Trump to a bowerless suit: A-Q-9 clubs, off ace, off nine', () => {
    // John's hand. At clubs both bowers are out, so the ace is only the third
    // trump and the queen the fifth; at No Trump both aces are locks and the
    // queen sits behind your own ace. NT is the better of the two calls.
    const hand = [c('C', 'A'), c('C', 'Q'), c('C', '9'), c('H', 'A'), c('D', '9')];
    const s = st({
      phase: 'order2', turnedDown: 'S', trump: null, maker: -1, turn: 1, dealer: 0,
      hands: [[], [], [], []].map((h, i) => (i === 1 ? hand : h)),
    });
    expect(botAction(s, 1, { noTrump: true }))
      .toEqual({ type: 'NAME_TRUMP', seat: 1, suit: 'NT', alone: false });
    // Without the house rule the bowerless club call isn't worth making.
    expect(botAction(s, 1)).toEqual({ type: 'PASS', seat: 1 });
  });

  it('never goes alone from 8 or 9 — a plain march already wins it', () => {
    const hand = [c('S', 'J'), c('C', 'J'), c('S', 'A'), c('S', 'K'), c('H', 'A')];
    for (const score of [8, 9]) {
      const s = order1(hand, 1, 3, c('S', '9'));
      expect(botAction(st({ ...s, scores: [0, score] }), 1))
        .toEqual({ type: 'ORDER_UP', seat: 1, alone: false });
    }
    // Seven still leaves a loner worth more than the march.
    expect(botAction(st({ ...order1(hand, 1, 3, c('S', '9')), scores: [0, 7] }), 1))
      .toEqual({ type: 'ORDER_UP', seat: 1, alone: true });
  });

  it('round 2: passes junk unless stuck as dealer, who names their least-bad suit', () => {
    const junk = [c('H', '9'), c('D', '10'), c('C', 'Q'), c('S', '9'), c('H', '10')];
    const base = {
      phase: 'order2' as const, turnedDown: 'S' as Suit, trump: null, maker: -1,
      hands: [[], [], [], []].map((h, i) => (i === 3 ? junk : h)),
    };
    expect(botAction(st({ ...base, turn: 3, dealer: 0 }), 3)).toEqual({ type: 'PASS', seat: 3 });
    const stuck = botAction(st({ ...base, turn: 3, dealer: 3 }), 3);
    expect(stuck?.type).toBe('NAME_TRUMP');
    if (stuck?.type === 'NAME_TRUMP') {
      expect(stuck.suit).not.toBe('S');
      expect(stuck.alone).toBe(false);
    }
  });
});

describe('pickDiscard', () => {
  it('sheds a lone low off-suit card to make a void, never an ace', () => {
    const six = [c('S', 'J'), c('S', 'A'), c('S', 'K'), c('S', 'Q'), c('D', '9'), c('H', 'A')];
    expect(pickDiscard(six, 'S').id).toBe(c('D', '9').id);
  });

  it('with only paired off-suits, sheds the lowest non-ace', () => {
    const six = [c('S', 'A'), c('S', 'K'), c('S', 'Q'), c('S', '10'), c('H', 'A'), c('H', 'K')];
    expect(pickDiscard(six, 'S').id).toBe(c('H', 'K').id);
  });

  it('all trump: sheds the weakest trump', () => {
    const six = [c('S', 'J'), c('C', 'J'), c('S', 'A'), c('S', 'K'), c('S', 'Q'), c('S', '10')];
    expect(pickDiscard(six, 'S').id).toBe(c('S', '10').id);
  });
});

describe('card play', () => {
  it('as maker, pulls trump by leading the boss', () => {
    const s = st({
      hands: [[c('S', 'J'), c('H', '9')], [], [], []],
      maker: 0, turn: 0,
    });
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('S', 'J').id });
  });

  it('cashes a guaranteed trump before a weak off-suit card, even with no trump left to pull', () => {
    // John's loner: J-J-A-K of trump + off 9. After J, J, A pull every spade,
    // the K is a lock — bank it and hope the discards make the 9 good.
    const s = st({
      hands: [[c('S', 'K'), c('H', '9')], [], [], []],
      maker: 0, alone: true, inactive: 2, turn: 0,
      played: [
        c('S', 'J'), c('C', 'J'), c('S', 'A'),
        c('S', 'Q'), c('S', '10'), c('S', '9'),
        c('D', 'A'), c('D', 'K'), c('D', 'Q'),
      ],
      tricksPlayed: 3, tricksTaken: [3, 0],
    });
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('S', 'K').id });
  });

  it('sloughs the cheapest card when partner has the trick locked', () => {
    const s = st({
      hands: [[c('H', 'A'), c('H', '9')], [], [], []],
      turn: 0, maker: 2,
      trick: [{ seat: 2, card: c('S', 'J') }],
    });
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('H', '9').id });
  });

  it('trumps in cheaply when the opponents are winning', () => {
    const s = st({
      hands: [[c('S', '9'), c('D', '9')], [], [], []],
      turn: 0, maker: 3,
      trick: [{ seat: 3, card: c('H', 'A') }],
    });
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('S', '9').id });
  });

  it('must-follow with one legal card just plays it', () => {
    const s = st({
      hands: [[c('C', 'J'), c('H', 'A'), c('H', 'K')], [], [], []],
      turn: 0, maker: 3,
      trick: [{ seat: 3, card: c('S', '9') }],
    });
    // Spades led: the left bower is the only effective spade.
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('C', 'J').id });
  });

  it('leads its last trump rather than throwing a loser away first', () => {
    // Bid made with 3 tricks, two cards left: a trump that might win and a
    // plain loser. Leading the loser hands over the lead for nothing.
    const s = st({
      hands: [[c('S', 'Q'), c('H', '9')], [], [], []],
      maker: 0, turn: 0,
      played: [
        c('D', 'A'), c('D', 'K'), c('D', 'Q'), c('D', '10'),
        c('H', 'A'), c('H', 'K'), c('H', 'Q'), c('H', '10'),
        c('C', 'A'), c('C', 'K'), c('C', 'Q'), c('C', '10'),
      ],
      tricksPlayed: 3, tricksTaken: [3, 0],
    });
    expect(botAction(s, 0)).toEqual({ type: 'PLAY', seat: 0, cardId: c('S', 'Q').id });
  });

  it('ruffs a plain lead with its lowest trump, never the right bower', () => {
    // An off-suit ace led into the maker: the nine takes it just as well, and
    // the right bower is a guaranteed trick that should not be spent here.
    const s = st({
      hands: [[], [c('S', 'J'), c('S', '9'), c('H', 'K')], [], []],
      maker: 1, turn: 1,
      trick: [{ seat: 0, card: c('D', 'A') }],
    });
    expect(botAction(s, 1)).toEqual({ type: 'PLAY', seat: 1, cardId: c('S', '9').id });
  });

  it('steps up over a partner whose card is beatable and an opponent still to act', () => {
    // The loner case: partner leads a nine, I hold the ace — sitting back with
    // the ten just gifts the trick to the only opponent left.
    const s = st({
      hands: [[], [], [c('D', 'A'), c('D', '10'), c('C', '9')], []],
      maker: 3, alone: true, inactive: 1, turn: 2,
      trick: [{ seat: 0, card: c('D', '9') }],
    });
    expect(botAction(s, 2)).toEqual({ type: 'PLAY', seat: 2, cardId: c('D', 'A').id });
  });

  it('a sitting-out seat never acts', () => {
    const s = st({ inactive: 0, turn: 0, hands: [[c('H', 'A')], [], [], []] });
    expect(botAction(s, 0)).toBeNull();
  });
});
