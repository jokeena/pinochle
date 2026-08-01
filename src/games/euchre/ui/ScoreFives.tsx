/**
 * A team's score kept the table way: two 5s, 0–10. John's family convention,
 * confirmed exactly:
 *  - 0    both face down, stacked in a cross
 *  - 1–4  bottom 5 face up, the face-down card slid/angled to expose N pips
 *  - 5    the face-up 5 fully exposed, the other tucked beneath
 *  - 6–9  both face up: the top 5 fully visible, slid to expose N−5 pips
 *  - 10   both fully face up side by side
 * Red 5s for one team, black for the other (conjured — the euchre deck has
 * no 5s). The face is a proper bicycle-style 5: two pips top, one center,
 * two bottom. The cover rotates and slides the way it does on a real table:
 * laid at 45° over everything but the top-left pip for 1, crosswise for
 * 2 and 3, and 45° over just the bottom-right pip for 4.
 */

interface Props {
  score: number;
  color: 'red' | 'black';
}

/**
 * Cover transforms for "expose N pips of the card underneath", N = 1–4.
 * Positions are worked out against the pip grid (rows at 20/50/80% of a
 * 44×62 card) so each pose covers exactly the pips it should.
 *
 * Both cards are the same card, so no pose may scale: a cover that is bigger
 * than the card under it stops reading as a deck. The diagonals earn their
 * coverage from translation alone — pose 1 slides down-right far enough to
 * leave the top-left pip out, pose 4 hangs off the bottom-right corner with
 * only its near edge over the last pip. Check any edit against `/#fives`.
 */
const COVER_POSE: Record<number, string> = {
  1: 'translate(26%, 6%) rotate(45deg)',
  2: 'translate(0, 16%) rotate(90deg)',
  3: 'translate(0, 44%) rotate(90deg)',
  4: 'translate(75%, 15%) rotate(45deg)',
};

const PIPS: [number, number][] = [[30, 20], [70, 20], [50, 50], [30, 80], [70, 80]];

/** The red team scores with the 5♥ and 5♦ together; the black team with the 5♠ and 5♣. */
const PAIR_SUITS: Record<'red' | 'black', [string, string]> = {
  red: ['♥', '♦'],
  black: ['♠', '♣'],
};

function FiveFace({ sym }: { sym: string }) {
  return (
    <svg className="five-svg" viewBox="0 0 44 62" aria-hidden="true">
      <text className="five-index" x="5.5" y="11">5</text>
      <text className="five-index five-index-suit" x="5.5" y="19">{sym}</text>
      {PIPS.map(([x, y], i) => (
        <text key={i} className="five-pip" x={`${x}%`} y={`${y}%`}>{sym}</text>
      ))}
      <g transform="rotate(180 22 31)">
        <text className="five-index" x="5.5" y="11">5</text>
        <text className="five-index five-index-suit" x="5.5" y="19">{sym}</text>
      </g>
    </svg>
  );
}

export function ScoreFives({ score, color }: Props) {
  const n = Math.max(0, Math.min(10, score));
  const cls = `five-card five-${color}`;

  let bottom: { face: boolean; style: React.CSSProperties };
  let top: { face: boolean; style: React.CSSProperties };

  if (n === 0) {
    bottom = { face: false, style: {} };
    top = { face: false, style: { transform: 'rotate(90deg)' } };
  } else if (n <= 4) {
    bottom = { face: true, style: {} };
    top = { face: false, style: { transform: COVER_POSE[n] } };
  } else if (n === 5) {
    bottom = { face: false, style: { transform: 'translate(-9%, -5%) rotate(-7deg)' } };
    top = { face: true, style: {} };
  } else if (n <= 9) {
    bottom = { face: true, style: {} };
    top = { face: true, style: { transform: COVER_POSE[n - 5] } };
  } else {
    bottom = { face: true, style: { transform: 'translate(-56%, 0)' } };
    top = { face: true, style: { transform: 'translate(56%, 0)' } };
  }

  const [bottomSym, topSym] = PAIR_SUITS[color];
  return (
    <div className={`fives ${n === 10 ? 'fives-win' : ''}`} title={`${n} point${n === 1 ? '' : 's'}`}>
      <div className={`${cls} ${bottom.face ? '' : 'five-back'}`} style={bottom.style}>
        {bottom.face && <FiveFace sym={bottomSym} />}
      </div>
      <div className={`${cls} ${top.face ? '' : 'five-back'}`} style={top.style}>
        {top.face && <FiveFace sym={topSym} />}
      </div>
    </div>
  );
}

/** Dev harness (#fives on the landing page): every score state side by side. */
export function FivesGallery() {
  return (
    <div className="fives-gallery">
      {Array.from({ length: 11 }).map((_, n) => (
        <div key={n} className="fives-gallery-item">
          <div className="fives-gallery-label">{n}</div>
          <ScoreFives score={n} color="red" />
          <ScoreFives score={n} color="black" />
        </div>
      ))}
    </div>
  );
}
