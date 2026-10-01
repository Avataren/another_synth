/**
 * GLSL for the spectrum terrain (WebGL2). The spectrum of the last few seconds
 * is a texture, one row per moment and one column per band, newest row nearest
 * the camera; the fragment shader raymarches it as a heightfield, so the music
 * is a landscape that streams away from the viewer. Lit by the same day/night
 * cycle as the raytraced bars. The relief borrows Inigo Quilez's terrain ideas:
 * noise whose detail is damped on steep slopes, a cheap field to march and a
 * fuller one for the normals, rock/moss/snow by height and slope, a sun-tinted fog.
 */

export const TERRAIN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform vec3 uEye;
uniform vec3 uTarget;
uniform float uFocal;          // 1 / tan(fov / 2)
uniform float uTime;

uniform sampler2D uHist;       // R16F: one row per moment (row 0 the newest), one column per band
uniform float uBands;          // columns in use
uniform float uTexW;           // columns in the texture
uniform float uRows;
uniform float uPhase;          // 0..1: how far the newest row has travelled towards the next one
uniform float uScroll;         // total distance the terrain has travelled, for the scenery that moves with it
uniform float uZ0;             // world z of the newest row
uniform float uDz;             // distance between rows
uniform float uHalfW;          // half the width the spectrum is spread over
uniform float uMaxH;           // the tallest a full-scale band gets

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbient;
uniform float uDay;
uniform float uNight;

out vec4 outColor;

const float FAR = 90.0;
// The sea: a plane at this height. Ground below it is seabed.
const float SEA = 0.0;
const mat2 M2 = mat2(0.8, -0.6, 0.6, 0.8);

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Value noise and its analytic derivatives (x: value, yz: gradient).
vec3 noised(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return vec3(a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y,
              6.0 * f * (1.0 - f) * (vec2(b - a, c - a) + (a - b - c + d) * u.yx));
}

float vnoise(vec2 p) {
  return noised(p).x;
}

// 3D value noise: the third axis lets the detail change with height, which a heightfield's 2D noise cannot.
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

float fbm(vec2 p) {
  float f = 0.0;
  p = M2 * p + 13.7;
  f += 0.5000 * vnoise(p); p = M2 * p * 2.02;
  f += 0.2500 * vnoise(p); p = M2 * p * 2.03;
  f += 0.1250 * vnoise(p); p = M2 * p * 2.01;
  f += 0.0625 * vnoise(p);
  return f / 0.9375;
}

// Terrain noise: each octave's weight falls with the slope so far, so steep ground stays smooth and the
// gentle ground gets the fine detail: ridges, gullies and shoulders, not sand ripples.
float relief(vec2 q, int octaves) {
  float a = 0.0;
  float b = 1.0;
  vec2 d = vec2(0.0);
  q = M2 * q;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    vec3 n = noised(q);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5;
    q = M2 * q * 2.0;
  }
  return a;
}

// How loud the music is under a point, 0..1: columns across (mirrored, so the bass is the crest down the
// middle), rows back in time. Fades to nothing at the edges and just ahead of the newest row (so a hit rises almost at once). The oldest row is not faded: the fog takes it.
float loudness(vec2 xz) {
  float dist = uZ0 - xz.y;
  float rowf = max(dist / uDz - uPhase, 0.0);
  float ax = abs(xz.x) / uHalfW;
  // Linear filtering with a smoothstep'd weight: no kinks between bands or rows, so the slope stays marchable.
  vec2 g = vec2(clamp(ax, 0.0, 1.0) * (uBands - 1.0), rowf);
  vec2 i = floor(g);
  vec2 f = g - i;
  f = f * f * (3.0 - 2.0 * f);
  float s = texture(uHist, (i + f + 0.5) / vec2(uTexW, uRows)).r;
  float fade = smoothstep(-0.3, 0.9, dist);
  return s * fade * (1.0 - smoothstep(1.0, 1.6, ax));
}

// The land: rolling ground everywhere, and the music's mountains rising out of it. Both are carried along
// with the rows, so the whole landscape streams past as one.
// How much of the fine detail to show at distance t: all of it up close, none where a pixel would be wider than it.
float detailLod(float t) {
  return 1.0 - smoothstep(4.0, 28.0, t);
}

// High-resolution relief: bumps from a few centimetres to a handful, riding the rows with everything else.
// Each octave is 3D noise taken at the current height, so the bumps change with altitude and drift slowly in time.
float micro(vec2 w, float y) {
  float a = 0.0;
  float b = 0.5;
  w *= 2.5;
  y *= 2.5;
  for (int i = 0; i < 3; i++) {
    a += b * (vnoise3(vec3(w, y + uTime * 0.2)) - 0.5);
    w = M2 * w * 2.1;
    y *= 2.1;
    b *= 0.5;
  }
  return a;
}

