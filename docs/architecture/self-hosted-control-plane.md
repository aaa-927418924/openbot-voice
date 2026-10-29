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

## Future device agent

A future device agent is a separate capability. Dynamic device IDs, OS names, online state, and granted actions should be injected as current developer context so the Bot can resolve names it learned in memory. A skill may explain the workflow, but it cannot grant access. The target device must enforce an explicit action allowlist, user permission, expiry, and revocation. Raw shell access is not part of this design.

## Rollout order

1. Add and test the self-hosted identity authority and a secure device sign-in flow.
2. Pass the account identity through host invites and map it to host-local membership without changing Team protocol meanings.
3. Add explicit Cloud/Local host placement and show the availability trade-off before creation.
4. Add the device-agent registry and restricted action API as a later, separately reviewed feature.

The current code still uses per-device local profiles in local-only mode and OpenBot-hosted account services in account mode. This document records the target architecture; it does not claim those paths have been replaced yet.
