/** Exact convex intersections, traversed in frequency-cell order. No global SDF step budget. */
export const RAYMARCH_GEOMETRY_GLSL = `
const vec2 OCTAGON_SIDES[8] = vec2[8](
  vec2(1.0, 0.0), vec2(0.70710678, 0.70710678), vec2(0.0, 1.0), vec2(-0.70710678, 0.70710678),
  vec2(-1.0, 0.0), vec2(-0.70710678, -0.70710678), vec2(0.0, -1.0), vec2(0.70710678, -0.70710678));

bool clipPlane(vec3 ro, vec3 rd, vec3 normal, float limit, inout float nearT, inout float farT) {
  float distance = limit - dot(normal, ro);
  float slope = dot(normal, rd);
  if (abs(slope) < 1e-7) return distance >= -1e-7;
  float t = distance / slope;
  if (slope < 0.0) nearT = max(nearT, t); else farT = min(farT, t);
  return nearT <= farT;
}

bool prismHit(vec3 ro, vec3 rd, int bar, bool cap, float start, float end, out float hitT) {
  vec2 hp = barHeights(bar);
  float hh = cap ? CAP_HALF : (hp.x + FOOT) * 0.5;
  float centre = cap ? hp.y + CAP_GAP : (hp.x - FOOT) * 0.5;
  float radius = cap ? uCapHalf : uHalf;
  float bevel = min(0.02, min(radius, hh) * 0.5);
  vec3 local = ro - vec3(cellX(bar), centre, 0.0);
  float a = start;
  float b = end;
  hitT = end;
  if (!clipPlane(local, rd, vec3(0.0, 1.0, 0.0), hh, a, b)) return false;
  if (!clipPlane(local, rd, vec3(0.0, -1.0, 0.0), hh, a, b)) return false;
  for (int side = 0; side < 8; side++) {
    vec2 n = OCTAGON_SIDES[side];
    if (!clipPlane(local, rd, vec3(n.x, 0.0, n.y), radius, a, b)) return false;
    // Small bevels catch the light at the rim. All planes stay inside the original sharp prism.
    float rim = radius + hh - bevel * 0.58578644;
    if (!clipPlane(local, rd, vec3(n.x, 1.0, n.y), rim, a, b)) return false;
    if (!clipPlane(local, rd, vec3(n.x, -1.0, n.y), rim, a, b)) return false;
  }
  hitT = a;
  return a <= b;
}

bool rowBox(vec3 ro, vec3 rd, out float nearT, out float farT) {
  float width = float(uBands) * uPitch * 0.5;
  vec3 lo = vec3(-width, -FOOT, -uHalfZ);
  vec3 hi = vec3(width, uMaxH + 0.14, uHalfZ);
  nearT = 0.001;
  farT = 1e4;
  for (int axis = 0; axis < 3; axis++) {
    if (abs(rd[axis]) < 1e-7) {
      if (ro[axis] < lo[axis] || ro[axis] > hi[axis]) return false;
    } else {
      float a = (lo[axis] - ro[axis]) / rd[axis];
      float b = (hi[axis] - ro[axis]) / rd[axis];
      nearT = max(nearT, min(a, b));
      farT = min(farT, max(a, b));
    }
  }
  return farT >= nearT;
}

Hit traceBars(vec3 ro, vec3 rd, Hit best) {
  float start, end;
  if (!rowBox(ro, rd, start, end)) return best;
  end = min(end, best.t);
  float t = start;
  float g0 = ro.x / uPitch + float(uBands) * 0.5;
  float dg = rd.x / uPitch;
  float g = g0 + dg * start;
  int bar = clamp(int(floor(g + sign(dg) * 0.0001)), 0, uBands - 1);
  int direction = dg > 0.0 ? 1 : -1;
  for (int cell = 0; cell < MAX_BARS; cell++) {
    if (t > end || bar < 0 || bar >= uBands) break;
    float nextT = end;
    if (abs(dg) > 1e-7) {
      float edge = float(bar) + (dg > 0.0 ? 1.0 : 0.0);
      nextT = min(end, max(t, (edge - g0) / dg));
    }
    float body, peak;
    bool bodyHit = prismHit(ro, rd, bar, false, t, nextT, body);
    bool peakHit = prismHit(ro, rd, bar, true, t, nextT, peak);
    if (bodyHit || peakHit) {
      bool cap = peakHit && (!bodyHit || peak < body);
      return Hit(cap ? peak : body, cap ? 3 : 2, bar);
    }
    if (nextT >= end) break;
    t = nextT;
    bar += direction;
  }
  return best;
}

Hit trace(vec3 ro, vec3 rd, bool waves) {
  Hit h = Hit(1e4, 0, 0);
  if (uBallOn > 0.5) {
    vec3 oc = ro - uBall.xyz;
    float b = dot(oc, rd);
    float discriminant = b * b - dot(oc, oc) + uBall.w * uBall.w;
    if (discriminant >= 0.0) {
      float t = -b - sqrt(discriminant);
      if (t > 0.001) h = Hit(t, 4, 0);
    }
  }
  h = traceBars(ro, rd, h);
  if (rd.y < -1e-4) {
    // An opaque hit above every possible crest cannot be hidden by the sea.
    float waterTop = uSeaLift + (1.0 - WAVE_MEAN) * WAVE_AMP + 0.09;
    if (h.mat == 0 || ro.y + rd.y * h.t <= waterTop) {
      float water = waves ? oceanHit(ro, rd) : (uSeaLift - ro.y) / rd.y;
      if (water > 0.001 && water < h.t) h = Hit(water, 1, 0);
    }
  }
  return h;
}

// A hit knows its bar. Nearby taller neighbours must not corrupt its bevel normal.
float hitDistance(vec3 p, Hit h) {
  vec2 hp = barHeights(h.bar);
  float hh = h.mat == 3 ? CAP_HALF : (hp.x + FOOT) * 0.5;
  float cy = h.mat == 3 ? hp.y + CAP_GAP : (hp.x - FOOT) * 0.5;
  float radius = h.mat == 3 ? uCapHalf : uHalf;
  float bevel = min(0.02, min(radius, hh) * 0.5);
  return sdRoundOctagonPrism(p - vec3(cellX(h.bar), cy, 0.0), radius, hh, bevel);
}

vec3 barNormal(vec3 p, Hit h) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0006;
  return normalize(k.xyy * hitDistance(p + k.xyy * e, h) + k.yyx * hitDistance(p + k.yyx * e, h)
                 + k.yxy * hitDistance(p + k.yxy * e, h) + k.xxx * hitDistance(p + k.xxx * e, h));
}
`;
