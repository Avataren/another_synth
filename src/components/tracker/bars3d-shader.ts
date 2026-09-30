/**
 * GLSL for the 3D bars scene (WebGL2): emissive boxes on a dark floor, drawn
 * once upright and once mirrored (the reflection), then combined and bloomed.
 */

/** One box per instance: x, y0, height, colour position t, and kind (0 bar, 1 cap). */
export const BARS3D_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;      // unit box: x, z in -0.5..0.5, y in 0..1
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aInst;     // x, y0, height, t
layout(location = 3) in float aKind;

uniform mat4 uViewProj;
uniform vec2 uSize;                      // box width, depth
uniform float uMirror;                   // 1 upright, -1 reflected in the floor

out vec3 vNormal;      // world normal (mirrored with the box)
out vec3 vWorld;
out vec3 vObj;         // position inside the unit box
out vec3 vDims;        // the box's size in world units
out float vT;
out float vKind;

void main() {
  float y = aInst.y + aPos.y * aInst.z;
  vec3 world = vec3(aInst.x + aPos.x * uSize.x, y * uMirror, aPos.z * uSize.y);
  vNormal = vec3(aNormal.x, aNormal.y * uMirror, aNormal.z);
  vWorld = world;
  vObj = aPos;
  vDims = vec3(uSize.x, aInst.z, uSize.y);
  vT = aInst.w;
  vKind = aKind;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

/**
 * Solid, lit bars: a key light from the upper left, a cool fill from the
 * right, a rim light from behind, a Blinn specular, and a faint self-glow so
 * the colour never goes dead. Edges are bevelled in the normal, so a rounded
 * lip catches the light and each face reads as a face.
 */
export const BARS3D_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
in vec3 vObj;
in vec3 vDims;
in float vT;
in float vKind;

uniform vec3 uEye;
uniform float uMirror;

out vec4 outColor;

vec3 rainbow(float t) {
  vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t * 0.9 + vec3(0.02, 0.36, 0.68)));
  return mix(vec3(dot(c, vec3(0.3333))), c, 1.25);
}

void main() {
  vec3 albedo = clamp(rainbow(vT), 0.0, 1.0);

  // Bevel: bend the normal towards any edge we are close to.
  vec3 nObj = vec3(vNormal.x, vNormal.y * uMirror, vNormal.z);
  vec3 half3 = vDims * 0.5;
  vec3 p = vec3(vObj.x * vDims.x, (vObj.y - 0.5) * vDims.y, vObj.z * vDims.z);
  vec3 edge = half3 - abs(p);
  float r = min(0.035, min(half3.x, min(half3.y, half3.z)) * 0.7);
  vec3 an = abs(nObj);
  vec3 bend = vec3(0.0);
  if (an.x < 0.5) bend.x = sign(p.x) * (1.0 - smoothstep(0.0, r, edge.x));
  if (an.y < 0.5) bend.y = sign(p.y) * (1.0 - smoothstep(0.0, r, edge.y));
  if (an.z < 0.5) bend.z = sign(p.z) * (1.0 - smoothstep(0.0, r, edge.z));
  vec3 nb = normalize(nObj + bend * 1.2);
  vec3 N = normalize(vec3(nb.x, nb.y * uMirror, nb.z));

  vec3 V = normalize(uEye - vWorld);
  vec3 keyDir = normalize(vec3(-0.5, 0.8, 0.6));
  vec3 fillDir = normalize(vec3(0.8, 0.25, 0.5));
  vec3 rimDir = normalize(vec3(0.1, 0.45, -1.0));

  float key = max(dot(N, keyDir), 0.0);
  float fill = max(dot(N, fillDir), 0.0);
  float rim = max(dot(N, rimDir), 0.0);

  // Bars stand in a pool of their own dark: less light near the floor.
  float height = abs(vWorld.y);
  float ao = mix(0.5, 1.0, smoothstep(0.0, 0.6, height));

  vec3 diffuse = albedo * (0.07 + 1.15 * key * ao + 0.22 * fill * vec3(0.7, 0.85, 1.0) + 0.3 * rim);

  vec3 H = normalize(keyDir + V);
  float spec = pow(max(dot(N, H), 0.0), 70.0) * 0.7;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec3 glow = albedo * (0.07 + 0.08 * clamp(height / 1.9, 0.0, 1.0));
  vec3 col = diffuse + glow + vec3(spec) + albedo * fres * 0.35;

  if (vKind > 0.5) col = mix(col, vec3(1.0), 0.35) * 1.1;   // peak caps: light, pale slabs
  outColor = vec4(col / (1.0 + col * 0.18), 1.0);           // soft shoulder, no hard clipping
}
`;

/** The floor: a big dark quad with a soft pool of light, fading to black in the distance. */
export const FLOOR_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const FLOOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform float uGlow;    // how loud the scene is: lifts the light pool a little
out vec4 outColor;
void main() {
  float r = length(vWorld.xz * vec2(0.45, 1.0));
  vec3 col = vec3(0.010, 0.013, 0.022)
           + vec3(0.020, 0.024, 0.040) * exp(-r * r * 0.05) * (0.6 + 0.8 * uGlow);
  col *= 1.0 - smoothstep(5.0, 15.0, length(vWorld.xz));
  outColor = vec4(col, 1.0);
}
`;

/** Scene plus the blurred reflection, faded with distance below the contact line. */
export const REFLECT_COMBINE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uRefl;
uniform float uBaseV;       // v of the floor line the bars stand on (0 at the bottom)
uniform float uStrength;
out vec4 outColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 refl = texture(uRefl, vUv).rgb;
  float below = max(0.0, uBaseV - vUv.y);
  float fade = exp(-below * 7.0);
  outColor = vec4(scene + refl * uStrength * fade, 1.0);
}
`;
