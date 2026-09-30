/**
 * GLSL for the raymarched bars scene (WebGL2). One full-screen triangle; the
 * fragment shader sphere-traces a signed distance field of the bars and
 * intersects the floor analytically, so the floor costs nothing and the
 * marcher only runs on rays that cross the bounding box of the row.
 */

export const RAYMARCH_VERTEX_SHADER = `#version 300 es
precision highp float;
void main() {
  // One triangle that covers the screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The classic Inigo Quilez kit, on a row of rounded cylinders above a glossy floor:
 *
 *  - an exact rounded-cylinder distance, evaluated for the cell under the point and
 *    its nearest neighbour only (domain repetition), so cost does not grow with
 *    the number of bars;
 *  - normals from the tetrahedron trick (4 taps);
 *  - soft shadows with the improved penumbra estimate;
 *  - ambient occlusion from 5 taps along the normal;
 *  - a glossy mirror floor and semi-gloss bars, each with one reflection bounce
 *    (Schlick fresnel, reflections fade with the distance they travelled);
 *  - the bars are light sources too: they tint the floor around them.
 */
export const RAYMARCH_FRAGMENT_SHADER = `#version 300 es
precision highp float;

#define MAX_BARS 128

uniform vec2 uRes;
uniform vec3 uEye;
uniform vec3 uTarget;
uniform float uFocal;          // 1 / tan(fov / 2)
uniform float uTime;
uniform int uBands;
uniform float uPitch;          // centre to centre
uniform float uHalf;           // half the width of a bar
uniform float uHalfZ;          // half its depth
uniform float uMaxH;           // the tallest a bar gets
uniform float uLoud;           // 0..1 how loud the mix is
uniform vec2 uBars[MAX_BARS];  // x: bar height, y: peak marker height

layout(location = 0) out vec4 outColor;   // the scene, without the floor's reflection
layout(location = 1) out vec4 outRefl;    // just the floor's reflection, to be blurred

vec3 gRefl = vec3(0.0);
float gShadow = 1.0;   // the floor's shadow term at the primary hit

const float CAP_HALF = 0.03;
const float CAP_GAP = 0.07;
const vec3 BG = vec3(0.0006, 0.0008, 0.0016);

// ---------------------------------------------------------------- geometry --