float height(vec2 xz, int octaves, float lod) {
  vec2 w = vec2(xz.x, uZ0 - xz.y - uScroll);
  vec2 q = w * 0.14;
  float n = relief(q, octaves);
  // An abyss: the sea is bottomless at the vent (the newest row) and shoals to the normal seabed over ten units, all the
  // way across, so there is no shelf and no trench to give the eruption away. The volcano is a pillar up out of it: at
  // the vent it is level with the abyss floor, and it climbs, breaking the surface about four units out, to its mountain.
  float dist = uZ0 - xz.y;
  float abyss = 40.0 * (1.0 - smoothstep(0.0, 10.0, dist));
  float climb = smoothstep(0.0, 4.0, dist);
  // The lookup is nudged by the relief, along the rows and across the bands: steady music makes near-identical
  // rows, which would otherwise stretch into long straight ridges, one per band, running down the view.
  float L = loudness(xz + vec2((vnoise(q * 2.3 + 9.0) - 0.5) * 1.2, (n - 0.4) * 1.6));
  // The pillar's footprint (wherever the music is audible) rises out of the abyss whatever the level; the level
  // only sets how tall the mountain on top of it stands.
  float pillar = smoothstep(0.02, 0.3, L);
  float h = uMaxH * (0.22 * n - 0.34) - abyss + pillar * abyss * climb + L * uMaxH * (0.25 + 1.3 * n * n) * climb;
  // Craggy ledges: 3D noise with the height so far as its third coordinate, so the displacement depends on altitude.
  h += uMaxH * 0.12 * (vnoise3(vec3(q * 1.7, h * 1.1 + uTime * 0.08)) - 0.5);
  if (lod > 0.0) h += lod * 0.22 * micro(w, h);
  return h;
}

// Sphere tracing the heightfield. A hit is anywhere within a tolerance that grows with distance (a pixel is wider
// there anyway), which lets far rays settle instead of crawling along the surface. A ray that runs out of steps
// or distance while still heading down is over ground we cannot resolve: it counts as ground (the fog takes it).
bool march(vec3 ro, vec3 rd, out float tHit) {
  float t = 0.1;
  float prevT = t;
  float cap = uMaxH * 1.6;
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - max(height(p.xz, 4, detailLod(t)), SEA);
    if (d < 0.0012 * t) {
      if (d < 0.0) {
        float lo = prevT;
        float hi = t;
        for (int j = 0; j < 6; j++) {
          float m = 0.5 * (lo + hi);
          vec3 q = ro + rd * m;
          if (q.y < max(height(q.xz, 4, detailLod(m)), SEA)) hi = m; else lo = m;
        }
        t = 0.5 * (lo + hi);
      }
      tHit = t;
      return true;
    }
    if (p.y > cap && rd.y >= 0.0) return false;
    prevT = t;
    t += clamp(d * 0.4, 0.015 + 0.003 * t, 0.9);
    if (t > FAR) break;
  }
  tHit = min(t, FAR);
  return rd.y < 0.0;
}

vec3 normalAt(vec2 xz, float t, int octaves, float detail) {
  float e = 0.01 + 0.002 * t;
  float lod = detailLod(t) * detail;
  return normalize(vec3(height(xz - vec2(e, 0.0), octaves, lod) - height(xz + vec2(e, 0.0), octaves, lod),
                        2.0 * e,
                        height(xz - vec2(0.0, e), octaves, lod) - height(xz + vec2(0.0, e), octaves, lod)));
}

float shadow(vec3 p, vec3 l, float lod) {
  if (l.y <= 0.01) return 0.0;
  float res = 1.0;
  float t = 0.05;
  for (int i = 0; i < 28; i++) {
    vec3 q = p + l * t;
    if (q.y > uMaxH * 1.6) break;
    float d = q.y - height(q.xz, 4, lod);
    res = min(res, 6.0 * d / t);
    if (res < 0.02) break;
    t += clamp(d, 0.05, 0.8);
  }
  return clamp(res, 0.0, 1.0);
}

// The sky without clouds: also what the fog fades into.
vec3 skyBase(vec3 rd) {
  float y = max(rd.y, 0.0);
  vec3 zenith = mix(vec3(0.003, 0.005, 0.02), vec3(0.10, 0.24, 0.55), uDay);
  vec3 horizon = mix(vec3(0.015, 0.02, 0.05), vec3(0.45, 0.6, 0.8), uDay);
  vec3 c = mix(horizon, zenith, pow(y, 0.45));
  float sd = max(dot(rd, uSunDir), 0.0);
  c += uSunColor * (0.07 * pow(sd, 6.0) + 0.4 * pow(sd, 64.0)) * (1.0 - 0.6 * y);
  return c;
}

