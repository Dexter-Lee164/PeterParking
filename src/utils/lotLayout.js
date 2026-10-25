'use strict';

/**
 * Scenes for the top-down lot on Find Parking (views/partials/parking-map.ejs).
 *
 * Each campus zone has its own drawing (see SCENES, keyed by zone code); any other zone gets a generic lot. A scene is
 * a list of ground primitives (asphalt, lines, trees, lamps, buildings, ...) plus stall positions. Units are
 * decimetres: a car stall is 2.6 m x 5.2 m.
 *
 * A stall position is described in its own frame: width w, depth h, centred on (cx, cy), with the back of the stall at
 * the top of the frame and the opening at the bottom, then rotated by `rot` degrees (0 opens down, 180 opens up,
 * 90 opens left, -90 opens right, anything else is angled). Vehicles are drawn nose-in, i.e. facing the frame's top.
 *
 * Slots are placed in sort order: each takes the first free position that prefers its type, else the first that
 * accepts it. A zone whose slots do not fit its scene falls back to the generic lot. The slot lists these scenes
 * expect are in src/db/lotPlans.js.
 */

const CAR = { w: 26, h: 52 };
const MOTO = { w: 14, h: 26 };
const PARALLEL = { w: 24, h: 58 };

function scene(width, height, ground = 'grass') {
  const s = { width, height, ground, prims: [], positions: [] };
  const add = (k, p) => s.prims.push(Object.assign({ k }, p));
  s.rect = (c, x, y, w, h, rx = 0) => add('rect', { c, x, y, w, h, rx });
  s.circle = (c, cx, cy, r) => add('circle', { c, cx, cy, r });
  s.line = (c, x1, y1, x2, y2) => add('line', { c, x1, y1, x2, y2 });
  s.text = (c, x, y, t, extra = {}) => add('text', Object.assign({ c, x, y, t, anchor: 'middle', rot: 0 }, extra));
  s.tree = (x, y, r = 9) => add('tree', { x, y, r, seed: s.prims.length });
  s.lamp = (x, y) => add('lamp', { x, y });
  s.arrow = (x, y, rot = 0, both = false) => add('arrow', { x, y, rot, both });
  s.zebra = (x, y, w, h, across = 'x') => add('zebra', { x, y, w, h, across });
  s.building = (x, y, w, h, face, label, sub) => add('building', { x, y, w, h, face, label, sub });
  s.canopy = (x, y, w, h, pillarsY) => add('canopy', { x, y, w, h, pillarsY });
  s.fountain = (cx, cy, r) => add('fountain', { cx, cy, r });
  s.bench = (x, y, rot = 0) => add('bench', { x, y, rot });
  s.gate = (x, y, w) => add('gate', { x, y, w });
  /** A stall position. kind: car | moto | parallel. */
  s.stall = (cx, cy, rot, kind = 'car') => {
    const dims = kind === 'moto' ? MOTO : kind === 'parallel' ? PARALLEL : CAR;
    const prefer = kind === 'moto' ? ['motorcycle'] : ['regular', 'accessible'];
    s.positions.push({ cx, cy, w: dims.w, h: dims.h, rot, kind, prefer });
  };
  return s;
}

/** Move everything drawn so far, e.g. to leave room above a scene for the zone card. */
function shift(s, dx, dy) {
  const keys = { x: dx, cx: dx, x1: dx, x2: dx, y: dy, cy: dy, y1: dy, y2: dy };
  s.prims.concat(s.positions).forEach((p) => {
    Object.keys(keys).forEach((k) => { if (typeof p[k] === 'number') p[k] += keys[k]; });
  });
  s.width += dx;
  s.height += dy;
}

const accepts = (pos, type) => (pos.kind === 'moto' ? type === 'motorcycle' : type !== 'motorcycle');

function allocate(s, slots) {
  const free = s.positions.slice();
  const stalls = [];
  const leftovers = [];
  slots.forEach((slot) => {
    let i = free.findIndex((p) => p.prefer.includes(slot.slot_type));
    if (i < 0) i = free.findIndex((p) => accepts(p, slot.slot_type));
    if (i < 0) leftovers.push(slot);
    else stalls.push(Object.assign({}, free.splice(i, 1)[0], { slot }));
  });
  leftovers.forEach((slot) => {
    if (free.length) stalls.push(Object.assign({}, free.shift(), { slot }));
  });
  if (stalls.length < slots.length) return null;
  return { stalls, empty: free };
}