float cellX(int i) {
  return (float(i) - float(uBands - 1) * 0.5) * uPitch;
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

/** Upright cylinder of radius r and half-height hh, edges rounded by rb (iq). */
float sdRoundCylinder(vec3 p, float r, float hh, float rb) {
  vec2 d = vec2(length(p.xz) - r + rb, abs(p.y) - hh + rb);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rb;
}

/** Distance to the bars and their peak caps: (distance, 2 * bar + (cap ? 1 : 0)). */
vec2 mapBars(vec3 p) {
  float fi = p.x / uPitch + float(uBands) * 0.5;
  int i0 = int(floor(fi));
  int i1 = i0 + (fract(fi) > 0.5 ? 1 : -1);
  vec2 best = vec2(1e5, 0.0);
  for (int k = 0; k < 2; k++) {
    int i = k == 0 ? i0 : i1;
    if (i < 0 || i >= uBands) continue;
    vec2 hp = uBars[i];
    vec3 q = p - vec3(cellX(i), 0.0, 0.0);
    // The box runs a little below the floor so its rounded foot is hidden.
    float h = hp.x;
    float hh = (h + 0.05) * 0.5;
    float db = sdRoundCylinder(
      q - vec3(0.0, (h - 0.05) * 0.5, 0.0),
      uHalf,
      hh,
      min(0.03, min(uHalf, hh) * 0.5));
    float dc = sdRoundCylinder(
      q - vec3(0.0, hp.y + CAP_GAP, 0.0),
      uHalf,
      CAP_HALF,
      0.02);
    if (db < best.x) best = vec2(db, float(i * 2));
    if (dc < best.x) best = vec2(dc, float(i * 2 + 1));
  }
  return best;
}

/** The row's bounding box; false when the ray misses it. */
bool rowBox(vec3 ro, vec3 rd, out float t0, out float t1) {
  float w = float(uBands) * uPitch * 0.5 + 0.1;
  vec3 lo = vec3(-w, -0.1, -uHalfZ - 0.1);
  vec3 hi = vec3(w, uMaxH + 0.25, uHalfZ + 0.1);
  vec3 inv = 1.0 / rd;
  vec3 a = (lo - ro) * inv;
  vec3 b = (hi - ro) * inv;
  vec3 tn = min(a, b);
  vec3 tf = max(a, b);
  t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
  t1 = min(tf.x, min(tf.y, tf.z));
  return t1 > t0;
}

struct Hit {
  float t;
  int mat;       // 0 sky, 1 floor, 2 bar, 3 peak cap
  int bar;
};

Hit trace(vec3 ro, vec3 rd, int steps) {
  Hit h = Hit(1e4, 0, 0);
  // The floor is a plane: no marching.
  if (rd.y < -1e-4) {
    float tf = -ro.y / rd.y;
    if (tf > 0.0) h = Hit(tf, 1, 0);
  }
  float t0, t1;
  if (!rowBox(ro, rd, t0, t1)) return h;
  t1 = min(t1, h.t);
  float t = t0;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec2 d = mapBars(ro + rd * t);
    if (d.x < 0.0004 * t) {
      float code = d.y;
      int bar = int(code * 0.5);
      return Hit(t, (code - float(bar * 2)) > 0.5 ? 3 : 2, bar);
    }
    t += d.x;
    if (t > t1) break;
  }
  return h;
}

vec3 barNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0006;
  return normalize(
    k.xyy * mapBars(p + k.xyy * e).x +
    k.yyx * mapBars(p + k.yyx * e).x +
    k.yxy * mapBars(p + k.yxy * e).x +
    k.xxx * mapBars(p + k.xxx * e).x);
}

// ---------------------------------------------------------------- lighting --

/**
 * Soft shadow from the row of bars. They are a thin comb (almost no depth), so
 * instead of marching, look where the light ray passes through that slab: the
 * ray crosses it over a short stretch, so take the closest approach to a bar
 * over a few points of that stretch. The penumbra widens with the distance to
 * the slab, like a real area light. Smooth, and it cannot step over a gap.
 */
float softShadow(vec3 ro, vec3 rd, float mint, float k) {
  if (rd.z > -1e-3) return 1.0;   // the light is not on the far side of the row
  float dmin = 1e5;
  float tMid = max(-ro.z / rd.z, 0.0);
  for (int i = 0; i < 9; i++) {
    float z = mix(-uHalfZ, uHalfZ, float(i) / 8.0);
    float t = (z - ro.z) / rd.z;
    if (t < mint) continue;
    dmin = min(dmin, mapBars(ro + rd * t).x);
  }
  float w = 0.004 + 0.11 * tMid * k / 12.0;
  float res = smoothstep(-w, w, dmin);
  return res;
}

/** Five taps along the normal (iq). The floor counts as an occluder. */
float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.015 + 0.30 * float(i) / 4.0;
    float d = min(mapBars(p + n * h).x, p.y + n.y * h);
    occ += (h - d) * sca;
    sca *= 0.9;
  }
  return clamp(1.0 - 1.8 * occ, 0.0, 1.0);
}

vec3 rainbow(float t) {
  vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t * 0.9 + vec3(0.02, 0.36, 0.68)));
  c = mix(vec3(dot(c, vec3(0.3333))), c, 1.25);
  return pow(clamp(c, 0.0, 1.0), vec3(2.2));   // authored on screen, lit in linear
}

vec3 barColour(int i) {
  return rainbow(uBands > 1 ? float(i) / float(uBands - 1) : 0.0);
}

