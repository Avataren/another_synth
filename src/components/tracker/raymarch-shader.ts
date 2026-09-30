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
 * The classic Inigo Quilez kit, on a row of rounded octagonal prisms above a glossy floor:
 *
 *  - an octagonal-prism distance, evaluated for the cell under the point and
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
uniform float uSeaLift;        // how far above y = 0 the sea's mean level sits
uniform vec2 uBars[MAX_BARS];  // x: bar height, y: peak marker height

// The sky's clock (see sky-cycle.ts): directions and light colours of the sun and moon, etc.
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;        // light from the sun, reddened by its air path; 0 below the horizon
uniform vec3 uMoonColor;
uniform vec3 uKeyDir;          // the brighter of the two: what the clouds are lit by
uniform vec3 uKeyColor;
uniform vec3 uAmbient;         // sky light in the shade
uniform float uDay;            // 0 night .. 1 day
uniform float uNight;          // 1 when dark enough for stars
uniform float uAurora;         // 0..1
uniform float uSunE;           // sine of the sun's elevation

// The bouncing ball: centre and radius, its orientation (ball axes to world), and whether it is on.
uniform vec4 uBall;
uniform mat3 uBallRot;
uniform float uBallOn;

layout(location = 0) out vec4 outColor;   // the scene, without the floor's reflection
layout(location = 1) out vec4 outRefl;    // just the floor's reflection, to be blurred

vec3 gRefl = vec3(0.0);
float gShadow = 1.0;   // the floor's shadow term at the primary hit

const float FOOT = 0.7;
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

