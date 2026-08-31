import { useEffect, useMemo, useState } from "react";
import type { HumanId, HumanPrincipal, TeamId, TeamMembership, TeamRole } from "../../types";

const teamNames: Record<TeamId, string> = {
  "team-alpha": "Team Alpha",
  "team-beta": "Team Beta",
};

interface TeamMembershipPanelProps {
  actor: HumanPrincipal | null;
  users: HumanPrincipal[];
  memberships: TeamMembership[];
  manageableMemberships: TeamMembership[];
  disabled?: boolean;
  onAdd: (input: { memberId: HumanId; teamId: TeamId; role: TeamRole }) => Promise<void>;
  onRemove: (input: { memberId: HumanId; teamId: TeamId }) => Promise<void>;
}

export function TeamMembershipPanel({
  actor,
  users,
  memberships,
  manageableMemberships,
  disabled = false,
  onAdd,
  onRemove,
}: TeamMembershipPanelProps) {
  const [memberId, setMemberId] = useState<HumanId>(users[0]?.id ?? "user-a");
  const [teamId, setTeamId] = useState<TeamId>("team-alpha");
  const [role, setRole] = useState<TeamRole>("viewer");
  const [saving, setSaving] = useState(false);

  const adminTeams = useMemo(
    () => memberships.filter((membership) => membership.role === "admin"),
    [memberships],
  );
  const userNames = new Map(users.map((user) => [user.id, user.name]));

  useEffect(() => {
    if (actor) setMemberId(actor.id);
  }, [actor]);

  useEffect(() => {
    if (!adminTeams.some((membership) => membership.teamId === teamId) && adminTeams[0]) {
      setTeamId(adminTeams[0].teamId);
    }
  }, [adminTeams, teamId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onAdd({ memberId, teamId, role });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (membership: TeamMembership) => {
    if (!window.confirm(`Remove ${userNames.get(membership.humanId) ?? membership.humanId} from ${teamNames[membership.teamId]}?`)) {
      return;
    }
    setSaving(true);
    try {
      await onRemove({ memberId: membership.humanId, teamId: membership.teamId });
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="team-membership-panel">
      <summary className="team-membership-heading" id="team-membership-title">
        <span>Team memberships</span>
        <span>{memberships.length}</span>
      </summary>
      {memberships.length === 0 ? (
        <p className="team-membership-empty">{actor?.name ?? "This user"} is not in a team.</p>
      ) : (
        <div className="team-membership-list">
          {memberships.map((membership) => (
            <div className="team-membership-row" key={`${membership.teamId}:${membership.humanId}`}>
              <span>{teamNames[membership.teamId]}</span>
              <strong>{membership.role}</strong>
            </div>
          ))}
        </div>
      )}

      {adminTeams.length > 0 ? (
        <>
          <div className="team-membership-management">
            <span className="team-membership-form-title">Manage members</span>
            {manageableMemberships.map((membership) => {
              const soleAdmin =
                membership.role === "admin" &&
                manageableMemberships.filter(
                  (candidate) => candidate.teamId === membership.teamId && candidate.role === "admin",
                ).length === 1;
              return (
                <div className="team-membership-managed-row" key={`${membership.teamId}:${membership.humanId}`}>
                  <div>
                    <strong>{userNames.get(membership.humanId) ?? membership.humanId}</strong>
                    <span>{teamNames[membership.teamId]} · {membership.role}</span>
                  </div>
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={disabled || saving || soleAdmin}
                    title={soleAdmin ? "A team must retain one administrator" : "Remove from team"}
                    onClick={() => void remove(membership)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
          <form className="team-membership-form" onSubmit={submit}>
          <span className="team-membership-form-title">Add a user</span>
          <label>
            User
            <select
              value={memberId}
              disabled={disabled || saving}
              onChange={(event) => setMemberId(event.target.value as HumanId)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </label>
          <label>
            Team
            <select
              value={teamId}
              disabled={disabled || saving}
              onChange={(event) => setTeamId(event.target.value as TeamId)}
            >
              {adminTeams.map((membership) => (
                <option key={membership.teamId} value={membership.teamId}>
                  {teamNames[membership.teamId]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select
              value={role}
              disabled={disabled || saving}
              onChange={(event) => setRole(event.target.value as TeamRole)}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="button button-primary" disabled={disabled || saving}>
            {saving ? "Adding…" : "Add to team"}
          </button>
          </form>
        </>
      ) : (
        <p className="team-membership-help">Only a team admin can add members.</p>
      )}
    </details>
  );
}
