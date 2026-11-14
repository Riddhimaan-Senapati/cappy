import type { BlockConfig, BlockName, BlockOf } from "@browser-agent/shared";
import { applyFormFixer } from "./form-fixer";
import { applyStopMotion } from "./stop-motion";
import { applyTextScale } from "./text-scale";

type RuntimeBlock<N extends BlockName> = (cfg: BlockOf<N>) => () => void;

export const runtimeBlocks: Partial<{ [N in BlockName]: RuntimeBlock<N> }> = {
  form_fixer: applyFormFixer,
  stop_motion: applyStopMotion,
  text_scale: applyTextScale,
};

export function hasRuntimeBlock(blocks: BlockConfig[]): boolean {
  return blocks.some((cfg) => cfg.block in runtimeBlocks);
}

export function applyRuntimeBlocks(blocks: BlockConfig[]): () => void {
  const undos: Array<() => void> = [];
  for (const cfg of blocks) {
    const apply = runtimeBlocks[cfg.block] as ((cfg: BlockConfig) => () => void) | undefined;
    if (!apply) continue;
    try {
      undos.push(apply(cfg));
    } catch (err) {
      console.warn(`runtime block ${cfg.block} failed`, err);
    }
  }
  return () => {
    for (const undo of undos.reverse()) undo();
  };
}