/** 2D octagon of apothem r (the distance to a flat side), flats facing the axes (iq). */
float sdOctagon(vec2 p, float r) {
  const vec3 k = vec3(-0.9238795325, 0.3826834323, 0.4142135623);
  p = abs(p);
  p -= 2.0 * min(dot(vec2(k.x, k.y), p), 0.0) * vec2(k.x, k.y);
  p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

/** Upright octagonal prism of apothem r and half-height hh, edges rounded by rb: eight flat faces to mirror things in. */
float sdRoundOctagonPrism(vec3 p, float r, float hh, float rb) {
  vec2 d = vec2(sdOctagon(p.xz, r - rb), abs(p.y) - hh + rb);
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
    float hh = (h + FOOT) * 0.5;   // the feet run down below the deepest trough
    float db = sdRoundOctagonPrism(
      q - vec3(0.0, (h - FOOT) * 0.5, 0.0),
      uHalf,
      hh,
      min(0.02, min(uHalf, hh) * 0.5));
    float dc = sdRoundOctagonPrism(
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

// ------------------------------------------------------------------ ocean --

// Waves after afl_ext (MIT): a sum of exp(sin) ridges in pseudo-random directions, each
// octave a little finer and faster, every ridge dragging the next octave's coordinates
// along with it (which is what makes the crests sharp and the troughs wide). Here the
// gradient comes out of the same loop, so a normal costs no extra samples.
const float WAVE_AMP = 1.0;       // height of the surface per unit of the normalised sum
const float WAVE_MEAN = 0.37;     // what that sum averages (for this SHARP), so the sea sits on its mean level
const float SHARP = 1.5;          // >1 narrows the crests and widens the troughs: crisper waves
const float WAVE_SPEED = 1.4;
const float DRAG = 0.38;
const float WAVE_FREQ = 0.9;

float oceanWaves(vec2 position, int iterations, out vec2 grad) {
  float phase = length(position) * 0.1;
  float iter = 0.0;
  float frequency = WAVE_FREQ;
  float timeMul = WAVE_SPEED;   // fixed: scaling the phase by anything that moves with the music makes the waves jump
  float weight = 1.0;
  float sumValues = 0.0;
  float sumWeights = 0.0;
  grad = vec2(0.0);
  for (int i = 0; i < 20; i++) {
    if (i >= iterations) break;
    vec2 dir = vec2(sin(iter), cos(iter));
    float x = dot(dir, position) * frequency + uTime * timeMul + phase;
    float wave = exp(SHARP * (sin(x) - 1.0));
    float dx = SHARP * wave * cos(x);
    position += dir * (-dx) * weight * DRAG;
    sumValues += wave * weight;
    sumWeights += weight;
    grad += dir * dx * frequency * weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMul *= 1.07;
    iter += 1232.399963;
  }
  grad /= sumWeights;
  return sumValues / sumWeights;
}

/** How much of the wave height is left at this distance: the far sea goes flat, which also stops it shimmering. */
float oceanFade(float dist) {
  return 1.0 - smoothstep(10.0, 40.0, dist);
}

// Rings the bars push out across the water. The phase is the distance to the nearest
// bar at the waterline, straight from the bars' own distance field, so the rings take
// their shape from the bars (octagons near the feet, rounding off further out) and move
// away from them; the height follows how tall the bar is, so a quiet bar leaves the
// water alone and a loud one sets off rings that run into its neighbours'.
const float RIPPLE_AMP = 0.03;
const float RIPPLE_K = 38.0;       // radians per unit: the rings are about 0.17 apart
const float RIPPLE_SPEED = 30.0;   // so they travel about 0.8 units a second
const float RIPPLE_DECAY = 2.4;    // they die away over about a unit

float barLevel(int i) {
  return (i < 0 || i >= uBands) ? 0.0 : uBars[i].x / uMaxH;
}

/**
 * How near the ball is to the water (1 when it is in it, 0 from about a unit above), and
 * the distance from a point of the water to the ring where the ball meets it.
 */
float ballWaterline(vec2 xz, out float near) {
  near = 0.0;
  if (uBallOn < 0.5) return 1e3;
  float centre = uBall.y - uSeaLift;
  near = 1.0 - smoothstep(0.0, 1.2, centre - uBall.w);
  if (near <= 0.0) return 1e3;
  // Radius of the circle the sphere cuts out of the water (zero while it is still above).
  float cut = sqrt(max(uBall.w * uBall.w - max(centre, 0.0) * max(centre, 0.0), 0.0));
  return max(length(xz - uBall.xz) - cut, 0.0);
}

/** Height of the ripples at a point of the water. */
float barRipple(vec2 xz) {
  // The ball's own rings, as it goes in and out of the water.
  float ballNear;
  float dBall = ballWaterline(xz, ballNear);
  float height = 0.0;
  if (ballNear > 0.0) {
    height = 0.06 * ballNear * exp(-dBall * 1.5) * smoothstep(0.0, 0.05, dBall) * sin(24.0 * dBall - uTime * 16.0);
  }
  float rowHalf = float(uBands) * uPitch * 0.5;
  if (abs(xz.y) > 3.0 || abs(xz.x) > rowHalf + 3.0) return height;
  float d = max(mapBars(vec3(xz.x, 0.0, xz.y)).x, 0.0);
  // The level of the bar the point is beside, eased between neighbours so the rings do not jump at cell borders.
  float g = xz.x / uPitch + float(uBands) * 0.5 - 0.5;
  int i0 = int(floor(g));
  float level = mix(barLevel(i0), barLevel(i0 + 1), smoothstep(0.0, 1.0, fract(g)));
  float env = exp(-d * RIPPLE_DECAY) * smoothstep(0.0, 0.05, d);
  return height + RIPPLE_AMP * level * level * env * sin(RIPPLE_K * d - uTime * RIPPLE_SPEED);
}

/** Height of the surface at a point, with few octaves (for finding where a ray meets it). */
float oceanHeight(vec2 xz, float dist) {
  vec2 g;
  float w = oceanWaves(xz, dist < 14.0 ? 8 : 6, g);
  return uSeaLift + (w - WAVE_MEAN) * WAVE_AMP * oceanFade(dist) + barRipple(xz);
}

/** Where a descending ray meets the waves: a few steps of Newton's method from the mean plane. */
float oceanHit(vec3 ro, vec3 rd) {
  float t = (uSeaLift - ro.y) / rd.y;
  if (t > 160.0) return t;   // the horizon: flat
  for (int i = 0; i < 5; i++) {
    vec3 p = ro + rd * t;
    float h = oceanHeight(p.xz, t);
    t += 0.85 * (p.y - h) / -rd.y;
  }
  return max(t, 0.0);
}

struct Hit {
  float t;
  int mat;       // 0 sky, 1 floor, 2 bar, 3 peak cap, 4 the ball
  int bar;
};

Hit trace(vec3 ro, vec3 rd, int steps, bool waves) {
  Hit h = Hit(1e4, 0, 0);
  // The sea is a few Newton steps; what a mirror looks at (waves false) gets the flat plane.
  if (rd.y < -1e-4) {
    float tf = waves ? oceanHit(ro, rd) : (uSeaLift - ro.y) / rd.y;
    if (tf > 0.0) h = Hit(tf, 1, 0);
  }
  // The ball is a sphere: no marching either.
  if (uBallOn > 0.5) {
    vec3 oc = ro - uBall.xyz;
    float b = dot(oc, rd);
    float disc = b * b - (dot(oc, oc) - uBall.w * uBall.w);
    if (disc > 0.0) {
      float tb = -b - sqrt(disc);
      if (tb > 1e-3 && tb < h.t) h = Hit(tb, 4, 0);
    }
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
  // A shadow this far from its caster is a long smear, not a shadow: let it fade out
  // with the distance the light travels to the bars, so it stays near their feet.
  return 1.0 - (1.0 - res) * exp(-tMid * 0.5);
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

const float CLOUD_LO = 30.0;
const float CLOUD_HI = 52.0;
const vec3 BETA_R = vec3(0.037, 0.087, 0.212);   // Rayleigh scattering per air mass: blue scatters most

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
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

/**
 * Single scattering of light \`e\` (already reddened on its way in) from direction
 * \`l\`, seen along \`rd\`: Rayleigh (blue sky, more of it along a long air path),
 * Mie haze round the light, and a cheat for multiple scattering, which whitens
 * the sky towards the horizon. Away from the light the colour of the light is
 * closer to its unreddened self, which is what puts blue on the far side of a sunset.
 */
vec3 scatter(vec3 rd, vec3 l, vec3 e) {
  float up = max(rd.y, 0.0);
  float am = min(1.0 / (up + 0.1), 10.0);
  vec3 fex = exp(-BETA_R * am * 0.6);
  float mu = dot(rd, l);
  float phaseR = 0.4 + 0.45 * (1.0 + mu * mu);
  float g = 0.76;
  float phaseM = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.018;
  vec3 white = vec3(dot(e, vec3(0.3, 0.5, 0.2))) * vec3(1.0, 0.96, 0.9);
  vec3 eff = mix(white, e, pow(clamp(0.5 + 0.5 * mu, 0.0, 1.0), 3.0));
  vec3 col = eff * (1.0 - fex) * phaseR * 0.5;
  col += e * phaseM * exp(-up * 4.0);
  float hazeWhite = smoothstep(0.0, 1.0, am / 10.0) * 0.55;
  return mix(col, vec3(luma(col)) * vec3(1.0, 0.97, 0.92), hazeWhite) * 0.22;
}

/** The moon's disc, with its dark seas, lit face on. */
vec3 moonDisc(vec3 rd) {
  float c = dot(rd, uMoonDir);
  vec3 col = uMoonColor * (pow(max(c, 0.0), 220.0) * 0.12 + pow(max(c, 0.0), 24.0) * 0.008);
  if (c > 0.9994) {
    vec3 right = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, uMoonDir);
    vec2 uv = vec2(dot(rd, right), dot(rd, up)) / 0.034;
    float seas = fbm(uv * 2.2 + 3.0);
    float craters = valueNoise(uv * 14.0);
    vec3 surface = mix(vec3(0.85, 0.87, 0.92), vec3(0.42, 0.45, 0.52), smoothstep(0.42, 0.62, seas));
    surface *= 0.85 + 0.3 * craters;
    surface *= 0.55 + 0.45 * sqrt(max(1.0 - dot(uv, uv), 0.0));
    col += uMoonColor * 2.6 * surface * smoothstep(0.9994, 0.99965, c);
  }
  return col;
}

/** Sky, sun, moon and twilight, without clouds, stars or aurora. */
vec3 skyBase(vec3 rd) {
  float up = clamp(rd.y, 0.0, 1.0);
  // What is left of the light after the sun has gone: a deep blue, brighter low down.
  vec3 col = uAmbient * vec3(0.55, 0.75, 1.3) * (0.5 + 0.5 * pow(1.0 - up, 2.0));
  col += scatter(rd, uSunDir, uSunColor);
  col += scatter(rd, uMoonDir, uMoonColor) * 0.035;

  // Twilight: an orange-to-violet band on the horizon, strongest towards the sun.
  float tw = smoothstep(-0.25, 0.0, uSunE) * (1.0 - smoothstep(0.0, 0.25, uSunE));
  float toward = pow(max(dot(normalize(rd.xz + 1e-4), normalize(uSunDir.xz)), 0.0), 2.0);
  col += vec3(1.0, 0.36, 0.12) * exp(-up * 7.0) * toward * tw * 0.55;
  col += vec3(0.30, 0.10, 0.38) * exp(-up * 3.0) * tw * 0.22;

  // The sun: a disc, a corona and a glare.
  float mu = dot(rd, uSunDir);
  col += uSunColor * (pow(max(mu, 0.0), 12.0) * 0.012 + pow(max(mu, 0.0), 200.0) * 0.06);
  col += uSunColor * 1.6 * smoothstep(0.9994, 0.9998, mu);
  col += moonDisc(rd);
  return col;
}

/** Points of light on a sphere: one star, or none, per cell of a 3D lattice. */
vec3 stars(vec3 rd) {
  float a = uTime * 0.006;
  rd.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * rd.xz;
  vec3 q = rd * 70.0;
  vec3 id = floor(q);
  float h = hash31(id);
  if (h > 0.07) return vec3(0.0);
  vec3 off = (hash33(id) - 0.5) * 0.5;
  float d = length(fract(q) - 0.5 - off);
  float mag = pow(hash31(id + 7.1), 3.0);
  float twinkle = 0.75 + 0.25 * sin(uTime * (2.0 + h * 90.0) + h * 600.0);
  float s = smoothstep(0.2, 0.0, d) * (0.8 + 6.0 * mag) * twinkle;
  vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.7, 0.82, 1.0), hash31(id + 3.3));
  return tint * s;
}

/**
 * A shooting star now and then: every few seconds a slot may hold one, a short
 * bright streak (thin, brightest at the head) crossing a patch of sky in about a second.
 */
vec3 meteors(vec3 rd) {
  const float period = 7.0;
  float slot = floor(uTime / period);
  float life = uTime - slot * period;
  vec3 h = hash33(vec3(slot, 12.7, 3.1));
  if (h.x > 0.6 || life > 1.1) return vec3(0.0);
  vec3 h2 = hash33(vec3(slot, 91.3, 7.7));
  vec3 s0 = normalize(vec3(mix(-0.7, 0.7, h.y), mix(0.08, 0.3, h.z), -1.0));
  vec3 vel = normalize(vec3(mix(-1.0, 1.0, h2.x), -mix(0.25, 0.7, h2.y), 0.0));
  vec3 head = normalize(s0 + vel * life * 0.45);
  vec3 tail = normalize(s0 + vel * max(life - 0.3, 0.0) * 0.45);
  vec3 pa = rd - tail;
  vec3 ba = head - tail;
  float along = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * along);
  float fade = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.8, 1.1, life));
  float width = 0.0008 + 0.0014 * along;
  float streak = smoothstep(width, 0.0, d) * along * along;
  return vec3(1.0, 0.95, 0.85) * streak * fade * 7.0;
}

