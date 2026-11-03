# Self-hosted identity and host placement

## Decision

The current Linux OpenBot PC is the self-owned identity authority. It is reached inside the user's Tailscale network. OpenBot-owned account APIs, hosted-server APIs, and hosted-site services are not part of this path.

The account authority owns one stable account ID and the shared account profile (display name and avatar). A client device also has a stable device ID and its operating-system device name. A conversational alias such as “Main PC” belongs to Bot memory; it is not stored as a device fact or used for authorization.

Each OpenBot host keeps its own team membership, roles, conversations, attachments, providers, workspaces, and SQLite data. The account ID is mapped to a host-local member ID after an authorized join. A local host can therefore be unavailable while its PC is off without affecting another host's data.

## Host placement

- **Cloud** means the OpenBot host runs on the current Linux central PC. It remains reachable while that PC and Tailscale are online. It is self-hosted, not OpenBot's hosted cloud.
- **Local** means the OpenBot host runs on the desktop PC that creates it. It is reachable while that PC and Tailscale are online.

Android is a client. It joins a Cloud or Local host; it does not host a server. “Cloud” is a placement label, not a promise of public-cloud uptime. Tailscale can use a direct path or a relay, so lower latency is not guaranteed.

## Authentication and trust boundaries

The identity authority issues account sessions and short-lived, single-use tickets for a specific host. Each host consumes a ticket and applies its own invite, role, and membership rules. Profile equality or matching display names never merge members by itself.

The identity API must bind only to the Tailscale interface (or loopback on the authority PC). It must not listen on a wildcard/public interface. Passwords are stored as salted, slow hashes; bearer values are stored only as hashes; logs never contain credentials or ticket contents. Session revocation takes effect at the identity authority. Host-local roles remain authoritative for each host.

The self-hosted service owns only account identity and host authorization. It does not receive conversations, attachments, prompts, provider credentials, or workspace data.

## Remote device operations

Windows and Linux OpenBot hosts can act as targets for a coordinator agent. The agent gets the current
online target list and its grants at tool-call time; the target's stable server ID and the coordinator
agent ID select the policy. Android remains a client and can start the same tools by chatting with
that coordinator.

Each target stores its policy in its local OpenBot profile. Command execution and Computer Use have
separate grants, both off by default. Commands run one explicitly allowed executable with separate
arguments, no shell, a fixed executable path, an allowed working directory, bounded runtime and
bounded output. The target performs a deterministic high-risk check before launch. Computer Use
reuses the existing CUA driver and its separate background cursor; it does not take over the user's
system cursor.

These allowlists and risk checks are application controls, not an operating-system sandbox. A
permitted process still runs as the OpenBot user and may access other files or resources that user
can reach. Do not describe this feature as isolation from the target computer. An OS-level sandbox or
a dedicated unprivileged account remains a separate hardening step.

## Rollout order

1. Add and test the self-hosted identity authority and a secure device sign-in flow.
2. Pass the account identity through host invites and map it to host-local membership without changing Team protocol meanings.
3. Add explicit Cloud/Local host placement and show the availability trade-off before creation.
4. Harden remote device operations with an OS sandbox or a dedicated unprivileged target account.

The current code still uses per-device local profiles in local-only mode and OpenBot-hosted account services in account mode. This document describes the implemented remote device operation path and its security boundary; it does not claim an OS-level sandbox exists.
