import type { HumanId, HumanPrincipal } from "../../types";

interface DemoActorSwitchProps {
  actor: HumanPrincipal | null;
  disabled?: boolean;
  onSwitch: (userId: HumanId) => void;
}

export function DemoActorSwitch({ actor, disabled = false, onSwitch }: DemoActorSwitchProps) {
  return (
    <label className="actor-switch">
      <span>Acting as</span>
      <select
        aria-label="Acting as"
        value={actor?.id ?? ""}
        disabled={disabled || actor === null}
        onChange={(event) => onSwitch(event.target.value as HumanId)}
      >
        <option value="user-a">User A</option>
        <option value="user-b">User B</option>
        <option value="user-c">User C · Org A reviewer</option>
      </select>
    </label>
  );
}