float tri(float x) {
  return clamp(abs(fract(x) - 0.5), 0.01, 0.49);
}

vec2 tri2(vec2 p) {
  return vec2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x)));
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

/** Folded triangle-wave noise that draws the aurora's curtains (nimitz). */
float curtainNoise(vec2 p, float speed) {
  float z = 1.8;
  float z2 = 2.5;
  float rz = 0.0;
  p *= rot(p.x * 0.06);
  vec2 bp = p;
  for (int i = 0; i < 5; i++) {
    vec2 dg = tri2(bp * 1.85) * 0.75;
    dg *= rot(uTime * speed);
    p -= dg / z2;
    bp *= 1.3;
    z2 *= 0.45;
    z *= 0.42;
    p *= 1.21 + (rz - 1.0) * 0.02;
    rz += tri(p.x + tri(p.y)) * z;
    p *= -mat2(0.95534, 0.29552, -0.29552, 0.95534);
  }
  return clamp(1.0 / pow(rz * 29.0, 1.3), 0.0, 0.55);
}

/** Aurora: stacked layers of the noise, green at the foot shading to violet above. */
vec3 aurora(vec3 rd, int steps) {
  vec4 col = vec4(0.0);
  vec4 avg = vec4(0.0);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float scale = 12.0 / float(steps);
  for (int i = 0; i < 12; i++) {
    if (i >= steps) break;
    float fi = float(i) * scale;
    float pt = ((0.8 + pow(fi, 1.4) * 0.002)) / (rd.y * 2.0 + 0.4);
    pt -= jitter * 0.006 * smoothstep(0.0, 15.0, fi);
    vec2 p = (pt * rd).zx;
    float rzt = curtainNoise(p, 0.06);
    vec4 layer = vec4((sin(1.0 - vec3(2.15, -0.5, 1.2) + fi * 0.043) * 0.5 + 0.5) * rzt, rzt);
    avg = mix(avg, layer, 0.5);
    col += avg * exp2(-fi * 0.065 - 2.5) * smoothstep(0.0, 5.0, fi) * scale;
  }
  return col.rgb * clamp(rd.y * 15.0 + 0.4, 0.0, 1.0) * 1.0;
}

