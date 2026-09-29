/*
 * glyphbomb engine
 *
 * The effect on its own: a grid of glyphs that reacts to the pointer, with
 * Repel, Attract, Stamp, Rage, Wind and the rest. It has no buttons or
 * panels; each page builds its own UI on top and talks to it through the API
 * returned by Glyphbomb.mount().
 *
 *   const gb = Glyphbomb.mount(element, {
 *     config: { ... },          // overrides for any CONFIG value
 *     keys: window,             // where to listen for shortcuts (false = none)
 *     keysWhen: 'always',       // 'always', or 'hover' (only while the pointer is over it)
 *     wheel: window,            // where scrolling makes wind (false = none)
 *     shakeEls: [],             // extra elements that shake a little on Rage
 *   });
 *
 *   gb.config                   live settings; change a value and it applies next frame
 *   gb.setMode('repulse' | 'attract' | null), gb.toggleMode(name), gb.mode
 *   gb.set('orient' | 'tumble', bool), gb.get(name)
 *   gb.stamp(x, y, { aim }), gb.rage(), gb.reset()
 *   gb.on(event, fn)            events: 'change', 'action' (click, space, esc),
 *                               'shift' (bool), 'scrolling' (bool), 'fps' (number),
 *                               'secret' (the ` key)
 *   gb.resize(), gb.pause(), gb.resume(), gb.destroy()
 */
