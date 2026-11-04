/** The sun seen from orbit: a small hot disk, its halo, and the streaks a lens adds. */
export const glareVertex = /* glsl */ `
varying vec2 vNdc;

void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const glareFragment = /* glsl */ `
uniform vec2 uCenter;
uniform float uAspect;
uniform float uVisible;
uniform vec3 uColor;
varying vec2 vNdc;

void main() {
  // Offsets in half screen heights, round whatever the aspect.
  vec2 q = (vNdc - uCenter) * vec2(uAspect, 1.0);
  float r = length(q);
  float disk = smoothstep(0.016, 0.008, r) * 2.5;
  float halo = exp(-r * 9.0) * 0.5 + exp(-r * 2.6) * 0.12;
  float streak = exp(-abs(q.y) * 110.0) * exp(-abs(q.x) * 2.8) * 0.3;
  float rays = pow(max(0.0, cos(atan(q.y, q.x) * 3.0)), 40.0) * exp(-r * 7.0) * 0.22;
  float light = (disk + halo + streak + rays) * uVisible;
  if (light < 0.002) discard;
  gl_FragColor = vec4(uColor * light, 0.0);
}
`;