/** Cloud density in a slab: noise thresholded into puffs, rounded off top and bottom. */
float cloudDensity(vec3 p) {
  float h = (p.y - CLOUD_LO) / (CLOUD_HI - CLOUD_LO);
  float profile = smoothstep(0.0, 0.25, h) * (1.0 - smoothstep(0.5, 1.0, h));
  vec2 wind = vec2(uTime * 0.35, uTime * 0.12);
  float n = fbm(p.xz * 0.011 + wind * 0.05 + p.y * 0.004);
  return clamp((n - (0.56 + 0.05 * uNight - 0.05 * uLoud)) * 3.6, 0.0, 1.0) * profile;
}

/**
 * The whole sky: scattering, sun and moon, then stars and aurora on the night
 * side, then clouds marched through a slab, a few steps each (fewer for
 * reflections, which are blurred anyway), lit from the brighter of sun and moon
 * by comparing the density here with a little towards the light (iq's cheap
 * directional light).
 */
vec3 background(vec3 rd, int steps) {
  vec3 col = skyBase(rd);
  if (rd.y < 0.0) return col;
  if (uNight > 0.02) {
    float moonGlare = 1.0 - 0.85 * pow(max(dot(rd, uMoonDir), 0.0), 6.0) * smoothstep(-0.05, 0.1, uMoonDir.y);
    float fade = uNight * smoothstep(0.0, 0.12, rd.y) * moonGlare;
    col += (stars(rd) + meteors(rd)) * fade;
    if (uAurora > 0.02) col += aurora(rd, steps > 8 ? 10 : 4) * uAurora * uNight;
  }
  if (rd.y < 0.015) return col;   // clouds are too far to march this close to the horizon
  float t0 = (CLOUD_LO - 1.0) / rd.y;
  float t1 = (CLOUD_HI - 1.0) / rd.y;
  float dt = (t1 - t0) / float(steps);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 litCloud = uSunColor * 0.28 + uMoonColor * 0.06 + uAmbient * 0.6;
  vec3 shadedCloud = uAmbient * vec3(0.8, 0.95, 1.25);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= steps || trans < 0.02) break;
    float t = t0 + dt * (float(i) + jitter);
    vec3 p = vec3(0.0, 1.0, 0.0) + rd * t;
    float d = cloudDensity(p);
    if (d > 0.01) {
      float ds = cloudDensity(p + uKeyDir * 3.0);
      float lit = clamp((d - ds) * 2.0 + 0.55, 0.0, 1.0);
      float a = clamp(d * dt * 0.03, 0.0, 1.0);
      acc += trans * a * mix(shadedCloud, litCloud, lit);
      trans *= 1.0 - a;
    }
  }
  // Far clouds melt into the haze at the horizon.
  float haze = exp(-t0 * 0.0018);
  return col * mix(1.0, trans, haze) + acc * haze;
}

