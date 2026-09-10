import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const NUMBERS = Array.from({ length: 36 }, (_, index) => index + 1);

const pocket = (value) => `pocket-${value}`;

function fixedBet(id, label, covers, toOne, group) {
  return {
    id,
    label,
    covers: covers.map(pocket),
    payout: { kind: 'fixed', toOne },
    group,
  };
}

function numberedBets() {
  const bets = NUMBERS.map((number) => (
    fixedBet(`straight-${number}`, String(number), [number], 35, 'inside')
  ));

  // The numbered felt is twelve rows of three. Horizontal neighbours share a row;
  // vertical neighbours are three apart in adjacent rows.
  for (let row = 0; row < 12; row += 1) {
    const first = (row * 3) + 1;
    bets.push(fixedBet(`split-${first}-${first + 1}`, `${first}/${first + 1}`, [first, first + 1], 17, 'inside'));
    bets.push(fixedBet(`split-${first + 1}-${first + 2}`, `${first + 1}/${first + 2}`, [first + 1, first + 2], 17, 'inside'));
    bets.push(fixedBet(`street-${first}-${first + 2}`, `${first}-${first + 2}`, [first, first + 1, first + 2], 11, 'inside'));
  }
  for (let number = 1; number <= 33; number += 1) {
    bets.push(fixedBet(`split-${number}-${number + 3}`, `${number}/${number + 3}`, [number, number + 3], 17, 'inside'));
  }
  for (let row = 0; row < 11; row += 1) {
    const first = (row * 3) + 1;
    bets.push(fixedBet(
      `corner-${first}-${first + 4}`,
      `${first}/${first + 1}/${first + 3}/${first + 4}`,
      [first, first + 1, first + 3, first + 4],
      8,
      'inside',
    ));
    bets.push(fixedBet(
      `corner-${first + 1}-${first + 5}`,
      `${first + 1}/${first + 2}/${first + 4}/${first + 5}`,
      [first + 1, first + 2, first + 4, first + 5],
      8,
      'inside',
    ));
    bets.push(fixedBet(
      `line-${first}-${first + 5}`,
      `${first}-${first + 5}`,
      [first, first + 1, first + 2, first + 3, first + 4, first + 5],
      5,
      'inside',
    ));
  }

  for (let dozen = 0; dozen < 3; dozen += 1) {
    const first = (dozen * 12) + 1;
    const last = first + 11;
    bets.push(fixedBet(`dozen-${dozen + 1}`, `${first}-${last}`, NUMBERS.slice(first - 1, last), 2, 'outside'));
  }
  for (let column = 1; column <= 3; column += 1) {
    const covers = NUMBERS.filter((number) => ((number - column) % 3) === 0);
    bets.push(fixedBet(`column-${column}`, `Column ${column}`, covers, 2, 'outside'));
  }

  bets.push(fixedBet('red', 'Red', NUMBERS.filter((number) => RED.has(number)), 1, 'outside'));
  bets.push(fixedBet('black', 'Black', NUMBERS.filter((number) => !RED.has(number)), 1, 'outside'));
  bets.push(fixedBet('odd', 'Odd', NUMBERS.filter((number) => number % 2 === 1), 1, 'outside'));
  bets.push(fixedBet('even', 'Even', NUMBERS.filter((number) => number % 2 === 0), 1, 'outside'));
  bets.push(fixedBet('low', '1 to 18', NUMBERS.filter((number) => number <= 18), 1, 'outside'));
  bets.push(fixedBet('high', '19 to 36', NUMBERS.filter((number) => number >= 19), 1, 'outside'));
  return bets;
}

function zeroBets() {
  return [
    fixedBet('straight-0', '0', [0], 35, 'inside'),
    fixedBet('straight-00', '00', ['00'], 35, 'inside'),
    fixedBet('split-0-00', '0/00', [0, '00'], 17, 'inside'),
    fixedBet('split-0-3', '0/3', [0, 3], 17, 'inside'),
    fixedBet('split-0-2', '0/2', [0, 2], 17, 'inside'),
    fixedBet('split-00-2', '00/2', ['00', 2], 17, 'inside'),
    fixedBet('split-00-1', '00/1', ['00', 1], 17, 'inside'),
    fixedBet('trio-0-2-3', '0/2/3', [0, 2, 3], 11, 'inside'),
    fixedBet('trio-00-1-2', '00/1/2', ['00', 1, 2], 11, 'inside'),
    fixedBet('trio-0-00-2', '0/00/2', [0, '00', 2], 11, 'inside'),
    fixedBet('five-number', '0/00/1/2/3', [0, '00', 1, 2, 3], 6, 'inside'),
  ];
}

export function buildModuleManifest() {
  return {
    contractVersion: 1,
    identity: {
      id: 'roulette',
      name: 'Roulette',
      description: 'American and European roulette tracking, play and simulation.',
      icon: { kind: 'glyph', glyph: '◉' },
    },
    outcomeSpace: {
      weightBasis: {
        kind: 'counted',
        note: 'The default American wheel has 38 pockets, one of each.',
      },
      outcomes: [
        { id: pocket(0), label: '0', weight: 1, meta: { colour: 'green' } },
        { id: pocket('00'), label: '00', weight: 1, meta: { colour: 'green' } },
        ...NUMBERS.map((number) => ({
          id: pocket(number),
          label: String(number),
          weight: 1,
          meta: { colour: RED.has(number) ? 'red' : 'black' },
        })),
      ],
    },
    bets: [...numberedBets(), ...zeroBets()],
    stages: [],
    roundSchemaVersion: 1,
    surfaces: { play: '/play' },
  };
}

export function serializeModuleManifest() {
  // This is a generated wire artifact, not a review surface. Keeping it on one line avoids a
  // 2,600-line committed file; the readable, tested source of truth is this generator.
  return `${JSON.stringify(buildModuleManifest())}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const serialized = serializeModuleManifest();
  if (process.argv.includes('--write')) {
    await writeFile(fileURLToPath(new URL('../module.json', import.meta.url)), serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
}
