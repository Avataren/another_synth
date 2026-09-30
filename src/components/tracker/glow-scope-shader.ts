/**
 * GLSL for the glow scope wall (WebGL2).
 *
 * Every segment of every trace is one instance of a quad, grown by the glow
 * radius on all sides. The fragment shader measures its distance to the
 * segment and turns that into a hot antialiased core plus a soft halo, so the
 * line is analytically smooth at any pixel ratio and needs no MSAA. Overlaps
 * between neighbouring segments are combined with MAX blending, which keeps
 * the joints from doubling their brightness.
 */
export const GLOW_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;   // (0|1, -1|1): along, across
layout(location = 1) in vec4 aSegment;  // a.xy, b.xy in device pixels
layout(location = 2) in vec4 aClip;     // cell rect x0 y0 x1 y1
layout(location = 3) in float aBright;

uniform vec2 uResolution;
uniform float uPad;                      // quad growth: core + glow reach

out vec2 vPos;
flat out vec4 vSegment;
flat out vec4 vClip;
flat out float vBright;

void main() {
  vec2 a = aSegment.xy;
  vec2 b = aSegment.zw;
  vec2 dir = b - a;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  // Extend past both ends so the round caps and the halo are inside the quad.
  vec2 along = mix(a - dir * uPad, b + dir * uPad, aCorner.x);
  vec2 pos = along + normal * aCorner.y * uPad;

  vPos = pos;
  vSegment = aSegment;
  vClip = aClip;
  vBright = aBright;

  vec2 ndc = pos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const GLOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
flat in vec4 vSegment;
flat in vec4 vClip;
flat in float vBright;

uniform vec3 uColor;
uniform float uCoreHalfWidth;  // device pixels
uniform float uGlowRadius;     // device pixels
uniform float uGlowStrength;

out vec4 outColor;

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  // Stay inside the cell: the halo of a peak must not bleed into its neighbour.
  if (vPos.x < vClip.x || vPos.y < vClip.y || vPos.x > vClip.z || vPos.y > vClip.w) discard;

  float d = segmentDistance(vPos, vSegment.xy, vSegment.zw);

  // The line: full colour on the centre, easing to nothing by uCoreHalfWidth
  // (a smoothstep of the distance, so it is antialiased by construction).
  float core = 1.0 - smoothstep(0.0, uCoreHalfWidth, d);

  // A faint halo behind it, kept low so the line stays the thing you see.
  float r = d / uGlowRadius;
  float halo = (0.6 * exp(-r * 6.0) + 0.4 * exp(-r * 2.2)) * (1.0 - smoothstep(0.8, 1.0, r)) * uGlowStrength;

  vec3 rgb = uColor * max(core, halo);
  float a = clamp(max(halo, core), 0.0, 1.0);

  // Premultiplied; MAX blending keeps overlaps from doubling up.
  outColor = vec4(min(rgb, vec3(1.0)), a) * vBright;
}
`;

/**
 * The CRT pass: one quad per scope cell, sampling the offscreen trace. A port
 * of the screen-content half of the shadertoy CRT (RGB fringing with a wobble,
 * ghosted bloom, vignette, scanlines, phosphor column mask, graticule) without
 * the curved bezel, so every cell stays a flat, rounded screen.
 */
export const CRT_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;  // 0..1
layout(location = 1) in vec4 aRect;    // cell x y w h, device pixels, y down

uniform vec2 uResolution;

out vec2 vPos;
flat out vec4 vRect;

void main() {
  vec2 pos = aRect.xy + aCorner * aRect.zw;
  vPos = pos;
  vRect = aRect;
  vec2 ndc = pos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const CRT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
flat in vec4 vRect;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec3 uColor;
uniform float uTime;    // seconds
uniform float uRatio;   // device pixels per CSS pixel
uniform float uCorner;  // corner radius, device pixels

out vec4 outColor;

vec3 scene(vec2 p) {
  // Stay inside the cell so the fringing does not pull in a neighbour.
  p = clamp(p, vRect.xy, vRect.xy + vRect.zw);
  return texture(uScene, vec2(p.x / uResolution.x, 1.0 - p.y / uResolution.y)).rgb;
}

void main() {
  vec2 size = vRect.zw;
  vec2 uv = (vPos - vRect.xy) / size;
  float t = uTime;

  // Horizontal wobble that drifts down the screen.
  float wob = sin(0.3 * t + uv.y * 21.0) * sin(0.7 * t + uv.y * 29.0)
            * sin(0.3 + 0.33 * t + uv.y * 31.0) * 0.0017 * size.x;

  vec3 base = uColor * 0.05 + 0.02;
  vec3 col;
  col.r = scene(vPos + vec2(wob + 0.7 * uRatio, 0.5 * uRatio)).r;
  col.g = scene(vPos + vec2(wob, -0.6 * uRatio)).g;
  col.b = scene(vPos + vec2(wob - 0.8 * uRatio, 0.0)).b;

  // A faint ghost of the trace, offset down and to the side.
  vec2 ghost = vec2(0.008 * size.x, -0.02 * size.y);
  col.r += 0.07 * scene(vPos + ghost + vec2(wob, 0.0)).r;
  col.g += 0.05 * scene(vPos + ghost * vec2(-1.0, 0.8) + vec2(wob, 0.0)).g;
  col.b += 0.07 * scene(vPos + ghost * vec2(-0.9, 0.7) + vec2(wob, 0.0)).b;

  col = clamp(col * 1.3 + 0.35 * col * col, 0.0, 1.0);
  col += base;

  // Vignette.
  float vig = 16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
  col *= pow(clamp(vig, 0.0, 1.0), 0.3);

  // Scanlines, rolling slowly.
  float scans = clamp(0.35 + 0.35 * sin(4.0 * t + vPos.y / uRatio), 0.0, 1.0);
  col *= 0.7 + 0.6 * pow(scans, 1.7);

  // Mains flicker and a light phosphor column mask.
  col *= 1.0 + 0.01 * sin(50.0 * t);
  col *= 1.0 - 0.2 * clamp((mod(floor(vPos.x / uRatio), 2.0) - 0.5) * 2.0, 0.0, 1.0);

  // Graticule.
  vec2 q = uv;
  float grid = 1.0;
  grid *= 1.0 - smoothstep(0.98, 0.99, 2.0 * abs(fract(q.x * 10.0) - 0.5));
  grid *= 1.0 - smoothstep(0.96, 0.98, 2.0 * abs(fract(q.y * 4.0) - 0.5));
  col *= 0.6 + 0.4 * grid;

  // Rounded screen with a thin bright rim.
  vec2 half_ = size * 0.5;
  vec2 d2 = abs(vPos - (vRect.xy + half_)) - half_ + uCorner;
  float dist = length(max(d2, 0.0)) + min(max(d2.x, d2.y), 0.0) - uCorner;
  float cover = clamp(0.5 - dist, 0.0, 1.0);
  col += uColor * 0.05 * (1.0 - smoothstep(0.0, 1.5 * uRatio, -dist));

  outColor = vec4(min(col, vec3(1.0)) * cover, cover);
}
`;