vec3 background(vec3 rd) {
  return background(rd, 14);
}

/**
 * What a mirror sees that is not geometry: the sky, plus a dim studio of soft
 * boxes (warm key, cool strip, rim behind) so a glossy surface always has
 * something to catch. The camera never sees these, only reflections do.
 */
vec3 environment(vec3 rd) {
  vec3 softKey = vec3(1.0, 0.92, 0.8) * pow(max(dot(rd, normalize(vec3(-0.5, 0.75, 0.35))), 0.0), 7.0) * 1.2;
  vec3 strip = vec3(0.6, 0.8, 1.0) * pow(max(dot(rd, normalize(vec3(0.75, 0.35, 0.55))), 0.0), 14.0) * 0.8;
  vec3 rim = vec3(0.9, 0.9, 1.0) * pow(max(dot(rd, normalize(vec3(0.0, 0.35, -1.0))), 0.0), 30.0) * 0.4;
  return background(rd, 4) + (softKey + strip + rim) * (0.3 + 0.7 * uDay);
}

const vec3 FILL = normalize(vec3(0.5, 0.35, 0.8));
const vec3 RIM = normalize(vec3(0.1, 0.45, -1.0));

/** Soft shadow of a sphere (iq): the penumbra comes from how near the ray passes to it. */
float sphereShadow(vec3 ro, vec3 rd, vec4 sph, float k) {
  vec3 oc = ro - sph.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - sph.w * sph.w;
  float h = b * b - c;
  float d = sqrt(max(0.0, sph.w * sph.w - h)) - sph.w;
  float t = -b - sqrt(max(h, 0.0));
  return t < 0.0 ? 1.0 : smoothstep(0.0, 1.0, 2.5 * k * d / t);
}

