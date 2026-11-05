/**
 * Catalog stars on a distant sphere. Positions are stored as if Greenwich
 * pointed at right ascension 0; turning by sidereal time puts each star over
 * the longitude it really stands above.
 */
export const starsVertex = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uSidereal;
uniform float uPixelRatio;
varying vec3 vColor;

void main() {
  float c = cos(uSidereal), s = sin(uSidereal);
  vec3 p = vec3(c * position.x - s * position.z, position.y, s * position.x + c * position.z);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * viewMatrix * vec4(p * 40.0, 1.0);
}
`;

export const starsFragment = /* glsl */ `
uniform float uReveal;
varying vec3 vColor;

void main() {
  // A flat core, so even a two-pixel star lights its pixels fully.
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.3, 1.0, d);
  if (a <= 0.0) discard;
  // Premultiplied, like the rest of the frame.
  gl_FragColor = vec4(vColor * a, 0.0) * uReveal;
}
`;
