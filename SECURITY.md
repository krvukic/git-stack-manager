# Security policy

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability
reporting](https://github.com/krvukic/git-stack-manager/security/advisories/new) rather than in a
public issue. Expect an acknowledgement within a week. There is no bounty programme.

## Supported versions

The latest release. This project carries no long-term support branches.

## Trust boundary

The extension runs git in the repository you open, on your machine, under your identity. It adds no
network listener and sends no telemetry. Every git invocation passes an argument array to `execFile`
rather than a command string to a shell, so no repository content reaches a shell.

Web mode does add a listener, and its boundary is narrower than it looks:

- The server binds `127.0.0.1` and accepts no token. Any process that can reach loopback on that
  port can rewrite history in the served repository. Treat an SSH port-forward of it as granting
  write access to that repository.
- The handler checks neither `Origin` nor `Host`. A page open in a browser on the same machine can
  therefore POST to it, and a text body needs no preflight to get through. Do not leave web mode
  running while browsing sites you do not trust.
- Web mode is a development and demo host. The VS Code extension is the supported way to drive a
  repository you care about.

A report about anything outside that boundary is in scope. Repository content reaching a shell, a
URL escaping the served bundle directory, and a ref or path being read as a command-line option are
the three classes worth naming.