vec3 sky(vec3 ro, vec3 rd) {
  vec3 c = skyBase(rd);
  float sd = max(dot(rd, uSunDir), 0.0);
  c += uSunColor * 10.0 * smoothstep(0.9994, 0.9998, sd);
  float md = max(dot(rd, uMoonDir), 0.0);
  c += uMoonColor * (0.04 * pow(md, 24.0) + 6.0 * smoothstep(0.9996, 0.9998, md));
  if (uNight > 0.0 && rd.y > 0.0) {
    vec3 g = floor(rd * 190.0);
    float star = step(0.9965, hash31(g)) * (0.5 + 0.5 * hash31(g + 7.0));
    c += vec3(0.8, 0.85, 1.0) * star * uNight * smoothstep(0.0, 0.15, rd.y);
  }
  if (rd.y > 0.0) {
    // A layer of cloud, drifting, lit by whichever of sun and moon is up.
    vec2 sc = ro.xz + rd.xz * (45.0 - ro.y) / rd.y;
    float cloud = smoothstep(0.5, 0.8, fbm(0.05 * sc + vec2(uTime * 0.02, 0.0)));
    vec3 cloudCol = uAmbient * 5.0 + uKeyColor * 0.35;
    c = mix(c, cloudCol, 0.55 * cloud * smoothstep(0.0, 0.2, rd.y));
  }
  return c;
}

// ---- Procedural materials. All are 3D at the hit point (scrolled xz, and the height), so they do not stretch on
// steep faces. Each fine layer fades out when a pixel's footprint on the ground (fp) outgrows its wavelength.

float fineFade(float wavelength, float fp) {
  return 1.0 - smoothstep(0.35 * wavelength, 1.4 * wavelength, fp);
}

float fbm3(vec3 p, int octaves) {
  float f = 0.0;
  float a = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    f += a * vnoise3(p);
    sum += a;
    p.xz = M2 * p.xz;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return f / sum;
}

vec2 hash22(vec2 p) {
  return vec2(hash21(p), hash21(p + vec2(37.2, 91.7)));
}