/* ------------------------------------------------------------------ Science: one drive-in lane to the labs */
function science() {
  const s = scene(640, 260);
  // the lab block along the right edge, its doors facing the lane, behind a planted strip
  s.building(556, 14, 74, 232, 'left', 'Science Complex', 'Laboratories');
  s.rect('pavers', 540, 14, 16, 232);
  [[20, 92], [148, 92]].forEach(([y, h]) => s.rect('bed', 543, y, 9, h, 3));
  s.rect('asphalt', 14, 44, 526, 168, 6);
  // the entry road up from the gate on the bottom left, two-way
  s.rect('asphalt', 14, 200, 44, 60);
  s.line('dash', 36, 160, 36, 250);
  s.arrow(26, 222, 0);
  s.arrow(46, 182, 180);
  s.gate(14, 256, 44);
  s.text('paint', 36, 246, 'IN / OUT');
  // the lane: in towards the labs on the top half, back out on the bottom half
  s.line('dash', 70, 128, 466, 128);
  [150, 330].forEach((x) => s.arrow(x, 115, 90));
  [240, 420].forEach((x) => s.arrow(x, 141, -90));
  // a row of fifteen on each side, numbered from the lab end; the accessible pair has a hatched access aisle
  s.rect('access', 428, 48, 18, 52);
  s.stall(459, 74, 0);
  s.stall(415, 74, 0);
  for (let i = 0; i < 13; i += 1) s.stall(389 - i * 26, 74, 0);
  for (let i = 0; i < 15; i += 1) s.stall(459 - i * 26, 182, 180);
  // turnaround around a tree island at the lab end
  s.circle('islandc', 506, 128, 14);
  s.tree(506, 128, 9);
  s.arrow(532, 128, 180);
  // covered motorcycle bays in the two corners of the turnaround, beside the entrance
  for (let i = 0; i < 4; i += 1) s.stall(485 + i * 14, 61, 0, 'moto');
  for (let i = 0; i < 4; i += 1) s.stall(485 + i * 14, 195, 180, 'moto');
  s.rect('shelter', 478, 46, 56, 30, 2);
  s.rect('shelter', 478, 180, 56, 30, 2);
  // landscaping and lights
  for (let x = 140; x < 540; x += 50) s.tree(x, 18 + ((x / 50) % 2) * 6, 10);
  for (let x = 90; x < 540; x += 50) s.tree(x, 240 - ((x / 50) % 2) * 6, 10);
  [[20, 26], [70, 16], [636, 10], [636, 250]].forEach(([x, y]) => s.tree(x, y, 8));
  [120, 260, 400].forEach((x) => s.lamp(x, 38));
  [120, 260, 400].forEach((x) => s.lamp(x, 218));
  return s;
}

