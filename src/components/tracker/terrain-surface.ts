/**
 * The atlas stores land and displaced water as separate bilinear heightfields.
 * RGBA8 packing works on every WebGL2 GPU, with about 1.5 mm height precision.
 * Bounds are maxima, never averaged mipmaps: each coarse tile encloses every
 * vertex of its cells. Rays skip empty tiles and solve the remaining cells.
 */
export const TERRAIN_PACK_GLSL = `
vec2 packHeight(float h) {
  float n = floor(clamp((h + 64.0) / 96.0, 0.0, 1.0) * 65535.0 + 0.5);
  return vec2(floor(n / 256.0), mod(n, 256.0)) / 255.0;
}
float unpackHeight(vec2 rg) {
  return dot(rg, vec2(65280.0, 255.0)) * (96.0 / 65535.0) - 64.0;
}
vec2 unpackSurface(vec4 rgba) {
  return vec2(unpackHeight(rgba.rg), unpackHeight(rgba.ba));
}
`;

export const TERRAIN_BOUND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSource;
uniform bool uVertices;
out vec4 outColor;
${TERRAIN_PACK_GLSL}
void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * 2;
  ivec2 last = textureSize(uSource, 0) - 1;
  vec2 bound = vec2(-64.0);
  // First reduction covers the 3x3 vertices of four cells, including their far edges.
  // Later reductions cover four already conservative child bounds.
  for (int y = 0; y < 3; y++) {
    for (int x = 0; x < 3; x++) {
      if (!uVertices && (x == 2 || y == 2)) continue;
      bound = max(bound, unpackSurface(texelFetch(uSource, min(origin + ivec2(x, y), last), 0)));
    }
  }
  outColor = vec4(packHeight(bound.x), packHeight(bound.y));
}
`;

export const TERRAIN_SURFACE_GLSL = `
uniform sampler2D uSurface;
uniform sampler2D uBounds;
uniform vec2 uSurfaceOrigin; // x and distance from the newest row, on the moving archive grid
uniform vec2 uSurfaceStep;
${TERRAIN_PACK_GLSL}

vec2 surfaceGrid(vec2 xz) {
  return (vec2(xz.x, uZ0 - xz.y) - uSurfaceOrigin) / uSurfaceStep;
}

vec2 surfaceVertex(ivec2 cell) {
  return unpackSurface(texelFetch(uSurface, clamp(cell, ivec2(0), textureSize(uSurface, 0) - 1), 0));
}

float landHeight(vec2 xz) {
  vec2 g = surfaceGrid(xz);
  vec2 last = vec2(textureSize(uSurface, 0) - 1);
  if (any(lessThan(g, vec2(0.0))) || any(greaterThan(g, last))) return height(xz, 4, 0.0);
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  return mix(mix(surfaceVertex(i).x, surfaceVertex(i + ivec2(1, 0)).x, f.x),
             mix(surfaceVertex(i + ivec2(0, 1)).x, surfaceVertex(i + ivec2(1, 1)).x, f.x), f.y);
}

// First root of a quadratic on 0..1. Stable q-form avoids cancellation on steep faces;
// the minimum can cross the surface even when BOTH segment endpoints are above it.
float firstRoot(float a, float b, float c) {
  if (c <= 0.0001) return 0.0;
  if (abs(a) < 1e-7) {
    float r = -c / (abs(b) > 1e-7 ? b : 1e-7);
    return r >= 0.0 && r <= 1.0 ? r : 2.0;
  }
  float discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) return 2.0;
  float q = -0.5 * (b + (b < 0.0 ? -1.0 : 1.0) * sqrt(discriminant));
  float r0 = q / a;
  float r1 = abs(q) > 1e-10 ? c / q : r0;
  float r = 2.0;
  if (r0 >= 0.0 && r0 <= 1.0) r = r0;
  if (r1 >= 0.0 && r1 <= 1.0) r = min(r, r1);
  return r;
}

float cellRoot(vec4 h, vec2 f, vec2 delta, float y, float dy) {
  float crossTerm = h.x - h.y - h.z + h.w;
  float value = h.x + (h.y - h.x) * f.x + (h.z - h.x) * f.y + crossTerm * f.x * f.y;
  float slope = (h.y - h.x) * delta.x + (h.z - h.x) * delta.y
              + crossTerm * (f.x * delta.y + f.y * delta.x);
  return firstRoot(-crossTerm * delta.x * delta.y, dy - slope, y - value);
}

// Select the cell on the ray's forward side. Bias in GRID units survives float
// rounding even for almost-vertical rays; a tiny time nudge can round to zero.
vec2 forwardCell(vec2 g, vec2 dg, float size) {
  return floor((g + sign(dg) * 0.0002) / size);
}

