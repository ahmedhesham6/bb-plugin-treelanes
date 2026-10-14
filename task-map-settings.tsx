import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TaskMapResult } from "./server";
import type { Choice, Choices } from "./task-map";
import { stageLabel, type StageId } from "./workflow";
import { Button } from "./components/ui/button";

const CHOOSES = "Orchestrator chooses";
const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function ChoiceRow({ map, slot, title, detail, choice, effort = true, onChange }: {
  map: TaskMapResult; slot: string; title: string; detail?: string; choice: Choice; effort?: boolean;
  onChange(choice: Choice): void;
}) {
  const models = choice.providerId ? map.models[choice.providerId] ?? [] : [];
  const model = models.find(candidate => candidate.model === choice.model);
  const problem = map.problems.find(item => item.slot === slot)?.message;
  // A saved value missing from the live catalog stays visible so the user sees what is wrong.
  const providers = map.providers.filter(provider => provider.available || provider.id === choice.providerId);
  const missingProvider = choice.providerId && !providers.some(provider => provider.id === choice.providerId);
  const missingModel = choice.model && !model;
  const efforts = model?.efforts ?? [];
  const missingEffort = choice.reasoningLevel && !efforts.includes(choice.reasoningLevel);
  return (
    <div className="grid gap-2 border-t border-border py-3 first:border-t-0 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:items-start">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {detail ? <div className="text-xs leading-5 text-muted-foreground">{detail}</div> : null}
        {problem ? <div role="alert" className="mt-1 text-xs font-medium text-destructive">Unavailable: {problem}</div> : null}
      </div>
      <select aria-label={`${title} harness`} className={selectClass} value={choice.providerId ?? ""}
        onChange={event => onChange(event.target.value ? { providerId: event.target.value } : {})}>
        <option value="">{CHOOSES}</option>
        {missingProvider ? <option value={choice.providerId}>{choice.providerId} (unavailable)</option> : null}
        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.available ? "" : " (unavailable)"}</option>)}
      </select>
      <select aria-label={`${title} model`} className={selectClass} value={choice.model ?? ""} disabled={!choice.providerId}
        onChange={event => onChange(event.target.value ? { providerId: choice.providerId, model: event.target.value } : { providerId: choice.providerId })}>
        <option value="">{CHOOSES}</option>
        {missingModel ? <option value={choice.model}>{choice.model} (unavailable)</option> : null}
        {models.map(candidate => <option key={candidate.model} value={candidate.model}>{candidate.name}</option>)}
      </select>
      {effort ? (
        <select aria-label={`${title} effort`} className={selectClass} value={choice.reasoningLevel ?? ""} disabled={!choice.model}
          onChange={event => onChange(event.target.value ? { ...choice, reasoningLevel: event.target.value } : { providerId: choice.providerId, model: choice.model })}>
          <option value="">{CHOOSES}</option>
          {missingEffort ? <option value={choice.reasoningLevel}>{choice.reasoningLevel} (unavailable)</option> : null}
          {efforts.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      ) : <div />}
    </div>
  );
}

/** Settings section: harness, model and effort for each task kind step. */
export function TaskMapSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [map, setMap] = useState<TaskMapResult | null>(null);
  const [draft, setDraft] = useState<Choices>({});
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("getTaskMap", {}).then(result => { setMap(result); setDraft(result.choices); })
      .catch(error => setStatus(`Could not load the task map: ${error instanceof Error ? error.message : String(error)}`));
  }, [rpc]);
  if (!map) return <p className="text-sm text-muted-foreground">{status ?? "Loading the task map…"}</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(map.choices);
  const row = (slot: string, title: string, detail?: string, effort = true) => (
    <ChoiceRow key={slot} map={map} slot={slot} title={title} detail={detail} effort={effort} choice={draft[slot] ?? {}}
      onChange={choice => { setStatus(null); setDraft(current => ({ ...current, [slot]: choice })); }} />
  );
  async function save() {
    setStatus("Saving…");
    try {
      const result = await rpc.call("saveTaskMap", { choices: draft });
      setMap(result); setDraft(result.choices); setStatus("Saved.");
    } catch (error) {
      setStatus(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-5 text-muted-foreground">
        Choose the harness, model and effort for each step. The board uses a saved choice in setup planning and rejects a plan that changes it. {CHOOSES} lets the orchestrator decide.
      </p>
      <section>
        <h3 className="text-sm font-semibold text-foreground">Shared</h3>
        {map.shared.map(item => row(item.slot, item.title, item.detail, item.slot !== "titles"))}
      </section>
      {map.kinds.map(kind => (
        <section key={kind.kind}>
          <h3 className="text-sm font-semibold capitalize text-foreground">{kind.kind.replace("-", " ")}</h3>
          {kind.steps.map(step => row(step.slot, step.title === stageLabel(step.stage as StageId) ? step.title : `${stageLabel(step.stage as StageId)}: ${step.title}`,
            [step.prOnly ? "Only when the target is a pull request." : "", step.checks.length ? `Checks: ${step.checks.join(" ")}` : "",
              `Skills: ${step.skills.join(", ")}`].filter(Boolean).join(" ")))}
        </section>
      ))}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void save()} disabled={!changed}>Save task map</Button>
        {status ? <span role="status" className="text-xs text-muted-foreground">{status}</span> : null}
      </div>
    </div>
  );
}