// Distance to the nearest cell border of a Voronoi diagram (0 on the border): the cracks between plates.
float voronoiEdge(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 r = g + hash22(i + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

// Pebble-and-sand grain at three high resolutions, each fading out as it gets finer than a pixel. 0..1, 0.5 when absent.
float detailGrain(vec3 q, float fp) {
  return 0.5 * mix(0.5, vnoise3(q * 18.0), fineFade(0.055, fp))
       + 0.3 * mix(0.5, vnoise3(q * 41.0 + 3.7), fineFade(0.024, fp))
       + 0.2 * mix(0.5, vnoise3(q * 93.0 + 9.1), fineFade(0.011, fp));
}

// 3D Voronoi: the distance to the nearest cell border (0 on it), and a random value for the nearest cell.
float voronoiEdge3(vec3 x, out float cellId) {
  vec3 i = floor(x);
  vec3 f = x - i;
  float d1 = 8.0;
  float d2 = 8.0;
  cellId = 0.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int k = -1; k <= 1; k++) {
        vec3 g = vec3(float(k), float(y), float(z));
        vec3 c = i + g;
        vec3 r = g + vec3(hash31(c), hash31(c + 17.3), hash31(c + 41.7)) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; cellId = hash31(c + 7.1); } else if (d < d2) { d2 = d; }
      }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

// Rock: fractured blocks, each its own shade, split by dark fissures; rain streaks running down the faces; thin
// bright mineral veins; lichen on the weathered patches. No banding: it is built from things rock actually does.
vec3 rockTexture(vec3 q, float fp) {
  float mott = fbm3(q * 1.1, 4);
  vec3 base = mix(vec3(0.2, 0.19, 0.18), vec3(0.23, 0.15, 0.085), smoothstep(0.35, 0.65, mott));

  // Blocks: a warped 3D lattice, so the fractures run in every direction and wander.
  vec3 warp = vec3(vnoise3(q * 0.9), vnoise3(q * 0.9 + 4.0), vnoise3(q * 0.9 + 9.0)) - 0.5;
  float cellId;
  float edge = voronoiEdge3(q * 1.7 + 1.6 * warp, cellId);
  float fissure = (1.0 - smoothstep(0.0, 0.1, edge)) * fineFade(0.3, fp);
  vec3 c = base * (0.75 + 0.5 * cellId);
  // Each block is a little lighter towards its middle: it reads as faceted, not flat.
  c *= 0.88 + 0.2 * smoothstep(0.0, 0.5, edge);
  c = mix(c, vec3(0.06, 0.055, 0.055), 0.28 * fissure);

  // Rain streaks: noise stretched along the height, so the dark runs hang down the face.
  float streak = smoothstep(0.5, 0.9, vnoise3(vec3(q.x * 4.5, q.y * 0.3, q.z * 4.5)));
  c *= 1.0 - 0.4 * streak * fineFade(0.22, fp);

  // Mineral veins: thin and pale, along a few long fractures.
  float vein = pow(1.0 - abs(2.0 * vnoise3(q * 1.9 + 5.0) - 1.0), 70.0);
  c = mix(c, vec3(0.5, 0.46, 0.4), 0.12 * vein);

  // Lichen: orange crust and green moss in small rounded patches.
  float lichen = fbm3(q * 4.1 + 9.0, 3);
  c = mix(c, vec3(0.4, 0.24, 0.05), smoothstep(0.7, 0.78, lichen) * 0.7 * fineFade(0.15, fp));
  c = mix(c, vec3(0.1, 0.17, 0.05), smoothstep(0.74, 0.82, fbm3(q * 3.3 + 20.0, 3)) * 0.7 * fineFade(0.15, fp));

  float grit = mix(0.5, fbm3(q * 7.0, 2), fineFade(0.14, fp));
  return c * (0.45 + 0.55 * grit + 0.9 * detailGrain(q, fp) * (0.6 + 0.8 * grit));
}

// Dry earth: ochre soil breaking into cracked plates, each plate a shade of its own.
vec3 earthTexture(vec3 q, float fp) {
  float soil = fbm3(q * 1.7, 3);
  // The plate lattice is warped, so the cracks wander instead of tiling.
  vec2 warped = q.xz + 0.45 * vec2(fbm3(q * 2.3, 2), fbm3(q * 2.3 + 5.0, 2)) - 0.22;
  vec2 cell = M2 * warped * 3.0;
  float edge = voronoiEdge(cell);
  float plate = hash21(floor(cell));
  float crack = (1.0 - smoothstep(0.0, 0.14, edge)) * fineFade(0.3, fp);
  vec3 c = mix(vec3(0.3, 0.205, 0.105), vec3(0.2, 0.15, 0.085), soil);
  c *= 0.9 + 0.2 * mix(0.5, plate, fineFade(0.3, fp));
  c *= 1.0 - 0.25 * crack;
  return c * (0.5 + 1.0 * detailGrain(q, fp));
}

// Sand: pale grains with fine ripples, darker and denser where the sea has wet it.
vec3 sandTexture(vec3 q, float fp, float wet) {
  float ripple = vnoise(vec2(q.x * 3.0 + 4.0 * vnoise(q.xz * 1.1), q.z * 9.0));
  vec3 c = mix(vec3(0.42, 0.36, 0.24), vec3(0.34, 0.29, 0.19), vnoise(q.xz * 0.8));
  c *= 0.75 + 0.3 * ripple;
  c *= 0.5 + 1.0 * detailGrain(q, fp);
  return c * mix(1.0, 0.5, wet);
}

// Snow: soft drifts with a faint blue shade in the hollows, and sparse glints.
vec3 snowTexture(vec3 q, float fp) {
  float drift = fbm3(q * 2.0, 3);
  vec3 c = mix(vec3(0.5, 0.56, 0.68), vec3(0.72, 0.74, 0.78), drift);
  float glint = step(0.994, hash31(floor(q * 55.0))) * fineFade(0.03, fp);
  return c + glint * 0.6;
}

// ---- Lava: flow noise after nimitz (shadertoy lslXRS). Every octave of noise is displaced by a rotating gradient
// field, then folded with a sine into ridges, so the pattern streams and writhes.

vec2 gradn(vec2 p) {
  return noised(p * 2.56).yz * 0.46;
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float flowNoise(vec2 p) {
  float time = uTime * 0.1;
  float z = 2.0;
  float rz = 0.0;
  vec2 bp = p;
  for (int i = 1; i < 7; i++) {
    p += time * 0.6;
    bp += time * 1.9;
    vec2 gr = gradn(float(i) * p * 0.34 + time);
    gr *= rot2(time * 6.0 - (0.05 * p.x + 0.03 * p.y) * 40.0);
    p += gr * 0.5;
    rz += (sin(vnoise(p * 2.56) * 7.0) * 0.5 + 0.5) / z;
    p = mix(bp, p, 0.77);
    z *= 1.4;
    p *= 2.0;
    bp *= 1.9;
  }
  return rz;
}

// Haze by distance. Fully fogged by the far limit, so ground the marcher gave up on meets the sky without a seam, and
// thick where the history ends, so the land goes into the fog instead of sinking away.
float fogAt(float t) {
  float dataEnd = uRows * uDz - uZ0;
  return max(1.0 - exp(-pow(t * 0.018, 1.5)), max(smoothstep(0.5 * FAR, FAR, t), smoothstep(0.4 * dataEnd, 0.95 * dataEnd, t)));
}

// Heat of the lava under a point: the newest rows of the loud bands, however deep they lie.
float lavaHeat(vec2 xz) {
  return (1.0 - smoothstep(6.0, 8.0, uZ0 - xz.y)) * smoothstep(0.02, 0.3, loudness(xz));
}

// The terrain is lit from the side and front: the sun is behind the range, which would leave every visible face in shade.
vec3 keyLight() {
  return normalize(vec3(uKeyDir.x * 1.3, uKeyDir.y, 0.4));
}

// The lava's emission under water: kept apart from the lit colour, because the water dims it differently.
vec3 gLava = vec3(0.0);

// The land, unfogged. mode 0 is what the camera sees; 1 is the same ground seen in a reflection; 2 is the seabed seen
// through the water, lit by what sunlight survives the way down. The secondary modes are cheaper (coarser normals,
// no shadow march), so the sea can afford to shade the real landscape twice per pixel.
vec3 shadeLand(vec3 p, vec3 rd, float t, int mode) {
  vec3 n = normalAt(p.xz, t, mode == 0 ? (t < 14.0 ? 7 : 4) : 3, 1.0);
  // The slope the materials follow: the broad lie of the land, without the fine bumps, which would speckle the plains.
  vec3 nb = normalAt(p.xz, t, mode == 0 ? 4 : 3, 0.0);
  // Surface noise rides the rows like everything else: in world coordinates it would sit still while the land streams under it.
  vec2 w = vec2(p.x, uZ0 - p.z - uScroll);
  float footprint = t * 2.0 / (uRes.y * uFocal) / max(dot(-rd, nb), 0.1);
  vec3 q = vec3(w.x, p.y, w.y);
  float alt = p.y / uMaxH;

  // Steep ground is rock, easing to dry earth as it flattens.
  float toEarth = smoothstep(0.62, 0.85, nb.y);
  vec3 col = toEarth < 0.999 ? rockTexture(q, footprint) : vec3(0.0);
  if (toEarth > 0.0) col = mix(col, earthTexture(q, footprint), toEarth);
  // A beach where the land meets the sea, wet and dark at the waterline.
  float shore = p.y - SEA;
  float beach = (1.0 - smoothstep(0.06, 0.4, shore)) * smoothstep(0.55, 0.9, nb.y);
  if (beach > 0.0) col = mix(col, sandTexture(q, footprint, 1.0 - smoothstep(0.0, 0.14, shore)), beach);
  // Broad patches of light and dark at two scales, multiplied in: this is what breaks the ground up.
  col *= 0.15 + 1.6 * sqrt(fbm(w * 0.9) * fbm(w * 0.11 + 5.0));

  float h = smoothstep(0.55, 0.95, alt + 0.2 * (vnoise(w * 0.6) - 0.5));
  float e = smoothstep(1.0 - 0.5 * h, 1.0 - 0.1 * h, nb.y);
  float snow = h * e * (0.3 + 0.7 * smoothstep(0.0, 0.1, nb.x + h * h));
  // Snow settles only on ground that has had time to cool: well behind the lava, not on peaks that were molten a moment ago.
  snow *= smoothstep(12.0, 30.0, uZ0 - p.z);
  col = mix(col, snowTexture(q, footprint), smoothstep(0.1, 0.9, snow));

  // Molten at the front, where the music rises. It streams away from the newest row, cooling to black crust with the
  // heat surviving in the cracks, redder and dimmer as it ages.
  float dFront = uZ0 - p.z + 0.5 * (vnoise(w * 0.7 + 3.0) - 0.5);
  float heat = (1.0 - smoothstep(6.0, 8.0, dFront)) * smoothstep(0.02, 0.3, loudness(p.xz));
  vec3 lava = vec3(0.0);
  if (heat > 0.0) {
    float cool = smoothstep(4.0, 7.0, dFront);
    // Under water the lava is quenched: it crusts over at once, and only the cracks keep their glow.
    if (mode == 2) cool = max(cool, 0.6);
    float rz = flowNoise(w * 0.8);
    float crust = smoothstep(0.0, 1.0, cool * 1.4 + (rz - 0.95) * 1.1);
    float crack = pow(1.0 - smoothstep(0.55, 1.05, rz), 2.0);
    vec3 glow = pow(vec3(0.2, 0.07, 0.01) / rz, vec3(1.4)) * 3.6;
    glow *= mix(1.0, (0.1 + 2.2 * crack) * (1.0 - 0.6 * cool), crust);
    glow *= mix(vec3(1.0), vec3(1.0, 0.55, 0.25), cool);
    lava = glow;
    col = mix(col, vec3(0.025, 0.023, 0.025) * (0.5 + detailGrain(q, footprint)), heat);
  }

  // The sun is behind the range, which leaves every face we can see in shade: light it from the side and front instead.
  vec3 l = keyLight();
  float dif = max(dot(n, l), 0.0);
  float sh = mode == 0 ? (dif > 0.0001 ? shadow(p + n * 0.02, l, detailLod(t)) : 0.0) : 0.85;
  vec3 keyCol = uKeyColor;
  vec3 ambCol = uAmbient;
  if (mode == 2) {
    // Under the sea: the light is dimmed and tinted by the water above, and gathered into a moving net of caustics.
    float dd = max(SEA - p.y, 0.0);
    float c1 = pow(1.0 - abs(2.0 * vnoise(w * 3.2 + vec2(uTime * 0.4, 0.0)) - 1.0), 5.0);
    float c2 = pow(1.0 - abs(2.0 * vnoise(w * 4.1 - vec2(0.0, uTime * 0.5) + 7.0) - 1.0), 5.0);
    keyCol *= exp(-dd / max(l.y, 0.2) * vec3(0.9, 0.28, 0.16)) * (0.6 + 2.2 * c1 * c2);
    ambCol *= exp(-dd * vec3(0.9, 0.28, 0.16));
  }
  float amb = 0.5 + 0.5 * n.y;
  float bac = clamp(0.2 + 0.8 * dot(normalize(vec3(-l.x, 0.0, l.z)), n), 0.0, 1.0);
  vec3 lin = keyCol * dif * vec3(sh, sh * sh * 0.5 + 0.5 * sh, sh * sh * 0.8 + 0.2 * sh)
    + ambCol * 1.8 * amb
    + vec3(0.5, 0.6, 0.9) * bac * (0.02 + 0.1 * uDay);
  col *= lin;
  vec3 hv = normalize(l - rd);
  col += (0.7 + 0.3 * snow) * (0.04 + 0.96 * pow(clamp(1.0 + dot(hv, rd), 0.0, 1.0), 5.0))
    * keyCol * dif * sh * pow(clamp(dot(n, hv), 0.0, 1.0), 16.0) * 0.5;
  col += snow * 0.65 * pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 4.0) * ambCol * 4.0;

  if (mode == 2) {
    gLava = lava * heat;
  } else {
    col += lava * heat;
  }
  return col;
}

vec3 shade(vec3 p, vec3 rd, float t) {
  return mix(shadeLand(p, rd, t, 0), skyBase(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))), fogAt(t));
}

