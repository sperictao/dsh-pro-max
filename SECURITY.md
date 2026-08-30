# Security Policy

## Supported versions

Only the [latest release](https://github.com/sperictao/dsh-pro-max/releases/latest)
receives security fixes. The app ships a built-in updater; staying current is
the expected posture.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/sperictao/dsh-pro-max/security/advisories/new)
rather than a public issue. You can expect an initial response within five
business days.

Please include: affected version (Settings → About), platform, steps or a proof
of concept, and the impact you believe is possible.

## Scope

In scope:

- The Tauri shell in this repository: IPC surface, updater flow, bundled
  plugin installation, autostart scripts, tray/window handling.
- How this app authorizes remote access (capability injection, Tailscale serve
  configuration it performs).

Out of scope (report upstream, but you may open a private advisory here so we
can track and ship the fix):

- Vulnerabilities in the `dsh` CLI itself (`@deepseek-ai/dsh`).
- The vendored plugins' upstream code: `dsh-client-connection-authz` and
  `dsh-auth-tailscale` (pinned, built from `vendor/`).
- Tailscale, Node.js, or other runtime dependencies.

## Design boundaries relevant to security review

- The dsh web service binds to `127.0.0.1:3899`; remote access is only exposed
  through Tailscale Serve HTTPS with identity authorization plugins.
- Remote privileged APIs require the user-configured admin capability; without
  it they answer 403 for remote identities.
- This launcher never rewrites `Host`/`Origin` headers or fabricates loopback
  identities.
- Logs stay on disk locally (`~/.dsh/dsh-web.log` and the app log directory);
  the app performs no telemetry and no crash reporting.
