/** Colors here are written directly as display values; no tone mapping is applied. */

export const earthVertex = /* glsl */ `
attribute vec3 aColor;
varying vec3 vColor;
varying vec3 vFaceNormal;
varying vec3 vPosition;

void main() {
  vColor = aColor;
  vFaceNormal = normal;
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const earthFragment = /* glsl */ `
uniform vec3 uSun;
varying vec3 vColor;
varying vec3 vFaceNormal;
varying vec3 vPosition;

void main() {
  vec3 sphereNormal = normalize(vPosition);
  float sunHeight = dot(sphereNormal, uSun);
  float day = smoothstep(-0.09, 0.13, sunHeight);

  float facet = max(dot(normalize(vFaceNormal), uSun), 0.0);
  vec3 lit = vColor * (0.64 + 0.5 * facet);
  // Night narrows the color range, so light deserts don't stand out as gray.
  vec3 nightBase = mix(vColor, vec3(0.32, 0.44, 0.58), 0.55);
  vec3 night = nightBase * vec3(0.17, 0.21, 0.40) + vec3(0.012, 0.02, 0.05);
  vec3 color = mix(night, lit, day);

  // A warm band along the terminator.
  float dusk = smoothstep(0.2, 0.0, abs(sunHeight - 0.02));
  color += vec3(0.15, 0.06, 0.015) * dusk * day;

  // Soft haze toward the limb.
  vec3 toCamera = normalize(cameraPosition - vPosition);
  float rim = pow(1.0 - max(dot(sphereNormal, toCamera), 0.0), 3.0);
  color = mix(color, vec3(0.58, 0.78, 1.0), rim * (0.06 + 0.2 * day));

  gl_FragColor = vec4(color, 1.0);
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