// ---- The sea. Waves after afl_ext (shadertoy MdXyzX): a sum of exp(sin) waves, each one dragging the next, so the
// crests sharpen and the troughs flatten. Used for the surface normals; the surface itself is the plane at SEA.

const float WATER_AMP = 0.3;

vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  return vec2(wave, -wave * cos(x));
}

float getwaves(vec2 position, int iterations) {
  float phase = length(position) * 0.1;
  float iter = 0.0;
  float frequency = 1.0;
  float timeMultiplier = 2.0;
  float weight = 1.0;
  float sumValues = 0.0;
  float sumWeights = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= iterations) break;
    vec2 d = vec2(sin(iter), cos(iter));
    vec2 res = wavedx(position, d, frequency, uTime * timeMultiplier + phase);
    position += d * res.y * weight * 0.38;
    sumValues += res.x * weight;
    sumWeights += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sumValues / sumWeights;
}

vec2 scrolled(vec2 xz) {
  return vec2(xz.x, uZ0 - xz.y - uScroll);
}

// What a ray leaving the water sees: the real landscape, marched and shaded with the same material as the land (lava
// included), or the sky.
vec3 reflectedWorld(vec3 ro, vec3 rd, float tCam) {
  float t = 0.15;
  for (int i = 0; i < 44; i++) {
    vec3 q = ro + rd * t;
    float d = q.y - height(q.xz, 4, 0.0);
    if (d < 0.003 * t + 0.002) {
      return mix(shadeLand(q, rd, tCam + t, 1), skyBase(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))), fogAt(tCam + t));
    }
    if (q.y > uMaxH * 1.6) break;
    t += clamp(d * 0.5, 0.05 + 0.01 * t, 2.0);
    if (t > 70.0) break;
  }
  return sky(ro, rd);
}

