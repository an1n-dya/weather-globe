/** Colors here are written directly as display values; no tone mapping is applied. */

export const earthVertex = /* glsl */ `
attribute vec4 aColor;
varying vec4 vColor;
varying vec3 vWorld;

void main() {
  vColor = aColor;
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Flat facets, lit by the real sun. The face normal comes from screen-space
 * derivatives of the position, so the mesh needs no normals of its own.
 * Alpha in the color is gloss: water glints, land stays matte.
 */
export const earthFragment = /* glsl */ `
uniform vec3 uSun;
uniform float uOpacity;
varying vec4 vColor;
varying vec3 vWorld;

void main() {
  vec3 up = normalize(vWorld);
  vec3 faceNormal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(faceNormal, up) < 0.0) faceNormal = -faceNormal;
  vec3 toCamera = normalize(cameraPosition - vWorld);
  vec3 base = vColor.rgb;
  float gloss = vColor.a;

  // Day and night from the sphere, so the terminator is a soft, even band.
  float sunHeight = dot(up, uSun);
  float day = smoothstep(-0.11, 0.17, sunHeight);

  // Each facet takes its own light from the sun.
  float lambert = clamp(dot(faceNormal, uSun), 0.0, 1.0);
  vec3 lit = base * (0.46 + 0.74 * lambert);
  // A small glint on the water facets nearest the sun's reflection, and a broad faint sheen.
  vec3 halfway = normalize(uSun + toCamera);
  float facing = max(dot(faceNormal, halfway), 0.0);
  float glint = (pow(facing, 420.0) * 0.22 + pow(facing, 24.0) * 0.05) * gloss * day;
  lit += vec3(1.0, 0.96, 0.86) * glint;

  // Night: a cool, moonlit version of the day colors, so continents stay readable.
  // Water goes darker than land, which keeps the coastlines clear.
  float luma = dot(base, vec3(0.3, 0.55, 0.15));
  vec3 night = mix(vec3(luma), base, 0.5) * vec3(0.22, 0.27, 0.42) + vec3(0.012, 0.02, 0.05);
  night *= (0.8 + 0.4 * clamp(dot(faceNormal, toCamera), 0.0, 1.0)) * (1.0 - 0.42 * gloss);
  vec3 color = mix(night, lit, day);

  // A warm band along the terminator.
  float dusk = smoothstep(0.2, 0.0, abs(sunHeight - 0.03));
  color += vec3(0.2, 0.08, 0.02) * dusk * (0.3 + 0.7 * day);

  // Atmosphere toward the limb: blue by day, deep blue at night.
  float rim = pow(1.0 - max(dot(up, toCamera), 0.0), 3.0);
  vec3 air = mix(vec3(0.13, 0.2, 0.45), vec3(0.55, 0.78, 1.0), day);
  color = mix(color, air, rim * (0.3 + 0.3 * day));

  gl_FragColor = vec4(color, uOpacity);
}
`;

export const atmosphereVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vNormal = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const atmosphereFragment = /* glsl */ `
uniform vec3 uSun;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  // Rendered on the back faces, so the glow falls off away from the limb.
  float facing = max(dot(-vNormal, vView), 0.0);
  float glow = pow(facing, 2.6);
  float day = smoothstep(-0.35, 0.35, dot(vNormal, uSun));
  vec3 color = mix(vec3(0.14, 0.22, 0.5), vec3(0.42, 0.68, 1.0), day);
  gl_FragColor = vec4(color, glow * (0.3 + 0.6 * day));
}
`;

export const lightsVertex = /* glsl */ `
attribute float aSize;
attribute float aMagnitude;
uniform vec3 uSun;
uniform float uScale;
uniform float uThreshold;
varying float vAlpha;

void main() {
  vec3 normal = normalize(position);
  float night = 1.0 - smoothstep(-0.1, 0.05, dot(normal, uSun));
  // Facing the camera, rather than the depth buffer, hides the far side and the limb.
  float facing = smoothstep(0.04, 0.3, dot(normal, normalize(cameraPosition - position)));
  // Smaller places fade in as the camera comes closer.
  float shown = smoothstep(uThreshold - 0.7, uThreshold, aMagnitude);
  vAlpha = night * facing * shown;
  gl_PointSize = vAlpha > 0.004 ? max(1.0, aSize * uScale) : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const lightsFragment = /* glsl */ `
varying float vAlpha;

void main() {
  if (vAlpha <= 0.004) discard;
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.3, 1.0, d);
  if (core <= 0.0) discard;
  gl_FragColor = vec4(1.0, 0.85, 0.55, core * vAlpha * 0.95);
}
`;

export const starsVertex = /* glsl */ `
attribute float aSize;
uniform float uPixelRatio;

void main() {
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const starsFragment = /* glsl */ `
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(0.82, 0.88, 1.0, smoothstep(1.0, 0.2, d) * 0.75);
}
`;