/* ------------------------------------------------------------------ Engineering: herringbone lane, side bay, workshops */
function engineering() {
  const s = scene(566, 274, 'grass');
  s.building(12, 12, 72, 250, 'right', 'Engineering', 'Workshops');
  s.rect('pavers', 84, 12, 10, 262);
  s.rect('concrete', 94, 22, 402, 180, 6);
  s.rect('concrete', 94, 196, 40, 78);
  s.rect('concrete', 454, 196, 42, 78);
  s.rect('bed', 134, 14, 320, 8);
  s.rect('bed', 134, 194, 320, 8);
  // one-way: in on the left, along the angled lane, out on the right
  s.arrow(114, 236, 0);
  s.arrow(114, 140, 0);
  [200, 300, 400].forEach((x) => s.arrow(x, 108, 90));
  s.arrow(475, 140, 180);
  s.arrow(475, 230, 180);
  s.gate(94, 270, 40);
  s.gate(454, 270, 42);
  s.text('paint', 114, 262, 'ENTER');
  s.text('paint', 475, 262, 'EXIT');
  // angled stalls on both sides of the lane, leaning with the traffic
  for (let i = 0; i < 10; i += 1) s.stall(159 + i * 30, 51, 30);
  for (let i = 0; i < 10; i += 1) s.stall(159 + i * 30, 165, 150);
  // side bay of covered motorcycle bays, opening onto the exit road, with a planted strip behind
  s.rect('concrete', 496, 30, 54, 170, 4);
  for (let i = 0; i < 10; i += 1) s.stall(509, 52 + i * 14, 90, 'moto');
  s.rect('shelter', 497, 42, 28, 146, 2);
  s.rect('bed', 530, 40, 14, 150, 3);
  // break area and trees
  s.tree(150, 240, 11);
  [[220, 236], [290, 236], [360, 236]].forEach(([x, y]) => s.bench(x, y));
  [186, 256, 326, 396, 432].forEach((x) => s.tree(x, x % 2 ? 254 : 218, 12));
  [160, 230, 300, 370, 440].forEach((x) => s.tree(x, 7, 7));
  [176, 296, 416].forEach((x) => s.lamp(x, 198));
  [176, 296, 416].forEach((x) => s.lamp(x, 18));
  s.tree(557, 10, 7);
  s.tree(557, 230, 8);
  // a planted strip along the top, under the zone card
  shift(s, 0, 40);
  s.rect('lawn', 0, 0, s.width, 40);
  [250, 320, 390, 460, 530].forEach((x, i) => s.tree(x, 18 + (i % 2) * 6, 11));
  return s;
}

/* ------------------------------------------------------------------ Administration: drop-off circle, visitor bays */
function administration() {
  const s = scene(420, 300);
  s.building(150, 6, 262, 74, 'bottom', 'Administration', 'Visitors welcome');
  s.rect('pavers', 140, 80, 280, 14);
  s.rect('lawn', 0, 0, 140, 104);
  s.circle('flagbase', 70, 50, 6);
  s.circle('flag', 70, 50, 2.2);
  [[24, 22], [116, 24], [30, 86], [112, 84]].forEach(([x, y]) => s.tree(x, y, 12));
  // drive (two-way) from the left edge to the circle
  s.rect('asphalt', 0, 148, 318, 42);
  s.line('yline', 6, 169, 312, 169);
  s.text('paint', 26, 184, 'IN');
  s.text('paint', 26, 160, 'OUT');
  s.arrow(70, 180, 90);
  s.arrow(70, 158, -90);
  // drop-off circle with a fountain, and the lane up to the portico
  s.rect('asphalt', 344, 92, 40, 40);
  s.rect('asphalt', 318, 196, 92, 60, 4);
  s.circle('asphaltc', 364, 170, 50);
  s.circle('islandc', 364, 170, 24);
  s.fountain(364, 170, 14);
  s.rect('portico', 330, 80, 68, 16, 2);
  s.text('paint', 364, 116, 'DROP-OFF');
  s.arrow(364, 214, 90);
  s.arrow(410, 170, 0);
  // accessible pair by the entrance, with a hatched access aisle between them
  s.rect('asphalt', 226, 94, 78, 54);
  s.rect('access', 256, 96, 18, 52);
  s.stall(243, 122, 0);
  s.stall(287, 122, 0);
  // parallel visitor bays along the drive
  s.rect('asphalt', 10, 124, 214, 24);
  [44, 112, 180].forEach((x) => s.stall(x, 136, 90, 'parallel'));
  // the visitor row
  for (let i = 0; i < 11; i += 1) s.stall(37 + i * 26, 216, 180);
  s.rect('asphalt', 24, 190, 286, 52);
  s.rect('curb', 24, 242, 290, 6);
  // covered motorcycle bays below the circle, opening up onto it
  for (let i = 0; i < 6; i += 1) s.stall(329 + i * 14, 240, 180, 'moto');
  s.rect('shelter', 320, 228, 88, 26, 2);
  // lawn, benches and lights
  [40, 110, 180, 250].forEach((x) => s.tree(x, 272, 12));
  [76, 146, 216].forEach((x) => s.bench(x, 270));
  [60, 160, 260].forEach((x) => s.lamp(x, 246));
  [[318, 120], [410, 120], [314, 262], [414, 262]].forEach(([x, y]) => s.lamp(x, y));
  [[300, 278], [364, 284], [410, 284]].forEach(([x, y]) => s.tree(x, y, 12));
  return s;
}