// What a ray going down through the water finds: it is marched to the seabed (the same heightfield as the land) and
// the seabed is shaded with the land's own material, lit by what sunlight reaches it. The whole path is then dimmed
// and tinted by the water, red first; the lava keeps more of its light than the day does.
vec3 seabedView(vec3 p, vec3 T, float tCam, out float depth) {
  vec3 deep = vec3(0.012, 0.06, 0.09) * (0.2 + 0.9 * uDay + 0.1 * length(uMoonColor));
  float t = 0.0;
  float prevT = 0.0;
  bool hit = false;
  for (int i = 0; i < 48; i++) {
    vec3 q = p + T * t;
    float d = q.y - height(q.xz, 4, 0.0);
    if (d < 0.0) {
      float lo = prevT;
      float hi = t;
      for (int j = 0; j < 5; j++) {
        float m = 0.5 * (lo + hi);
        vec3 r = p + T * m;
        if (r.y < height(r.xz, 4, 0.0)) hi = m; else lo = m;
      }
      t = 0.5 * (lo + hi);
      hit = true;
      break;
    }
    prevT = t;
    t += clamp(d * 0.5, 0.03, 2.0);
    if (t > 60.0) break;
  }
  depth = t;
  vec3 qEnd = p + T * t;
  // The lava's light is absorbed like everything else, red least: bright where the vent is shallow, a dull red glow
  // lower down, and black in the deep. It spreads into a soft halo around the vent.
  float halo = lavaHeat(qEnd.xz) + lavaHeat(qEnd.xz + vec2(2.2, 0.0)) + lavaHeat(qEnd.xz - vec2(2.2, 0.0))
             + lavaHeat(qEnd.xz + vec2(0.0, 2.2)) + lavaHeat(qEnd.xz - vec2(0.0, 2.2));
  vec3 haloGlow = vec3(1.4, 0.4, 0.06) * (halo * 0.1) * exp(-t * vec3(1.7, 2.5, 3.4)) * (0.6 + 0.4 * vnoise(scrolled(qEnd.xz) * 0.6 + uTime * 0.15));
  if (!hit) return deep + haloGlow;
  vec3 bed = shadeLand(qEnd, T, tCam + t, 2);
  vec3 absorb = exp(-t * vec3(0.9, 0.28, 0.16));
  return bed * absorb + gLava * exp(-t * vec3(1.7, 2.5, 3.4)) + haloGlow + deep * (1.0 - absorb);
}