/** Light the bars throw on the floor around them: their own colour, by level. */
vec3 floorGlow(vec3 p) {
  float fi = p.x / uPitch + float(uBands) * 0.5;
  int i0 = int(floor(fi));
  vec3 sum = vec3(0.0);
  float dz = max(abs(p.z) - uHalfZ, 0.0);
  for (int k = -5; k <= 5; k++) {
    int i = i0 + k;
    if (i < 0 || i >= uBands) continue;
    float level = uBars[i].x / uMaxH;
    float dx = max(abs(p.x - cellX(i)) - uHalf, 0.0);
    float d2 = dx * dx + dz * dz;
    sum += barColour(i) * level * (0.55 * exp(-d2 * 14.0) + 0.25 * exp(-d2 * 3.0));
  }
  return sum * (40.0 / float(uBands));   // the same light however many bars share it
}

// -------------------------------------------------------------------- sky --

// Low in the sky and behind the row, so the clouds are backlit and the disc is in view.
const vec3 SKY_SUN = normalize(vec3(-0.45, 0.2, -0.87));
const float CLOUD_LO = 30.0;
const float CLOUD_HI = 52.0;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float a = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += a * valueNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return sum;
}

/** Cloud density in a slab: noise thresholded into puffs, rounded off top and bottom. */
float cloudDensity(vec3 p) {
  float h = (p.y - CLOUD_LO) / (CLOUD_HI - CLOUD_LO);
  float profile = smoothstep(0.0, 0.25, h) * (1.0 - smoothstep(0.5, 1.0, h));
  vec2 wind = vec2(uTime * 0.35, uTime * 0.12);
  float n = fbm(p.xz * 0.011 + wind * 0.05 + p.y * 0.004);
  return clamp((n - (0.56 - 0.05 * uLoud)) * 3.6, 0.0, 1.0) * profile;
}

/** The sky without clouds: a blue gradient warming to the horizon, and the sun. */
vec3 skyBase(vec3 rd) {
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 zenith = vec3(0.004, 0.018, 0.10);
  vec3 horizon = vec3(0.07, 0.12, 0.26);
  vec3 col = mix(horizon, zenith, pow(up, 0.45));
  float sun = max(dot(rd, SKY_SUN), 0.0);
  col += vec3(1.0, 0.75, 0.45) * (pow(sun, 10.0) * 0.06 + pow(sun, 80.0) * 0.25);
  col += vec3(1.2, 1.0, 0.8) * smoothstep(0.9994, 0.9998, sun);   // the disc
  return col;
}

/**
 * Clouds against the blue: march a slab at altitude, a few steps each (fewer for
 * reflections, which are blurred anyway), lit from the sun side by comparing the
 * density here with a little towards the sun (iq's cheap directional light).
 */
vec3 background(vec3 rd, int steps) {
  vec3 col = skyBase(rd);
  if (rd.y < 0.015) return col;
  float t0 = (CLOUD_LO - 1.0) / rd.y;
  float t1 = (CLOUD_HI - 1.0) / rd.y;
  float dt = (t1 - t0) / float(steps);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= steps || trans < 0.02) break;
    float t = t0 + dt * (float(i) + jitter);
    vec3 p = vec3(0.0, 1.0, 0.0) + rd * t;
    float d = cloudDensity(p);
    if (d > 0.01) {
      float ds = cloudDensity(p + SKY_SUN * 3.0);
      float lit = clamp((d - ds) * 2.0 + 0.55, 0.0, 1.0);
      vec3 cloud = mix(vec3(0.05, 0.08, 0.17), vec3(0.75, 0.50, 0.40), lit);   // shadowed blue-grey to sunlit cream
      float a = clamp(d * dt * 0.03, 0.0, 1.0);
      acc += trans * a * cloud;
      trans *= 1.0 - a;
    }
  }
  // Far clouds melt into the haze at the horizon.
  float haze = exp(-t0 * 0.0018);
  vec3 sky = col;
  return sky * mix(1.0, trans, haze) + acc * haze;
}

