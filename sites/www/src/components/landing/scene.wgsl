// Brings the workspace illustration to life. Every effect is keyed to a region measured on the
// 1322x920 source image, in image pixels; outside those regions the illustration passes through.

struct Params {
	time: f32,
	// The viewer's pointer, in image pixels; the window cat's eyes follow it.
	pointer: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const SIZE = vec2f(1322.0, 920.0);
const MOON = vec2f(205.5, 215.5);
const TERM_BG = vec3f(10.0, 12.0, 14.0) / 255.0;

// The terminal loop, in seconds: type the command, run each step, hold, clear.
const PERIOD = 14.0;
const CLEAR_AT = 12.4;

fn hash(p: vec2f) -> f32 {
	return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn inside(p: vec2f, lo: vec2f, hi: vec2f) -> bool {
	return all(p >= lo) && all(p <= hi);
}

fn luma(c: vec3f) -> f32 {
	return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn tap(p: vec2f) -> vec3f {
	return textureSampleLevel(scene, samp, p / SIZE, 0.0).rgb;
}

/** The x up to which a terminal line has been typed at loop time `tau`; a margin either side takes glyph halos with it. */
fn typed(line: vec4f, start: f32, duration: f32, tau: f32) -> f32 {
	let origin = line.z - 8.0;
	if (tau >= CLEAR_AT) {
		return origin;
	}
	return origin + (line.w + 8.0 - origin) * clamp((tau - start) / duration, 0.0, 1.0);
}

/** Brightens text in a row band, leaving the dark ground beneath it alone. */
fn lift(col: vec3f, amount: f32) -> vec3f {
	return col + (col - TERM_BG) * amount * smoothstep(0.12, 0.3, luma(col));
}

/** Whether cell `c` of a 5-wide pixel glyph is set; bit 4 is the leftmost column. */
fn glyph(rows: array<u32, 5>, c: vec2i) -> bool {
	if (any(c < vec2i(0)) || any(c > vec2i(4))) {
		return false;
	}
	return ((rows[c.y] >> u32(4 - c.x)) & 1u) == 1u;
}

// The window cat turns from the glass to watch you, then turns back: 12s per visit.
const CAT_TURN = 12.0;
const CAT_HEAD = vec2f(188.0, 526.0);
const EYE_AMBER = vec3f(0.93, 0.78, 0.36);
const EYE_CELL = 2.4;

/** 0 while facing the window, 1 with eyes wide open, 0.5 mid-blink or mid-turn. */
fn catOpen(t: f32) -> f32 {
	let c = t % CAT_TURN;
	if (c < 2.5 || c >= 11.15) {
		return 0.0;
	}
	let blinking = abs(c - 5.5) < 0.07 || abs(c - 8.7) < 0.07;
	if (c < 2.65 || c >= 11.0 || blinking) {
		return 0.5;
	}
	return 1.0;
}

/** A cat's eye on a 2.4px grid: an almond, 5x3 cells, with a slit pupil `look` cells off centre. */
fn catEye(p: vec2f, centre: vec2f, open: f32, look: i32) -> vec4f {
	let c = vec2i(floor((p - centre) / EYE_CELL + vec2f(2.5, 1.5)));
	if (any(c < vec2i(0)) || c.x > 4 || c.y > 2) {
		return vec4f(0.0);
	}
	// Half open is a lid-thin line; full open is the almond.
	if (open < 1.0) {
		return select(vec4f(0.0), vec4f(EYE_AMBER * 0.45, 1.0), c.y == 1 && c.x > 0 && c.x < 4);
	}
	if (c.y != 1 && (c.x == 0 || c.x == 4)) {
		return vec4f(0.0);
	}
	if (c.x == 2 + look) {
		return vec4f(0.04, 0.04, 0.05, 1.0);
	}
	return vec4f(EYE_AMBER * select(1.0, 0.82, c.y == 2), 1.0);
}

// The sleeping cat's Zs: three at a time, each rising and fading over ZZZ_LIFE seconds.
const ZZZ_LIFE = 3.6;
const ZZZ_FROM = vec2f(1128.0, 762.0);

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
	let t = params.time;
	var p = uv * SIZE;

	// The plant leans in a slow breeze, more at the tips than at the pot.
	if (inside(p, vec2f(1160.0, 500.0), vec2f(1285.0, 600.0))) {
		let reach = clamp((600.0 - p.y) / 95.0, 0.0, 1.0);
		p.x += sin(t * 1.3 + p.y * 0.03) * 2.2 * reach;
	}
	// The sleeping cat breathes, rising from where it lies.
	if (inside(p, vec2f(1090.0, 745.0), vec2f(1260.0, 840.0))) {
		let rise = 1.0 + 0.02 * (0.5 + 0.5 * sin(t * 1.6));
		p.y = 840.0 - (840.0 - p.y) / rise;
	}

	var col = tap(p);

	// City windows: warm cells switch off and on at their own pace, and shimmer a little.
	let warm = col.r > 0.55 && col.r - col.b > 0.27 && col.g > 0.35;
	if (warm && inside(p, vec2f(130.0, 220.0), vec2f(465.0, 550.0)) && distance(p, MOON) > 40.0) {
		let cell = floor(p / 9.0);
		let seed = hash(cell);
		let epoch = floor(t * 0.15 + seed * 7.0);
		let on = step(0.18, hash(cell + epoch * 13.1));
		col *= mix(0.22, 1.0, on) * (0.93 + 0.07 * sin(t * 3.0 + seed * 40.0));
	}

	// Stars twinkle in the open sky, never on the buildings.
	let sky = col.b - col.r > 0.04 && luma(col) > 0.05 && luma(col) < 0.16;
	if (sky && inside(p, vec2f(135.0, 90.0), vec2f(480.0, 330.0)) && distance(p, MOON) > 45.0) {
		let cell = floor(p / 6.0);
		let seed = hash(cell + vec2f(7.0, 3.0));
		let centred = all(abs(fract(p / 6.0) - 0.5) < vec2f(0.2));
		if (seed > 0.985 && centred) {
			col += vec3f(0.8, 0.85, 1.0) * pow(0.5 + 0.5 * sin(t * 2.0 + seed * 100.0), 6.0) * 0.7;
		}
	}

	// The moon breathes a soft halo.
	let fromMoon = distance(p, MOON);
	if (fromMoon > 27.0 && inside(p, vec2f(130.0, 90.0), vec2f(480.0, 340.0))) {
		col += vec3f(0.95, 0.88, 0.7) * exp(-(fromMoon - 27.0) / 18.0) * 0.09 * (0.85 + 0.15 * sin(t * 0.8));
	}

	// The terminal types `codework run`, then runs each step in turn.
	// Each line is (top, bottom, text start, text end); bands meet so no glyph halo survives a clear.
	var lines = array<vec4f, 7>(
		vec4f(500.0, 540.0, 451.0, 634.0),
		vec4f(541.0, 580.0, 451.0, 760.0),
		vec4f(581.0, 612.0, 451.0, 721.0),
		vec4f(613.0, 645.0, 451.0, 772.0),
		vec4f(646.0, 678.0, 451.0, 631.0),
		vec4f(679.0, 710.0, 451.0, 708.0),
		vec4f(711.0, 745.0, 451.0, 694.0),
	);
	let tau = t % PERIOD;
	var cursorLine = 0;
	var cursorX = lines[0].z - 2.0;
	var typing = false;
	for (var i = 0; i < 7; i++) {
		let start = select(2.0 + f32(i - 1), 0.4, i == 0);
		let duration = select(0.45, 1.1, i == 0);
		let line = lines[i];
		let reach = typed(line, start, duration, tau);
		if (tau >= start && tau < CLEAR_AT) {
			cursorLine = i;
			cursorX = max(reach, line.z) + 2.0;
			typing = tau < start + duration;
		}
		if (p.y >= line.x && p.y <= line.y && p.x > reach && p.x <= line.w + 8.0) {
			col = TERM_BG;
		}
	}
	// The drawn cursor is replaced by a live one that follows the typing.
	if (inside(p, vec2f(698.0, 712.0), vec2f(716.0, 742.0))) {
		col = TERM_BG;
	}
	var centres = array<f32, 7>(518.0, 564.0, 597.0, 629.0, 662.0, 695.0, 727.0);
	let cursorY = centres[cursorLine];
	let blink = typing || fract(t * 1.1) < 0.55;
	if (blink && inside(p, vec2f(cursorX, cursorY - 12.0), vec2f(cursorX + 11.0, cursorY + 12.0))) {
		col = textureLoad(scene, vec2i(706, 727), 0).rgb;
	}

	// A faint scan band rolls down the monitor.
	if (inside(p, vec2f(378.0, 440.0), vec2f(1110.0, 780.0))) {
		col *= 1.0 + 0.035 * smoothstep(0.9, 1.0, 1.0 - abs(fract(p.y / 340.0 - t * 0.08) * 2.0 - 1.0));
	}

	// The wall panel walks down its list, lighting one line at a time.
	let idea = i32(t * 0.6) % 3;
	var ideas = array<vec2f, 3>(vec2f(240.0, 265.0), vec2f(278.0, 303.0), vec2f(318.0, 342.0));
	if (inside(p, vec2f(510.0, ideas[idea].x), vec2f(735.0, ideas[idea].y))) {
		col = lift(col, 0.55);
	}

	// The poster reads itself: BUILD, TWEAK, EXTEND, REPEAT.
	let word = i32(t * 0.8) % 4;
	var words = array<vec2f, 4>(vec2f(175.0, 201.0), vec2f(219.0, 244.0), vec2f(261.0, 286.0), vec2f(303.0, 328.0));
	if (inside(p, vec2f(1108.0, words[word].x), vec2f(1240.0, words[word].y))) {
		col = lift(col, 0.6);
	}
	// And its cursor blinks.
	if (inside(p, vec2f(1114.0, 355.0), vec2f(1143.0, 364.0)) && fract(t * 0.9) > 0.5) {
		col = textureLoad(scene, vec2i(1128, 345), 0).rgb;
	}

	// The robot on the monitor blinks every few seconds.
	if (inside(p, vec2f(890.0, 128.0), vec2f(940.0, 147.0)) && fract(t / 4.5) > 0.965) {
		col *= 0.25;
	}

	// Steam curls up from the mug, drawn on a coarse grid to stay pixel art.
	let q = floor(p / 3.0) * 3.0;
	let rise = (795.0 - q.y) / 60.0;
	if (rise > 0.0 && rise < 1.0 && inside(q, vec2f(575.0, 735.0), vec2f(640.0, 795.0))) {
		var steam = 0.0;
		for (var k = 0; k < 2; k++) {
			let lane = f32(k);
			let x = 598.0 + lane * 12.0 + sin(q.y * 0.09 - t * 2.2 + lane * 2.0) * 6.0 * rise + sin(q.y * 0.05 + t) * 2.0;
			let width = 3.0 + 3.0 * rise;
			steam += smoothstep(width, 0.0, abs(q.x - x)) * (0.6 + 0.4 * sin(q.y * 0.2 - t * 3.0 + lane));
		}
		col += vec3f(0.62, 0.64, 0.68) * steam * (1.0 - rise) * smoothstep(0.0, 0.15, rise) * 0.2;
	}

	// The window cat looks back over its shoulder, eyes following the pointer.
	let open = catOpen(t);
	if (open > 0.0 && inside(p, CAT_HEAD - vec2f(24.0, 10.0), CAT_HEAD + vec2f(24.0, 10.0))) {
		let look = i32(round(clamp((params.pointer.x - CAT_HEAD.x) / 220.0, -1.0, 1.0)));
		let left = catEye(p, CAT_HEAD - vec2f(12.0, 0.0), open, look);
		let right = catEye(p, CAT_HEAD + vec2f(12.0, 0.0), open, look);
		col = mix(col, left.rgb, left.a);
		col = mix(col, right.rgb, right.a);
	}
	// A faint glow says the eyes are catching the light.
	if (open == 1.0) {
		let glow = exp(-distance(p, CAT_HEAD - vec2f(12.0, 0.0)) / 5.0) + exp(-distance(p, CAT_HEAD + vec2f(12.0, 0.0)) / 5.0);
		col += EYE_AMBER * glow * 0.12;
	}

	// Zzz: pixel Zs drift up and to the left of the sleeping cat, growing as they fade.
	if (inside(p, ZZZ_FROM - vec2f(60.0, 90.0), ZZZ_FROM + vec2f(20.0, 8.0))) {
		let z = array<u32, 5>(31u, 2u, 4u, 8u, 31u);
		for (var k = 0; k < 3; k++) {
			let age = fract(t / ZZZ_LIFE + f32(k) / 3.0);
			let at = ZZZ_FROM + vec2f(-26.0 * age + 5.0 * sin(age * 6.0 + f32(k)), -72.0 * age);
			let cell = 2.2 + 1.8 * age;
			if (glyph(z, vec2i(floor((p - at) / cell)))) {
				let alpha = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.6, 1.0, age));
				col = mix(col, vec3f(0.92, 0.88, 0.78), alpha * 0.85);
			}
		}
	}

	return vec4f(col, 1.0);
}
