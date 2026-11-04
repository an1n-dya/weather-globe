import { constants, equirect, hash, output } from "./common";

/**
 * The planet, its clouds and its air, ray traced on one shell that encloses
 * the atmosphere. Every surface is found analytically per pixel, so the limb
 * stays round and sharp at any zoom, and everything is tone mapped once.
 */

export const planetVertex = /* glsl */ `
varying vec3 vWorld;

void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const planetFragment = /* glsl */ `
${constants}
${hash}
${equirect}
${output}

uniform vec3 uSun;
uniform sampler2D uDay;
uniform sampler2D uLights;
uniform sampler2D uWater;
uniform samplerCube uClouds;
uniform sampler3D uNoise;
uniform float uDayReady;
uniform float uCloudAmount;
uniform float uTime;
uniform float uLightning;
uniform float uDetail;
uniform float uExposure;
uniform float uReveal;

varying vec3 vWorld;

// The air, in planet radii. Its height is exaggerated about eight times so it
// reads at globe scale, and scattering is scaled down to match, which keeps
// the real atmosphere's vertical optical depth and so its colors.
const float R_TOP = 1.068;
const float H_R = 0.0095;
const float H_M = 0.0022;
const float LN2 = 0.6931472;
const vec3 BETA_R = vec3(4.89, 11.4, 27.9);
// Ozone absorbs mostly orange and red, which keeps twilight skies blue.
const vec3 BETA_O = vec3(2.05, 5.94, 0.27);
const float BETA_M = 13.6;
const vec3 SUN = vec3(1.0, 0.98, 0.95);
const vec3 OCEAN = vec3(0.010, 0.026, 0.060);

vec2 sphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float h = b * b - dot(ro, ro) + radius * radius;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Schüler's approximation of the Chapman function times 2^-h, with the
// radius X and the height h measured in heights at which density halves.
float chapman(float X, float h, float cosChi) {
  float c = sqrt(X + h);
  if (cosChi >= 0.0) return c / (c * cosChi + 1.0) * exp2(-h);
  float x0 = sqrt(max(0.0, 1.0 - cosChi * cosChi)) * (X + h);
  return 2.0 * sqrt(x0) * exp2(min(X - x0, 30.0)) - c / (1.0 - c * cosChi) * exp2(-h);
}

// How much of the sun a point at radius r sees, past the planet's curve.
float sunVisibility(float r, float mu) {
  float horizon = -sqrt(max(0.0, 1.0 - 1.0 / (r * r)));
  return smoothstep(horizon - 0.03, horizon + 0.03, mu);
}

vec3 opticalDepthToSun(float r, float mu) {
  float h = r - 1.0;
  float h50R = H_R * LN2;
  float h50M = H_M * LN2;
  float odR = h50R * chapman(1.0 / h50R, h / h50R, mu);
  float odM = h50M * chapman(1.0 / h50M, h / h50M, mu);
  return (BETA_R + BETA_O) * odR + vec3(BETA_M * 1.11) * odM;
}

vec3 sunlightAt(vec3 p) {
  float r = length(p);
  float mu = dot(p, uSun) / r;
  float visible = sunVisibility(r, mu);
  if (visible <= 0.0) return vec3(0.0);
  return SUN * exp(-opticalDepthToSun(r, mu)) * visible;
}

float phaseRayleigh(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseMie(float c) {
  const float g = 0.76;
  const float g2 = g * g;
  return 0.1193662 * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Single scattering along the view ray, from t0 to t1.
vec3 scatter(vec3 ro, vec3 rd, float t0, float t1, out vec3 transmittance) {
  float ds = (t1 - t0) / float(STEPS);
  vec3 depth = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
    float r = length(p);
    float h = max(r - 1.0, 0.0);
    float dR = exp(-h / H_R);
    float dM = exp(-h / H_M);
    vec3 half_ = ((BETA_R + BETA_O) * dR + vec3(BETA_M * 1.11 * dM)) * ds * 0.5;
    depth += half_;
    float mu = dot(p, uSun) / r;
    float visible = sunVisibility(r, mu);
    if (visible > 0.0) {
      vec3 t = exp(-(depth + opticalDepthToSun(r, mu))) * visible * ds;
      sumR += t * dR;
      sumM += t * dM;
    }
    depth += half_;
  }
  transmittance = exp(-depth);
  float c = dot(rd, uSun);
  return SUN * (sumR * BETA_R * phaseRayleigh(c) + sumM * BETA_M * phaseMie(c));
}

// Cubic B-spline filtering from four bilinear reads (GPU Gems 2, chapter 20),
// so magnified city lights are soft points rather than square texels.
float smoothLights(vec3 n) {
  vec2 size = vec2(textureSize(uLights, 0));
  vec2 uv = equirectUv(n) * size - 0.5;
  vec2 i = floor(uv);
  vec2 f = uv - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 a = (i - 0.5 + w1 / g0) / size;
  vec2 b = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * textureLod(uLights, a, 0.0).r + g1.x * textureLod(uLights, vec2(b.x, a.y), 0.0).r)
    + g1.y * (g0.x * textureLod(uLights, vec2(a.x, b.y), 0.0).r + g1.x * textureLod(uLights, b, 0.0).r);
}