/** A fullscreen triangle from `gl_VertexID` (no attributes), for the blur passes. */
export const BLUR_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** One direction of a separable gaussian; \`uStep\` is the tap spacing in uv. */
export const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  vec4 c = texture(uSrc, vUv) * 0.227027;
  c += (texture(uSrc, vUv + uStep) + texture(uSrc, vUv - uStep)) * 0.1945946;
  c += (texture(uSrc, vUv + uStep * 2.0) + texture(uSrc, vUv - uStep * 2.0)) * 0.1216216;
  c += (texture(uSrc, vUv + uStep * 3.0) + texture(uSrc, vUv - uStep * 3.0)) * 0.054054;
  c += (texture(uSrc, vUv + uStep * 4.0) + texture(uSrc, vUv - uStep * 4.0)) * 0.016216;
  outColor = c;
}
`;

/**
 * The bloom composite, drawn per cell with the CRT vertex shader: the sharp
 * trace plus four blurs of it, each half the size of the last, so the light
 * spreads over several radii at once like a real bloom.
 */
export const BLOOM_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
flat in vec4 vRect;

uniform sampler2D uScene;
uniform sampler2D uBloom0;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform sampler2D uBloom3;
uniform vec2 uResolution;
uniform float uStrength;

out vec4 outColor;

