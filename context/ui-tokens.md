# UI Tokens — AgentGate Additions

The CodeJam starter already defines a visual language in `apps/web/src/styles.css`.

Do not replace it.

## Existing baseline tokens

```css
--ink: #20211f;
--muted: #777870;
--line: #deddd6;
--paper: #fbfaf7;
--purple: #6954d9;
--purple-dark: #513db9;
--purple-soft: #efecff;
--green: #33906d;
--red: #c55353;
--shadow: 0 24px 60px rgba(39, 38, 33, 0.12);
```

Use these first.

## Semantic mapping

| State | Token |
|---|---|
| allowed/success | `--green` |
| denied/failure | `--red` |
| approval/capability/pending | `--purple` / `--purple-soft` |
| metadata | `--muted` |
| card surface | `--paper` |
| border | `--line` |
| text | `--ink` |

No new rainbow security palette.

## AgentGate UI rules

Approval status must include text:

```text
ALLOW
DENY
APPROVAL REQUIRED
APPROVED
```

Color is supporting information only.

Runtime/Agent IDs may be visually shortened, never runtime token.

Use existing `.button`, `.button-primary`, `.button-danger`, card/border conventions.

## Do not

- add Tailwind;
- add CSS-in-JS;
- add component library;
- redesign sidebar;
- show secrets;
- use animated "cybersecurity" effects;
- create large colored backgrounds for every event.
