import {
  ClampToEdgeWrapping,
  type Data3DTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";
import { FIELD_HEIGHT, FIELD_WIDTH } from "../weather/field";
import { FullscreenPass } from "./passes";
import type { Quality } from "./quality";
import { cloudFragment } from "./shaders/clouds";

/** Outward normals of the cube faces, in WebGL's face order. */
const FACE_NORMALS = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

/** A face this close to facing away can still show at the edge of the globe. */
const VISIBLE_DOT = -0.62;
const FIELD_FADE_S = 1.5;
const SPOT_FADE_S = 0.8;

function fieldTexture(data: Uint8Array<ArrayBuffer>): DataTexture {
  const texture = new DataTexture(data, FIELD_WIDTH, FIELD_HEIGHT, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function cloudUniforms(
  noise: Data3DTexture,
  field: DataTexture,
  previous: DataTexture,
  size: number,
) {
  return {
    uFace: { value: 0 },
    uSize: { value: size },
    uTime: { value: 0 },
    uNoise: { value: noise },
    uField: { value: field },
    uFieldPrev: { value: previous },
    uFieldMix: { value: 1 },
    uSpotDir: { value: new Vector3(0, 1, 0) },
    uSpotSky: { value: new Vector4() },
    uSpotWeight: { value: 0 },
  };
}

/**
 * The cloud cube map and what drives it. While cloud only drifts, one face is
 * redrawn at a time, favoring faces in view and long since drawn, so it costs
 * a fraction of a frame. While the weather itself changes, every face in view
 * is redrawn together, so neighbors never disagree along their shared edge.
 */
export class CloudLayer {
  readonly target: WebGLCubeRenderTarget;
  private readonly pass: FullscreenPass;
  private readonly uniforms: ReturnType<typeof cloudUniforms>;
  private readonly drawnAt = [0, 0, 0, 0, 0, 0];
  private readonly stale = [true, true, true, true, true, true];
  private field: DataTexture;
  private fieldPrev: DataTexture;
  private fieldMix = 1;
  private spotWeight = 0;
  private spotTarget = 0;
  private pendingSpot: { dir: Vector3; sky: Vector4 } | null = null;

  constructor(noise: Data3DTexture, initialField: Uint8Array<ArrayBuffer>, quality: Quality) {
    this.target = new WebGLCubeRenderTarget(quality.cloudFace, {
      type: UnsignedByteType,
      format: RGBAFormat,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.field = fieldTexture(initialField);
    this.fieldPrev = fieldTexture(new Uint8Array(initialField));
    this.uniforms = cloudUniforms(noise, this.field, this.fieldPrev, quality.cloudFace);
    this.pass = new FullscreenPass({
      fragmentShader: cloudFragment,
      defines: { OCTAVES: quality.cloudOctaves },
      uniforms: this.uniforms,
    });
  }

  /** New weather, which fades in over a moment unless `instant`. */
  setField(data: Uint8Array<ArrayBuffer>, instant: boolean): void {
    // The texture being faded in becomes the one faded from.
    const previous = this.fieldPrev;
    this.fieldPrev = this.field;
    previous.image.data = data;
    previous.needsUpdate = true;
    this.field = previous;
    this.fieldMix = instant ? 1 : 0;
    this.uniforms.uField.value = this.field;
    this.uniforms.uFieldPrev.value = this.fieldPrev;
    this.invalidate();
  }

  /**
   * The selected place's own conditions, which should match the panel.
   * `sky` holds cloud, precipitation, snow share and lightning, each 0 to 1.
   */
  setSpot(dir: Vector3 | null, sky: Vector4, instant: boolean): void {
    if (!dir) {
      this.spotTarget = 0;
      this.pendingSpot = null;
    } else if (instant || this.spotWeight < 0.01) {
      this.applySpot(dir, sky);
    } else {
      // Fade the old spot out before showing the new one somewhere else.
      this.pendingSpot = { dir: dir.clone(), sky: sky.clone() };
      this.spotTarget = 0;
    }
    if (instant) this.spotWeight = this.spotTarget;
    this.invalidate();
  }

  private applySpot(dir: Vector3, sky: Vector4): void {
    this.uniforms.uSpotDir.value.copy(dir);
    this.uniforms.uSpotSky.value.copy(sky);
    this.spotTarget = 1;
    this.pendingSpot = null;
  }

  /** Every face needs redrawing, such as after new data or a lost context. */
  invalidate(): void {
    this.stale.fill(true);
  }

  /** True while a fade is under way, which needs every face in view kept current. */
  get transitioning(): boolean {
    return (
      this.fieldMix < 1 ||
      Math.abs(this.spotWeight - this.spotTarget) > 0.001 ||
      this.pendingSpot !== null
    );
  }

  /**
   * Advances fades by `dt` seconds and redraws up to `faces` faces, more when
   * faces in view are out of date. Returns whether anything was drawn.
   */
  update(
    renderer: WebGLRenderer,
    time: number,
    dt: number,
    viewDir: Vector3,
    faces: number,
  ): boolean {
    if (this.fieldMix < 1) this.fieldMix = Math.min(1, this.fieldMix + dt / FIELD_FADE_S);
    if (this.spotWeight !== this.spotTarget) {
      const step = dt / SPOT_FADE_S;
      this.spotWeight =
        this.spotWeight < this.spotTarget
          ? Math.min(this.spotTarget, this.spotWeight + step)
          : Math.max(this.spotTarget, this.spotWeight - step);
    }
    if (this.pendingSpot && this.spotWeight <= 0) {
      this.applySpot(this.pendingSpot.dir, this.pendingSpot.sky);
    }
    if (this.transitioning) this.invalidate();
    this.uniforms.uFieldMix.value = this.fieldMix;
    this.uniforms.uSpotWeight.value = this.spotWeight;
    this.uniforms.uTime.value = time;

    // Stale faces in view can't wait: one drawn without its neighbor would show a seam.
    const due: number[] = [];
    FACE_NORMALS.forEach((normal, face) => {
      if (this.stale[face] && normal.dot(viewDir) > VISIBLE_DOT) due.push(face);
    });
    while (due.length < faces) {
      const face = this.nextFace(time, viewDir, due);
      if (face < 0) break;
      due.push(face);
    }
    if (!due.length) return false;

    const previous = renderer.getRenderTarget();
    for (const face of due) {
      this.uniforms.uFace.value = face;
      renderer.setRenderTarget(this.target, face);
      this.pass.render(renderer);
      this.drawnAt[face] = time;
      // Faces out of view stay stale through a fade, and catch up once it ends.
      this.stale[face] = false;
    }
    renderer.setRenderTarget(previous);
    return true;
  }

  /** The face most worth redrawing, or -1 when all are current. */
  private nextFace(time: number, viewDir: Vector3, taken: number[]): number {
    let best = -1;
    let bestScore = 0;
    FACE_NORMALS.forEach((normal, face) => {
      if (taken.includes(face)) return;
      // Faces turned away matter less, but still drift eventually.
      const facing = 0.15 + Math.max(0, normal.dot(viewDir) + 0.35);
      const age = time - (this.drawnAt[face] ?? 0);
      const score = this.stale[face] ? 1e6 + facing : age * facing;
      if (score > bestScore) {
        best = face;
        bestScore = score;
      }
    });
    return best;
  }

  get texture() {
    return this.target.texture;
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
    this.field.dispose();
    this.fieldPrev.dispose();
  }
}
