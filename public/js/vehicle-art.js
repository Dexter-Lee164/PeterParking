/*
 * Top-down vehicle drawings for the Find Parking lot map (window.UPVehicle).
 *  - styleOf(vehicle)   body style from vehicle_type and model: sedan | hatchback | suv | mpv | pickup | van | motorcycle
 *  - colorOf(vehicle)   paint colour from the free-text colour ("Pearl White", "Gray", "#3366cc", ...)
 *  - svg(vehicle)       an <svg> string, front at the top, drawn in centimetres at the style's real size
 *  - size(vehicle)      { w, l } in centimetres, used to scale the drawing to its stall
 *  - side(vehicle)      a side-profile <svg> string for the "Your Vehicle" card
 * Gloss and glass use the shared gradients in views/partials/lot-defs.ejs (#up-sheen, #up-glass, ...).
 */
(function () {
  'use strict';

  // Real-world footprints (cm) and where each part ends, as a fraction of the length from the front.
  var STYLES = {
    sedan: { w: 176, l: 445, hood: 0.3, glass: 0.42, roof: 0.66, rear: 0.78 },
    hatchback: { w: 170, l: 390, hood: 0.27, glass: 0.4, roof: 0.78, rear: 0.89 },
    suv: { w: 186, l: 465, hood: 0.26, glass: 0.36, roof: 0.84, rear: 0.92, rails: true },
    mpv: { w: 178, l: 450, hood: 0.22, glass: 0.35, roof: 0.86, rear: 0.93 },
    pickup: { w: 186, l: 510, hood: 0.24, glass: 0.33, roof: 0.5, rear: 0.54, bed: true },
    van: { w: 190, l: 500, hood: 0.1, glass: 0.2, roof: 0.97, rear: 0.97, ribs: true },
    motorcycle: { w: 78, l: 205 },
  };

  var MODELS = [
    ['pickup', /hilux|ranger|navara|strada|d-?max|triton|tacoma|frontier|colorado|tundra|f-?150|bt-?50|gladiator/],
    ['van', /hiace|urvan|starex|l300|grandia|transit|sprinter|staria|carry|kombi|nv350|alphard/],
    ['mpv', /xpander|innova|avanza|ertiga|stargazer|veloz|br-?v|livina|carnival|odyssey|sienna|rush|apv|xl7|traviz|carens/],
    ['suv', /fortuner|montero|everest|cr-?v|rav ?4|terra|territory|tucson|raize|seltos|sportage|x-?trail|santa ?fe|cx-?\d|hr-?v|coolray|creta|kona|land ?cruiser|prado|pajero|trailblazer|forester|outlander|tiggo|jimny|ecosport|venue|stonic|kicks/],
    ['hatchback', /wigo|jazz|brio|mirage(?! g4)|swift|picanto|celerio|spark|yaris|march|i10|s-?presso|fit|polo|golf|rio|mazda ?2|note|agya|ayla/],
    ['sedan', /vios|city|dzire|civic|corolla|altis|accent|almera|mirage g4|elantra|camry|sentra|mazda ?3|lancer|sonata|accord|cerato|soluna|ciaz|genesis|model 3/],
  ];

  var COLORS = [
    [/pearl|white|puti/, '#eef1f4'],
    [/silver|chrome|platinum/, '#bfc5ce'],
    [/charcoal|graphite|gunmetal/, '#4a5059'],
    [/gr[ae]y|titanium/, '#7c8592'],
    [/black|itim|onyx/, '#1c1f25'],
    [/maroon|burgundy|wine/, '#7a1f2c'],
    [/red|pula|crimson/, '#c62a2a'],
    [/orange/, '#e2742a'],
    [/yellow|dilaw/, '#e9bd2c'],
    [/gold|champagne/, '#c7a457'],
    [/beige|cream|sand/, '#d8c7a4'],
    [/brown|bronze|copper/, '#73523a'],
    [/green|berde|olive/, '#2f7d4a'],
    [/teal|turquoise|cyan/, '#1f8f93'],
    [/navy/, '#1e2c55'],
    [/blue|asul/, '#2559c7'],
    [/purple|violet/, '#6b46a8'],
    [/pink/, '#d86b98'],
  ];
  var FALLBACK = '#9aa3ae';

  function styleOf(v) {
    if (!v) return 'sedan';
    if (v.vehicle_type === 'motorcycle') return 'motorcycle';
    var text = ((v.make || '') + ' ' + (v.model || '')).toLowerCase();
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i][1].test(text)) return MODELS[i][0];
    return v.vehicle_type === 'van' ? 'van' : 'sedan';
  }

  function colorOf(v) {
    var raw = String((v && v.color) || '').trim();
    var text = raw.toLowerCase();
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(text)) return text;
    for (var i = 0; i < COLORS.length; i++) if (COLORS[i][0].test(text)) return COLORS[i][1];
    if (raw && window.CSS && CSS.supports && CSS.supports('color', raw)) return raw.replace(/[^a-z0-9#(),.% -]/gi, '');
    return FALLBACK;
  }

  // Mix a #rrggbb colour toward white (amount > 0) or black (amount < 0). Non-hex colours are returned unchanged.
  function shade(hex, amount) {
    var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex);
    if (!m) return hex;
    var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    var target = amount > 0 ? 255 : 0;
    var a = Math.abs(amount);
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var c = parseInt(h.substr(i * 2, 2), 16);
      var v = Math.round(c + (target - c) * a);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  function size(v) {
    var s = STYLES[styleOf(v)];
    return { w: s.w, l: s.l };
  }

  function trapezoid(W, y1, y2, front, back) {
    var a = (W - W * front) / 2;
    var b = (W - W * back) / 2;
    return 'M' + a + ',' + y1 + ' L' + (W - a) + ',' + y1 + ' L' + (W - b) + ',' + y2 + ' L' + b + ',' + y2 + ' Z';
  }

  function car(style, paint) {
    var s = STYLES[style];
    var W = s.w;
    var L = s.l;
    var dark = shade(paint, -0.3);
    var deep = shade(paint, -0.5);
    var light = shade(paint, 0.3);
    var y = function (f) { return Math.round(L * f); };
    var x = function (f) { return (W * f).toFixed(1); };
    // Body outline: rounded nose and tail, slightly narrower at the bumpers than at the doors.
    var body = 'M' + x(0.2) + ',' + y(0.012) + ' Q' + x(0.5) + ',' + y(-0.008) + ' ' + x(0.8) + ',' + y(0.012)
      + ' Q' + x(0.97) + ',' + y(0.03) + ' ' + x(0.985) + ',' + y(0.13) + ' L' + x(1) + ',' + y(0.5) + ' L' + x(0.985) + ',' + y(0.88)
      + ' Q' + x(0.97) + ',' + y(0.975) + ' ' + x(0.8) + ',' + y(0.99) + ' Q' + x(0.5) + ',' + y(1.005) + ' ' + x(0.2) + ',' + y(0.99)
      + ' Q' + x(0.03) + ',' + y(0.975) + ' ' + x(0.015) + ',' + y(0.88) + ' L' + x(0) + ',' + y(0.5) + ' L' + x(0.015) + ',' + y(0.13)
      + ' Q' + x(0.03) + ',' + y(0.03) + ' ' + x(0.2) + ',' + y(0.012) + ' Z';
    // Glass: curved windscreen and rear window; the cabin (roof) sits between them.
    var curve = function (y1, y2, w1, w2, bulge) {
      var a1 = (1 - w1) / 2;
      var a2 = (1 - w2) / 2;
      return 'M' + x(a1) + ',' + y1 + ' Q' + x(0.5) + ',' + (y1 - bulge) + ' ' + x(1 - a1) + ',' + y1
        + ' L' + x(1 - a2) + ',' + y2 + ' Q' + x(0.5) + ',' + (y2 - bulge * 0.6) + ' ' + x(a2) + ',' + y2 + ' Z';
    };
    var parts = [];
    parts.push('<ellipse cx="' + x(0.5) + '" cy="' + y(0.52) + '" rx="' + x(0.56) + '" ry="' + y(0.52) + '" fill="#000" opacity=".55" filter="url(#up-soft)"/>');
    [0.19, 0.8].forEach(function (f) {
      parts.push('<rect x="-4" y="' + (y(f) - 32) + '" width="20" height="64" rx="8" fill="#0b0d10"/>');
      parts.push('<rect x="' + (W - 16) + '" y="' + (y(f) - 32) + '" width="20" height="64" rx="8" fill="#0b0d10"/>');
    });
    parts.push('<path d="' + body + '" fill="' + paint + '" stroke="' + deep + '" stroke-width="3"/>');
    parts.push('<path d="' + body + '" fill="url(#up-sheen)"/>');
    // hood creases and a long gloss streak
    parts.push('<path d="M' + x(0.3) + ',' + y(0.03) + ' Q' + x(0.27) + ',' + y(s.hood * 0.6) + ' ' + x(0.24) + ',' + y(s.hood) + '" fill="none" stroke="' + dark + '" stroke-width="2.5" opacity=".6"/>');
    parts.push('<path d="M' + x(0.7) + ',' + y(0.03) + ' Q' + x(0.73) + ',' + y(s.hood * 0.6) + ' ' + x(0.76) + ',' + y(s.hood) + '" fill="none" stroke="' + dark + '" stroke-width="2.5" opacity=".6"/>');
    parts.push('<rect x="' + x(0.42) + '" y="' + y(0.03) + '" width="' + x(0.09) + '" height="' + (y(s.hood) - y(0.05)) + '" rx="8" fill="#fff" opacity=".22"/>');
    // glass
    parts.push('<path d="' + curve(y(s.hood), y(s.glass), 0.8, 0.68, L * 0.03) + '" fill="url(#up-glass)" stroke="' + deep + '" stroke-width="2"/>');
    parts.push('<path d="M' + x(0.22) + ',' + (y(s.hood) + 6) + ' L' + x(0.4) + ',' + (y(s.hood) + 4) + ' L' + x(0.3) + ',' + (y(s.glass) - 6) + ' Z" fill="#fff" opacity=".12"/>');
    if (s.rear > s.roof) parts.push('<path d="' + curve(y(s.roof), y(s.rear), 0.68, 0.74, -L * 0.02) + '" fill="url(#up-glass)" stroke="' + deep + '" stroke-width="2"/>');
    // side windows, visible past the roof edge
    parts.push('<path d="M' + x(0.1) + ',' + y(s.glass) + ' L' + x(0.17) + ',' + y(s.glass) + ' L' + x(0.17) + ',' + y(s.roof) + ' L' + x(0.1) + ',' + y(s.roof - 0.02) + ' Z" fill="url(#up-glass)"/>');
    parts.push('<path d="M' + x(0.9) + ',' + y(s.glass) + ' L' + x(0.83) + ',' + y(s.glass) + ' L' + x(0.83) + ',' + y(s.roof) + ' L' + x(0.9) + ',' + y(s.roof - 0.02) + ' Z" fill="url(#up-glass)"/>');
    // roof panel with its own sheen
    parts.push('<rect x="' + x(0.17) + '" y="' + y(s.glass) + '" width="' + x(0.66) + '" height="' + (y(s.roof) - y(s.glass)) + '" rx="' + W * 0.12 + '" fill="' + light + '"/>');
    parts.push('<rect x="' + x(0.17) + '" y="' + y(s.glass) + '" width="' + x(0.66) + '" height="' + (y(s.roof) - y(s.glass)) + '" rx="' + W * 0.12 + '" fill="url(#up-sheen)"/>');
    if (s.rails) {
      parts.push('<rect x="' + x(0.22) + '" y="' + (y(s.glass) + 8) + '" width="5" height="' + (y(s.roof) - y(s.glass) - 16) + '" rx="2" fill="' + deep + '"/>');
      parts.push('<rect x="' + (W * 0.78 - 5) + '" y="' + (y(s.glass) + 8) + '" width="5" height="' + (y(s.roof) - y(s.glass) - 16) + '" rx="2" fill="' + deep + '"/>');
    }
    if (s.ribs) {
      for (var r = 0; r < 5; r++) {
        parts.push('<rect x="' + x(0.24) + '" y="' + y(s.glass + 0.1 + r * 0.14) + '" width="' + x(0.52) + '" height="4" rx="2" fill="' + dark + '" opacity=".5"/>');
      }
    }
    if (s.bed) {
      parts.push('<rect x="' + x(0.1) + '" y="' + y(0.56) + '" width="' + x(0.8) + '" height="' + (y(0.975) - y(0.56)) + '" rx="8" fill="' + deep + '"/>');
      parts.push('<rect x="' + x(0.16) + '" y="' + y(0.59) + '" width="' + x(0.68) + '" height="' + (y(0.95) - y(0.59)) + '" rx="4" fill="#1b1f25"/>');
      for (var k = 0; k < 4; k++) parts.push('<rect x="' + x(0.16) + '" y="' + y(0.63 + k * 0.08) + '" width="' + x(0.68) + '" height="2" fill="#2b3038"/>');
    }
    // mirrors, lights
    parts.push('<path d="M' + x(0.02) + ',' + (y(s.hood) + 4) + ' l-12,4 l1,10 l12,-2 Z" fill="' + dark + '"/>');
    parts.push('<path d="M' + x(0.98) + ',' + (y(s.hood) + 4) + ' l12,4 l-1,10 l-12,-2 Z" fill="' + dark + '"/>');
    parts.push('<path d="M' + x(0.12) + ',' + y(0.03) + ' Q' + x(0.2) + ',' + y(0.012) + ' ' + x(0.32) + ',' + y(0.015) + ' L' + x(0.3) + ',' + y(0.04) + ' Z" fill="#fff8d9"/>');
    parts.push('<path d="M' + x(0.88) + ',' + y(0.03) + ' Q' + x(0.8) + ',' + y(0.012) + ' ' + x(0.68) + ',' + y(0.015) + ' L' + x(0.7) + ',' + y(0.04) + ' Z" fill="#fff8d9"/>');
    parts.push('<rect x="' + x(0.1) + '" y="' + y(0.968) + '" width="' + x(0.22) + '" height="' + y(0.016) + '" rx="3" fill="#e0312f"/>');
    parts.push('<rect x="' + x(0.68) + '" y="' + y(0.968) + '" width="' + x(0.22) + '" height="' + y(0.016) + '" rx="3" fill="#e0312f"/>');
    return { W: W, L: L, body: parts.join('') };
  }

  function motorcycle(paint) {
    var W = STYLES.motorcycle.w;
    var L = STYLES.motorcycle.l;
    var dark = shade(paint, -0.3);
    var parts = [
      '<ellipse cx="' + W / 2 + '" cy="' + L / 2 + '" rx="' + W * 0.42 + '" ry="' + L * 0.48 + '" fill="#000" opacity=".3"/>',
      '<rect x="' + (W / 2 - 9) + '" y="0" width="18" height="52" rx="9" fill="#0d0f13"/>',
      '<rect x="' + (W / 2 - 10) + '" y="' + (L - 54) + '" width="20" height="54" rx="10" fill="#0d0f13"/>',
      '<rect x="2" y="44" width="' + (W - 4) + '" height="7" rx="3.5" fill="#2a2f37"/>',
      '<circle cx="4" cy="47" r="5" fill="#2a2f37"/><circle cx="' + (W - 4) + '" cy="47" r="5" fill="#2a2f37"/>',
      '<path d="M' + W / 2 + ',30 C' + (W - 6) + ',48 ' + (W - 8) + ',150 ' + W / 2 + ',176 C8,150 6,48 ' + W / 2 + ',30 Z" fill="' + paint + '" stroke="' + dark + '" stroke-width="3"/>',
      '<rect x="' + (W / 2 - 16) + '" y="96" width="32" height="64" rx="14" fill="#1b1e24"/>',
      '<rect x="' + (W / 2 - 10) + '" y="58" width="20" height="26" rx="8" fill="#16202e"/>',
      '<rect x="' + (W / 2 - 8) + '" y="30" width="16" height="7" rx="3" fill="#fff6c8"/>',
      '<rect x="' + (W / 2 - 7) + '" y="170" width="14" height="6" rx="3" fill="#e0312f"/>',
    ];
    return { W: W, L: L, body: parts.join('') };
  }

  function svg(v) {
    var style = styleOf(v);
    var paint = colorOf(v);
    var art = style === 'motorcycle' ? motorcycle(paint) : car(style, paint);
    return '<svg class="vehicle-svg" viewBox="-12 -4 ' + (art.W + 24) + ' ' + (art.L + 8) + '" preserveAspectRatio="none" focusable="false" aria-hidden="true">' + art.body + '</svg>';
  }

  /** A believable stand-in for someone else's parked vehicle, stable per slot. */
  var PARKED_STYLES = ['sedan', 'hatchback', 'suv', 'mpv', 'sedan', 'pickup'];
  var PARKED_COLORS = ['White', 'Silver', 'Black', 'Gray', 'Red', 'Blue', 'Pearl White', 'Charcoal'];
  var PARKED_MODELS = { sedan: 'Vios', hatchback: 'Wigo', suv: 'Fortuner', mpv: 'Innova', pickup: 'Hilux' };
  function parked(seed, slotType) {
    var n = Math.abs(parseInt(seed, 10) || 0) * 2654435761 % 4294967296;
    if (slotType === 'motorcycle') return { vehicle_type: 'motorcycle', model: '', color: PARKED_COLORS[n % PARKED_COLORS.length] };
    var style = PARKED_STYLES[n % PARKED_STYLES.length];
    return { vehicle_type: 'car', model: PARKED_MODELS[style], color: PARKED_COLORS[(n >>> 3) % PARKED_COLORS.length] };
  }

  /* ---------------------------------------------------------------- side profile */
  // Outline points as fractions of length (rear 0 -> front 1) and height (roof 0 -> ground 1).
  var PROFILES = {
    sedan: { l: 445, h: 147, body: [[0.01, 0.72], [0.02, 0.5], [0.06, 0.44], [0.24, 0.41], [0.36, 0.13], [0.43, 0.08], [0.6, 0.08], [0.7, 0.37], [0.9, 0.44], [0.985, 0.52], [0.995, 0.72]], glass: [[0.27, 0.41], [0.38, 0.16], [0.6, 0.15], [0.68, 0.4]], pillar: 0.52 },
    hatchback: { l: 390, h: 150, body: [[0.01, 0.72], [0.015, 0.4], [0.06, 0.14], [0.14, 0.07], [0.58, 0.07], [0.7, 0.36], [0.9, 0.44], [0.985, 0.52], [0.995, 0.72]], glass: [[0.06, 0.38], [0.13, 0.15], [0.57, 0.14], [0.67, 0.39]], pillar: 0.4 },
    suv: { l: 465, h: 180, body: [[0.01, 0.74], [0.015, 0.2], [0.05, 0.06], [0.62, 0.05], [0.74, 0.34], [0.95, 0.4], [0.995, 0.5], [0.995, 0.74]], glass: [[0.05, 0.36], [0.07, 0.12], [0.6, 0.11], [0.71, 0.36]], pillar: 0.36 },
    mpv: { l: 450, h: 170, body: [[0.01, 0.73], [0.015, 0.22], [0.05, 0.07], [0.64, 0.06], [0.8, 0.36], [0.96, 0.43], [0.995, 0.52], [0.995, 0.73]], glass: [[0.05, 0.38], [0.07, 0.13], [0.62, 0.12], [0.76, 0.38]], pillar: 0.4 },
    pickup: { l: 510, h: 180, body: [[0.01, 0.74], [0.01, 0.42], [0.45, 0.42], [0.46, 0.08], [0.66, 0.07], [0.76, 0.36], [0.96, 0.42], [0.995, 0.5], [0.995, 0.74]], glass: [[0.48, 0.38], [0.49, 0.13], [0.65, 0.12], [0.73, 0.37]], pillar: 0.58 },
    van: { l: 500, h: 210, body: [[0.01, 0.76], [0.01, 0.06], [0.82, 0.04], [0.92, 0.36], [0.99, 0.46], [0.995, 0.76]], glass: [[0.05, 0.36], [0.06, 0.12], [0.8, 0.1], [0.89, 0.36]], pillar: 0.62 },
  };
  var poly = function (pts, L, H) { return pts.map(function (p) { return (p[0] * L).toFixed(1) + ',' + (p[1] * H).toFixed(1); }).join(' '); };

  function side(v) {
    var style = styleOf(v);
    var paint = colorOf(v);
    var dark = shade(paint, -0.35);
    if (style === 'motorcycle') {
      return '<svg viewBox="-10 -10 230 140" class="vehicle-side" aria-hidden="true" focusable="false">'
        + '<ellipse cx="105" cy="122" rx="100" ry="6" fill="#000" opacity=".35"/>'
        + '<circle cx="40" cy="92" r="28" fill="#111"/><circle cx="40" cy="92" r="15" fill="url(#up-rim)"/>'
        + '<circle cx="172" cy="92" r="28" fill="#111"/><circle cx="172" cy="92" r="15" fill="url(#up-rim)"/>'
        + '<path d="M40,92 L92,70 L150,72 L172,92" fill="none" stroke="#3a3f47" stroke-width="7" stroke-linecap="round"/>'
        + '<path d="M70,62 C80,40 128,36 150,46 L162,70 L84,74 Z" fill="' + paint + '" stroke="' + dark + '" stroke-width="3"/>'
        + '<path d="M70,62 C80,40 128,36 150,46 L162,70 L84,74 Z" fill="url(#up-sheen-side)"/>'
        + '<path d="M58,52 L104,48 L100,58 L60,62 Z" fill="#1b1e24"/>'
        + '<path d="M150,46 L168,22 L176,24" fill="none" stroke="#2a2f37" stroke-width="5" stroke-linecap="round"/>'
        + '<circle cx="178" cy="50" r="5" fill="#fff6c8"/></svg>';
    }
    var p = PROFILES[style];
    var L = p.l;
    var H = p.h;
    var r = H * 0.2;
    var wy = H * 0.76;
    var wheel = function (x) {
      return '<circle cx="' + x + '" cy="' + wy + '" r="' + (r * 1.12).toFixed(1) + '" fill="#0d0f13"/>'
        + '<circle cx="' + x + '" cy="' + wy + '" r="' + (r * 0.62).toFixed(1) + '" fill="url(#up-rim)"/>'
        + '<circle cx="' + x + '" cy="' + wy + '" r="' + (r * 0.16).toFixed(1) + '" fill="#4b5058"/>';
    };
    var arch = function (x) { return '<circle cx="' + x + '" cy="' + wy + '" r="' + (r * 1.3).toFixed(1) + '" fill="' + dark + '"/>'; };
    var rearX = L * 0.19;
    var frontX = L * 0.81;
    var gx = p.pillar * L;
    return '<svg viewBox="' + (-L * 0.03) + ' ' + (-H * 0.05) + ' ' + (L * 1.06) + ' ' + (H * 1.12) + '" class="vehicle-side" aria-hidden="true" focusable="false">'
      + '<ellipse cx="' + L / 2 + '" cy="' + (wy + r * 1.1) + '" rx="' + L * 0.5 + '" ry="' + H * 0.05 + '" fill="#000" opacity=".4"/>'
      + '<polygon points="' + poly(p.body, L, H) + '" fill="' + paint + '" stroke="' + dark + '" stroke-width="' + (H * 0.02) + '" stroke-linejoin="round"/>'
      + '<polygon points="' + poly(p.body, L, H) + '" fill="url(#up-sheen-side)"/>'
      + arch(rearX) + arch(frontX)
      + '<polygon points="' + poly(p.glass, L, H) + '" fill="url(#up-glass)"/>'
      + '<rect x="' + (gx - L * 0.012) + '" y="' + H * 0.08 + '" width="' + L * 0.024 + '" height="' + H * 0.34 + '" fill="' + paint + '"/>'
      + '<line x1="' + L * 0.08 + '" y1="' + H * 0.55 + '" x2="' + L * 0.93 + '" y2="' + H * 0.55 + '" stroke="' + dark + '" stroke-width="' + H * 0.012 + '" opacity=".6"/>'
      + '<rect x="' + (L * 0.955) + '" y="' + H * 0.45 + '" width="' + L * 0.035 + '" height="' + H * 0.06 + '" rx="' + H * 0.02 + '" fill="#fff6c8"/>'
      + '<rect x="' + (L * 0.012) + '" y="' + H * 0.46 + '" width="' + L * 0.03 + '" height="' + H * 0.07 + '" rx="' + H * 0.02 + '" fill="#e0312f"/>'
      + wheel(rearX) + wheel(frontX)
      + '</svg>';
  }

  window.UPVehicle = { styleOf: styleOf, colorOf: colorOf, size: size, svg: svg, side: side, parked: parked };
})();
