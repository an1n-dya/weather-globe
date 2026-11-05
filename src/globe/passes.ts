import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  type Data3DTexture,
  LinearFilter,
  Mesh,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  WebGL3DRenderTarget,
  type WebGLRenderer,
} from "three";
import { noiseVolumeFragment } from "./shaders/clouds";
import { fullscreenVertex } from "./shaders/common";

/** A shader drawn over a whole render target, for work that needs no camera. */
export class FullscreenPass {
  readonly material: ShaderMaterial;
  private readonly scene = new Scene();
  private readonly camera = new Camera();

  constructor(parameters: ConstructorParameters<typeof ShaderMaterial>[0]) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.material = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      depthTest: false,
      depthWrite: false,
      ...parameters,
    });
    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const child of this.scene.children) (child as Mesh).geometry.dispose();
    this.material.dispose();
  }
}

const NOISE_SIZE = 64;
const NOISE_PERIOD = 16;

/** Tileable four-channel gradient noise, generated on the GPU in a few milliseconds. */
export class NoiseVolume {
  readonly target = new WebGL3DRenderTarget(NOISE_SIZE, NOISE_SIZE, NOISE_SIZE, {
    depthBuffer: false,
  });

  constructor() {
    const texture = this.target.texture;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.wrapR = RepeatWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
  }

  get texture(): Data3DTexture {
    return this.target.texture;
  }

  /** Also needed after a lost graphics context, which empties render targets. */
  build(renderer: WebGLRenderer): void {
    const layer = { value: 0 };
    const pass = new FullscreenPass({
      fragmentShader: noiseVolumeFragment,
      uniforms: {
        uLayer: layer,
        uSize: { value: NOISE_SIZE },
        uPeriod: { value: NOISE_PERIOD },
      },
    });
    const previous = renderer.getRenderTarget();
    for (let z = 0; z < NOISE_SIZE; z++) {
      layer.value = z;
      renderer.setRenderTarget(this.target, z);
      pass.render(renderer);
    }
    renderer.setRenderTarget(previous);
    pass.dispose();
  }

  dispose(): void {
    this.target.dispose();
  }
}
