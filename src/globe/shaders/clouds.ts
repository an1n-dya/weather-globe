import { constants, cubeFace, equirect, hash } from "./common";

/**
 * Fills one layer of a tileable 3D noise volume: four independent channels of
 * gradient noise, so shaders get fractal noise from a few texture reads
 * instead of costly arithmetic noise.
 */
export const noiseVolumeFragment = /* glsl */ `
${hash}

uniform float uLayer;
uniform float uSize;
uniform float uPeriod;

float gradientNoise(vec3 p, float channel) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 salt = vec3(channel * 131.0, channel * 71.0, channel * 29.0);
  float corners[8];
  for (int c = 0; c < 8; c++) {
    vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
    vec3 g = normalize(hash33(mod(i + o, uPeriod) + salt) * 2.0 - 1.0 + 1e-4);
    corners[c] = dot(g, f - o);
  }
  return mix(
    mix(mix(corners[0], corners[1], u.x), mix(corners[2], corners[3], u.x), u.y),
    mix(mix(corners[4], corners[5], u.x), mix(corners[6], corners[7], u.x), u.y),
    u.z
  );
}

void main() {
  vec3 p = vec3(gl_FragCoord.xy, uLayer + 0.5) / uSize * uPeriod;
  vec4 n = vec4(gradientNoise(p, 0.0), gradientNoise(p, 1.0), gradientNoise(p, 2.0), gradientNoise(p, 3.0));
  gl_FragColor = clamp(n * 0.62 + 0.5, 0.0, 1.0);
}
`;

/**
 * Renders one face of the cloud cube map: red is cloud density, green rain or
 * snow, blue the share of it that is snow, alpha lightning. The weather field
 * says where cloud is and how much; fractal noise drawn through it says what
 * it looks like, drifting on the prevailing winds.
 */
export const cloudFragment = /* glsl */ `
${constants}
${hash}
${equirect}
${cubeFace}

uniform int uFace;
uniform float uSize;
uniform float uTime;
uniform sampler3D uNoise;
uniform sampler2D uField;
uniform sampler2D uFieldPrev;
uniform float uFieldMix;
uniform vec3 uSpotDir;
uniform vec4 uSpotSky;
uniform float uSpotWeight;

// Seconds per flow cycle, and how far cloud drifts in one, in radians.
const float CYCLE = 40.0;
const float DRIFT = 0.022;
// One noise tile spans this many planet radii at the coarsest octave.
const float TILE = 4.6;
// Spread of the fractal noise, measured, for turning cloud cover into a threshold.
const float SPREAD = 0.067;
const mat3 TURN = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

vec3 rotateY(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

// Easterly trade winds, then westerlies, then polar easterlies.
float zonalWind(float y) {
  float lat = asin(clamp(y, -1.0, 1.0));
  return -cos(3.0 * lat) + 0.2;
}

float fbm(vec3 p) {
  vec4 warp = texture(uNoise, p * 0.45 + 0.37);
  p += (warp.gba - 0.5) * 0.11;
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < OCTAVES; i++) {
    sum += amp * texture(uNoise, p).r;
    norm += amp;
    amp *= 0.53;
    p = TURN * p * 2.03;
  }
  return sum / norm;
}

vec4 weatherAt(vec3 dir) {
  vec2 uv = equirectUv(dir);
  vec4 field = mix(textureLod(uFieldPrev, uv, 0.0), textureLod(uField, uv, 0.0), uFieldMix);
  // The selected place's own forecast, blended over a few degrees around it.
  float spot = uSpotWeight * smoothstep(0.9962, 0.9994, dot(dir, uSpotDir));
  return mix(field, uSpotSky, spot);
}

void main() {
  vec3 dir = cubeDirection(uFace, gl_FragCoord.xy / uSize);
  vec4 weather = weatherAt(dir);

  // Two copies of the noise drift along the wind half a cycle apart, each
  // faded out as it jumps back, so the motion never visibly resets.
  float wind = zonalWind(dir.y) * DRIFT;
  float phase = uTime / CYCLE;
  float a = fract(phase);
  float b = fract(phase + 0.5);
  float breathe = 1.0 + 0.025 * sin(uTime * 0.0097);
  // Squeezed north to south, so cloud bands stretch along the winds.
  vec3 p = dir * vec3(1.0, 1.3, 1.0) * (breathe / TILE);
  float na = fbm(rotateY(p, -wind * a) + 0.3);
  float nb = fbm(rotateY(p, -wind * b) + 0.3);
  float wa = 1.0 - abs(2.0 * a - 1.0);
  float wb = 1.0 - wa;
  float n = ((na - 0.5) * wa + (nb - 0.5) * wb) / sqrt(wa * wa + wb * wb) + 0.5;

  // Rain needs thick cloud overhead. The boost ramps in, as a sudden one
  // would draw the edge of every shower as a hard line.
  float wet = smoothstep(0.0, 0.12, weather.g);
  float cover = clamp(max(weather.r, wet * (0.7 + 0.3 * weather.g)), 0.02, 0.98);
  // The noise is close to normal, so the inverse of its distribution (here
  // the logistic approximation) turns a cover fraction into a threshold.
  float threshold = 0.5 + SPREAD * log((1.0 - cover) / cover) / 1.702 - 0.02;
  float density = smoothstep(threshold - 0.012, threshold + 0.1, n);
  density *= mix(0.62, 1.0, smoothstep(threshold + 0.03, threshold + 0.2, n));
  // Overcast skies close up into a sheet, however the noise falls. The wide
  // ramp keeps the edge of an overcast region from showing as a line.
  density = mix(density, max(density, 0.62), smoothstep(0.78, 1.0, cover));

  float core = smoothstep(threshold + 0.02, threshold + 0.12, n);
  gl_FragColor = vec4(density, weather.g * core, weather.b, weather.a * core);
}
`;