void main() {
  vec2 uv = vec2(vPos.x / uResolution.x, 1.0 - vPos.y / uResolution.y);
  vec4 sharp = texture(uScene, uv);
  vec3 bloom = texture(uBloom0, uv).rgb * 0.9
             + texture(uBloom1, uv).rgb * 0.8
             + texture(uBloom2, uv).rgb * 0.7
             + texture(uBloom3, uv).rgb * 0.6;
  vec3 rgb = min(sharp.rgb + bloom * uStrength, vec3(1.0));
  // Premultiplied: the coverage has to be at least the brightest channel.
  float a = clamp(max(sharp.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
  outColor = vec4(rgb, a);
}
`;

/**
 * Tapered needles for the Spikes view. Same instance layout as the trace
 * shader; each instance is a vertical segment about its own midpoint, thickest
 * and brightest at the middle and thinning to a point at both tips. Colour runs
 * from `uColor` to `uColor2` across the cell, and the shorter needles lean
 * towards the second colour.
 */
export const NEEDLE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
flat in vec4 vSegment;
flat in vec4 vClip;
flat in float vBright;

uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uCoreHalfWidth;
uniform float uGlowRadius;
uniform float uGlowStrength;

out vec4 outColor;

void main() {
  if (vPos.x < vClip.x || vPos.y < vClip.y || vPos.x > vClip.z || vPos.y > vClip.w) discard;

  vec2 a = vSegment.xy;
  vec2 b = vSegment.zw;
  vec2 mid = (a + b) * 0.5;
  vec2 ba = b - a;
  float len = length(ba);
  float halfLen = max(len * 0.5, 0.5);
  vec2 dir = len > 1e-4 ? ba / len : vec2(0.0, 1.0);

  // 0 in the middle of the needle, 1 at its tips.
  float s = clamp(abs(dot(vPos - mid, dir)) / halfLen, 0.0, 1.0);
  float taper = pow(1.0 - s, 2.2);

  // Distance to the segment itself, so the tips get round caps and a halo.
  vec2 pa = vPos - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h);

  float w = uCoreHalfWidth * 0.7 * mix(0.2, 1.0, taper);

  // Brightness fades along the whole length, from full at the middle of the
  // needle to nothing at its tips (no floor), so they dissolve into the dark.
  float fade = pow(1.0 - s, 1.7);
  float core = (1.0 - smoothstep(0.0, w, d)) * fade;

  float r = d / uGlowRadius;
  float halo = (0.6 * exp(-r * 6.0) + 0.4 * exp(-r * 2.4))
             * (1.0 - smoothstep(0.8, 1.0, r)) * uGlowStrength * fade;

  // Taller needles are brighter; the height in cell terms picks the colour too.
  float cellHalf = max((vClip.w - vClip.y) * 0.5, 1.0);
  float amp = clamp(halfLen / cellHalf, 0.0, 1.0);
  float fx = clamp((mid.x - vClip.x) / max(vClip.z - vClip.x, 1.0), 0.0, 1.0);
  vec3 col = mix(uColor, uColor2, clamp(fx * 0.7 + (1.0 - amp) * 0.3, 0.0, 1.0));

  float energy = max(core, halo) * (0.45 + 0.55 * amp);
  // The middle of a needle burns towards white.
  vec3 rgb = mix(col, vec3(1.0), 0.55 * core * fade) * energy;
  float a_ = clamp(energy, 0.0, 1.0);
  outColor = vec4(min(rgb, vec3(1.0)), a_) * vBright;
}
`;

/**
 * LED bars for the Equalizer view. Same instance layout as the trace shader;
 * each instance is one horizontal LED, a rounded box from `a` to `b` that is
 * `uCoreHalfWidth` tall on each side. The colour comes from where the LED sits
 * across the cell (a rainbow), so an instance needs no colour of its own, and
 * the per-instance brightness carries lit, unlit, peak and reflection LEDs.
 */
export const BARS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
flat in vec4 vSegment;
flat in vec4 vClip;
flat in float vBright;

uniform vec3 uColor;
uniform float uCoreHalfWidth;
uniform float uGlowRadius;
uniform float uGlowStrength;

out vec4 outColor;

void main() {
  if (vPos.x < vClip.x || vPos.y < vClip.y || vPos.x > vClip.z || vPos.y > vClip.w) discard;

  vec2 a = vSegment.xy;
  vec2 b = vSegment.zw;
  vec2 mid = (a + b) * 0.5;
  float halfLen = max(length(b - a) * 0.5, 0.5);

  // Distance to the LED's rounded box (x along the bar, y across it).
  vec2 q = abs(vPos - mid) - vec2(halfLen - 1.0, uCoreHalfWidth - 1.0);
  float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 1.0;

  float body = 1.0 - smoothstep(-0.5, 0.5, dist);
  float r = max(dist, 0.0) / uGlowRadius;
  float halo = (0.6 * exp(-r * 6.0) + 0.4 * exp(-r * 2.4))
             * (1.0 - smoothstep(0.8, 1.0, r)) * uGlowStrength;

  float fx = clamp((mid.x - vClip.x) / max(vClip.z - vClip.x, 1.0), 0.0, 1.0);
  // Cyan through blue and magenta to yellow and green, like the reference.
  vec3 col = 0.55 + 0.45 * cos(6.2831853 * (fx * 0.9 + vec3(0.02, 0.36, 0.68)));
  col = mix(col, vec3(1.0), 0.18);

  float energy = max(body, halo);
  outColor = vec4(min(col * energy, vec3(1.0)), clamp(energy, 0.0, 1.0)) * vBright;
}
`;