vec3 shadeWater(vec3 p, vec3 rd, float t) {
  vec2 pw = scrolled(p.xz) * 1.7;
  float e = 0.034;
  float h0 = getwaves(pw, 8);
  float hx = getwaves(pw + vec2(e, 0.0), 8);
  float hz = getwaves(pw + vec2(0.0, e), 8);
  vec3 n = normalize(vec3(-(hx - h0) * WATER_AMP / 0.02, 1.0, -(hz - h0) * WATER_AMP / 0.02));
  // Smooth the far waves: at a distance they only shimmer.
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.8 * min(1.0, sqrt(t * 0.01) * 1.1)));

  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  vec3 R = reflect(rd, n);
  R.y = abs(R.y);
  vec3 refl = reflectedWorld(p + vec3(0.0, 0.01, 0.0), R, t);
  refl += uSunColor * pow(max(dot(R, uSunDir), 0.0), 300.0) * 3.0;

  float depth;
  vec3 T = refract(rd, n, 0.75);
  vec3 refr = seabedView(p, T, t, depth);
  // Foam where the water is thin: the shore, and the lava's edge.
  float foam = (1.0 - smoothstep(0.0, 0.35, depth)) * (0.4 + 0.6 * vnoise(scrolled(p.xz) * 7.0 + uTime * 0.5));
  refr = mix(refr, vec3(0.8, 0.85, 0.9) * (uKeyColor * 0.25 + uAmbient * 3.0), foam * 0.6);

  vec3 col = fresnel * refl + (1.0 - fresnel) * refr;
  return mix(col, skyBase(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))), fogAt(t));
}

