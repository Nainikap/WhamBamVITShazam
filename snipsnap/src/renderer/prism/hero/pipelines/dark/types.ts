import type { Bundle, Draw, Effect, Target } from "vgpu";

export interface BloomLevelTargets {
  readonly horizontal: Target;
  readonly vertical: Target;
}

export interface BloomLevelEffects {
  readonly horizontal: Effect;
  readonly vertical: Effect;
}

export type BloomTargets = readonly [
  BloomLevelTargets,
  BloomLevelTargets,
  BloomLevelTargets,
  BloomLevelTargets
];

export type BloomBlurEffects = readonly [
  BloomLevelEffects,
  BloomLevelEffects,
  BloomLevelEffects,
  BloomLevelEffects
];

/** Dark-only draws, postprocess effects, and render targets. */
export interface DarkPipelineGraph {
  light: Draw;
  lights: Draw[];
  lightWireframe?: Draw | undefined;
  readonly dust: Draw;
  readonly copyBackground: Effect;
  readonly bloomExtract: Effect;
  readonly bloomBlur: BloomBlurEffects;
  readonly bloomComposite: Effect;
  readonly particleLightDownsample: Effect;
  readonly present: Effect;
  readonly copyPresentation: Effect;
  glassBack: Draw;
  glassFront: Draw;
  glassBacks: Draw[];
  glassFronts: Draw[];
  solidsVersion: number;
  wireframe?: Draw | undefined;
  backdropBundle?: Bundle | undefined;
  backgroundTarget?: Target | undefined;
  sceneTarget?: Target | undefined;
  bloomTargets?: BloomTargets | undefined;
  presentationTarget?: Target | undefined;
}