(function () {
function mount(container, opts = {}) {
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach(fn => fn(data));
  let running = true, rafId = 0, scrolling = false;
  const shakeEls = opts.shakeEls || [];

    // Tunables. Values are CSS pixels.
    const CONFIG = Object.assign({
      spacing: 18,       // distance between grid cells
      minSize: 3.2,      // resting glyph size
      maxSize: 13,       // glyph size directly under the cursor
      shapeSize: 347,    // width of the glyph-shaped influence area, at rest
      // Shape size follows cursor speed: slow movement shrinks it, fast grows it.
      slowScale: 0.3,    // shape scale while moving slowly (70% smaller)
      fastScale: 1.5,    // shape scale at sizeSpeed and above (50% larger)
      sizeSpeed: 2000,   // cursor speed (px/s) that reaches fastScale
      sizeRate: 3,       // how quickly the shape eases to a new size
      inner: 47,         // depth inside the edge over which glyphs grow to full size
      outer: 73,         // distance outside the edge at which influence reaches zero
      rampCurve: 1,      // shape of the size ramp between the two (1 = smooth S-curve)
      anchor: [0.75, 0.25],   // point of the outline under the cursor (0..1, from top left)
      minAlpha: 0.35,
      maxAlpha: 1,
      ease: 0.12,        // cursor smoothing, 0..1 (lower is lazier)
      // Idle: once the pointer has been still (or away) for a while, the giant
      // glyph grows in at its resting size and wanders slowly around the grid.
      // Moving the pointer brings it back.
      idleOn: false,
      idleAfterMs: 1000, // no pointer movement for this long counts as idle
      idleGrowMs: 1400,  // time for the glyph to grow in
      idleSpeed: 0.08,   // wandering speed (lower is slower)
      idleRange: 0.9,    // how far it wanders, as a share of the room that keeps it in view
      returnMs: 600,     // time for a glyph to shrink back once the shape moves off it
      // Rotation: while the cursor moves, every glyph points its top-right
      // tip in the direction of movement, then eases back when it stops.
      turnSpeed: 900,    // cursor speed (px/s) that gives the full turn
      turnRate: 10,      // how quickly glyphs turn to the movement direction
      restRate: 6,       // how quickly glyphs ease back to rest
      stopMs: 40,        // no movement for this long counts as stopped
      // Avoid (Z): while the cursor moves, an arrow (the glyph outline, tip at
      // the cursor, pointing along the movement) pushes glyphs out of its way.
      // They ease back to their grid position once it stops.
      avoidSize: 80,     // width of the arrow
      avoidMargin: 40,   // distance outside the arrow's edge that still pushes
      avoidPush: 60,     // how far glyphs are pushed at the arrow's edge
      avoidRate: 14,     // how quickly glyphs get out of the way
      // Hits: a few glyphs inside the arrow get knocked loose, bounce around the
      // screen, then find their way home.
      hitChance: 0.6,    // share of glyphs the arrow passes through that get knocked loose, at full speed (0 to 0.7)
      maxLoose: 5000,    // most glyphs loose at once (high enough to hold every glyph)
      // Plowing: glyphs pushed aside by the arrow pile up like snow on a plow,
      // growing with how far they've been pushed.
      pushGrow: 2.8,     // extra size at pushGrowDist, 2.8 means 3.8x
      pushGrowDist: 60,  // push distance (px) that reaches the full extra size
      // Collisions between loose glyphs, treated as discs. Only glyphs at a
      // similar height off the page touch, so thrown ones fly over the rest.
      collide: true,
      restitution: 0.6,  // bounciness of glyph-on-glyph hits, 0 to 1
      collideGrip: 0.4,  // how much a glancing hit turns into spin, 0 to 1
      depthGap: 0.35,    // height difference beyond which glyphs pass each other
      // Black hole (V): glyphs near the cursor bend toward it and some get
      // pulled in. Once stuck to it for a moment they break free, fly off and
      // return to their place.
      attractRadius: 400, // reach of the pull
      attractPull: 22,   // how far glyphs in reach lean toward the cursor
      captureChance: 0.96, // share of glyphs at the centre pulled in each second (0 to 1), fading toward the edge of reach
      gravity: 3e7,      // strength of the pull on captured glyphs
      gravitySoft: 24,   // softens the pull right at the cursor
      orbit: 1.05,       // sideways speed on capture, so glyphs swirl in
      attractDrag: 2.5,  // drag while falling in
      stickDist: 28,     // distance at which a glyph counts as stuck
      stuckMs: 3000,     // time stuck before breaking free
      captureMaxMs: 6000, // longest a glyph stays captured, stuck or not
      captureFalloff: 0, // how much capture chance fades toward the edge of reach, 0 = even
      carry: 1,          // how much captured glyphs travel with the cursor, 0 = left behind, 1 = carried along
      escapeSpeed: 1000, // speed of the break-free fling
      escapeFlightMs: 450, // time flying before heading home
      attractCooldown: 250, // time after escaping before a glyph can be caught again
      // Click (stamp): the glyphs around the click assemble into a giant glyph
      // made of glyphs, pressed down like a stamp, and burst apart. A card-flip
      // wave rolls out across the grid where it lands. Every click stamps.
      formSize: 360,     // width of the giant glyph
      formSpacing: 15,   // spacing of the glyphs that make it up
      formAssembleMs: 600, // time to fly in and press down
      formHoldMs: 100,   // time the stamp holds before bursting
      stampDrop: 0.35,   // how much bigger the stamp starts, coming down from above
      burstSpeed: 1100,  // how hard it bursts apart
      waveSpeed: 1100,   // px per second the flip wave travels
      waveWidth: 240,    // thickness of the wave
      wavePush: 16,      // how far glyphs lift outward as it passes
      waveGrow: 1.6,     // how much they swell as it passes
      waveFade: 2600,    // distance over which the wave fades out
      waveGlow: 0.06,    // how much the wave brightens glyphs
      // Motion blur (experimental): moving glyphs are smeared back along their
      // path, and the whole frame can leave fading trails.
      mbOn: true,
      mbShutter: 0.02,   // exposure time in seconds; smear length = speed x this
      mbSamples: 2,      // 2 = one stretched smear; more adds layered smears (slower)
      mbMinSpeed: 210,   // slower than this (px/s) and there's no smear
      mbMaxLen: 210,     // longest smear in px
      mbTail: 0.55,      // opacity of the smear relative to the glyph
      mbTrails: 0.35,    // share of the last frame kept each frame (0 = none)
      // Space: slam the table. Everything jumps, the screen shakes, tiles
      // scatter and tumble, then find their way back.
      slamLift: 1.7,     // how high glyphs jump
      slamScatter: 520,  // how far they scatter sideways
      slamShake: 16,     // screen shake in px
      slamShakeMs: 500,  // how long the shake lasts
      slamFlightMs: 700, // time scattered before heading home
      slamReturn: 2,     // how much faster slammed glyphs fly, fall and return
      // Wind (scroll): scrolling whips up a breeze blowing the way you scroll.
      // Glyphs stay pinned in place, like paper ribbons stuck to a wall: they
      // swing downwind, stretch out and flutter, with gusts rolling across.
      windGain: 0.015,   // wind added per unit of scroll
      windDecay: 1.6,    // how quickly the wind fades while you keep scrolling
      windStopMs: 90,    // no scroll for this long counts as stopped
      windRecover: 26.5,    // how quickly everything settles once scrolling stops
      windTurn: 1,       // how far tips swing to point downwind
      windFlutter: 0.75, // flutter swing, in radians
      windFlutterHz: 3.2, // flutter speed
      windCurl: 2.65,     // how much ribbons curl (3D flip) as they flutter
      windStretch: 1.35,  // how much they stretch along the wind
      windGustSize: 650, // size of the gusts rolling across the wall, px
      windSpeed: 1280,   // speed of the air carrying loose glyphs, px/s
      windPush: 12,       // how quickly loose glyphs pick up the air's speed (drag)
      windTurbulence: 1, // sideways buffeting, as a share of the air speed
      // Near the downwind edge the air rolls into vortices (like wind eddying
      // off a wall). They build up the longer the wind keeps blowing, until
      // glyphs pinned at the wall get swept along it and flung back out, then
      // blown in again.
      eddyStrength: 2.95, // strength of the rolls at full build-up (1.2+ lets glyphs escape)
      eddySize: 670,     // width of each roll along the wall, px
      eddyDepth: 90,     // how far the rolls reach out from the wall, px
      eddyBuildMs: 700,  // how long the wind must blow for the rolls to fully form
      // Tear-off: keep scrolling and pinned glyphs start tearing loose at
      // random, the bigger ones much sooner, until every glyph is off the wall.
      detachFullMs: 4500, // scrolling time after which every glyph has torn loose
      detachSpeed: 0.3,  // how early they start going (higher = more tear off early)
      detachSizeBias: 2, // how much sooner big glyphs tear off (5 = up to 6x sooner)
      // Edges in the wind act like a wall meeting paper or leaves: almost no
      // bounce, a scrape along the wall, and a flip and tumble on impact.
      leafBounce: 0.12,  // speed kept bouncing off the wall
      leafScrape: 0.7,   // speed kept sliding along the wall on impact
      leafFlip: 0.05,    // how much an impact flips the glyph over (per px/s)
      uiShake: 0.3,      // share of the shake the menu and panel get
      // Keep raging (more than chillAfter presses in a row) and the glyphs
      // line up to spell "chill", hold it, then drift calmly home.
      chillAfter: 7,     // presses in a row before it kicks in
      chillGapMs: 700,   // presses closer together than this count as in a row
      chillAssembleMs: 600, // time for the word to form
      chillHoldMs: 1000, // time it stays up (1.6s in all)
      // 3D tumble (A): loose glyphs also flip around their own x and y axes,
      // drawn as a flat glyph turning in 3D (seen straight on, no perspective).
      tumbleScale: 0.8,  // flip speed from a hit, relative to its flat spin
      tumbleShade: 0.45, // how much a glyph dims as it turns edge-on
      hitSpeed: 0.9,     // share of the cursor's speed passed on in a hit
      bounce: 0.75,      // speed kept after bouncing off a screen edge
      drag: 0.9,         // air drag on loose glyphs
      flightMs: 1800,    // time loose before heading home
      homeSpring: 18,    // pull back to the grid position after flight
      homeDamping: 7,    // drag on the way home
      spinDrag: 1.5,     // how quickly a loose glyph's spin dies down
      hitSpinScale: 1,   // how much spin a hit gives, scaled by how fast the cursor hits
      maxSpin: 90,       // fastest spin in radians per second (about 14 turns/s)
      wallFriction: 0.6, // grip on the screen edges, 0 slides, 1 rolls without slipping
      spinRadius: 6,     // glyph radius used for edge grip, smaller spins up more
      liftChance: 0.4,   // share of hits that also fly "toward the viewer" and grow
      lift: 3,           // upward kick for those, bigger means larger and longer
      zGravity: 5,       // pull back down to the page
      zScale: 4.6,       // how much thrown glyphs grow with height
      // Bokeh: thrown glyphs past blurStart times their size soften, as if
      // closer to the viewer than the focal plane, fully blurred at blurFull.
      blurStart: 1.08,
      blurFull: 6,
      blurMax: 0.22,     // blur radius at blurFull, as a share of the glyph's size
      color: '#ffffff',
    }, opts.config || {});

    // Inlined copy of glyph-union.svg so the page works as a single file.
    const GLYPH_SVG =
      '<svg width="45" height="45" viewBox="0 0 45 45" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M45 27.8125L27.8125 45V17.1875H0L17.1875 0H45V27.8125Z" fill="white"/></svg>';

    // The same outline as a polygon (45-unit viewBox), used for the influence area.
    const GLYPH_POLY = [
      [45, 27.8125], [27.8125, 45], [27.8125, 17.1875],
      [0, 17.1875], [17.1875, 0], [45, 0],
    ];

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;touch-action:none;';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let dpr = 1, w = 0, h = 0, cols = 0, rows = 0;

    // Per-glyph return animation: the influence each glyph shrinks back from,
    // and when that shrink started.
    let peak = new Float32Array(0), peakAt = new Float64Array(0);
    // Per-glyph rotation, in radians from rest.
    let ang = new Float32Array(0);
    // Per-glyph offset from its grid position, used by the avoid mode.
    let offX = new Float32Array(0), offY = new Float32Array(0);
    // Loose glyphs knocked away by a hit: position, velocity, spin, launch time.
    let loose = new Uint8Array(0), lx = new Float32Array(0), ly = new Float32Array(0);
    let lvx = new Float32Array(0), lvy = new Float32Array(0), lspin = new Float32Array(0);
    let looseAt = new Float64Array(0), looseCount = 0;
    // Height above the page for thrown glyphs (0 on the page, 1 = twice the size).
    let lz = new Float32Array(0), lvz = new Float32Array(0);
    // Whether the arrow is currently passing through a glyph, so each pass gets
    // one chance to knock it loose.
    let touched = new Uint8Array(0);
    // Collision radius of each loose glyph, from its size last frame.
    let lrad = new Float32Array(0);
    // Black hole state: when a glyph got stuck, and when it last escaped.
    let stuckAt = new Float64Array(0), escapedAt = new Float64Array(0);
    // 3D tumble: flip angles around the glyph's x and y axes, and their speeds.
    let flipX = new Float32Array(0), flipY = new Float32Array(0);
    let flipVX = new Float32Array(0), flipVY = new Float32Array(0);
    // Stamps: each member's spot in the giant glyph, and its current scale.
    let formU = new Float32Array(0), formV = new Float32Array(0), formScale = new Float32Array(0);
    // Stamps in progress. formRef[i] is the stamp glyph i belongs to.
    let forms = [], formRef = [];
    const waves = [];
    // Slams: per-glyph speed-up for faster resets.
    let boost = new Float32Array(0);
    // Until this time, loose glyphs tumble in 3D even with Q off (bursts, slams).
    let tumbleUntil = 0, frameNow = 0, shakeAt = -1e9;
    // Size a glyph keeps after leaving a formation, easing down to its grid
    // size so it doesn't shrink in one frame.
    let linger = new Float32Array(0);
    // Rest direction of the glyph's top-right tip, in screen angle.
    const TIP_ANGLE = -Math.PI / 4;

    const pointer = { x: -9999, y: -9999, active: false };
    const eased = { x: -9999, y: -9999, strength: 0 };

    // Rasterise the glyph once at high resolution, tinted to CONFIG.color,
    // so the SVG's own fill doesn't matter and per-frame draws stay cheap.
    let sprite = null;
    const SPRITE_PX = 128;

    // Bokeh sprites: the glyph convolved with a disc (the shape of an
    // out-of-focus lens highlight) at increasing radii, all with the same
    // padding so they can be cross-faded. Level 0 is sharp.
    const BLUR_LEVELS = 8;
    let blurSprites = [], blurPad = 0;

    function buildBlurSprites(base) {
      const maxR = Math.round(Math.max(base.width, base.height) * CONFIG.blurMax);
      blurPad = maxR + 2;
      blurSprites = [];
      for (let l = 0; l <= BLUR_LEVELS; l++) {
        const R = maxR * l / BLUR_LEVELS;
        const c = document.createElement('canvas');
        c.width = base.width + blurPad * 2;
        c.height = base.height + blurPad * 2;
        const cx = c.getContext('2d');
        // Sample the disc on a grid, adding the copies together so the result
        // is the average of the glyph over the disc.
        const pts = [];
        const step = Math.max(1, R / 12);
        for (let yy = -R; yy <= R + 1e-6; yy += step) {
          for (let xx = -R; xx <= R + 1e-6; xx += step) {
            if (xx * xx + yy * yy <= R * R + 1e-6) pts.push([xx, yy]);
          }
        }
        cx.globalCompositeOperation = 'lighter';
        cx.globalAlpha = 1 / pts.length;
        for (const [xx, yy] of pts) cx.drawImage(base, blurPad + xx, blurPad + yy);
        blurSprites.push(c);
      }
    }

    function buildSprite(img) {
      const s = document.createElement('canvas');
      const aspect = (img.naturalWidth || 1) / (img.naturalHeight || 1);
      s.width = aspect >= 1 ? SPRITE_PX : Math.round(SPRITE_PX * aspect);
      s.height = aspect >= 1 ? Math.round(SPRITE_PX / aspect) : SPRITE_PX;
      const sc = s.getContext('2d');
      sc.drawImage(img, 0, 0, s.width, s.height);
      sc.globalCompositeOperation = 'source-in';
      sc.fillStyle = CONFIG.color;
      sc.fillRect(0, 0, s.width, s.height);
      sprite = s;
      buildBlurSprites(s);
    }

    function loadGlyph() {
      const img = new Image();
      img.onload = () => buildSprite(img);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(GLYPH_SVG);
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, container.clientWidth);
      h = Math.max(1, container.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cols = Math.ceil(w / CONFIG.spacing) + 1;
      rows = Math.ceil(h / CONFIG.spacing) + 1;
      peak = new Float32Array(cols * rows);
      peakAt = new Float64Array(cols * rows);
      ang = new Float32Array(cols * rows);
      offX = new Float32Array(cols * rows);
      offY = new Float32Array(cols * rows);
      const n = cols * rows;
      loose = new Uint8Array(n); lx = new Float32Array(n); ly = new Float32Array(n);
      lvx = new Float32Array(n); lvy = new Float32Array(n); lspin = new Float32Array(n);
      looseAt = new Float64Array(n); looseCount = 0;
      lz = new Float32Array(n); lvz = new Float32Array(n);
      touched = new Uint8Array(n);
      lrad = new Float32Array(n);
      stuckAt = new Float64Array(n);
      escapedAt = new Float64Array(n).fill(-1e9);
      flipX = new Float32Array(n); flipY = new Float32Array(n);
      flipVX = new Float32Array(n); flipVY = new Float32Array(n);
      formU = new Float32Array(n); formV = new Float32Array(n); formScale = new Float32Array(n).fill(1);
      linger = new Float32Array(n);
      forms = []; formRef = new Array(n).fill(null);
      boost = new Float32Array(n).fill(1);
      waves.length = 0;
    }

    // Signed distance from (px, py) to a polygon: negative inside, positive outside.
    function sdPolygon(px, py, v) {
      let d = Infinity, sign = 1;
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
        const ax = v[j][0], ay = v[j][1], bx = v[i][0], by = v[i][1];
        const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
        const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
        const dx = wx - ex * t, dy = wy - ey * t;
        d = Math.min(d, dx * dx + dy * dy);
        if ((ay > py) !== (by > py) && px < ax + (py - ay) * ex / ey) sign = -sign;
      }
      return sign * Math.sqrt(d);
    }

    // Current shape scale, eased toward the speed-based target each frame.
    let shapeScale = 1;
    // Idle wandering: when the pointer last moved, whether we're idle, and
    // the grow-in (0..1) and path phase for the current idle spell.
    let lastActive = performance.now(), idling = false, idleT0 = 0, shapeGrow = 1;
    let idlePa = 0, idlePb = 0;
    // Orient: the shape turns with movement, like the glyphs. Set from the Variables panel.
    let shapeTurns = true;
    // Press Z (Repel) to toggle glyphs fleeing the cursor while it moves.
    let avoidCursor = false;
    // Press X (Attract) to toggle the black hole pull.
    let attractCursor = false;
    // 3D tumble: loose glyphs flip in 3D. Set from the Variables panel.
    let tumble3d = false;
    let shapeAng = 0;

    // Smooth falloff: 1 once CONFIG.inner deep inside the outline, 0 at CONFIG.outer
    // outside. The edge widths scale with the shape so its look stays the same.
    // rampCurve bends the ramp: below 1 glyphs grow early and stay big, above 1
    // they stay small until close to full size.
    function falloff(d) {
      const inner = CONFIG.inner * shapeScale, outer = CONFIG.outer * shapeScale;
      const t = Math.max(0, Math.min(1, (outer - d) / (outer + inner)));
      const s = t * t * (3 - 2 * t);
      return CONFIG.rampCurve === 1 ? s : Math.pow(s, CONFIG.rampCurve);
    }

    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

    // Draw a glyph image centred at (x, y), `size` wide, rotated by `a`, and
    // optionally flipped by rx, ry around its own x and y axes. The flat glyph
    // turned in 3D and seen straight on is exactly the top-left 2x2 of its 3D
    // rotation matrix (Rz * Ry * Rx), so it maps to a canvas transform. Blurred
    // sprites carry extra padding, scaled the same so the glyph lines up.
    // `stretch` (with direction ux, uy) elongates the drawn glyph along that
    // direction, used for motion blur.
    function drawGlyph(img, x, y, size, a, alpha, rx = 0, ry = 0, ux = 0, uy = 0, stretch = 1) {
      if (alpha <= 0) return;
      const k = size / Math.max(sprite.width, sprite.height);
      const dw = img.width * k, dh = img.height * k;
      if (a !== 0 || rx !== 0 || ry !== 0 || stretch !== 1) {
        const cz = Math.cos(a), sz = Math.sin(a);
        const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
        let m00 = cz * cy, m01 = cz * sy * sx - sz * cx;
        let m10 = sz * cy, m11 = sz * sy * sx + cz * cx;
        if (stretch !== 1) {
          // Scale by `stretch` along (ux, uy): S = I + (stretch - 1) u uᵀ, then S·M.
          const e = stretch - 1, s00 = 1 + e * ux * ux, s01 = e * ux * uy, s11 = 1 + e * uy * uy;
          const n00 = s00 * m00 + s01 * m10, n01 = s00 * m01 + s01 * m11;
          const n10 = s01 * m00 + s11 * m10, n11 = s01 * m01 + s11 * m11;
          m00 = n00; m01 = n01; m10 = n10; m11 = n11;
        }
        // Dim as the glyph turns edge-on, like light catching a card.
        const facing = Math.abs(cx * cy);
        ctx.globalAlpha = alpha * (1 - CONFIG.tumbleShade * (1 - facing));
        ctx.setTransform(dpr * m00, dpr * m10, dpr * m01, dpr * m11, dpr * x, dpr * y);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
      }
    }

    // Motion blur: behind a moving glyph, draw faded copies stretched back
    // along its path (as if the shutter stayed open for mbShutter seconds),
    // then the glyph itself. Each extra sample is one more stretched copy, so
    // 2 samples costs just one extra draw per moving glyph.
    function drawMoving(img, x, y, size, a, alpha, rx, ry, vx, vy, sux = 0, suy = 0, st = 1) {
      const sp = Math.hypot(vx, vy);
      if (!CONFIG.mbOn || sp < CONFIG.mbMinSpeed || CONFIG.mbSamples < 2) {
        drawGlyph(img, x, y, size, a, alpha, rx, ry, sux, suy, st);
        return;
      }
      const len = Math.min(sp * CONFIG.mbShutter, CONFIG.mbMaxLen);
      const ux = vx / sp, uy = vy / sp, n = Math.round(CONFIG.mbSamples) - 1;
      for (let k = n; k >= 1; k--) {
        const l = len * k / n;
        drawGlyph(img, x - ux * l / 2, y - uy * l / 2, size, a, alpha * CONFIG.mbTail / n, rx, ry,
          ux, uy, 1 + l / Math.max(size, 1));
      }
      drawGlyph(img, x, y, size, a, alpha, rx, ry, sux, suy, st);
    }

    // 3D tumble helpers. A knock sets flip speeds from the flat spin it gave;
    // each frame flips turn, dying down, and settle flat when `settle` is true
    // or the mode is off, taking the shortest way back.
    const tumbling = () => tumble3d || frameNow < tumbleUntil;
    function kickFlip(i, extra = 0) {
      if (!tumbling()) return;
      const base = (Math.max(Math.abs(lspin[i]), 6) + extra) * CONFIG.tumbleScale;
      flipVX[i] += (Math.random() - 0.5) * 2 * base;
      flipVY[i] += (Math.random() - 0.5) * 2 * base;
    }
    function updateFlip(i, dt, settle) {
      if (!tumbling() || settle) {
        flipVX[i] *= Math.exp(-8 * dt); flipVY[i] *= Math.exp(-8 * dt);
        flipX[i] = wrap(flipX[i] + flipVX[i] * dt);
        flipY[i] = wrap(flipY[i] + flipVY[i] * dt);
        const a = Math.min(1, dt * CONFIG.restRate);
        flipX[i] -= flipX[i] * a; flipY[i] -= flipY[i] * a;
      } else {
        const k = Math.exp(-CONFIG.spinDrag * dt);
        flipVX[i] *= k; flipVY[i] *= k;
        flipX[i] = wrap(flipX[i] + flipVX[i] * dt);
        flipY[i] = wrap(flipY[i] + flipVY[i] * dt);
      }
    }
    const wrap = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

    // Cursor speed and direction, measured from pointer events. Speed drops to
    // zero once the cursor has been still for stopMs.
    const motion = { speed: 0, eventSpeed: 0, dirX: 1, dirY: -1, moveAt: 0, lastT: 0 };

    // Frame rate, averaged over half a second and reported as an 'fps' event.
    let fpsFrames = 0, fpsSince = 0;

    // Wind from scrolling: signed strength (+ blows down, - blows up), eased so
    // it builds and fades smoothly, and a running phase for the flutter.
    const wind = { target: 0, amt: 0, lastWheel: -1e9 };
    let windAmt = 0, windAng = 0, windPhase = 0, windBlowMs = 0;

    function frame(now) {
      frameNow = now;
      fpsFrames++;
      if (!fpsSince) fpsSince = now;
      if (now - fpsSince >= 500) {
        emit('fps', Math.round(fpsFrames * 1000 / (now - fpsSince)));
        fpsFrames = 0;
        fpsSince = now;
      }
      const dt = Math.min(1 / 30, motion.lastT ? (now - motion.lastT) / 1000 : 1 / 60);
      // Screen shake after a slam: fast jitter that dies away.
      const st = (now - shakeAt) / CONFIG.slamShakeMs;
      const shake = st < 1 ? CONFIG.slamShake * (1 - st) * (1 - st) : 0;
      const shakeT = shake > 0.2
        ? `translate(${((Math.random() - 0.5) * 2 * shake).toFixed(1)}px, ${((Math.random() - 0.5) * 2 * shake).toFixed(1)}px)` : '';
      const uiS = shake * CONFIG.uiShake;
      const uiT = uiS > 0.2
        ? `translate(${((Math.random() - 0.5) * 2 * uiS).toFixed(1)}px, ${((Math.random() - 0.5) * 2 * uiS).toFixed(1)}px)` : '';
      if (canvas.style.transform !== shakeT) canvas.style.transform = shakeT;
      for (const el of shakeEls) if (el.style.transform !== uiT) el.style.transform = uiT;
      // Waves travel until they've crossed the screen.
      for (let k = waves.length - 1; k >= 0; k--) {
        if ((now - waves[k].t0) * CONFIG.waveSpeed / 1000 > Math.hypot(w, h) + CONFIG.waveWidth) waves.splice(k, 1);
      }
      // Stamps land, then burst after their hold.
      for (const fm of forms.slice()) {
        const el = now - fm.t0;
        if (!fm.landed && el > fm.assemble) fm.landed = true;
        if (el > fm.assemble + fm.hold) {
          if (fm.kind === 'chill') releaseForm(fm, now); else burstForm(fm, now);
        }
      }
      motion.lastT = now;
      // While scrolling the wind builds and fades gently; the moment scrolling
      // stops it drops away, so glyphs start settling back straight away.
      if (now - wind.lastWheel > CONFIG.windStopMs) wind.target = 0;
      else wind.target *= Math.exp(-CONFIG.windDecay * dt);
      const windRate = wind.target === 0 ? CONFIG.windRecover : 6;
      wind.amt += (wind.target - wind.amt) * Math.min(1, dt * windRate);
      windAmt = Math.min(1, Math.abs(wind.amt));
      windAng = wrap((wind.amt >= 0 ? Math.PI / 2 : -Math.PI / 2) - TIP_ANGLE);
      windPhase += dt * (0.4 + windAmt);
      // How long a real wind has been blowing, which builds up the wall eddies.
      windBlowMs = windAmt > 0.3 ? windBlowMs + dt * 1000 : Math.max(0, windBlowMs - dt * 2000);
      // Report when scrolling starts and stops (pages light their scroll key).
      const scrollingNow = now - wind.lastWheel <= CONFIG.windStopMs;
      if (scrollingNow !== scrolling) { scrolling = scrollingNow; emit('scrolling', scrolling); }
      const moving = pointer.active && now - motion.moveAt < CONFIG.stopMs;
      const v = moving ? motion.eventSpeed : 0;
      motion.speed += (v - motion.speed) * Math.min(1, dt * 12);
      // Once stopped, glyphs start easing back right away instead of waiting
      // for the smoothed speed to fade.
      // While "chill" is up, the grid rests: glyphs stay small and ignore the
      // mouse until it goes away.
      const calm = forms.some(fm => fm.kind === 'chill');
      const drive = moving && !calm ? Math.min(1, motion.speed / CONFIG.turnSpeed) : 0;
      // Resting size when still, slowScale..fastScale while moving. Repel and
      // Attract keep the shape at its resting size.
      const sizeTarget = moving && !avoidCursor && !attractCursor
        ? CONFIG.slowScale + (CONFIG.fastScale - CONFIG.slowScale) *
          Math.min(1, motion.speed / CONFIG.sizeSpeed)
        : 1;
      shapeScale += (sizeTarget - shapeScale) * Math.min(1, dt * CONFIG.sizeRate);
      // Shape rotation follows the same rules as the glyphs: ease toward the
      // movement direction while moving, back to rest when still or toggled off.
      const moveAngNow = wrap(Math.atan2(motion.dirY, motion.dirX) - TIP_ANGLE);
      if (shapeTurns && drive > 0.001) {
        shapeAng = wrap(shapeAng + wrap(moveAngNow - shapeAng) * Math.min(1, dt * CONFIG.turnRate * drive));
      } else {
        shapeAng -= shapeAng * Math.min(1, dt * CONFIG.restRate);
        if (Math.abs(shapeAng) < 0.001) shapeAng = 0;
      }
      // Rotation that points the tip along the direction of movement.
      const moveAng = wrap(Math.atan2(motion.dirY, motion.dirX) - TIP_ANGLE);

      // Idle: start a new spell once the pointer has been still long enough.
      // The glyph grows in from nothing and drifts along a slow Lissajous path.
      const idleNow = CONFIG.idleOn && now - lastActive > CONFIG.idleAfterMs;
      if (idleNow && !idling) {
        idleT0 = now; shapeGrow = 0;
        idlePa = Math.random() * Math.PI * 2; idlePb = Math.random() * Math.PI * 2;
      }
      idling = idleNow;
      if (idling) shapeGrow = Math.min(1, shapeGrow + dt * 1000 / CONFIG.idleGrowMs);
      else shapeGrow += (1 - shapeGrow) * Math.min(1, dt * 6);
      const growK = 1 - Math.pow(1 - shapeGrow, 3);

      const k = CONFIG.ease;
      if (idling) {
        const it = (now - idleT0) / 1000 * CONFIG.idleSpeed;
        // The path is for the glyph's centre; shift by the anchor so the whole
        // glyph stays in view.
        const S = CONFIG.shapeSize * shapeScale;
        const rx = Math.max(0, w - S) / 2 * CONFIG.idleRange, ry = Math.max(0, h - S) / 2 * CONFIG.idleRange;
        eased.x = w / 2 + rx * Math.sin(it * 1.0 + idlePa) + (CONFIG.anchor[0] - 0.5) * S;
        eased.y = h / 2 + ry * Math.sin(it * 1.37 + idlePb) + (CONFIG.anchor[1] - 0.5) * S;
      } else if (pointer.active) {
        if (eased.x < -1000) { eased.x = pointer.x; eased.y = pointer.y; }
        eased.x += (pointer.x - eased.x) * k;
        eased.y += (pointer.y - eased.y) * k;
      }
      eased.strength += (((pointer.active || idling) && !calm ? 1 : 0) - eased.strength) * k;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (CONFIG.mbOn && CONFIG.mbTrails > 0) {
        // Fade the last frame instead of clearing it, leaving trails.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0,0,0,${1 - CONFIG.mbTrails})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clearRect(0, 0, w, h);
      }

      if (sprite) {
        const offset = (w - (cols - 1) * CONFIG.spacing) / 2;
        const offsetY = (h - (rows - 1) * CONFIG.spacing) / 2;

        // Glyph outline in screen space, with CONFIG.anchor under the cursor.
        const scale = CONFIG.shapeSize * shapeScale * growK / 45;
        const ax = CONFIG.anchor[0] * 45, ay = CONFIG.anchor[1] * 45;
        const sc = Math.cos(shapeAng), ss = Math.sin(shapeAng);
        const poly = GLYPH_POLY.map(([px, py]) => {
          const lx = (px - ax) * scale, ly = (py - ay) * scale;
          return [eased.x + lx * sc - ly * ss, eased.y + lx * ss + ly * sc];
        });

        // Avoid arrow: glyph outline with its tip on the cursor, pointing along
        // the movement direction.
        const avoidOn = avoidCursor && drive > 0.001 && pointer.active;
        const attractOn = attractCursor && pointer.active && !calm;
        // The cursor's path since last frame. Capture checks use the distance to
        // this segment, so a fast cursor still sweeps up everything it passes.
        const segX0 = motion.prevX ?? pointer.x, segY0 = motion.prevY ?? pointer.y;
        const segDX = pointer.x - segX0, segDY = pointer.y - segY0;
        const segL2 = segDX * segDX + segDY * segDY;
        // Stuck glyphs pile into a clump, so the stuck radius grows with it.
        let capturedNow = 0;
        for (let i = 0; i < loose.length; i++) if (loose[i] === 2) capturedNow++;
        const stickR = CONFIG.stickDist + Math.sqrt(capturedNow) * 3;

        // Break a captured glyph free: fling it away from the cursor, then let
        // the normal loose flight bring it home.
        function escape(i) {
          let ex = lx[i] - pointer.x, ey = ly[i] - pointer.y;
          const ed = Math.hypot(ex, ey);
          const a0 = ed > 2 ? Math.atan2(ey, ex) : Math.random() * Math.PI * 2;
          const a1 = a0 + (Math.random() - 0.5) * 1.2;
          const sp = CONFIG.escapeSpeed * (0.7 + Math.random() * 0.6);
          lvx[i] = Math.cos(a1) * sp;
          lvy[i] = Math.sin(a1) * sp;
          lspin[i] = (Math.random() - 0.5) * 30;
          kickFlip(i);
          lz[i] = 0;
          lvz[i] = Math.random() < CONFIG.liftChance * 0.5 ? CONFIG.lift * (0.4 + Math.random() * 0.6) : 0;
          loose[i] = 1;
          looseAt[i] = now - CONFIG.flightMs + CONFIG.escapeFlightMs;
          escapedAt[i] = now;
        }
        const aScale = CONFIG.avoidSize / 45;
        const ac = Math.cos(moveAng), as = Math.sin(moveAng);
        const arrow = GLYPH_POLY.map(([px, py]) => {
          const qx = (px - 45) * aScale, qy = py * aScale;
          return [pointer.x + qx * ac - qy * as, pointer.y + qx * as + qy * ac];
        });
        // Only glyphs inside the arrow's bounding box (plus margin) need checking.
        const m = CONFIG.avoidMargin;
        let aMinX = Infinity, aMaxX = -Infinity, aMinY = Infinity, aMaxY = -Infinity;
        for (const [px, py] of arrow) {
          aMinX = Math.min(aMinX, px); aMaxX = Math.max(aMaxX, px);
          aMinY = Math.min(aMinY, py); aMaxY = Math.max(aMaxY, py);
        }
        aMinX -= m; aMaxX += m; aMinY -= m; aMaxY += m;
        const cvx = motion.dirX * motion.speed, cvy = motion.dirY * motion.speed;
        // Spin from a hit, scaled by how fast the cursor was moving. An
        // off-centre knock (cursor motion across the push direction) sets the
        // direction of spin, and a random share on top keeps hits varied.
        function hitSpin(hit) {
          const cross = (hit.nx * cvy - hit.ny * cvx) / 30;
          const kick = (Math.random() - 0.5) * motion.speed / 25;
          const spin = (cross + kick) * CONFIG.hitSpinScale;
          return Math.max(-CONFIG.maxSpin, Math.min(CONFIG.maxSpin, spin));
        }
        // Bounce off a screen edge with inward normal (nx, ny). The glyph is
        // treated as a disc: the edge grips its contact point, trading sliding
        // speed along the edge for spin (and spin for sliding speed).
        // Paper against a wall: the impact mostly dies, it scrapes along the
        // wall, and it flips and spins; pinned by the wind it keeps fluttering
        // and piles up with the others (the glyph collisions do the piling).
        function leafWall(i, nx, ny) {
          const vn = lvx[i] * nx + lvy[i] * ny;
          const tx = -ny, ty = nx;
          const vt = lvx[i] * tx + lvy[i] * ty;
          const impact = Math.max(0, -vn);
          const vn2 = impact * CONFIG.leafBounce;
          const vt2 = vt * CONFIG.leafScrape + (Math.random() - 0.5) * (20 + impact * 0.3);
          lvx[i] = vn2 * nx + vt2 * tx;
          lvy[i] = vn2 * ny + vt2 * ty;
          lspin[i] += (Math.random() - 0.5) * (1 + impact / 25);
          flipVX[i] += (Math.random() - 0.5) * (0.5 + impact * CONFIG.leafFlip);
          flipVY[i] += (Math.random() - 0.5) * (0.5 + impact * CONFIG.leafFlip);
          // Let the flips play out even with 3D tumble off.
          tumbleUntil = Math.max(tumbleUntil, frameNow + 400);
        }
        function wallBounce(i, nx, ny) {
          const vn = lvx[i] * nx + lvy[i] * ny;
          if (vn >= 0) return;
          const tx = -ny, ty = nx, k = 0.5, rr = CONFIG.spinRadius;
          const vt = lvx[i] * tx + lvy[i] * ty;
          const slip = vt - lspin[i] * rr;
          const j = -slip * CONFIG.wallFriction / (1 + 1 / k);
          const vt2 = vt + j;
          lspin[i] = Math.max(-CONFIG.maxSpin, Math.min(CONFIG.maxSpin, lspin[i] - j / (k * rr)));
          const vn2 = -vn * CONFIG.bounce;
          // In 3D tumble, a hard knock off the edge also flips the glyph.
          if (tumble3d) {
            flipVX[i] += (Math.random() - 0.5) * -vn / 40;
            flipVY[i] += (Math.random() - 0.5) * -vn / 40;
          }
          lvx[i] = vn2 * nx + vt2 * tx;
          lvy[i] = vn2 * ny + vt2 * ty;
        }
        // Signed distance to the arrow plus its outward direction, or null when
        // the point is too far away to matter.
        function arrowHit(px, py) {
          if (px < aMinX || px > aMaxX || py < aMinY || py > aMaxY) return null;
          const d = sdPolygon(px, py, arrow);
          if (d > CONFIG.avoidMargin) return null;
          const nx = sdPolygon(px + 1, py, arrow) - sdPolygon(px - 1, py, arrow);
          const ny = sdPolygon(px, py + 1, arrow) - sdPolygon(px, py - 1, arrow);
          const nl = Math.hypot(nx, ny) || 1;
          return { d, nx: nx / nl, ny: ny / nl };
        }

        // Thrown and heavily plowed glyphs are drawn after the grid, smallest
        // first, so the ones nearest the viewer sit on top.
        const thrown = [];

        // Collisions between loose glyphs: sort by x and sweep, so only
        // neighbours are compared. Overlaps are separated, then an impulse
        // bounces them apart, and friction at the contact trades sliding for
        // spin, the same disc model as the screen edges.
        if (CONFIG.collide && looseCount > 1) {
          const ids = [];
          for (let i = 0; i < loose.length; i++) if ((loose[i] === 1 || loose[i] === 2) && lrad[i] > 0) ids.push(i);
          ids.sort((p, q) => (lx[p] - lrad[p]) - (lx[q] - lrad[q]));
          const k = 0.5, e = CONFIG.restitution;
          for (let a = 0; a < ids.length; a++) {
            const i = ids[a], ri = lrad[i];
            for (let b = a + 1; b < ids.length; b++) {
              const j = ids[b], rj = lrad[j];
              if (lx[j] - rj > lx[i] + ri) break;
              if (Math.abs(lz[i] - lz[j]) > CONFIG.depthGap) continue;
              const dx = lx[j] - lx[i], dy = ly[j] - ly[i];
              const rs = ri + rj, d2 = dx * dx + dy * dy;
              if (d2 >= rs * rs || d2 === 0) continue;
              const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
              const mi = ri * ri, mj = rj * rj, im = 1 / mi + 1 / mj;
              // Separate the overlap, heavier glyphs moving less.
              const over = rs - d;
              lx[i] -= nx * over * (1 / mi) / im; ly[i] -= ny * over * (1 / mi) / im;
              lx[j] += nx * over * (1 / mj) / im; ly[j] += ny * over * (1 / mj) / im;
              const vn = (lvx[j] - lvx[i]) * nx + (lvy[j] - lvy[i]) * ny;
              if (vn >= 0) continue;
              const jn = -(1 + e) * vn / im;
              lvx[i] -= jn * nx / mi; lvy[i] -= jn * ny / mi;
              lvx[j] += jn * nx / mj; lvy[j] += jn * ny / mj;
              // Friction along the contact tangent couples motion and spin.
              const tx = -ny, ty = nx;
              const slip = (lvx[j] * tx + lvy[j] * ty - rj * lspin[j]) -
                           (lvx[i] * tx + lvy[i] * ty + ri * lspin[i]);
              const jt = -slip * CONFIG.collideGrip / (im * (1 + 1 / k));
              lvx[j] += jt * tx / mj; lvy[j] += jt * ty / mj;
              lvx[i] -= jt * tx / mi; lvy[i] -= jt * ty / mi;
              const cap = CONFIG.maxSpin;
              lspin[j] = Math.max(-cap, Math.min(cap, lspin[j] - jt / (k * mj * rj)));
              lspin[i] = Math.max(-cap, Math.min(cap, lspin[i] - jt / (k * mi * ri)));
            }
          }
        }

        for (let r = 0; r < rows; r++) {
          const y = offsetY + r * CONFIG.spacing;
          for (let c = 0; c < cols; c++) {
            const x = offset + c * CONFIG.spacing;
            const target = falloff(sdPolygon(x, y, poly)) * eased.strength;
            // Grow immediately. Once the shape leaves, ease out from the last
            // peak to the resting size over CONFIG.returnMs.
            const i = r * cols + c;
            const t = Math.min(1, (now - peakAt[i]) / CONFIG.returnMs);
            const decayed = peak[i] * (1 - easeOutCubic(t));
            let f;
            if (target >= decayed) {
              f = peak[i] = target;
              peakAt[i] = now;
            } else {
              f = decayed;
            }
            // Rotation: every glyph eases toward the movement direction. Once the
            // cursor stops they ease back to rest.
            let want = null, rate = 0;
            if (loose[i]) {
              // Loose glyphs spin freely, handled with the flight below.
            } else if (drive > 0.001) {
              want = moveAng;
              rate = CONFIG.turnRate * drive;
            }
            if (want !== null) {
              // Kept within ±180° so turning never winds up extra full rotations,
              // and the ease back to rest always takes the shortest way round.
              ang[i] = wrap(ang[i] + wrap(want - ang[i]) * Math.min(1, dt * rate));
            } else if (ang[i] !== 0 && !loose[i]) {
              ang[i] -= ang[i] * Math.min(1, dt * CONFIG.restRate);
              if (Math.abs(ang[i]) < 0.001) ang[i] = 0;
            }

            let gx, gy;
            let wRx = 0, wRy = 0, wGrow = 1;
            if (loose[i] === 3) {
              // In a stamp: fly to its spot while the whole stamp comes down
              // from above (larger, and soft with bokeh), pressing flat on landing.
              const fm = formRef[i];
              const el = now - fm.t0;
              const a = Math.min(1, el / fm.assemble);
              const press = fm.kind === 'stamp' ? 1 - easeOutCubic(a) : 0;
              const sp = 1 + CONFIG.stampDrop * press;
              const tx = fm.cx + formU[i] * sp, ty = fm.cy + formV[i] * sp;
              const kk = fm.landed ? Math.min(1, dt * 30) : Math.min(1, dt * (fm.kind === 'stamp' ? 10 : 5));
              const nx = lx[i] + (tx - lx[i]) * kk, ny = ly[i] + (ty - ly[i]) * kk;
              lvx[i] = (nx - lx[i]) / dt; lvy[i] = (ny - ly[i]) / dt;
              lx[i] = nx; ly[i] = ny;
              ang[i] = wrap(ang[i] + wrap((fm.turn || 0) - ang[i]) * Math.min(1, dt * 12));
              flipX[i] -= flipX[i] * Math.min(1, dt * 12);
              flipY[i] -= flipY[i] * Math.min(1, dt * 12);
              formScale[i] = 1 + 1.4 * press;
              f = 0.9;
              gx = lx[i]; gy = ly[i];
            } else if (loose[i] === 2) {
              // Captured: gravity toward the cursor with drag, so glyphs swirl
              // in and cling. After stuckMs clinging (or captureMaxMs in all)
              // they break free.
              const dx = pointer.x - lx[i], dy = pointer.y - ly[i];
              const d2 = dx * dx + dy * dy, d = Math.sqrt(d2) || 1;
              const soft = CONFIG.gravitySoft;
              const acc = CONFIG.gravity / (d2 + soft * soft);
              lvx[i] += dx / d * acc * dt;
              lvy[i] += dy / d * acc * dt;
              // Drag acts relative to the moving cursor (by `carry`), so
              // captured glyphs travel with it however fast it goes.
              const fx = cvx * CONFIG.carry, fy = cvy * CONFIG.carry;
              const dragK = Math.exp(-(stuckAt[i] ? 10 : CONFIG.attractDrag) * dt);
              lvx[i] = fx + (lvx[i] - fx) * dragK;
              lvy[i] = fy + (lvy[i] - fy) * dragK;
              lx[i] += lvx[i] * dt; ly[i] += lvy[i] * dt;
              if (!stuckAt[i] && d < stickR) stuckAt[i] = now;
              // Point along the fall, like debris spiralling in.
              if (Math.hypot(lvx[i], lvy[i]) > 20) {
                const want = wrap(Math.atan2(lvy[i], lvx[i]) - TIP_ANGLE);
                ang[i] = wrap(ang[i] + wrap(want - ang[i]) * Math.min(1, dt * CONFIG.turnRate));
              }
              updateFlip(i, dt, false);
              f = Math.max(f, falloff(sdPolygon(lx[i], ly[i], poly)) * eased.strength);
              // A little variation per glyph so they don't all break free at once.
              const hold = CONFIG.stuckMs * (0.75 + ((i * 7919) % 100) / 200);
              if (!attractOn || (stuckAt[i] && now - stuckAt[i] > hold) ||
                  now - looseAt[i] > CONFIG.captureMaxMs) {
                escape(i);
              }
              gx = lx[i]; gy = ly[i];
            } else if (loose[i]) {
              // Flight: drag, bounce off the screen edges, get knocked again by
              // the arrow, then spring home after flightMs and rejoin the grid.
              const age = now - looseAt[i];
              // Loose glyphs ride the air like paper: drag pulls each toward the
              // wind's speed (a little different for each), with its own
              // turbulence buffeting it sideways and spinning it.
              if (windAmt > 0.01) {
                // Two per-glyph random numbers, so neighbours don't move in step.
                const hsh = ((i * 2654435761) >>> 0) / 4294967296;
                const hs2 = ((i * 2246822519 + 3266489917) >>> 0) / 4294967296;
                const air = CONFIG.windSpeed * windAmt;
                const tb = Math.sin(windPhase * (3 + hsh * 4) + hs2 * 40) + 0.5 * Math.sin(windPhase * (7 + hs2 * 5) + hsh * 40);
                const airVy = Math.sign(wind.amt) * air * (0.55 + 0.9 * hsh) + tb * air * 0.25;
                let airVx = Math.cos(windPhase * (2 + hs2 * 3) + hsh * 60) * air * CONFIG.windTurbulence;
                let airVyE = airVy;
                // Wall eddies: a row of rolls along the downwind edge. At the wall
                // the air runs along it; where neighbouring rolls meet it turns and
                // streams back out, carrying glyphs away before the wind pushes
                // them in again.
                const build = Math.min(1, windBlowMs / CONFIG.eddyBuildMs);
                if (build > 0) {
                  const down = wind.amt > 0;
                  const dWall = down ? h - ly[i] : ly[i];
                  const B = CONFIG.eddyDepth, q = dWall / B;
                  if (q < 4) {
                    const e = Math.exp(-q);
                    const kx = Math.PI * 2 / CONFIG.eddySize;
                    const th = lx[i] * kx + windPhase * 0.35;
                    const A = CONFIG.eddyStrength * build * air;
                    airVx += A * Math.sin(th) * (1 - q) * e;
                    const away = A * -Math.cos(th) * q * e * kx * B;
                    airVyE += down ? -away : away;
                  }
                }
                const k = Math.min(1, CONFIG.windPush * dt);
                lvx[i] += (airVx - lvx[i]) * k;
                lvy[i] += (airVyE - lvy[i]) * k;
                lspin[i] += tb * windAmt * 8 * dt;
              }
              // Slammed glyphs run faster (boost), so the whole reset is quicker.
              const bst = boost[i];
              const dragK = Math.exp(-CONFIG.drag * bst * dt);
              lvx[i] *= dragK; lvy[i] *= dragK;
              if (age > CONFIG.flightMs) {
                // A strong wind loosens the pull home, so loose glyphs sail off
                // with it and come back once it dies down.
                const hold = 1 - 0.85 * windAmt;
                const ks = CONFIG.homeSpring * bst * bst * hold, kd = CONFIG.homeDamping * bst * (0.4 + 0.6 * hold);
                lvx[i] += ((x - lx[i]) * ks - lvx[i] * kd) * dt;
                lvy[i] += ((y - ly[i]) * ks - lvy[i] * kd) * dt;
              }
              if (avoidOn) {
                const hit = arrowHit(lx[i], ly[i]);
                if (hit && hit.d < 0) {
                  lvx[i] += hit.nx * motion.speed * 0.5;
                  lvy[i] += hit.ny * motion.speed * 0.5;
                  lspin[i] += hitSpin(hit);
                  kickFlip(i);
                }
              }
              // Height: a simple throw up off the page and back down, with a
              // small bounce when it lands.
              if (lz[i] > 0 || lvz[i] > 0) {
                // While the wind blows it holds each glyph at whatever height it
                // had, so it keeps its scale and blur; it falls once the wind drops.
                if (windAmt > 0.05) lvz[i] *= Math.exp(-25 * dt);
                else lvz[i] -= CONFIG.zGravity * boost[i] * boost[i] * dt;
                lz[i] += lvz[i] * dt;
                if (lz[i] <= 0) {
                  lz[i] = 0;
                  lvz[i] = lvz[i] < -0.8 ? -lvz[i] * 0.35 : 0;
                }
              }
              lx[i] += lvx[i] * dt; ly[i] += lvy[i] * dt;
              // Screen edges bounce glyphs while they fly. On the way home they
              // pass through, since the grid's outer rows sit just off screen.
              // While the wind blows, the edges hold everything in, and act like
              // a wall meeting paper rather than a bouncy ball.
              const leafy = windAmt > 0.02;
              if (age <= CONFIG.flightMs || leafy) {
                const hit = leafy ? leafWall : wallBounce;
                if (lx[i] < 0) { lx[i] = 0; hit(i, 1, 0); }
                if (lx[i] > w) { lx[i] = w; hit(i, -1, 0); }
                if (ly[i] < 0) { ly[i] = 0; hit(i, 0, 1); }
                if (ly[i] > h) { ly[i] = h; hit(i, 0, -1); }
              }
              const homeDist = Math.hypot(x - lx[i], y - ly[i]);
              const flySpeed = Math.hypot(lvx[i], lvy[i]);
              if (age <= CONFIG.flightMs) {
                // Tumbling: spin carried over from the hit, slowly dying down.
                lspin[i] *= Math.exp(-CONFIG.spinDrag * dt);
                ang[i] = wrap(ang[i] + lspin[i] * dt);
              } else {
                // Heading home: stop tumbling and point along the path, then
                // settle to rest for the last stretch.
                lspin[i] *= Math.exp(-8 * dt);
                ang[i] = wrap(ang[i] + lspin[i] * dt);
                const want = homeDist > CONFIG.spacing && flySpeed > 20
                  ? wrap(Math.atan2(lvy[i], lvx[i]) - TIP_ANGLE) : 0;
                ang[i] = wrap(ang[i] + wrap(want - ang[i]) * Math.min(1, dt * CONFIG.turnRate));
              }
              updateFlip(i, dt, age > CONFIG.flightMs);
              // Glyphs fresh out of a formation keep their size for a moment.
              if (linger[i] > 0) {
                f = Math.max(f, linger[i]);
                linger[i] = Math.max(0, linger[i] - dt * 0.9);
              }
              // Size follows the shape wherever the glyph currently is.
              f = Math.max(f, falloff(sdPolygon(lx[i], ly[i], poly)) * eased.strength);
              if (age > CONFIG.flightMs && homeDist < 0.5 && flySpeed < 10 && lz[i] === 0) {
                loose[i] = 0; looseCount--;
                offX[i] = offY[i] = 0;
                flipX[i] = flipY[i] = flipVX[i] = flipVY[i] = 0;
                boost[i] = 1;
              }
              gx = lx[i]; gy = ly[i];
            } else {
              // Avoid: push glyphs out of the arrow's way while the cursor moves,
              // then ease them home once it stops (or the mode is switched off).
              let tx = 0, ty = 0;
              if (avoidOn) {
                const hit = arrowHit(x + offX[i], y + offY[i]);
                if (hit) {
                  const t = Math.min(1, (CONFIG.avoidMargin - hit.d) / CONFIG.avoidMargin);
                  const push = CONFIG.avoidPush * t * t * (3 - 2 * t) + Math.max(0, -hit.d);
                  tx = offX[i] + hit.nx * push * 0.5;
                  ty = offY[i] + hit.ny * push * 0.5;
                  // Each time the arrow passes through a glyph, it gets one chance
                  // of being knocked loose, higher the faster the cursor moves.
                  const entering = hit.d < 0 && !touched[i];
                  if (hit.d < 0) touched[i] = 1;
                  if (entering && looseCount < CONFIG.maxLoose &&
                      Math.random() < CONFIG.hitChance * drive) {
                    loose[i] = 1; looseCount++;
                    looseAt[i] = now;
                    lx[i] = x + offX[i]; ly[i] = y + offY[i];
                    const jitter = (Math.random() - 0.5) * 0.8;
                    const jc = Math.cos(jitter), js = Math.sin(jitter);
                    const bx = cvx * CONFIG.hitSpeed + hit.nx * 250;
                    const by = cvy * CONFIG.hitSpeed + hit.ny * 250;
                    lvx[i] = bx * jc - by * js;
                    lvy[i] = bx * js + by * jc;
                    lspin[i] = hitSpin(hit);
                    kickFlip(i);
                    lz[i] = 0;
                    lvz[i] = Math.random() < CONFIG.liftChance
                      ? CONFIG.lift * (0.5 + Math.random()) : 0;
                  }
                }
                if (!hit) touched[i] = 0;
                // Out of the arrow's reach, glyphs drift back in behind it.
                const a = Math.min(1, dt * (hit ? CONFIG.avoidRate : CONFIG.restRate));
                offX[i] += (tx - offX[i]) * a;
                offY[i] += (ty - offY[i]) * a;
              } else if (offX[i] !== 0 || offY[i] !== 0) {
                touched[i] = 0;
                const a = Math.min(1, dt * CONFIG.restRate);
                offX[i] -= offX[i] * a;
                offY[i] -= offY[i] * a;
                if (Math.abs(offX[i]) + Math.abs(offY[i]) < 0.05) offX[i] = offY[i] = 0;
              }
              // Black hole: glyphs in reach lean toward the cursor, and some get
              // pulled in, unless they escaped recently.
              if (attractOn && now - escapedAt[i] > CONFIG.attractCooldown) {
                const dx = pointer.x - x, dy = pointer.y - y, d = Math.hypot(dx, dy);
                // Closest the cursor came to this glyph since last frame.
                const st = segL2 > 0
                  ? Math.max(0, Math.min(1, ((x - segX0) * segDX + (y - segY0) * segDY) / segL2)) : 1;
                const ds = Math.hypot(segX0 + segDX * st - x, segY0 + segDY * st - y);
                if (ds < CONFIG.attractRadius && d > 0.5) {
                  const kk = 1 - ds / CONFIG.attractRadius;
                  const pull = d < CONFIG.attractRadius ? CONFIG.attractPull * kk * kk : 0;
                  const a = Math.min(1, dt * CONFIG.avoidRate);
                  offX[i] += (dx / d * pull - offX[i]) * a;
                  offY[i] += (dy / d * pull - offY[i]) * a;
                  const chance = CONFIG.captureChance * (1 - CONFIG.captureFalloff * (1 - kk));
                  if (looseCount < CONFIG.maxLoose && Math.random() < 1 - Math.pow(1 - chance, dt)) {
                    loose[i] = 2; looseCount++;
                    looseAt[i] = now;
                    stuckAt[i] = 0;
                    lx[i] = x + offX[i]; ly[i] = y + offY[i];
                    // Start with some sideways speed so they swirl in.
                    const sp = Math.sqrt(CONFIG.gravity * d / (d * d + CONFIG.gravitySoft ** 2)) * CONFIG.orbit;
                    lvx[i] = -dy / d * sp;
                    lvy[i] = dx / d * sp;
                    lspin[i] = 0;
                    lz[i] = lvz[i] = 0;
                    kickFlip(i, 4);
                  }
                }
              }
              // Tear-off: each glyph has its own random point in the scroll
              // (sooner for bigger glyphs); once the wind has blown that long it
              // tears loose, keeping its size, and joins the loose glyphs.
              if (!loose[i] && windAmt > 0.3 && windBlowMs > 0 && looseCount < CONFIG.maxLoose) {
                const hsh = ((i * 2654435761) >>> 0) / 4294967296;
                const at = CONFIG.detachFullMs * Math.pow(hsh, CONFIG.detachSpeed) /
                  (1 + CONFIG.detachSizeBias * f);
                if (windBlowMs > at) {
                  loose[i] = 1; looseCount++;
                  lx[i] = x + offX[i]; ly[i] = y + offY[i];
                  lvx[i] = (Math.random() - 0.5) * 60;
                  lvy[i] = Math.sign(wind.amt) * 80 * (0.5 + Math.random());
                  lz[i] = lvz[i] = 0;
                  lspin[i] = (Math.random() - 0.5) * 6;
                  flipVX[i] = (Math.random() - 0.5) * 6;
                  flipVY[i] = (Math.random() - 0.5) * 6;
                  linger[i] = Math.max(linger[i], f);
                  boost[i] = 1;
                  looseAt[i] = now - CONFIG.flightMs;
                  tumbleUntil = Math.max(tumbleUntil, now + 600);
                }
              }
              gx = x + offX[i]; gy = y + offY[i];
              // Flip wave: as the ring passes, each glyph flips over outward like
              // a card, lifts and swells, fading with distance.
              for (const wv of waves) {
                const r = (now - wv.t0) * CONFIG.waveSpeed / 1000;
                const ex = x - wv.x, ey = y - wv.y, d = Math.hypot(ex, ey) || 1;
                const ph = (r - d) / CONFIG.waveWidth;
                if (ph > 0 && ph < 1) {
                  const amp = Math.exp(-d / CONFIG.waveFade);
                  const bump = Math.sin(ph * Math.PI) * amp;
                  const flip = ph * Math.PI * 2;
                  if (Math.abs(ex) > Math.abs(ey)) wRy += flip * Math.sign(ex); else wRx -= flip * Math.sign(ey);
                  wGrow *= 1 + bump * CONFIG.waveGrow;
                  gx += ex / d * bump * CONFIG.wavePush;
                  gy += ey / d * bump * CONFIG.wavePush;
                }
              }
            }

            // Thrown glyphs grow with height and read a little brighter. Pushed
            // glyphs grow with how far they've been plowed aside.
            const z = loose[i] ? lz[i] : 0;
            const pushed = loose[i] ? 0
              : Math.min(1, Math.hypot(offX[i], offY[i]) / CONFIG.pushGrowDist);
            const grow = (1 + z * CONFIG.zScale) * (1 + pushed * CONFIG.pushGrow) *
              (loose[i] === 3 ? formScale[i] : wGrow);
            const size = (CONFIG.minSize + (CONFIG.maxSize - CONFIG.minSize) * f) * grow;
            // The flip wave also brightens glyphs as it passes.
            const alpha = Math.min(1,
              CONFIG.minAlpha + (CONFIG.maxAlpha - CONFIG.minAlpha) * f + z * 0.3 + (wGrow - 1) * CONFIG.waveGlow);
            if (loose[i]) lrad[i] = Math.max(2, size * 0.42);
            let rxD = flipX[i] + wRx, ryD = flipY[i] + wRy, aD = ang[i];
            let sux = 0, suy = 0, st = 1;
            if (windAmt > 0.01 && !loose[i]) {
              // Wind on a pinned ribbon: the local gust strength rolls across
              // the wall, the tip swings downwind, and it flutters and curls,
              // each glyph a little out of step with its neighbours.
              const gk = Math.PI * 2 / CONFIG.windGustSize;
              const gust = windAmt * (0.55 + 0.45 * Math.sin(x * gk * 0.7 + y * gk + windPhase * 1.3));
              const ph = windPhase * CONFIG.windFlutterHz * Math.PI * 2 + x * 0.21 + y * 0.37 + (i % 7);
              const flutter = Math.sin(ph) * CONFIG.windFlutter * gust;
              // Ribbons swing all the way downwind even in a moderate breeze.
              const swing = Math.min(1, gust * CONFIG.windTurn * 2.5);
              aD = wrap(aD + wrap(windAng - aD) * swing * swing * (3 - 2 * swing) + flutter);
              rxD += Math.sin(ph * 1.7 + 1.3) * CONFIG.windCurl * gust;
              sux = 0; suy = 1;
              st = 1 + CONFIG.windStretch * gust * (0.8 + 0.2 * Math.cos(ph));
            }
            // Anything thrown, or grown past blurStart by plowing, is drawn
            // after the grid so bokeh applies and nearer glyphs sit on top.
            if (z > 0 || grow > CONFIG.blurStart) {
              thrown.push({ gx, gy, size, alpha, a: aD, z, grow, rx: rxD, ry: ryD,
                vx: loose[i] ? lvx[i] : 0, vy: loose[i] ? lvy[i] : 0, sux, suy, st });
            } else {
              if (loose[i]) drawMoving(sprite, gx, gy, size, aD, alpha, rxD, ryD, lvx[i], lvy[i]);
              else drawGlyph(sprite, gx, gy, size, aD, alpha, rxD, ryD, sux, suy, st);
            }
          }
        }

        thrown.sort((p, q) => p.grow - q.grow);
        for (const t of thrown) {
          const b = Math.max(0, Math.min(1,
            (t.grow - CONFIG.blurStart) / (CONFIG.blurFull - CONFIG.blurStart)));
          if (b === 0 || !blurSprites.length) {
            drawMoving(sprite, t.gx, t.gy, t.size, t.a, t.alpha, t.rx, t.ry, t.vx, t.vy, t.sux, t.suy, t.st);
          } else {
            // Cross-fade the two nearest blur levels for a gradual blur, and
            // let out-of-focus glyphs read a little softer.
            const lv = b * BLUR_LEVELS, l0 = Math.floor(lv), l1 = Math.min(BLUR_LEVELS, l0 + 1);
            const frac = lv - l0, alpha = t.alpha * (1 - 0.3 * b);
            drawMoving(blurSprites[l0], t.gx, t.gy, t.size, t.a, alpha * (1 - frac), t.rx, t.ry, t.vx, t.vy, t.sux, t.suy, t.st);
            if (frac > 0) drawMoving(blurSprites[l1], t.gx, t.gy, t.size, t.a, alpha * frac, t.rx, t.ry, t.vx, t.vy, t.sux, t.suy, t.st);
          }
        }
        ctx.globalAlpha = 1;
      }
      motion.prevX = pointer.x;
      motion.prevY = pointer.y;
      if (running) rafId = requestAnimationFrame(frame);
    }

    // Home position of glyph i in the grid.
    const homeX = i => (w - (cols - 1) * CONFIG.spacing) / 2 + (i % cols) * CONFIG.spacing;
    const homeY = i => (h - (rows - 1) * CONFIG.spacing) / 2 + Math.floor(i / cols) * CONFIG.spacing;

    // Click: gather the glyphs nearest the click into a giant glyph made of
    // glyphs. Spots are sampled on a grid inside the glyph outline; the
    // nearest glyphs take the innermost spots so paths don't cross much.
    // `turn` rotates the whole stamp (shift-click aims it along the mouse's
    // direction); its glyphs turn with it.
    function startForm(px, py, now, turn = 0) {
      const half = CONFIG.formSize / 2, sc = CONFIG.formSize / 45;
      const cx = Math.max(half + 16, Math.min(w - half - 16, px));
      const cy = Math.max(half + 16, Math.min(h - half - 16, py));
      const ct = Math.cos(turn), st = Math.sin(turn);
      const rot = (u, v) => [u * ct - v * st, u * st + v * ct];
      const spots = [];
      for (let v = -half; v <= half; v += CONFIG.formSpacing) {
        for (let u = -half; u <= half; u += CONFIG.formSpacing) {
          if (sdPolygon(u / sc + 22.5, v / sc + 22.5, GLYPH_POLY) < -0.2) spots.push(rot(u, v));
        }
      }
      // Only one giant glyph at a time: a new stamp bursts the one before.
      for (const fm of forms.slice()) if (fm.kind === 'stamp') burstForm(fm, now);
      // Draft from a larger glyph-shaped area around the click (not a circle),
      // so the gap left in the grid is glyph-shaped too.
      const big = CONFIG.formSize * 1.25 / 45;
      const bigPoly = GLYPH_POLY.map(([gx, gy]) => {
        const [u, v] = rot((gx - 22.5) * big, (gy - 22.5) * big);
        return [cx + u, cy + v];
      });
      buildForm(cx, cy, spots, now, 'stamp', CONFIG.formAssembleMs, CONFIG.formHoldMs,
        (x, y) => sdPolygon(x, y, bigPoly));
      forms[forms.length - 1].turn = turn;
    }

    // Spell "chill" in glyphs across the middle of the screen: draw the word
    // offscreen and put a glyph wherever the letters are.
    function startChill(now) {
      const c = document.createElement('canvas');
      const tw = Math.min(w * 0.72, 1000), fs = Math.round(tw / 2.4);
      c.width = Math.ceil(tw + 40); c.height = Math.ceil(fs * 1.4);
      const cc = c.getContext('2d');
      cc.font = `700 ${fs}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
      cc.textAlign = 'center';
      cc.textBaseline = 'middle';
      cc.fillStyle = '#000';
      cc.fillText('chill', c.width / 2, c.height / 2);
      const data = cc.getImageData(0, 0, c.width, c.height).data;
      const step = 12;
      const spots = [];
      for (let y = 0; y < c.height; y += step) {
        for (let x = 0; x < c.width; x += step) {
          if (data[(y * c.width + x) * 4 + 3] > 128) spots.push([x - c.width / 2, y - c.height / 2]);
        }
      }
      buildForm(w / 2, h / 2, spots, now, 'chill', CONFIG.chillAssembleMs, CONFIG.chillHoldMs);
    }

    // Draft glyphs into a formation. Resting glyphs and ones already flying
    // home can be drafted, so it always gets its full set however fast you go.
    // The nearest glyphs take the innermost spots so paths don't cross much.
    // `rank` orders which glyphs get drafted (lowest first); by default it's
    // distance from the centre.
    function buildForm(cx, cy, spots, now, kind, assemble, hold, rank) {
      rank = rank || ((x, y) => Math.hypot(x - cx, y - cy));
      const free = [];
      for (let i = 0; i < loose.length; i++) {
        if (!loose[i]) free.push([i, rank(homeX(i) + offX[i], homeY(i) + offY[i])]);
        else if (loose[i] === 1) free.push([i, rank(lx[i], ly[i])]);
      }
      free.sort((a, b) => a[1] - b[1]);
      // Of the drafted glyphs, the ones nearest the centre take the innermost
      // spots, so paths don't cross much.
      const n0 = Math.min(spots.length, free.length);
      const pos = i => loose[i] ? [lx[i], ly[i]] : [homeX(i) + offX[i], homeY(i) + offY[i]];
      const chosen = free.slice(0, n0).map(([i]) => { const [x, y] = pos(i); return [i, Math.hypot(x - cx, y - cy)]; });
      chosen.sort((a, b) => a[1] - b[1]);
      free.splice(0, n0, ...chosen);
      spots.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
      const n = Math.min(spots.length, free.length);
      const fm = { cx, cy, t0: now, ids: [], landed: false, kind, assemble, hold };
      for (let k = 0; k < n; k++) {
        const i = free[k][0];
        if (!loose[i]) {
          looseCount++;
          lx[i] = homeX(i) + offX[i]; ly[i] = homeY(i) + offY[i];
        }
        loose[i] = 3;
        formRef[i] = fm;
        lvx[i] = lvy[i] = lz[i] = lvz[i] = 0;
        boost[i] = 1;
        formU[i] = spots[k][0]; formV[i] = spots[k][1];
        formScale[i] = 1;
        fm.ids.push(i);
      }
      forms.push(fm);
    }

    // Let "chill" go gently: every glyph drifts straight home, no tumbling.
    // Esc: calm everything down and send every glyph straight home, fast.
    function resetAll(now) {
      forms.length = 0;
      waves.length = 0;
      wind.target = wind.amt = 0;
      windBlowMs = 0;
      shakeAt = -1e9;
      tumbleUntil = 0;
      for (let i = 0; i < loose.length; i++) {
        if (!loose[i]) continue;
        formRef[i] = null;
        formScale[i] = 1;
        loose[i] = 1;
        lvx[i] = lvy[i] = 0;
        lvz[i] = Math.min(lvz[i], 0);
        lspin[i] = flipVX[i] = flipVY[i] = 0;
        linger[i] = 0;
        boost[i] = 2.5;
        looseAt[i] = now - CONFIG.flightMs;
      }
    }

    function releaseForm(fm, now) {
      const k0 = forms.indexOf(fm);
      if (k0 < 0) return;
      forms.splice(k0, 1);
      for (const i of fm.ids) {
        if (loose[i] !== 3 || formRef[i] !== fm) continue;
        formRef[i] = null;
        // Drift outward a little, then float home slowly, shrinking as they go.
        const ex = lx[i] - fm.cx, ey = ly[i] - fm.cy, d = Math.hypot(ex, ey) || 1;
        lvx[i] = ex / d * (60 + Math.random() * 120) + (Math.random() - 0.5) * 80;
        lvy[i] = ey / d * (60 + Math.random() * 120) + (Math.random() - 0.5) * 80;
        lz[i] = lvz[i] = 0;
        lspin[i] = (Math.random() - 0.5) * 3;
        flipVX[i] = flipVY[i] = 0;
        formScale[i] = 1;
        linger[i] = 0.9;
        boost[i] = 0.8;
        loose[i] = 1;
        looseAt[i] = now - CONFIG.flightMs + 250;
      }
    }

    // Burst the giant glyph: every piece flies outward, tumbling, some thrown
    // toward the viewer, then heads home.
    function burstForm(fm, now) {
      const k0 = forms.indexOf(fm);
      if (k0 < 0) return;
      forms.splice(k0, 1);
      tumbleUntil = Math.max(tumbleUntil, now + 2600);
      for (const i of fm.ids) {
        if (loose[i] !== 3 || formRef[i] !== fm) continue;
        formRef[i] = null;
        const ex = lx[i] - fm.cx, ey = ly[i] - fm.cy, d = Math.hypot(ex, ey) || 1;
        const sp = CONFIG.burstSpeed * (0.5 + Math.random() * 0.9);
        lvx[i] = ex / d * sp + lvx[i] * 0.3 + (Math.random() - 0.5) * 200;
        lvy[i] = ey / d * sp + lvy[i] * 0.3 + (Math.random() - 0.5) * 200;
        lz[i] = 0;
        lvz[i] = Math.random() < 0.45 ? CONFIG.lift * (0.4 + Math.random() * 0.8) : 0;
        lspin[i] = (Math.random() - 0.5) * 40;
        flipVX[i] = (Math.random() - 0.5) * 30;
        flipVY[i] = (Math.random() - 0.5) * 30;
        formScale[i] = 1;
        loose[i] = 1;
        looseAt[i] = now - CONFIG.flightMs + 700;
      }
    }

    // Space: slam the table. Every glyph jumps off the page and scatters,
    // spinning and flipping, while the screen shakes.
    function slam(now) {
      shakeAt = now;
      tumbleUntil = Math.max(tumbleUntil, now + CONFIG.slamFlightMs + 1200);
      for (const fm of forms.slice()) burstForm(fm, now);
      const bst = CONFIG.slamReturn;
      for (let i = 0; i < loose.length; i++) {
        if (!loose[i]) {
          loose[i] = 1; looseCount++;
          lx[i] = homeX(i) + offX[i]; ly[i] = homeY(i) + offY[i];
          lvx[i] = lvy[i] = lz[i] = 0;
        } else if (loose[i] === 2) {
          loose[i] = 1;
        }
        // Same heights and spread as before, played back `slamReturn` times faster.
        boost[i] = bst;
        const big = Math.random() < 0.08 ? 1.7 : 1;
        // Slams keep stacking, but a glyph never jumps higher than one big jump.
        lvz[i] = Math.min(Math.max(lvz[i], 0) + CONFIG.slamLift * (0.35 + Math.random() * 0.8) * big * bst,
          CONFIG.slamLift * 1.7 * bst);
        const sc = CONFIG.slamScatter * (0.2 + Math.random()) * bst;
        const a = Math.random() * Math.PI * 2;
        lvx[i] += Math.cos(a) * sc;
        lvy[i] += Math.sin(a) * sc;
        lspin[i] = (Math.random() - 0.5) * 50;
        flipVX[i] = (Math.random() - 0.5) * 40;
        flipVY[i] = (Math.random() - 0.5) * 40;
        looseAt[i] = now - CONFIG.flightMs + CONFIG.slamFlightMs;
      }
    }


  // ---- Input -------------------------------------------------------------

  // Presses in a row, for the "chill" easter egg.
  let rageCount = 0, lastRage = -1e9;
  // Pointer position relative to the container.
  const local = e => {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  let hovering = false;

  function stamp(px, py, { aim = false } = {}) {
    const now = performance.now();
    // A click during "chill" just ends it.
    const chill = forms.find(fm => fm.kind === 'chill');
    if (chill) { releaseForm(chill, now); return; }
    // Aiming turns the stamp to point along the mouse's last direction of
    // travel, the same way the hover shape and glyphs orient.
    const turn = aim ? wrap(Math.atan2(motion.dirY, motion.dirX) - TIP_ANGLE) : 0;
    startForm(px, py, now, turn);
    // Every stamp sends out a shockwave.
    waves.push({ x: px, y: py, t0: now });
    if (waves.length > 6) waves.shift();
  }

  function rage() {
    const now = performance.now();
    rageCount = now - lastRage < CONFIG.chillGapMs ? rageCount + 1 : 1;
    lastRage = now;
    if (rageCount > CONFIG.chillAfter) {
      // That's enough. Calm everything down and spell it out.
      rageCount = 0;
      shakeAt = -1e9;
      tumbleUntil = 0;
      for (const fm of forms.slice()) if (fm.kind === 'stamp') burstForm(fm, now);
      // Bring everything in the air back down and settle it, quickly.
      for (let i = 0; i < loose.length; i++) {
        if (loose[i] !== 1 && loose[i] !== 2) continue;
        loose[i] = 1;
        lvx[i] *= 0.2; lvy[i] *= 0.2;
        lvz[i] = Math.min(lvz[i], -2);
        lspin[i] *= 0.2; flipVX[i] = flipVY[i] = 0;
        boost[i] = 2;
        looseAt[i] = now - CONFIG.flightMs;
      }
      if (!forms.some(fm => fm.kind === 'chill')) startChill(now);
    } else if (!forms.some(fm => fm.kind === 'chill')) {
      slam(now);
    }
  }

  // Modes. Repel and Attract can't run together; turning one on from
  // neither turns 3D tumble on, and with neither on it turns off.
  function setMode(m) {
    const was = avoidCursor || attractCursor;
    avoidCursor = m === 'repulse';
    attractCursor = m === 'attract';
    const active = avoidCursor || attractCursor;
    if (active && !was) tumble3d = true;
    if (!active) tumble3d = false;
    emit('change');
  }
  const getMode = () => avoidCursor ? 'repulse' : attractCursor ? 'attract' : null;

  const onDown = e => {
    if (e.button !== 0) return;
    lastActive = performance.now();
    const [x, y] = local(e);
    stamp(x, y, { aim: e.shiftKey });
    emit('action', 'click');
  };
  const onMove = e => {
    const [px, py] = local(e);
    hovering = true;
    const t = performance.now();
    lastActive = t;
    if (pointer.active && motion.moveAt) {
      const et = Math.max(1, t - motion.moveAt) / 1000;
      const v = Math.hypot(px - pointer.x, py - pointer.y) / et;
      motion.eventSpeed += (v - motion.eventSpeed) * 0.5;
      const mx = px - pointer.x, my = py - pointer.y, m = Math.hypot(mx, my);
      if (m > 0.5) {
        motion.dirX += (mx / m - motion.dirX) * 0.35;
        motion.dirY += (my / m - motion.dirY) * 0.35;
      }
    }
    motion.moveAt = t;
    pointer.x = px;
    pointer.y = py;
    pointer.active = true;
  };
  const onLeave = () => { pointer.active = false; hovering = false; };
  // Scrolling blows wind against the scroll: up the page when scrolling down,
  // like air rushing past as the page moves.
  const onWheel = e => {
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    wind.target = Math.max(-1.2, Math.min(1.2, wind.target - d * CONFIG.windGain));
    wind.lastWheel = performance.now();
  };
  const keysLive = () => opts.keysWhen !== 'hover' || hovering;
  const onKeyDown = e => {
    if (e.metaKey || e.ctrlKey || e.altKey || !keysLive()) return;
    if (e.key === 'Shift') { emit('shift', true); return; }
    if (e.key === '`') { emit('secret'); return; }
    if (e.key === 'Escape') { reset(); emit('action', 'esc'); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) { rage(); emit('action', 'space'); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'z') setMode(avoidCursor ? null : 'repulse');
    if (k === 'x') setMode(attractCursor ? null : 'attract');
  };
  const onKeyUp = e => { if (e.key === 'Shift') emit('shift', false); };
  const onBlur = () => { pointer.active = false; emit('shift', false); };
  function reset() { resetAll(performance.now()); }

  canvas.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onBlur);
  const wheelEl = opts.wheel === undefined ? window : opts.wheel;
  if (wheelEl) wheelEl.addEventListener('wheel', onWheel, { passive: true });
  const keyEl = opts.keys === undefined ? window : opts.keys;
  if (keyEl) { keyEl.addEventListener('keydown', onKeyDown); keyEl.addEventListener('keyup', onKeyUp); }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  resize();
  loadGlyph();
  rafId = requestAnimationFrame(frame);

  return {
    config: CONFIG,
    get mode() { return getMode(); },
    setMode,
    toggleMode: m => setMode(getMode() === m ? null : m),
    set(name, v) {
      if (name === 'orient') shapeTurns = !!v;
      else if (name === 'tumble') tumble3d = !!v;
      emit('change');
    },
    get(name) {
      if (name === 'orient') return shapeTurns;
      if (name === 'tumble') return tumble3d;
      if (name === 'mode') return getMode();
    },
    stamp, rage, reset,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    resize: () => resize(),
    pause() { running = false; cancelAnimationFrame(rafId); },
    resume() { if (!running) { running = true; motion.lastT = 0; rafId = requestAnimationFrame(frame); } },
    destroy() {
      this.pause();
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onBlur);
      if (wheelEl) wheelEl.removeEventListener('wheel', onWheel);
      if (keyEl) { keyEl.removeEventListener('keydown', onKeyDown); keyEl.removeEventListener('keyup', onKeyUp); }
      canvas.remove();
    },
  };
}
window.Glyphbomb = { mount };
})();