// ---- Steam. Where the lava meets the sea it boils the water off: a plume that rises from the waterline under hot lava,
// billows with 3D noise that climbs as it goes, and streams away with the scroll. Marched as a volume along the
// camera ray, through a box around the vent only, so the rest of the picture does not pay for it.

const float STEAM_TOP = 4.5;

// How dense the steam is at a point, 0..1.
float steamDensity(vec3 p) {
  float h = p.y - SEA;
  if (h < -0.3 || h > STEAM_TOP) return 0.0;
  // The source: hot lava, at the place where the ground crosses the waterline.
  float heat = lavaHeat(p.xz);
  if (heat <= 0.0) return 0.0;
  float edge = (height(p.xz, 3, 0.0) - SEA) / 0.8;
  float source = heat * exp(-edge * edge);
  if (source < 0.01) return 0.0;
  vec2 w = scrolled(p.xz);
  float billow = fbm3(vec3(w.x * 0.5, p.y * 0.55 - uTime * 0.7, w.y * 0.5), 3);
  float plume = source * exp(-max(h, 0.0) / 1.7) * smoothstep(0.5, 0.85, billow + 0.15 * source);
  return clamp(plume, 0.0, 1.0);
}

// Steam along the ray from the eye to tEnd (the surface it hit): the light it adds, and what is left of the picture behind it.
vec4 steamAlong(vec3 ro, vec3 rd, float tEnd) {
  // Only inside a box around the vent.
  vec3 lo = vec3(-uHalfW * 1.3, SEA - 0.3, uZ0 - 14.0);
  vec3 hi = vec3(uHalfW * 1.3, SEA + STEAM_TOP, uZ0 + 1.0);
  vec3 inv = 1.0 / (rd + vec3(1e-5));
  vec3 t0 = (lo - ro) * inv;
  vec3 t1 = (hi - ro) * inv;
  float tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.1));
  float tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tEnd));
  if (tFar <= tNear) return vec4(0.0, 0.0, 0.0, 1.0);

  const int STEPS = 32;
  float dt = (tFar - tNear) / float(STEPS);
  float t = tNear + dt * hash21(gl_FragCoord.xy + uTime);
  vec3 light = uAmbient * 3.5 + uKeyColor * 0.6 * (0.7 + 0.3 * pow(max(dot(rd, keyLight()), 0.0), 3.0));
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float dens = steamDensity(p);
    if (dens > 0.0) {
      // Lit from below by the lava, the more so the lower in the plume.
      float glow = lavaHeat(p.xz) * exp(-max(p.y - SEA, 0.0) / 1.4);
      vec3 c = vec3(0.86, 0.88, 0.92) * light + vec3(1.2, 0.4, 0.08) * glow * 0.9;
      float a = 1.0 - exp(-dens * dt * 0.45);
      acc += trans * a * c;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
    t += dt;
  }
  return vec4(acc, trans);
}

// ACES filmic (Stephen Hill's fit of the RRT and ODT).
const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);

vec3 aces(vec3 color) {
  vec3 v = ACES_IN * color;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a / b), 0.0, 1.0);
}

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  vec3 ww = normalize(uTarget - uEye);
  // Cylindrical projection: the angle sideways is linear across the image and the height is rectilinear. A very
  // wide strip in the usual flat projection stretches everything near its edges into sideways smears.
  float a = uv.x * min(1.0 / uFocal, 1.1 / (uRes.x / uRes.y));
  vec2 h0 = normalize(ww.xz);
  vec2 hz = vec2(h0.x * cos(a) - h0.y * sin(a), h0.x * sin(a) + h0.y * cos(a));
  float sp = ww.y;
  float cp = sqrt(1.0 - sp * sp);
  vec3 rd = normalize(vec3(hz.x * cp, sp, hz.y * cp) + vec3(-hz.x * sp, cp, -hz.y * sp) * (uv.y / uFocal));

  float t;
  vec3 col;
  float tEnd = FAR;
  if (march(uEye, rd, t)) {
    vec3 p = uEye + rd * t;
    col = height(p.xz, 4, detailLod(t)) > SEA + 0.015 ? shade(p, rd, t) : shadeWater(p, rd, t);
    tEnd = t;
  } else {
    col = sky(uEye, rd);
  }
  vec4 steam = steamAlong(uEye, rd, tEnd);
  col = col * steam.a + steam.rgb;

  vec2 q = gl_FragCoord.xy / uRes;
  float vignette = 0.6 + 0.4 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.25);
  col = pow(aces(col * 1.3 * vignette), vec3(1.0 / 2.2));
  // A touch of S-curve: deeper darks and cleaner lights, so the texture has some bite.
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