/**
 * Light from the sun and from the moon on a surface point: each one's colour
 * times n.l times its own shadow (a light that is down, or facing away, costs
 * nothing). \`shadowMix\` is the shadow averaged over the two by how much light
 * each brings, and \`spec\` their Blinn highlights.
 */
vec3 bodyLight(vec3 p, vec3 n, vec3 v, bool full, float offset, float mint, float k, bool ballShadow,
               out float shadowMix, out vec3 spec) {
  vec3 sum = vec3(0.0);
  spec = vec3(0.0);
  float weights = 0.0;
  float shadowed = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 l = i == 0 ? uSunDir : uMoonDir;
    vec3 e = i == 0 ? uSunColor : uMoonColor;
    float nl = max(dot(n, l), 0.0);
    float lum = luma(e);
    if (nl <= 0.0 || lum < 0.003) continue;
    float s = full ? softShadow(p + n * offset, l, mint, k) : 1.0;
    if (full && ballShadow && uBallOn > 0.5) s *= sphereShadow(p + n * offset, l, uBall, 7.0);
    sum += e * nl * s;
    spec += e * pow(max(dot(n, normalize(l + v)), 0.0), 70.0) * 0.25 * s;
    weights += lum * nl;
    shadowed += lum * nl * s;
  }
  shadowMix = weights > 0.0 ? shadowed / weights : 1.0;
  return sum;
}

/**
 * The lit colour of a surface point, and how mirror-like it is (refl, 0..1).
 * The second bounce runs without shadows and occlusion.
 */
