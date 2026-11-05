import { constants } from "./common";

/**
 * Rain and snow as particles in screen space. Each one looks down at the
 * globe beneath it and only shows where the cloud map says something is
 * falling, so the same particles mark showers from orbit and fill the view
 * close up.
 */
export const precipitationVertex = /* glsl */ `
${constants}

attribute vec2 corner;
attribute vec4 aSeed;
attribute float aThreshold;

uniform samplerCube uClouds;
uniform vec3 uSun;
uniform mat4 uInverseViewProjection;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uOffset;
uniform vec2 uWind;
uniform float uCloseness;
uniform float uAmount;

varying vec2 vCorner;
varying float vAlpha;
varying float vSnow;
varying float vHail;
varying float vLight;

vec3 rayAt(vec2 ndc, out vec3 origin) {
  vec4 near = uInverseViewProjection * vec4(ndc, -1.0, 1.0);
  vec4 far = uInverseViewProjection * vec4(ndc, 1.0, 1.0);
  origin = near.xyz / near.w;
  return normalize(far.xyz / far.w - origin);
}

void main() {
  float depth = aSeed.z;
  float scale = mix(0.42, 1.0, uCloseness);
  float snowy = step(aSeed.w, 0.5);

  // Rain falls fast and straight, snow slowly with a sway; nearer is faster.
  vec2 fall = snowy > 0.5 ? vec2(0.0, mix(28.0, 80.0, depth)) : vec2(0.0, mix(520.0, 1300.0, depth));
  fall *= scale;
  vec2 drift = uWind * (snowy > 0.5 ? 0.45 : 1.0) * fall.y;
  vec2 velocity = vec2(drift.x, -fall.y);
  vec2 sway = snowy > 0.5 ? vec2(sin(uTime * (0.7 + depth) + aSeed.x * 40.0) * 9.0, 0.0) : vec2(0.0);
  vec2 screen = aSeed.xy + uOffset * mix(0.55, 1.0, depth) + (velocity * uTime + sway) / uResolution;
  screen = fract(screen);
  vec2 ndc = screen * 2.0 - 1.0;

  // What falls on the ground below this particle.
  vec3 origin;
  vec3 ray = rayAt(ndc, origin);
  float b = dot(origin, ray);
  float h = b * b - dot(origin, origin) + 1.0;
  float precip = 0.0;
  float snow = 0.0;
  float storm = 0.0;
  float light = 0.0;
  if (h > 0.0) {
    vec3 ground = normalize(origin + ray * (-b - sqrt(h)));
    vec4 cloud = texture(uClouds, ground);
    precip = cloud.g;
    snow = cloud.b;
    storm = cloud.a;
    light = mix(0.28, 1.0, smoothstep(-0.12, 0.2, dot(ground, uSun)));
  }
  // Heavier precipitation shows more of the particles, as well as stronger ones.
  float shown = smoothstep(aThreshold, aThreshold + 0.18, precip) * uAmount;
  // A particle's kind is fixed, as its motion depends on it; each kind shows
  // in proportion to how much of what falls here is snow.
  float roll = snowy > 0.5 ? aSeed.w * 2.0 : aSeed.w * 2.0 - 1.0;
  shown *= smoothstep(roll, roll + 0.08, snowy > 0.5 ? snow : 1.0 - snow);
  vAlpha = shown * mix(0.35, 1.0, uCloseness) * mix(0.55, 1.0, depth);
  vSnow = snowy;
  // The strongest storms carry hail: some raindrops show as pellets instead.
  vHail = snowy > 0.5 ? 0.0 : step(0.55, fract(aSeed.x * 91.7)) * smoothstep(0.78, 0.9, storm);
  vLight = light;
  vCorner = corner;

  if (vAlpha < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Streaks stretch along their motion, like a camera's short exposure.
  vec2 along = normalize(velocity + vec2(0.0001));
  // Right-handed with along, so the quad keeps its winding and isn't culled.
  vec2 across = vec2(along.y, -along.x);
  bool round = snowy > 0.5 || vHail > 0.5;
  vec2 size = snowy > 0.5
    ? vec2(mix(2.4, 6.5, depth)) * scale
    : vHail > 0.5
      ? vec2(mix(2.0, 3.6, depth)) * scale
      : vec2(mix(1.3, 2.6, depth), length(velocity) * 0.022);
  vec2 offset = round
    ? corner * size
    : across * corner.x * size.x + along * corner.y * size.y;
  gl_Position = vec4(ndc + offset * 2.0 / uResolution, 0.0, 1.0);
}
`;

export const precipitationFragment = /* glsl */ `
varying vec2 vCorner;
varying float vAlpha;
varying float vSnow;
varying float vHail;
varying float vLight;

void main() {
  // Mid tones with darker rims, so rain and snow show over bright cloud as
  // well as dark ground.
  float shape;
  vec3 color;
  if (vSnow > 0.5 || vHail > 0.5) {
    float r = length(vCorner) * 2.0;
    shape = smoothstep(1.0, 0.55, r);
    color = mix(vec3(0.62, 0.68, 0.78), vec3(1.0), smoothstep(0.75, 0.25, r));
  } else {
    float x = abs(vCorner.x) * 2.0;
    float along = smoothstep(-0.5, -0.1, vCorner.y) * smoothstep(0.5, 0.2, vCorner.y);
    shape = (1.0 - x * x) * along;
    color = mix(vec3(0.42, 0.5, 0.62), vec3(0.84, 0.9, 0.98), smoothstep(0.9, 0.2, x));
  }
  float a = shape * vAlpha * (vSnow > 0.5 || vHail > 0.5 ? 0.9 : 0.62);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(color * mix(0.45, 1.0, vLight) * a, a);
}
`;

/** Mist drifting over a foggy place, seen only close up. */
export const fogFragment = /* glsl */ `
uniform sampler3D uNoise;
uniform vec2 uResolution;
uniform float uTime;
uniform float uFog;
uniform vec2 uOffset;

void main() {
  vec2 p = gl_FragCoord.xy / uResolution.y + uOffset * vec2(uResolution.x / uResolution.y, 1.0);
  vec3 q = vec3(p * 0.22, uTime * 0.004);
  float n = texture(uNoise, q + vec3(uTime * 0.003, 0.0, 0.0)).r * 0.6
    + texture(uNoise, q * 2.3 - vec3(0.0, uTime * 0.004, 0.0)).g * 0.4;
  float a = uFog * smoothstep(0.32, 0.72, n) * 0.5;
  gl_FragColor = vec4(vec3(0.86, 0.89, 0.93) * a, a);
}
`;