vec3 background(vec3 rd) {
  return background(rd, 14);
}

/**
 * What a mirror sees that is not geometry: the dark backdrop plus a studio of
 * soft boxes (warm key, cool strip, rim behind), so a glossy surface has
 * something to reflect. The camera never sees these, only reflections do.
 */
vec3 environment(vec3 rd) {
  vec3 softKey = vec3(1.0, 0.92, 0.8) * pow(max(dot(rd, normalize(vec3(-0.5, 0.75, 0.35))), 0.0), 7.0) * 2.4;
  vec3 strip = vec3(0.6, 0.8, 1.0) * pow(max(dot(rd, normalize(vec3(0.75, 0.35, 0.55))), 0.0), 14.0) * 1.6;
  vec3 rim = vec3(0.9, 0.9, 1.0) * pow(max(dot(rd, normalize(vec3(0.0, 0.35, -1.0))), 0.0), 30.0) * 0.8;
  return background(rd, 4) + softKey * 0.5 + strip + rim;
}

const vec3 KEY = normalize(vec3(-0.55, 0.6, -0.55));
const vec3 FILL = normalize(vec3(0.5, 0.35, 0.8));
const vec3 RIM = normalize(vec3(0.1, 0.45, -1.0));

/**
 * The lit colour of a surface point, and how mirror-like it is (refl, 0..1).
 * The second bounce runs without shadows and occlusion.
 */
vec3 shade(vec3 p, vec3 rd, Hit h, bool full, out vec3 n, out float refl) {
  vec3 v = -rd;
  vec3 col;
  float ao = 1.0;
  if (h.mat == 1) {
    n = vec3(0.0, 1.0, 0.0);
    float r = length(p.xz * vec2(0.45, 1.0));
    float pool = exp(-r * r * 0.05) * (0.6 + 0.8 * uLoud);
    // Faint tiles, so the mirror has something to show perspective with.
    vec2 g = abs(fract(p.xz * 0.5 + 0.5) - 0.5);
    float w = 0.012 + 0.0025 * h.t;
    float line = 1.0 - smoothstep(0.0, w * 2.0, min(g.x, g.y));
    vec3 albedo = vec3(0.012, 0.015, 0.024) * (1.0 + 0.6 * pool) + vec3(0.010, 0.014, 0.026) * line * pool;
    float shadow = full ? softShadow(p + n * 0.002, KEY, 0.01, 10.0) : 1.0;
    ao = full ? ambientOcclusion(p, n) : 1.0;
    float key = max(dot(n, KEY), 0.0) * shadow;
    col = albedo * (0.1 * ao + 3.2 * key * vec3(1.0, 0.95, 0.9)) + vec3(0.001, 0.0012, 0.002) * pool * ao;
    col += floorGlow(p) * ao * 0.9;
    // A shadow reads as a shadow only if the glow does not wash it out: dim all of it.
    if (full) { gShadow = shadow; col *= mix(0.35, 1.0, shadow); }
    col = mix(col, background(rd), 1.0 - exp(-h.t * h.t * 0.0012));
    float f = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    refl = mix(0.22, 1.0, f) * 0.85 * (1.0 - smoothstep(6.0, 15.0, length(p.xz)));
    return col;
  }

  n = barNormal(p);
  bool cap = h.mat == 3;
  vec3 albedo = barColour(h.bar);
  if (full) ao = ambientOcclusion(p, n);
  float shadow = full ? softShadow(p + n * 0.01, KEY, 0.04, 12.0) : 1.0;
  float key = max(dot(n, KEY), 0.0) * shadow;
  float fill = max(dot(n, FILL), 0.0);
  float rim = max(dot(n, RIM), 0.0);
  vec3 hv = normalize(KEY + v);
  float spec = pow(max(dot(n, hv), 0.0), 70.0) * 0.8 * shadow;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float height = clamp(p.y / uMaxH, 0.0, 1.0);

  col = albedo * (0.07 * ao + 1.25 * key * ao * vec3(1.0, 0.96, 0.92)
                  + 0.6 * fill * vec3(0.75, 0.88, 1.0) * ao + 0.3 * rim * ao);
  col += vec3(spec);
  // Self-light, so a colour is never dead, brighter towards the tip.
  col += albedo * (0.10 + 0.22 * height) * (cap ? 2.5 : 1.0);
  col += albedo * fres * 0.25;
  if (cap) col = mix(col * 1.5, vec3(1.0), 0.1) + albedo * 0.35;   // bright, but still the bar's colour
  refl = cap ? mix(0.3, 0.6, fres) : mix(0.14, 0.6, fres);
  return col;
}