vec3 shade(vec3 p, vec3 rd, Hit h, bool full, out vec3 n, out float refl) {
  vec3 v = -rd;
  vec3 col;
  float ao = 1.0;
  float shadow;
  vec3 spec;
  if (h.mat == 1) {
    // The sea: a wave normal (flat for what only a mirror sees), flattened with distance.
    n = vec3(0.0, 1.0, 0.0);
    float crest = 0.4;
    {
      vec2 g;
      // Full detail only for what the camera looks at; a mirror off a bar gets the broad shape of the waves, which reads as a gradient, not noise.
      float w = oceanWaves(p.xz, !full ? 6 : (h.t < 18.0 ? 18 : 10), g);
      float fade = oceanFade(h.t);
      n = normalize(vec3(-g.x * WAVE_AMP * fade, 1.0, -g.y * WAVE_AMP * fade));
      n = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.8 * min(1.0, sqrt(h.t * 0.01) * 1.1)));
      crest = clamp((w - 0.25) * 2.4, 0.0, 1.0);
      // The bars' rings tilt the surface too (forward differences of their height).
      const float e = 0.012;
      float r0 = barRipple(p.xz);
      vec2 rg = vec2(barRipple(p.xz + vec2(e, 0.0)) - r0, barRipple(p.xz + vec2(0.0, e)) - r0) / e;
      n = normalize(vec3(n.x - rg.x, n.y, n.z - rg.y));
    }
    vec3 irradiance = bodyLight(p, n, v, full, 0.002, 0.01, 10.0, true, shadow, spec);
    ao = full ? ambientOcclusion(p, vec3(0.0, 1.0, 0.0)) : 1.0;
    // Water's own colour (sky light scattered back up; brighter in the crests) plus the
    // sun and moon on the wave faces. The mirror part is added separately, from the reflection.
    vec3 body = uAmbient * vec3(0.15, 0.4, 0.6) * (0.3 + 0.9 * crest);
    col = body * ao + vec3(0.02, 0.05, 0.08) * irradiance * 0.3;
    col += floorGlow(p) * ao * 0.9;
    // A shadow reads as a shadow only if the glow does not wash it out: dim all of it.
    if (full) { gShadow = shadow; col *= mix(0.25, 1.0, shadow); }
    // Foam where the ball goes into the water: broken up by noise, aqua rather than white, and
    // only as bright as the light on it (dim at night).
    if (full) {
      float ballNear;
      float dBall = ballWaterline(p.xz, ballNear);
      float foam = ballNear * exp(-dBall * 26.0) * (0.25 + 0.75 * valueNoise(p.xz * 24.0 + vec2(uTime * 0.9, 0.0)));
      col += vec3(0.42, 0.68, 0.82) * foam * 0.16 * (0.2 + 0.8 * uDay);
    }
    // A ring of the bar's own colour where it meets the water, brighter for a taller bar.
    if (full && abs(p.z) < 1.0) {
      vec2 near = mapBars(vec3(p.x, 0.0, p.z));
      int bar = int(near.y * 0.5);
      float wet = exp(-max(near.x, 0.0) * 55.0) * (0.15 + barLevel(bar));
      col += barColour(bar) * wet * 1.4;
    }
    // Far water melts into the sky just above the horizon, whatever is there (aurora, haze, clouds).
    // By how close the ray runs to the horizon, not by distance: distance fog is a set of circles
    // round the camera, which show up as big arcs on the floor when the camera is far back.
    float fog = 1.0 - smoothstep(0.0, 0.07, -rd.y);
    fog *= fog;
    if (fog > 0.05) col = mix(col, background(normalize(vec3(rd.x, abs(rd.y) + 0.012, rd.z)), 4), fog);
    // Schlick fresnel with water's 2% at normal incidence: looking down you see into it, at a glance a mirror.
    float f = pow(1.0 - max(dot(n, v), 0.0), 5.0);
    refl = (0.02 + 0.98 * f) * (1.0 - fog);   // by the horizon the water is simply the sky
    return col;
  }

  if (h.mat == 4) {
    n = normalize(p - uBall.xyz);
    // The classic chequer: 16 segments round and 8 from pole to pole, so the squares are square at the equator.
    vec3 local = n * uBallRot;
    float lon = atan(local.z, local.x) * (16.0 / 6.2831853);
    float lat = asin(clamp(local.y, -1.0, 1.0)) * (8.0 / 3.14159265);
    float edge = sin(3.14159265 * lon) * sin(3.14159265 * lat);
    float chequer = 0.5 + 0.5 * clamp(edge / (0.12 + 0.012 * h.t), -1.0, 1.0);
    vec3 albedo = mix(vec3(0.8, 0.004, 0.004), vec3(0.85), chequer);
    vec3 irradiance = bodyLight(p, n, v, full, 0.01, 0.05, 12.0, false, shadow, spec);
    col = albedo * (uAmbient * (0.9 + 0.4 * n.y) + irradiance * 0.55 + 0.05);
    col += spec * 2.0;
    // A glossy coat: it mirrors the scene, more at a glancing angle.
    refl = mix(0.28, 0.9, pow(1.0 - max(dot(n, v), 0.0), 4.0));
    return col;
  }

  n = barNormal(p);
  bool cap = h.mat == 3;
  vec3 albedo = barColour(h.bar);
  if (full) ao = ambientOcclusion(p, n);
  vec3 irradiance = bodyLight(p, n, v, full, 0.01, 0.04, 12.0, true, shadow, spec);
  float dayFill = mix(0.25, 1.0, uDay);
  float fill = max(dot(n, FILL), 0.0) * dayFill;
  float rim = max(dot(n, RIM), 0.0) * dayFill;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float height = clamp(p.y / uMaxH, 0.0, 1.0);

  col = albedo * (uAmbient * 0.7 * ao + irradiance * 0.4 * ao
                  + 0.6 * fill * vec3(0.75, 0.88, 1.0) * ao + 0.3 * rim * ao);
  col += spec;
  // Self-light, so a colour is never dead, brighter towards the tip.
  col += albedo * (0.10 + 0.22 * height) * (cap ? 2.5 : 1.0);
  col += albedo * fres * 0.25;
  if (cap) col = mix(col * 1.5, vec3(1.0), 0.1) + albedo * 0.35;   // bright, but still the bar's colour
  refl = cap ? mix(0.4, 0.75, fres) : mix(0.32, 0.8, fres);
  return col;
}

