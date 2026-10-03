import { fxaaGlsl } from 'src/components/tracker/fxaa-shader';

/**
 * The Fractal view's scene, one full-screen fragment shader: a Mandelbulb
 * floating above a glossy checkered floor whose light squares glow with the spectrum, and
 * a glass sphere orbiting it that bends the view of both (reflection, refraction
 * and a Fresnel mix between them). It is HDR: the colour is linear light that may go
 * far past 1 (glints, the lit squares, the glow in the crevices), packed into an 8 bit target
 * with the same curve the raytraced view uses, and FRACTAL_COMBINE_FRAGMENT_SHADER
 * unpacks it, runs the FXAA, and tone maps (Reinhard).
 *
 * Nothing here recurses: `trace` reflects the floor by marching the bulb again
 * with fewer steps, and the glass sphere calls `trace` for what it sees
 * through and in itself.
 */
export const FRACTAL_BANDS = 16;

/** Reads the average of a frame: its coarsest mip level, written to a 1x1 target. */
export const FRACTAL_METER_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  outColor = vec4(textureLod(uSrc, vec2(0.5), 14.0).rgb, 1.0);
}
`;

export const FRACTAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uRes;
uniform vec3 uEye;
uniform vec3 uTarget;
uniform float uFocal;
uniform float uTime;
uniform float uPower;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec3 uGlass;
uniform float uBand[${FRACTAL_BANDS}];

out vec4 outColor;

const float FLOOR_Y = -1.45;
const float BULB_RADIUS = 1.3;
const float GLASS_RADIUS = 0.6;
const float GLASS_IOR = 1.45;
// A strong warm sun against a cool sky dome, roughly 2:1, as in the shader this lighting comes from.
const vec3 KEY_DIR = normalize(vec3(0.55, 0.75, 0.35));
const vec3 SUN_COL = 2.2 * vec3(1.1, 0.8, 0.6);
const vec3 SKY_COL = 0.9 * vec3(0.2, 0.5, 0.8);
const vec3 BOUNCE_COL = 0.5 * vec3(1.2, 0.8, 0.6);
const vec3 HAZE_COL = vec3(0.8, 0.9, 1.0);

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

vec3 palette(float t) {
  // Three chosen colours, cyan to violet to coral and back, rather than the whole wheel: it drifts slowly, and never turns muddy.
  t = fract(t + uTime * 0.012) * 3.0;
  vec3 a = vec3(0.0, 0.55, 0.95);
  vec3 b = vec3(0.55, 0.08, 0.95);
  vec3 c = vec3(1.0, 0.3, 0.12);
  if (t < 1.0) return mix(a, b, smoothstep(0.0, 1.0, t));
  if (t < 2.0) return mix(b, c, smoothstep(0.0, 1.0, t - 1.0));
  return mix(c, a, smoothstep(0.0, 1.0, t - 2.0));
}

// The Mandelbulb's distance estimate. 'trap' collects the smallest |w| per axis and the smallest radius squared along the orbit.
float mapBulb(vec3 p, out vec4 trap) {
  p.xz = rot(uTime * 0.11) * p.xz;
  p.yz = rot(0.35 + 0.15 * sin(uTime * 0.07)) * p.yz;
  vec3 w = p;
  float m = dot(w, w);
  float dz = 1.0;
  trap = vec4(abs(w), m);
  for (int i = 0; i < 7; i++) {
    dz = uPower * pow(m, 0.5 * (uPower - 1.0)) * dz + 1.0;
    float r = length(w);
    float b = uPower * acos(clamp(w.y / r, -1.0, 1.0));
    float a = uPower * atan(w.x, w.z);
    w = p + pow(r, uPower) * vec3(sin(b) * sin(a), cos(b), sin(b) * cos(a));
    trap = min(trap, vec4(abs(w), m));
    m = dot(w, w);
    if (m > 256.0) break;
  }
  return 0.25 * log(m) * sqrt(m) / dz;
}

// How far a ray has already travelled before the one being marched (a reflection off the floor, a trip through the glass): tolerances scale with the whole path, so what a pixel cannot resolve is not traced.
float gTravel = 0.0;

float mapBulb(vec3 p) {
  vec4 trap;
  return mapBulb(p, trap);
}

// Marches the bulb inside its bounding sphere. Returns the hit distance, or -1.
float marchBulb(vec3 ro, vec3 rd, int steps) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - BULB_RADIUS * BULB_RADIUS;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t = max(-b - h, 0.0);
  float tEnd = -b + h;
  if (tEnd < 0.0) return -1.0;
  float d = 1.0;
  for (int i = 0; i < 128; i++) {
    if (i >= steps) break;
    d = mapBulb(ro + rd * t);
    if (d < 0.0006 * (t + gTravel)) return t;
    t += d;
    if (t > tEnd) return -1.0;
  }
  // Out of steps while skimming the surface: that is a silhouette, not a gap.
  return d < 0.004 * (t + gTravel) ? t : -1.0;
}

vec3 bulbNormal(vec3 p, float t) {
  vec2 e = vec2(1.0, -1.0) * 0.0016 * max(t + gTravel, 1.5);
  return normalize(e.xyy * mapBulb(p + e.xyy) + e.yyx * mapBulb(p + e.yyx) +
                   e.yxy * mapBulb(p + e.yxy) + e.xxx * mapBulb(p + e.xxx));
}

vec3 sky(vec3 rd) {
  // Pale haze at the horizon up to the sky dome's blue, the sun's glow and disc, and a little of the bass in the haze.
  vec3 col = mix(0.035 * HAZE_COL * (1.0 + 0.8 * uBass), SKY_COL * 0.3, smoothstep(0.0, 0.55, rd.y));
  float s = max(dot(rd, KEY_DIR), 0.0);
  col += SUN_COL * (0.08 * pow(s, 8.0) + 6.0 * pow(s, 400.0));
  return col;
}

// A soft shadow of the bulb along 'dir' (k = how soft: higher is harder).
float bulbShadow(vec3 p, vec3 dir, int steps, float k, float tmax) {
  float sh = 1.0;
  float s = 0.02;
  for (int i = 0; i < 40; i++) {
    if (i >= steps) break;
    float d = mapBulb(p + dir * s);
    sh = min(sh, k * d / s);
    s += clamp(d, 0.02, 0.3);
    if (sh < 0.01 || s > tmax) break;
  }
  return clamp(sh, 0.0, 1.0);
}

// How open the surface is to the sky: the distance field a few steps along the normal.
float bulbAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.02 + 0.12 * float(i) / 3.0;
    occ += (h - mapBulb(p + n * h)) * sca;
    sca *= 0.8;
  }
  return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}

vec3 shadeBulb(vec3 ro, vec3 rd, float t) {
  vec3 p = ro + rd * t;
  vec4 trap;
  mapBulb(p, trap);
  vec3 n = bulbNormal(p, t);
  float ao = bulbAO(p, n) * clamp(trap.w * 1.6 + 0.25, 0.0, 1.0);
  ao *= ao;
  // The orbit trap sweeps the palette round more than once across the surface, and darkens the folds, so neighbouring areas differ in hue and in value.
  vec3 albedo = palette(0.1 + 1.5 * trap.x + 0.8 * trap.y);
  albedo *= 0.25 + 1.1 * smoothstep(0.0, 0.9, trap.z);

  float dif = max(dot(n, KEY_DIR), 0.0);
  float sh = dif > 0.0 ? bulbShadow(p + n * 0.002, KEY_DIR, 28, 8.0, 2.6) : 0.0;
  vec3 hal = normalize(KEY_DIR - rd);
  float spe = 4.0 * pow(max(dot(n, hal), 0.0), 32.0);
  float fre0 = 0.04 + 0.96 * pow(clamp(1.0 - dot(hal, KEY_DIR), 0.0, 1.0), 5.0);

  vec3 col = albedo * SUN_COL * dif * sh;
  col += SUN_COL * dif * sh * spe * fre0 * 3.0;
  // The sky dome fills the shade, blue and occluded by the folds; the ground throws warm light back up at the undersides.
  col += albedo * SKY_COL * (0.5 + 0.5 * n.y) * ao;
  col += albedo * BOUNCE_COL * clamp(0.5 - 0.5 * n.y, 0.0, 1.0) * ao * 0.5;
  float fre = pow(1.0 - max(dot(-rd, n), 0.0), 4.0);
  col += sky(reflect(rd, n)) * (0.02 + 0.2 * fre) * ao;
  // The crevices glow with the music: the highs light them, the mids pulse them.
  col += palette(0.55 + 0.4 * trap.y + uTime * 0.02) * pow(1.0 - ao, 2.0) * (0.1 + 1.6 * uHigh + 0.8 * uMid);
  return col;
}

vec3 floorColor(vec3 p, vec3 rd, bool reflect_) {
  // A box-filtered checkerboard: the filter is as wide as a pixel is on the floor (wider for the glass's secondary rays), so the far squares melt to their average instead of shimmering.
  float dist = length(p - uEye);
  float fw = max(dist * 2.0 / (uRes.y * uFocal) / max(-rd.y, 0.12), 1e-3) * (reflect_ ? 1.0 : 3.0);
  vec2 w = vec2(fw);
  vec2 q = p.xz;
  vec2 i = 2.0 * (abs(fract((q - 0.5 * w) * 0.5) - 0.5) - abs(fract((q + 0.5 * w) * 0.5) - 0.5)) / w;
  float dark = 0.5 - 0.5 * i.x * i.y;
  dark = mix(dark, 0.5, smoothstep(0.12, 0.5, fw));
  // The light squares glow with the spectrum (the band for their distance from the middle) and the dark ones stay dark.
  vec2 tile = floor(q) + 0.5;
  float k = clamp(floor(length(tile) * 1.2), 0.0, ${FRACTAL_BANDS}.0 - 1.0);
  float level = uBand[int(k)];
  vec3 glow = palette(k / ${FRACTAL_BANDS}.0 * 0.8) * level * level * 2.6 * smoothstep(0.0, 14.0, 14.0 - length(tile));
  vec3 albedo = mix(vec3(0.034, 0.036, 0.043), vec3(0.006, 0.006, 0.01), dark);

  // Lit like the bulb: the sun (blocked by the bulb), the sky (less of it under the bulb).
  float sh = reflect_ ? bulbShadow(p, KEY_DIR, 22, 6.0, 5.0) : 0.8;
  float open = 1.0 - 0.6 * smoothstep(2.6, 0.0, length(p.xz));
  vec3 lit = albedo * (SUN_COL * KEY_DIR.y * sh + SKY_COL * 0.7 * open);
  float fre = 0.2 + 0.6 * pow(1.0 - max(-rd.y, 0.0), 3.0);
  vec3 col = lit * (1.0 - 0.5 * fre) + glow * (1.0 - dark);
  // The sun's glint on the glossy floor, sharper and stronger on the dark squares (polished), and the bulb blocks it.
  float glint = pow(max(dot(reflect(rd, vec3(0.0, 1.0, 0.0)), KEY_DIR), 0.0), mix(150.0, 500.0, dark));
  col += SUN_COL * glint * mix(0.15, 0.6, dark) * sh;
  if (reflect_) {
    vec3 rr = reflect(rd, vec3(0.0, 1.0, 0.0));
    gTravel = dist;
    float t = marchBulb(p + vec3(0.0, 0.002, 0.0), rr, 72);
    vec3 seenBulb = t > 0.0 ? shadeBulb(p, rr, t) : vec3(0.0);
    gTravel = 0.0;
    // The mirror image: the bulb at full strength, the sky only faintly, and least on the dark squares so they stay dark.
    col += (t > 0.0 ? seenBulb * fre * 0.8 : sky(rr) * fre * 0.25 * (1.0 - 0.7 * dark));
  } else {
    col += sky(reflect(rd, vec3(0.0, 1.0, 0.0))) * fre * 0.25 * (1.0 - 0.7 * dark);
  }
  // The distance fades to the horizon's haze.
  float fog = 1.0 - exp2(-0.03 * dist);
  return mix(col, sky(vec3(rd.x, 0.02, rd.z)), fog * fog);
}

// What a ray sees, ignoring the glass sphere. 'dist' is how far it went (or 1e9 for the sky).
vec3 trace(vec3 ro, vec3 rd, bool full, out float dist) {
  float tb = marchBulb(ro, rd, full ? 96 : 72);
  float tf = rd.y < -1e-4 ? (FLOOR_Y - ro.y) / rd.y : -1.0;
  if (tb > 0.0 && (tf < 0.0 || tb < tf)) {
    dist = tb;
    return shadeBulb(ro, rd, tb);
  }
  if (tf > 0.0) {
    dist = tf;
    return floorColor(ro + rd * tf, rd, full);
  }
  dist = 1e9;
  return sky(rd);
}

// The distance to the glass sphere along a ray, or -1.
float glassHit(vec3 ro, vec3 rd) {
  vec3 oc = ro - uGlass;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - GLASS_RADIUS * GLASS_RADIUS);
  if (h < 0.0) return -1.0;
  float t = -b - sqrt(h);
  return t > 0.0 ? t : -1.0;
}

vec3 shadeGlass(vec3 ro, vec3 rd, float tg) {
  vec3 p = ro + rd * tg;
  vec3 n = normalize(p - uGlass);
  float fre = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  float d;
  gTravel = tg;
  vec3 colR = trace(p + n * 0.01, reflect(rd, n), false, d);
  // Through the glass: refract in, cross to the back of the sphere, refract out. Each colour bends a little differently.
  vec3 colT = vec3(0.0);
  for (int c = 0; c < 3; c++) {
    float ior = GLASS_IOR + (float(c) - 1.0) * 0.018;
    vec3 rin = refract(rd, n, 1.0 / ior);
    vec3 oc = p - uGlass;
    float tExit = -2.0 * dot(oc, rin);
    vec3 pe = p + rin * tExit;
    vec3 ne = normalize(pe - uGlass);
    vec3 rout = refract(rin, -ne, ior);
    if (dot(rout, rout) < 0.5) rout = reflect(rin, -ne);
    vec3 seen = trace(pe + rout * 0.01, rout, false, d);
    if (c == 0) colT.r = seen.r;
    else if (c == 1) colT.g = seen.g;
    else colT.b = seen.b;
  }
  gTravel = 0.0;
  colT *= vec3(0.93, 0.98, 1.0);
  vec3 col = mix(colT, colR, fre);
  col += SUN_COL * pow(max(dot(reflect(rd, n), KEY_DIR), 0.0), 120.0) * 3.0;
  return col;
}

void main() {
  vec3 fwd = normalize(uTarget - uEye);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  vec3 rd = normalize(uv.x * right + uv.y * up + uFocal * fwd);

  float dist;
  vec3 col = trace(uEye, rd, true, dist);
  float tg = glassHit(uEye, rd);
  if (tg > 0.0 && tg < dist) col = shadeGlass(uEye, rd, tg);

  // Linear light, packed: c / (1 + c) under a gamma. The combine pass undoes it.
  col = max(col, vec3(0.0));
  outColor = vec4(pow(col / (1.0 + col), vec3(1.0 / 2.2)), 1.0);
}
`;

// FXAA on the packed values (a perceptual-ish space, so edges are judged about as the eye sees them), then unpack, expose, a Reinhard curve and gamma.
export const FRACTAL_COMBINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uExposure;
out vec4 outColor;

vec3 decodeHdr(vec3 y) {
  vec3 t = pow(y, vec3(2.2));
  return t / max(1.0 - t, 1.0 / 64.0);
}

${fxaaGlsl('uScene')}
void main() {
  vec3 col = decodeHdr(antiAlias(vUv).rgb);
  // The exposure is set by the renderer from the frame's average; the curve is a plain Reinhard with a little gain, then gamma and a vignette.
  col *= uExposure;
  col = col * 1.4 / (1.0 + col);
  col = pow(col, vec3(0.4545));
  // An S-curve for contrast: deepens the shadows and lifts the lights.
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.4);
  col *= 0.5 + 0.5 * pow(16.0 * vUv.x * vUv.y * (1.0 - vUv.x) * (1.0 - vUv.y), 0.1);
  // A little noise against banding in the dark gradients.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