/* ------------------------------------------------------------------ Main Building: four covered blocks below the lobby */
function mainBuilding() {
  const s = scene(652, 462);
  // the lobby along the top, its doors on the walkway that runs down between the blocks
  s.rect('lawn', 0, 0, 652, 78);
  s.building(120, 8, 412, 56, 'bottom', 'Main Building', 'Lobby');
  s.rect('pavers', 14, 64, 624, 14);
  s.rect('asphalt', 14, 80, 624, 368, 8);
  // one loop, clockwise: two-way entry road on the left, top aisle, right road, bottom aisle; the middle aisle runs left
  s.line('dash', 36, 100, 36, 430);
  [200, 380].forEach((y) => s.arrow(26, y, 0));
  [140, 320].forEach((y) => s.arrow(46, y, 180));
  [130, 230, 420, 520].forEach((x) => s.arrow(x, 105, 90));
  [180, 340].forEach((y) => s.arrow(616, y, 180));
  [130, 230, 420, 520].forEach((x) => s.arrow(x, 421, -90));
  [175, 475].forEach((x) => s.arrow(x, 262, -90));
  s.gate(14, 446, 44);
  s.text('paint', 36, 438, 'IN / OUT');
  // a 2 x 2 grid of double rows of nine, numbered outward from the walkway: top left, top right, bottom left, bottom
  // right; in each, the first row opens up and the second down
  [130, 290].forEach((y) => {
    [[287, -26], [365, 26]].forEach(([x0, step]) => {
      for (let i = 0; i < 9; i += 1) s.stall(x0 + i * step, y + 26, 180);
      for (let i = 0; i < 9; i += 1) s.stall(x0 + i * step, y + 78, 0);
    });
  });
  // solar canopies over each block
  [130, 290].forEach((y) => [62, 348].forEach((x) => s.canopy(x, y + 2, 242, 100, y + 52)));
  // the planted walkway between the blocks, with crossings over the aisles up to the lobby doors
  [134, 294].forEach((y) => s.rect('island', 306, y, 40, 96, 6));
  s.zebra(306, 82, 40, 46, 'y');
  s.zebra(306, 236, 40, 52, 'y');
  // landscaping and lights
  [[20, 22], [60, 50], [96, 18], [556, 20], [596, 46], [634, 16]].forEach(([x, y]) => s.tree(x, y, 10));
  [110, 190, 270, 350, 430].forEach((y) => s.tree(6, y, 6));
  [110, 190, 270, 350, 430].forEach((y) => s.tree(646, y, 6));
  [100, 200, 300, 400, 500, 600].forEach((x) => s.tree(x, 456, 6));
  [120, 230, 420, 530].forEach((x) => s.lamp(x, 262));
  return s;
}

/* ------------------------------------------------------------------ Motorcycle Parking: 80 angled bays on two lanes */
function motorcycles() {
  const s = scene(490, 340);
  // the Student Center along the bottom, between the entry and exit roads
  s.building(70, 284, 350, 50, 'top', 'Student Center', 'Helmet lockers');
  s.rect('pavers', 60, 272, 370, 12);
  s.rect('asphalt', 14, 44, 460, 228, 6);
  s.rect('asphalt', 14, 260, 44, 80);
  s.rect('asphalt', 430, 260, 44, 80);
  // one way through: in on the left road, along either lane, out on the right road
  [[36, 300], [36, 170]].forEach(([x, y]) => s.arrow(x, y, 0));
  [[452, 170], [452, 300]].forEach(([x, y]) => s.arrow(x, y, 180));
  [95, 221].forEach((y) => [160, 340].forEach((x) => s.arrow(x, y, 90)));
  s.gate(14, 336, 44);
  s.gate(430, 336, 44);
  s.text('paint', 36, 326, 'IN');
  s.text('paint', 452, 326, 'OUT');
  // two lanes, each lined on both sides with angled bays leaning with the traffic: rows of twenty, split by the
  // walkway; numbered along the top lane (top side, then bottom side), then the bottom lane
  [[62, 30], [128, 150], [188, 30], [254, 150]].forEach(([cy, rot]) => {
    for (let i = 0; i < 10; i += 1) s.stall(84 + i * 16, cy, rot, 'moto');
    for (let i = 0; i < 10; i += 1) s.stall(268 + i * 16, cy, rot, 'moto');
  });
  // light roofs over each run of bays
  [47, 113, 173, 239].forEach((y) => [[71, 170], [255, 170]].forEach(([x, w]) => s.rect('shelter', x, y, w, 30, 2)));
  // the planted median between the lanes, and the walkway from it down to the Student Center
  s.rect('island', 72, 147, 352, 22, 8);
  s.rect('pavers', 238, 239, 20, 33);
  s.zebra(236, 204, 24, 34, 'y');
  [160, 336].forEach((x) => s.lamp(x, 158));
  // landscaping
  for (let x = 130; x < 480; x += 45) s.tree(x, 18 + ((x / 45) % 2) * 6, 10);
  [[22, 30], [70, 20]].forEach(([x, y]) => s.tree(x, y, 8));
  [[64, 300], [426, 300]].forEach(([x, y]) => s.tree(x, y, 6));
  [[482, 120], [482, 220], [6, 120], [6, 220]].forEach(([x, y]) => s.tree(x, y, 6));
  return s;
}

