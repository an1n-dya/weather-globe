import {
  BufferGeometry,
  Color,
  CustomBlending,
  Float32BufferAttribute,
  type IUniform,
  Mesh,
  OneFactor,
  type PerspectiveCamera,
  ShaderMaterial,
  Vector2,
  Vector3,
  ZeroFactor,
} from "three";
import { glareFragment, glareVertex } from "./shaders/glare";

const LOW_SUN = new Color(1.0, 0.56, 0.26);
const HIGH_SUN = new Color(1.0, 0.96, 0.88);

/**
 * How much of the sun shows past the planet, seen from `camera` at distance
 * from the center, with the sun toward `sun`: 0 when hidden, rising to 1 as
 * the line of sight clears the limb. Also how far clear, in planet radii.
 */
export function sunClearance(
  camera: Vector3,
  sun: Vector3,
): { visible: number; clearance: number } {
  const along = -camera.dot(sun);
  // The planet sits behind the camera from the sun's point of view.
  if (along <= 0) return { visible: 0, clearance: Number.POSITIVE_INFINITY };
  const closest = Math.sqrt(Math.max(0, camera.lengthSq() - along * along));
  const t = Math.max(0, Math.min(1, (closest - 1) / 0.018));
  return { visible: t * t * (3 - 2 * t), clearance: closest - 1 };
}

/**
 * The sun, drawn only when it is in the frame and not behind the planet: the
 * rare view of a sunrise over the limb.
 */
export class SunGlare {
  readonly mesh: Mesh;
  private readonly point = new Vector3();
  private readonly center = new Vector2();
  private readonly color = new Color();
  private readonly aspect = { value: 1 };
  private readonly strength = { value: 0 };

  constructor(
    private readonly sun: IUniform<Vector3>,
    private readonly reveal: IUniform<number>,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    const material = new ShaderMaterial({
      vertexShader: glareVertex,
      fragmentShader: glareFragment,
      uniforms: {
        uCenter: { value: this.center },
        uAspect: this.aspect,
        uVisible: this.strength,
        uColor: { value: this.color },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  update(camera: PerspectiveCamera): void {
    const { visible, clearance } = sunClearance(camera.position, this.sun.value);
    const ndc = this.point
      .copy(camera.position)
      .addScaledVector(this.sun.value, 30)
      .project(camera);
    // A margin, so the halo can reach in from just outside the frame.
    const inFrame = Math.abs(ndc.x) < 1.4 && Math.abs(ndc.y) < 1.4 && ndc.z < 1;
    const strength = inFrame ? visible * this.reveal.value : 0;
    this.mesh.visible = strength > 0.001;
    if (!this.mesh.visible) return;
    this.center.set(ndc.x, ndc.y);
    this.aspect.value = camera.aspect;
    this.strength.value = strength;
    // Seen through the air at the limb, the sun is low and red.
    const height = Math.max(0, Math.min(1, clearance / 0.05));
    this.color.copy(LOW_SUN).lerp(HIGH_SUN, height);
  }
}
