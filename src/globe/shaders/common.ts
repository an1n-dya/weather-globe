/**
 * GLSL shared by the globe's shaders. World space is Earth-fixed: +Y is north,
 * +Z faces longitude 0 and +X longitude 90°E, with the planet a unit sphere.
 */

export const constants = /* glsl */ `
const float PI = 3.141592653589793;
const float R_CLOUD = 1.0095;
`;

/** Integer hashes are exact on every GPU, unlike the usual sine-based ones. */
export const hash = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash33(vec3 p) {
  return vec3(pcg3d(uvec3(ivec3(floor(p)) + 65536))) * (1.0 / 4294967295.0);
}
float hash13(vec3 p) { return hash33(p).x; }
`;

/** Equirectangular texture coordinates, north at the top: row 0 holds latitude 90°. */
export const equirect = /* glsl */ `
vec2 equirectUv(vec3 n) {
  return vec2(atan(n.x, n.z) * (0.5 / PI) + 0.5, acos(clamp(n.y, -1.0, 1.0)) / PI);
}
// Derivatives from a copy of u turned by half a revolution, so the seam at
// the antimeridian doesn't select the blurriest mip level.
vec4 sampleEquirect(sampler2D map, vec3 n) {
  vec2 uv = equirectUv(n);
  vec2 alt = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxAlt = dFdx(alt), dyAlt = dFdy(alt);
  dx.x = abs(dx.x) < abs(dxAlt.x) ? dx.x : dxAlt.x;
  dy.x = abs(dy.x) < abs(dyAlt.x) ? dy.x : dyAlt.x;
  return textureGrad(map, uv, dx, dy);
}
`;

/** A filmic curve: highlights such as sun glint roll off instead of clipping. */
export const output = /* glsl */ `
vec3 toneMap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toDisplay(vec3 linear) {
  vec3 c = clamp(linear, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

/** The direction a texel of a cube face looks along, following the WebGL face layout. */
export const cubeFace = /* glsl */ `
vec3 cubeDirection(int face, vec2 st) {
  vec2 c = st * 2.0 - 1.0;
  if (face == 0) return normalize(vec3(1.0, -c.y, -c.x));
  if (face == 1) return normalize(vec3(-1.0, -c.y, c.x));
  if (face == 2) return normalize(vec3(c.x, 1.0, c.y));
  if (face == 3) return normalize(vec3(c.x, -1.0, -c.y));
  if (face == 4) return normalize(vec3(c.x, -c.y, 1.0));
  return normalize(vec3(-c.x, -c.y, -1.0));
}
`;

/** Clip-space triangle covering the whole target, for passes without a camera. */
export const fullscreenVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