/* ------------------------------------------------------------------ any other zone */
function generic(zone, count) {
  const cols = Math.max(1, Math.min(count || 1, (zone && zone.map_columns) || 6));
  const rows = Math.max(1, Math.ceil(count / cols));
  const pairs = Math.ceil(rows / 2);
  const lotW = cols * CAR.w;
  const width = 12 + 40 + lotW + 40 + 12;
  const height = 12 + 40 + pairs * (CAR.h * 2 + 56) + (pairs - 1) * 16 + 40 + 12;
  const s = scene(width, height);
  s.rect('asphalt', 12, 12, width - 24, height - 24, 6);
  s.gate(12, height - 12, 40);
  let y = 52;
  for (let p = 0; p < pairs; p += 1) {
    if (p > 0) {
      s.rect('island', 52, y, lotW, 16, 8);
      for (let x = 52 + 13; x < 52 + lotW; x += 52) s.tree(x, y + 8, 9);
      y += 16;
    }
    for (let c = 0; c < cols; c += 1) s.stall(52 + 13 + c * 26, y + 26, 0);
    for (let c = 0; c < cols; c += 1) s.stall(52 + 13 + c * 26, y + 52 + 56 + 26, 180);
    [0.3, 0.7].forEach((f) => s.arrow(52 + lotW * f, y + 52 + 28, 90));
    y += CAR.h * 2 + 56;
  }
  s.arrow(32, height / 2, 0);
  s.arrow(width - 32, height / 2, 180);
  for (let x = 30; x < width; x += 40) s.tree(x, 6, 6);
  return s;
}

const SCENES = { SC: science, EN: engineering, AD: administration, MB: mainBuilding, MC: motorcycles };

function build(zone, slots) {
  const code = zone && String(zone.code || '').toUpperCase();
  let s = SCENES[code] ? SCENES[code]() : null;
  let placed = s && allocate(s, slots);
  if (!placed) {
    s = generic(zone, slots.length);
    placed = allocate(s, slots);
  }
  s.stalls = placed.stalls;
  s.empty = placed.empty;
  return s;
}

/** Inline style for a stall button: its unrotated box in percentages of the scene, plus the rotation. */
function stallStyle(s, p) {
  const f = (v, of) => `${((v / of) * 100).toFixed(4)}%`;
  return `left:${f(p.cx - p.w / 2, s.width)};top:${f(p.cy - p.h / 2, s.height)};width:${f(p.w, s.width)};height:${f(p.h, s.height)};--rot:${p.rot}deg`;
}

/** Short description for the zone card: "40 slots · Car, Motorcycle". */
function summary(slots) {
  const kinds = [];
  if (slots.some((s) => s.slot_type !== 'motorcycle')) kinds.push('Car');
  if (slots.some((s) => s.slot_type === 'motorcycle')) kinds.push('Motorcycle');
  return `${slots.length} slot${slots.length === 1 ? '' : 's'}${kinds.length ? ` · ${kinds.join(', ')}` : ''}`;
}

module.exports = { build, stallStyle, summary, SCENES: Object.keys(SCENES) };