/** What a ray sees after a mirror: the lit surface it lands on, without shadows or occlusion. */
vec3 secondary(vec3 ro, vec3 rd, out float t) {
  Hit h = trace(ro, rd, 56, false);
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
    Hit h = trace(ro, rd, bounce == 0 ? 96 : 56, true);   // the sea is real for mirrors off the bars too
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
      vec3 mirror = reflect(rd, n);
      mirror.y = abs(mirror.y);   // a steep wave can turn a reflection into the water; keep it going up
      vec3 seen = secondary(p + n * 0.003, mirror, td);
      gRefl = refl * exp(-min(td, 12.0) * 0.02) * seen * mix(0.2, 1.0, gShadow);
      break;
    }
    if (bounce == 1) {
      // A mirror off a bar that lands on the sea sees the sea's own reflection of the sky too.
      if (h.mat == 1) {
        vec3 m = reflect(rd, n);
        m.y = abs(m.y);
        local += refl * background(m, 3);
      }
      refl = 0.0;
    }
    col += through * local * (1.0 - refl);
    if (refl < 0.01) break;
    // What the mirror shows fades with the distance it travelled.
    through *= refl * exp(-h.t * 0.02);
    rd = reflect(rd, n);
    ro = p + n * 0.003;
  }
  return col;
}

vec3 encodeHdr(vec3 x) {
  return pow(max(x, 0.0) / (1.0 + max(x, 0.0)), vec3(1.0 / 2.2));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (2.0 * frag - uRes) / uRes.y;
  vec3 ww = normalize(uTarget - uEye);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + uFocal * ww);

  vec3 col = render(uEye, rd);

  // Both targets are 8 bit, so keep the wide range in them: a Reinhard curve
  // under a gamma (dark values keep their precision); the combine pass undoes it.
  outColor = vec4(encodeHdr(col), 1.0);
  outRefl = vec4(encodeHdr(gRefl), 1.0);
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
uniform float uExposure;
out vec4 outColor;

vec3 decodeHdr(vec3 y) {
  vec3 t = pow(y, vec3(2.2));
  return t / max(1.0 - t, 1.0 / 64.0);
}

// ACES filmic (Stephen Hill's fit of the RRT and ODT): a soft shoulder, a little
// contrast in the mids, and bright colours drifting to white instead of clipping.
const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);

vec3 aces(vec3 color) {
  vec3 v = ACES_IN * color;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a / b), 0.0, 1.0);
}

void main() {
  vec3 scene = decodeHdr(texture(uScene, vUv).rgb);
  float below = max(0.0, uBaseV - vUv.y);
  vec3 sharp = decodeHdr(texture(uSharp, vUv).rgb);
  vec3 blur = decodeHdr(texture(uBlur, vUv).rgb);
  vec3 refl = mix(sharp, blur, smoothstep(0.0, 0.3, below) * 0.45 + 0.05);
  vec3 col = scene + refl * uStrength * exp(-below * 1.4);

  float vignette = 0.55 + 0.45 * pow(16.0 * vUv.x * vUv.y * (1.0 - vUv.x) * (1.0 - vUv.y), 0.25);
  col = aces(col * uExposure * vignette);
  col = pow(col, vec3(1.0 / 2.2));
  // A little noise against banding in the dark gradients.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