/** What a ray sees after a mirror: the lit surface it lands on, without shadows or occlusion. */
vec3 secondary(vec3 ro, vec3 rd, out float t) {
  Hit h = trace(ro, rd, 56);
  t = h.t;
  if (h.mat == 0) return background(rd, 5);
  vec3 n;
  float refl;
  vec3 local = shade(ro + rd * h.t, rd, h, false, n, refl);
  return local * (1.0 - refl);
}

vec3 render(vec3 ro, vec3 rd) {
  vec3 col = vec3(0.0);
  vec3 through = vec3(1.0);
  for (int bounce = 0; bounce < 2; bounce++) {
    Hit h = trace(ro, rd, bounce == 0 ? 96 : 56);
    if (h.mat == 0) {
      col += through * (bounce == 0 ? background(rd) : environment(rd));
      break;
    }
    vec3 p = ro + rd * h.t;
    vec3 n;
    float refl;
    vec3 local = shade(p, rd, h, bounce == 0, n, refl);
    if (bounce == 0 && h.mat == 1) {
      // The floor's mirror goes to its own buffer: the renderer blurs it (more
      // the further it is from the contact line) and adds it back.
      col += through * local * (1.0 - refl);
      float td;
      vec3 seen = secondary(p + n * 0.003, reflect(rd, n), td);
      gRefl = refl * exp(-min(td, 12.0) * 0.02) * seen * mix(0.45, 1.0, gShadow);
      break;
    }
    if (bounce == 1) refl = 0.0;
    col += through * local * (1.0 - refl);
    if (refl < 0.01) break;
    // What the mirror shows fades with the distance it travelled.
    through *= refl * exp(-h.t * 0.02);
    rd = reflect(rd, n);
    ro = p + n * 0.003;
  }
  return col;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (2.0 * frag - uRes) / uRes.y;
  vec3 ww = normalize(uTarget - uEye);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + uFocal * ww);

  vec3 col = render(uEye, rd);

  // Soft shoulder, vignette, gamma, and a little noise against banding in the dark.
  vec2 q = frag / uRes;
  float vignette = 0.55 + 0.45 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.25);
  col = pow(max(col / (1.0 + col * 0.18) * vignette, 0.0), vec3(1.0 / 2.2));
  vec3 refl = pow(max(gRefl / (1.0 + gRefl * 0.18) * vignette, 0.0), vec3(1.0 / 2.2));
  float n = fract(sin(dot(frag, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
  outRefl = vec4(refl, 1.0);
}
`;

/**
 * Scene plus the blurred floor reflection. The reflection is sharp where it
 * meets the bars' feet and gives way to the blur further below the contact
 * line (uBaseV, the v of that line), so it reads as a glossy, not a smeared, floor.
 */
export const RAYMARCH_COMBINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform float uBaseV;
uniform float uStrength;
out vec4 outColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  float below = max(0.0, uBaseV - vUv.y);
  vec3 refl = mix(texture(uSharp, vUv).rgb, texture(uBlur, vUv).rgb, smoothstep(0.0, 0.3, below) * 0.9 + 0.1);
  outColor = vec4(scene + refl * uStrength * exp(-below * 2.5), 1.0);
}
`;
