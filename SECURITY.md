# Security policy

## Supported versions

Security fixes go into the latest release line only. Today that is 3.2.x. If you run an older version, update first and check that the problem is still there.

| Version | Supported |
| --- | --- |
| 3.2.x | Yes |
| Older | No |

## Report a problem

Report it privately. Don't open a public issue or pull request for a security problem.

1. Open the **Security** tab of [the repository](https://github.com/mrramdn/laci).
2. Choose **Report a vulnerability**.
3. Fill in the form.

This is GitHub's private vulnerability reporting. Only you and the maintainer can see the report. Laci is a one-person project, so a reply can take a few days. You will be told when a fix is out.

## What is in scope

Laci changes files on your disk, so the question that matters is whether it can be made to touch something you didn't ask it to.

- Anything that can move, delete, trash or rewrite files or folders it shouldn't, from the app, the CLI or MCP. That includes archive, move, Move to Trash, freeing space and rewriting paths in agent logs.
- The undo journal and its backups: a way to make Undo restore the wrong data, lose data, or write outside the folders Laci may use.
- The MCP server (`laci mcp`): a tool that changes files it shouldn't, skips its plan-then-confirm step where it has one, or gives an agent data it shouldn't see.
- Project files that run code or reach outside the project, for example through a README, an agent log, `.laci.md` or a folder's Git settings.
- Update signing and releases: anything that lets someone other than the maintainer publish a build or an update that Laci accepts.

## What is not in scope

- Problems that need someone who already controls your account or can already write to your home folder.
- Bugs in the tools Laci starts, such as Claude Code, Codex, Git or your terminal. Report those to their projects.
- Scanner output with no sign that it affects Laci.

## What to include

- The Laci version (`laci --version`) and your operating system.
- What you did, what happened and what you expected. Steps, or a small example folder, help most.
- Whether data was lost or changed.

Please reproduce it on a throwaway home folder (`LACI_HOME`, see the README) and not on your real projects, and don't send real secrets or private project data. If you plan to publish what you found, say when, so a fix can be ready first.

## Bug bounty

There is no bug bounty. Laci is a free project and can't pay for reports.