// Rare, soft flashes in thundery cloud, about a degree across.
float lightning(vec3 n, float thunder) {
  if (thunder < 0.02 || uLightning <= 0.0) return 0.0;
  vec3 q = n * 48.0;
  vec3 cell = floor(q);
  vec3 h = hash33(cell);
  float t = uTime * (0.25 + 0.35 * h.x) + h.y * 13.0;
  float slot = floor(t);
  float phase = t - slot;
  float roll = hash13(cell + vec3(slot * 7.0, slot * 3.0, 11.0));
  float on = step(1.0 - 0.2 * thunder, roll);
  float envelope = exp(-phase * 16.0) + 0.6 * exp(-abs(phase - 0.16) * 34.0);
  // Each flash stays inside its own cell, as only that cell is looked at.
  vec3 center = cell + 0.5 + (hash33(cell + 17.0) - 0.5) * 0.12;
  vec3 d = q - center;
  float glow = exp(-dot(d, d) / 0.045) * smoothstep(0.46, 0.3, length(d));
  return on * envelope * glow;
}

vec3 shadeGround(vec3 n, vec3 view, vec3 day, float water, float grain, float cloudShadow) {
  vec3 albedo = mix(OCEAN, day, uDayReady);
  // Deep water in the imagery is darker than the sea looks from orbit.
  albedo = mix(albedo, max(albedo, OCEAN), water);
  albedo *= 1.0 + grain * 0.22 * uDetail * (1.0 - water);

  float mu = dot(n, uSun);
  vec3 sun = sunlightAt(n) * cloudShadow;
  float twilight = smoothstep(-0.22, 0.25, mu);
  // Sky light by day, and a little moonlight by night to make out the land.
  vec3 sky = vec3(0.16, 0.24, 0.42) * twilight * 0.22 + vec3(0.010, 0.014, 0.028);
  vec3 color = albedo / PI * (sun * max(mu, 0.0) + sky);

  // Sun glint on open water, with the sky reflected toward the limb.
  vec3 halfway = normalize(uSun + view);
  float nh = max(dot(n, halfway), 0.0);
  float nv = max(dot(n, view), 0.02);
  float nl = max(mu, 0.0);
  const float a2 = 0.012;
  float d = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(view, halfway), 0.0), 5.0);
  float skyFresnel = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  float shiny = water * (1.0 - smoothstep(0.08, 0.3, dot(day, vec3(0.33))) * uDayReady);
  color += shiny * (sun * d * fresnel * nl / (4.0 * nv * max(nl, 0.02)) * 0.9 + sky * skyFresnel * 0.6);
  return color;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 view = -rd;

  vec2 top = sphere(ro, rd, R_TOP);
  if (top.y <= 0.0) discard;
  float b = dot(ro, rd);
  float closest = sqrt(max(dot(ro, ro) - b * b, 0.0));
  float coverage = clamp(0.5 + (1.0 - closest) / max(fwidth(closest), 1e-6), 0.0, 1.0);

  vec2 ground = sphere(ro, rd, 1.0);
  bool hit = ground.x > 0.0;
  float tGround = hit ? ground.x : -b;
  float t0 = max(top.x, 0.0);
  float t1 = hit ? tGround : top.y;

  vec3 transmittance;
  vec3 air = scatter(ro, rd, t0, t1, transmittance);

  // Faint airglow, a green line along the night limb.
  float limbHeight = closest - 1.0;
  float night = 1.0 - smoothstep(-0.25, 0.1, dot(normalize(ro + rd * max(-b, 0.0)), uSun));
  air += vec3(0.0012, 0.0032, 0.0015) * exp(-pow((limbHeight - 0.016) / 0.0035, 2.0)) * night * (1.0 - coverage);

  vec3 outside = toDisplay(toneMap(air * uExposure));
  vec3 color = outside;
  float alpha = 0.0;

  // Every texture is read here, before any branch, so mip selection sees all
  // four pixels of a quad even where some of them miss the planet or cloud.
  // Rays that miss look up the point where they pass closest instead.
  vec3 n = normalize(ro + rd * tGround);
  vec3 day = sampleEquirect(uDay, n).rgb;
  float water = sampleEquirect(uWater, n).r;
  float lights = sampleEquirect(uLights, n).r;
  // Close up, the map is magnified, and smooth filtering hides its texels.
  // Branches on uniforms like this one keep the whole quad together.
  if (uDetail > 0.0) lights = mix(lights, smoothLights(n), uDetail);
  float grain = texture(uNoise, n * 26.0).r - 0.5;
  float groundMu = dot(n, uSun);
  float toShell = -groundMu + sqrt(groundMu * groundMu + R_CLOUD * R_CLOUD - 1.0);
  float overhead = texture(uClouds, normalize(n + uSun * toShell)).r;

  vec2 shell = sphere(ro, rd, R_CLOUD);
  vec3 nc = normalize(ro + rd * (shell.x > 0.0 ? shell.x : max(-b, 0.0)));
  vec4 cloud = texture(uClouds, nc);
  float mu = dot(nc, uSun);
  // Thick cloud toward the sun leaves this side in its shade.
  vec3 towardSun = uSun - nc * mu;
  float ahead = texture(uClouds, normalize(nc + towardSun * 0.02)).r;
  float fine = 0.5;
  if (uDetail > 0.0) fine = texture(uNoise, nc * 7.0).r * 0.6 + texture(uNoise, nc * 19.0).r * 0.4;
  float glow = textureLod(uLights, equirectUv(nc), 4.5).r;

  // Clouds, on a thin shell just above the ground.
  float cloudAlpha = 0.0;
  vec3 cloudColor = vec3(0.0);
  if (shell.x > 0.0 && uCloudAmount > 0.0) {
    float density = cloud.r;
    density = clamp(density + (fine - 0.5) * 0.55 * uDetail * (1.0 - density * 0.6), 0.0, 1.0);
    // Close up, the view looks down through thinner cloud at the ground and
    // what falls on it.
    cloudAlpha = density * uCloudAmount * (1.0 - 0.5 * uDetail);

    // Lit as if at a real cloud height, so the sunset band isn't drawn too wide.
    vec3 sun = sunlightAt(nc * 1.0016);
    float shade = 1.0 - 0.45 * clamp(ahead - density * 0.7, 0.0, 1.0);
    float wrap = clamp((mu + 0.32) / 1.32, 0.0, 1.0);
    vec3 skyLight = vec3(0.18, 0.24, 0.36) * smoothstep(-0.25, 0.3, mu) * 0.3;
    vec3 albedo = vec3(0.86) * mix(1.0, mix(0.8, 0.62, uDetail), cloud.g);
    cloudColor = albedo / PI * (sun * wrap * shade * 1.05 + skyLight) + vec3(0.004, 0.0048, 0.0068);

    // City light glowing up through cloud, and lightning inside it.
    float dark = 1.0 - smoothstep(-0.12, 0.05, mu);
    cloudColor += vec3(1.0, 0.62, 0.32) * glow * glow * 0.05 * density * dark;
    float flash = lightning(nc, cloud.a) * uLightning;
    cloudColor += vec3(0.72, 0.8, 1.0) * flash * mix(0.35, 0.07, smoothstep(-0.1, 0.3, mu)) * density;
  }

  if (coverage > 0.0) {
    // Cloud where the ray toward the sun crosses the cloud shell.
    float shadow = 1.0 - 0.72 * smoothstep(0.05, 0.85, overhead) * uCloudAmount;
    vec3 surface = shadeGround(n, view, day, water, grain, shadow);
    float lightsVisible = 1.0 - smoothstep(-0.14, 0.03, groundMu);
    vec3 lamp = mix(vec3(1.0, 0.6, 0.28), vec3(1.0, 0.88, 0.72), smoothstep(0.45, 1.0, lights));
    surface += lamp * lights * lights * 0.11 * lightsVisible * (1.0 - cloudAlpha * 0.85);
    surface = mix(surface, cloudColor, cloudAlpha);
    vec3 inside = toDisplay(toneMap((air + transmittance * surface) * uExposure));
    color = mix(outside, inside, coverage);
    alpha = coverage;
  } else if (cloudAlpha > 0.0) {
    vec3 cloudy = toDisplay(toneMap((air + transmittance * cloudColor) * uExposure));
    color = mix(outside, cloudy, cloudAlpha);
    alpha = cloudAlpha;
  }

  gl_FragColor = vec4(color, alpha) * uReveal;
}
`;
