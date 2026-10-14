import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import type { Execution } from "@noodles/schema";
import type { GraphIndex } from "../graph/model";

interface Props {
  index: GraphIndex;
  exec: Execution;
  stepIdx: number;
  playing: boolean;
  follow: boolean;
  onExec: (id: string) => void;
  onStep: (i: number) => void;
  onPlay: (p: boolean) => void;
  onFollow: (f: boolean) => void;
}

export function TracePlayer({ index, exec, stepIdx, playing, follow, onExec, onStep, onPlay, onFollow }: Props) {
  const steps = exec.steps;
  const step = steps[stepIdx];
  const node = step ? index.nodes.get(step.node) : undefined;
  const ms = step?.start !== undefined && step?.end !== undefined ? `${(step.end - step.start).toFixed(1)} ms` : "";
  const atEnd = stepIdx >= steps.length - 1;
  return (
    <div className="player" role="toolbar" aria-label="Trace player">
      <select value={exec.id} onChange={(e) => onExec(e.target.value)} aria-label="Execution">
        {index.executions.map((x) => (
          <option key={x.id} value={x.id}>
            {x.status === "error" ? "✕ " : ""}
            {x.name ?? x.id}
          </option>
        ))}
      </select>
      <button className="icon-btn" onClick={() => onStep(Math.max(0, stepIdx - 1))} disabled={stepIdx === 0} aria-label="Previous step">
        <ChevronLeft size={17} />
      </button>
      <button
        className="icon-btn play"
        onClick={() => {
          if (atEnd) {
            onStep(0);
            onPlay(true);
          } else onPlay(!playing);
        }}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={16} /> : atEnd ? <RotateCcw size={16} /> : <Play size={16} />}
      </button>
      <button className="icon-btn" onClick={() => onStep(Math.min(steps.length - 1, stepIdx + 1))} disabled={atEnd} aria-label="Next step">
        <ChevronRight size={17} />
      </button>
      <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={stepIdx} onChange={(e) => onStep(Number(e.target.value))} aria-label="Step" />
      <span className="step-info" title={node?.name}>
        <strong>
          {stepIdx + 1}/{steps.length}
        </strong>{" "}
        {node?.name ?? step?.node} {ms && `· ${ms}`}
        {step?.status === "error" ? " · error" : ""}
      </span>
      <label title="Drill into the active node automatically">
        <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} /> Follow
      </label>
    </div>
  );
}
