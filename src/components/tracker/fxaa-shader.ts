/**
 * A cheap FXAA (Lottes' two-tap form) as GLSL for a fragment shader that has a
 * `sampler2D` named `sampler`: defines `lumaOf` and `antiAlias(uv)`, which
 * returns the filtered texel. Run it on values that are already under a gamma
 * (or a tone curve), so edges are judged about as the eye sees them. Flat areas
 * bail out after the first taps; only the edge pixels pay for the rest.
 */
export function fxaaGlsl(sampler: string): string {
  return `
float lumaOf(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

vec4 antiAlias(vec2 uv) {
  vec2 px = 1.0 / vec2(textureSize(${sampler}, 0));
  vec4 m = texture(${sampler}, uv);
  float lM = lumaOf(m.rgb);
  float lNW = lumaOf(texture(${sampler}, uv + vec2(-1.0, 1.0) * px).rgb);
  float lNE = lumaOf(texture(${sampler}, uv + vec2(1.0, 1.0) * px).rgb);
  float lSW = lumaOf(texture(${sampler}, uv + vec2(-1.0, -1.0) * px).rgb);
  float lSE = lumaOf(texture(${sampler}, uv + vec2(1.0, -1.0) * px).rgb);
  float lo = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float hi = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (hi - lo < max(0.03, hi * 0.1)) return m;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * px;

  vec4 a = 0.5 * (texture(${sampler}, uv + dir * (1.0 / 3.0 - 0.5))
                + texture(${sampler}, uv + dir * (2.0 / 3.0 - 0.5)));
  vec4 b = a * 0.5 + 0.25 * (texture(${sampler}, uv + dir * -0.5)
                           + texture(${sampler}, uv + dir * 0.5));
  float lB = lumaOf(b.rgb);
  return (lB < lo || lB > hi) ? a : b;
}
`;
}