// Travel to the next grid boundary, with parallel axes excluded explicitly.
float cellExit(vec2 g, vec2 dg, float size) {
  vec2 cell = forwardCell(g, dg, size);
  vec2 edge = (cell + step(vec2(0.0), dg)) * size;
  vec2 reach = vec2(1e20);
  if (abs(dg.x) > 1e-7) reach.x = (edge.x - g.x) / dg.x;
  if (abs(dg.y) > 1e-7) reach.y = (edge.y - g.y) / dg.y;
  return max(min(reach.x, reach.y), 0.0);
}

bool traceSurface(vec3 ro, vec3 rd, float start, float end, bool includeWater,
                  out float tHit, out bool water) {
  tHit = end;
  water = false;
  vec2 g0 = surfaceGrid(ro.xz);
  vec2 dg = vec2(rd.x, -rd.z) / uSurfaceStep;
  vec2 extent = vec2(textureSize(uSurface, 0) - 1);
  float nearT = start;
  float farT = end;
  // Skip everything above the conservative terrain/sea bound before touching tiles.
  if (rd.y < -1e-7) nearT = max(nearT, (uHeightBound - ro.y) / rd.y);
  else if (rd.y > 1e-7) farT = min(farT, (uHeightBound - ro.y) / rd.y);
  else if (ro.y > uHeightBound) return false;
  // Clip the ray to the atlas. A parallel ray outside it has no candidate cells.
  for (int axis = 0; axis < 2; axis++) {
    if (abs(dg[axis]) < 1e-7) {
      if (g0[axis] < 0.0 || g0[axis] > extent[axis]) return false;
    } else {
      float a = -g0[axis] / dg[axis];
      float b = (extent[axis] - g0[axis]) / dg[axis];
      nearT = max(nearT, min(a, b));
      farT = min(farT, max(a, b));
    }
  }
  if (farT <= nearT) return false;
  float t = nearT;
  // The largest supported atlas spans fewer than 240 coarse cells along any ray.
  for (int tile = 0; tile < 256; tile++) {
    if (t >= farT) break;
    vec2 g = g0 + dg * t;
    float tileEnd = min(farT, t + max(cellExit(g, dg, 8.0), 0.00001));
    ivec2 index = clamp(ivec2(forwardCell(g, dg, 8.0)), ivec2(0), textureSize(uBounds, 0) - 1);
    vec2 upper = unpackSurface(texelFetch(uBounds, index, 0));
    float bound = includeWater ? max(upper.x, upper.y) : upper.x;
    if (min(ro.y + rd.y * t, ro.y + rd.y * tileEnd) <= bound + 0.0001) {
      // An 8x8 tile needs at most 16 cell crossings, including corner/edge ties.
      for (int cell = 0; cell < 20; cell++) {
        if (t >= tileEnd) break;
        g = g0 + dg * t;
        ivec2 i = clamp(ivec2(forwardCell(g, dg, 1.0)), ivec2(0), textureSize(uSurface, 0) - 2);
        float nextT = min(tileEnd, t + max(cellExit(g, dg, 1.0), 0.00001));
        float dt = nextT - t;
        vec2 h00 = surfaceVertex(i);
        vec2 h10 = surfaceVertex(i + ivec2(1, 0));
        vec2 h01 = surfaceVertex(i + ivec2(0, 1));
        vec2 h11 = surfaceVertex(i + ivec2(1, 1));
        vec2 f = clamp(g0 + dg * t - vec2(i), vec2(0.0), vec2(1.0));
        float land = cellRoot(vec4(h00.x, h10.x, h01.x, h11.x), f, dg * dt, ro.y + rd.y * t, rd.y * dt);
        float sea = includeWater ? cellRoot(vec4(h00.y, h10.y, h01.y, h11.y), f, dg * dt, ro.y + rd.y * t, rd.y * dt) : 2.0;
        float root = min(land, sea);
        if (root <= 1.0) {
          tHit = t + dt * root;
          water = sea < land;
          return true;
        }
        t = nextT;
      }
    }
    t = tileEnd;
  }
  return false;
}

bool march(vec3 ro, vec3 rd, out float tHit, out bool water) {
  float seaT = rd.y < -1e-7 ? (SEA - ro.y) / rd.y : 1e20;
  float end = min(sceneEnd(), seaT);
  if (traceSurface(ro, rd, 0.1, end, true, tHit, water)) return true;
  // The undisplaced ocean outside the atlas has an exact intersection.
  // Exhausting a traversal never invents a hit or changes a sky ray into land.
  tHit = end;
  water = true;
  return seaT > 0.0 && seaT < sceneEnd();
}
`;
